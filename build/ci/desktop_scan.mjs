#!/usr/bin/env node
// desktop.yml 编完以后核对 exe 的环境（B6-exe F8、F9、A14；架构 8.3 desktop.yml 0.48 第 7 条）：
//   node build/ci/desktop_scan.mjs --env production|preview <exe 路径>
//   node build/ci/desktop_scan.mjs --env production|preview --latest <latest.json 路径>
// 1. 本环境的值必须都在：site_origin、identifier、会话键（证明编的确实是这一套环境）；
// 2. 反向搜对方环境：对方的 site_origin、identifier、会话键、更新地址、updater 公钥，搜到一个就失败。
// 两套环境的值不在这里另抄一份，直接从 desktop/src-tauri/src/env.rs 读（两个 #[cfg] 块）；
// updater 公钥从 tauri.conf.json、tauri.preview.conf.json 的 plugins.updater.pubkey 读（现在还没配，F7 配了以后自动生效；
// 正式配了公钥、预览配置却没写自己的（会继承正式那把）或写了同一把，直接失败）。
// --latest：latest.json 草稿里安装包的下载地址必须和 env.rs 本环境的 update_url 同源、同目录（B6-exe 安全审查 S-3），
// 版本号必须是 X.Y.Z 或 X.Y.Z-preview.N，只许一个平台 windows-x86_64。
// exe 里的字符串按 UTF-8 和 UTF-16LE 各搜一遍。只读，不改任何文件，不打印 exe 内容。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = resolve(HERE, '..', '..', 'desktop', 'src-tauri');

/** 从 env.rs 读出两套环境（production = not(feature = "preview") 那块） */
export function parseEnvRs(text) {
  const out = {};
  const block = /#\[cfg\((not\(feature = "preview"\)|feature = "preview")\)\]\s*pub const ENV: EnvSpec = EnvSpec \{([\s\S]*?)\n\};/g;
  for (const m of text.matchAll(block)) {
    const body = m[2];
    const str = (k) => new RegExp(`\\b${k}: "([^"]+)"`).exec(body)?.[1];
    const keys = /\bsession_keys: &\[([^\]]*)\]/.exec(body)?.[1] ?? '';
    const spec = {
      name: str('name'),
      identifier: str('identifier'),
      site_origin: str('site_origin'),
      update_url: str('update_url'),
      session_keys: [...keys.matchAll(/"([^"]+)"/g)].map((k) => k[1]),
    };
    for (const [k, v] of Object.entries(spec)) {
      if (!v || (Array.isArray(v) && v.length === 0)) throw new Error(`env.rs 的 ${m[1]} 块里读不到 ${k}`);
    }
    out[m[1].startsWith('not') ? 'production' : 'preview'] = spec;
  }
  if (!out.production || !out.preview) throw new Error('env.rs 里没找到正式、预览两个 ENV 块');
  if (out.production.name !== 'production' || out.preview.name !== 'preview') throw new Error('env.rs 两个 ENV 块的 name 对不上');
  return out;
}

/**
 * 这一套环境要核对的值：required 必须都在，forbidden 一个都不能有（都是普通子串）。
 * Rust 的字符串常量在 exe 里首尾相连地放着，前后没有分隔符，所以不用整词匹配；
 * 改成数次数：对方的值出现的次数，比它作为本环境的值（own）的一部分出现的次数多，才算搜到。
 * 这样预览 exe 里 com.lemomemo.app.preview 中的 com.lemomemo.app 不算正式版的标识；
 * 反过来正式 exe 里多出来的 com.lemomemo.app.preview 照样能搜到（不能先把本环境的值抹掉再搜：会连对方的值一起抹掉）
 */
export function rulesFor(envName, envs, pubkeys = {}) {
  const other = envName === 'production' ? 'preview' : 'production';
  const me = envs[envName];
  const them = envs[other];
  if (!me || !them) throw new Error(`未知环境 ${envName}`);
  const own = [me.site_origin, me.identifier, ...me.session_keys, me.update_url];
  const required = [me.site_origin, me.identifier, ...me.session_keys];
  const forbidden = [them.site_origin, them.identifier, ...them.session_keys, them.update_url].map((s) => ({ what: s, text: s }));
  const theirKey = pubkeys[other];
  if (theirKey && theirKey !== pubkeys[envName]) forbidden.push({ what: `${other} 的 updater 公钥`, text: theirKey });
  if (pubkeys[envName]) own.push(pubkeys[envName]);
  return { required, forbidden, own };
}

/** s 在 text 里出现几次（允许重叠） */
function count(text, s) {
  let n = 0;
  for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + 1)) n++;
  return n;
}

/** 在二进制里按 UTF-8（逐字节当 latin1）和 UTF-16LE（两种对齐）搜 */
export function scan(buf, rules) {
  const views = [buf.toString('latin1'), buf.toString('utf16le'), buf.subarray(1).toString('utf16le')];
  const extra = (v, f) => count(v, f) - rules.own.reduce((n, o) => n + (o.includes(f) ? count(v, o) * count(o, f) : 0), 0);
  return {
    missing: rules.required.filter((r) => !views.some((v) => v.includes(r))),
    found: rules.forbidden.filter((r) => views.some((v) => extra(v, r.text) > 0)).map((r) => r.what),
  };
}

/** latest.json 草稿核对：返回问题列表，空数组表示通过 */
export function checkLatest(latest, spec) {
  const problems = [];
  const base = spec.update_url.replace(/\/latest\.json$/, '');
  if (base === spec.update_url) return [`env.rs 的 update_url 不是以 /latest.json 结尾：${spec.update_url}`];
  const platforms = latest?.platforms && typeof latest.platforms === 'object' ? Object.keys(latest.platforms) : [];
  if (platforms.length !== 1 || platforms[0] !== 'windows-x86_64') problems.push(`platforms 只许 windows-x86_64，现在是：${platforms.join('、') || '空'}`);
  const url = latest?.platforms?.['windows-x86_64']?.url;
  if (typeof url !== 'string') return [...problems, '缺 platforms.windows-x86_64.url'];
  let u;
  try {
    u = new URL(url);
  } catch {
    return [...problems, `url 不是合法地址：${url}`];
  }
  const b = new URL(base + '/');
  const name = url.startsWith(b.href) ? url.slice(b.href.length) : '';
  if (u.origin !== b.origin) problems.push(`url 的主机 ${u.origin} 和 env.rs 的 ${b.origin} 不一样`);
  else if (!/^[A-Za-z0-9._-]+-setup\.exe$/.test(name) || u.search || u.hash) problems.push(`url 应为 ${b.href}<安装包文件名>，现在是：${url}`);
  const ver = latest?.version;
  if (typeof ver !== 'string' || !/^\d+\.\d+\.\d+(-preview\.\d+)?$/.test(ver)) problems.push(`version 不对：${ver}`);
  else if ((spec.name === 'preview') !== ver.includes('-preview.')) problems.push(`version ${ver} 和环境 ${spec.name} 对不上`);
  return problems;
}

function pubkeyOf(file) {
  try {
    const j = JSON.parse(readFileSync(join(SRC_TAURI, file), 'utf8'));
    const k = j?.plugins?.updater?.pubkey;
    return typeof k === 'string' && k ? k : undefined;
  } catch {
    return undefined;
  }
}

function main(argv) {
  const i = argv.indexOf('--env');
  const envName = i >= 0 ? argv[i + 1] : undefined;
  const l = argv.indexOf('--latest');
  const latestPath = l >= 0 ? argv[l + 1] : undefined;
  const exe = argv.filter((a, j) => j !== i && j !== i + 1 && j !== l && j !== l + 1)[0];
  if ((envName !== 'production' && envName !== 'preview') || (l >= 0 ? !latestPath || exe : !exe)) {
    console.error('用法：node build/ci/desktop_scan.mjs --env production|preview <exe 路径>');
    console.error('　或：node build/ci/desktop_scan.mjs --env production|preview --latest <latest.json 路径>');
    return 2;
  }
  const envs = parseEnvRs(readFileSync(join(SRC_TAURI, 'src', 'env.rs'), 'utf8'));
  if (latestPath) {
    const problems = checkLatest(JSON.parse(readFileSync(latestPath, 'utf8')), envs[envName]);
    if (problems.length) {
      console.error(`latest.json 和 env.rs 的 ${envName} 对不上（安全审查 S-3）：${problems.join('；')}`);
      return 1;
    }
    console.log(`latest.json 核对通过（${envName}）：下载地址和 env.rs 的 update_url 同源、同目录`);
    return 0;
  }
  const prodKey = pubkeyOf('tauri.conf.json');
  const prevKey = pubkeyOf('tauri.preview.conf.json');
  if (prodKey && (!prevKey || prevKey === prodKey)) {
    console.error('tauri.preview.conf.json 没写自己的 updater 公钥（或和正式的是同一把）：预览版会继承正式公钥，两套环境必须各用一把（F8）');
    return 1;
  }
  const pubkeys = { production: prodKey, preview: prevKey };
  const r = scan(readFileSync(exe), rulesFor(envName, envs, pubkeys));
  if (r.missing.length) console.error(`exe 里缺本环境（${envName}）的值，编的可能不是这一套环境：${r.missing.join('、')}`);
  if (r.found.length) console.error(`exe 里搜到了另一套环境的值（F8 反向搜索）：${r.found.join('、')}`);
  if (r.missing.length || r.found.length) return 1;
  console.log(`环境核对通过（${envName}）：本环境 ${envs[envName].identifier} 的值都在，没有另一套环境的地址、标识、会话键、更新地址、公钥`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
