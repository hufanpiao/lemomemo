#!/usr/bin/env node
// desktop.yml 编完以后核对 exe 的环境（B6-exe F8、F9、A14；架构 8.3 desktop.yml 0.48 第 7 条）：
//   node build/ci/desktop_scan.mjs --env production|preview <exe 路径>
//   node build/ci/desktop_scan.mjs --env production|preview --latest <latest.json 路径>
//   node build/ci/desktop_scan.mjs --env production|preview --package <bundle/nsis 目录> --version <这次的版本号>
// 1. 本环境的值必须都在：site_origin、identifier、会话键（证明编的确实是这一套环境）；
// 2. 反向搜对方环境：对方的 site_origin、identifier、会话键、更新地址、updater 公钥，搜到一个就失败。
// 两套环境的值不在这里另抄一份，直接从 desktop/src-tauri/src/env.rs 读（两个 #[cfg] 块）；
// updater 公钥从 tauri.conf.json、tauri.preview.conf.json 的 plugins.updater.pubkey 读（现在还没配，F7 配了以后自动生效；
// 正式配了公钥、预览配置却没写自己的（会继承正式那把）或写了同一把，直接失败）。
// --latest：latest.json 草稿里安装包的下载地址必须和 env.rs 本环境的 update_url 同源、同目录（B6-exe 安全审查 S-3），
// 版本号必须是 X.Y.Z 或 X.Y.Z-preview.N，只许一个平台 windows-x86_64；
// 版本号还要和这次编译用的配置一致（预览配置 tauri.preview.conf.json 自己写了 version 就用它，否则用 tauri.conf.json 的，
// desktop.yml 已把 VERSION 同步进去），下载地址的文件名必须是 setupName(环境, 版本) 拼出的整名，
// latest.json 所在目录（要上传的那一批）里只许有这个安装包、latest.json、SHA256SUMS 三样（工作流审查 M3、安全审查 A-3）。
// --package：NSIS 目录里正好一个安装包，原名必须整名等于“合并后的 productName_合并后的 version_x64-setup.exe”，
// 而且那个 version 就是 --version（证明编进 exe 的版本是这次的版本；工作流审查 M2、安全审查 A-1、A-2）；
// 通过就在标准输出打印上传用的文件名（setupName），desktop.yml 用它改名，checkLatest 也按它核对，前缀只在这里写一处。
// 有 tauri.windows.conf.json 就失败：Tauri 在 Windows 上会再合并它，这里没按它取版本和产品名。
// exe 里的字符串按 UTF-8 和 UTF-16LE 各搜一遍。只读，不改任何文件，不打印 exe 内容。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * latest.json 草稿核对：返回问题列表，空数组表示通过。
 * opts.version：这次编译用的版本号（给了就必须相等）；opts.files：要上传的那一批文件名（给了就要求下载地址的文件名是其中唯一的安装包）
 */
export function checkLatest(latest, spec, opts = {}) {
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
  if (opts.version !== undefined && ver !== opts.version) problems.push(`version ${ver} 和这次编译用的配置（${opts.version}）不一样`);
  if (typeof ver === 'string' && name && name !== setupName(spec.name, ver)) problems.push(`下载地址的文件名 ${name} 不是 ${setupName(spec.name, ver)}（文件名里的版本号要和 version 一致）`);
  if (opts.files) {
    const setups = opts.files.filter((f) => f.endsWith('-setup.exe'));
    if (setups.length !== 1) problems.push(`要上传的目录里安装包应该正好 1 个，现在 ${setups.length} 个`);
    else if (name && name !== setups[0]) problems.push(`下载地址的文件名 ${name} 和要上传的安装包 ${setups[0]} 不一样`);
    const extra = opts.files.filter((f) => f !== 'latest.json' && f !== 'SHA256SUMS' && !(setups.length === 1 && f === setups[0]));
    const missing = ['latest.json', 'SHA256SUMS'].filter((f) => !opts.files.includes(f));
    if (setups.length === 1 && extra.length) problems.push(`要上传的目录里只许有安装包、latest.json、SHA256SUMS 三样，多了：${extra.join('、')}`);
    if (missing.length) problems.push(`要上传的目录里缺 ${missing.join('、')}`);
  }
  return problems;
}

/** 上传、发布用的安装包文件名（desktop.yml 从 --package 的输出取，checkLatest 也按它核对；前缀只写这一处） */
export function setupName(envName, ver) {
  return `${envName === 'preview' ? 'lemomemo-preview' : 'lemomemo'}_${ver}_x64-setup.exe`;
}

/**
 * NSIS 安装包核对：nsisFiles 是 bundle/nsis 目录里的文件名，version 是这次的版本号。返回问题列表，空数组表示通过。
 * Tauri 按合并后的配置给安装包起名：<productName>_<version>_x64-setup.exe，所以原名整名相等就证明编进去的版本是这次的版本。
 */
export function checkPackage(envName, nsisFiles, version, readConf = defaultReadConf) {
  const problems = [];
  let built;
  try {
    built = builtVersion(envName, readConf);
  } catch (e) {
    return [String(e instanceof Error ? e.message : e)];
  }
  if (built !== version) problems.push(`编译配置里的 version ${built} 不是这次的版本 ${version}`);
  const product = (envName === 'preview' ? readConf('tauri.preview.conf.json')?.productName : undefined) ?? readConf('tauri.conf.json')?.productName;
  if (typeof product !== 'string' || !product) return [...problems, 'tauri.conf.json 里没有 productName'];
  const setups = nsisFiles.filter((f) => f.endsWith('-setup.exe'));
  if (setups.length !== 1) return [...problems, `NSIS 安装包应该正好 1 个，现在 ${setups.length} 个`];
  const want = `${product}_${version}_x64-setup.exe`;
  if (setups[0] !== want) problems.push(`安装包原名 ${setups[0]} 不是 ${want}（版本号或产品名不对）`);
  return problems;
}

/** 读 desktop/src-tauri 下的配置，文件不存在返回 undefined */
function defaultReadConf(f) {
  const p = join(SRC_TAURI, f);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined;
}

/**
 * 这次编译实际用的版本号：预览配置自己写了 version 就用它（desktop.yml 不许这样写，这里照 Tauri 合并配置的规则取），否则用 tauri.conf.json 的。
 * readConf(文件名) 文件不存在时返回 undefined。有 tauri.windows.conf.json 就失败（Tauri 在 Windows 上还会合并它）
 */
export function builtVersion(envName, readConf = defaultReadConf) {
  if (readConf('tauri.windows.conf.json') !== undefined) throw new Error('desktop/src-tauri 里有 tauri.windows.conf.json：Tauri 在 Windows 上会再合并它，版本号和产品名就不只看这两个配置了。先删掉它，或改 desktop_scan.mjs 一并读它');
  const base = readConf('tauri.conf.json')?.version;
  const over = envName === 'preview' ? readConf('tauri.preview.conf.json')?.version : undefined;
  const v = over ?? base;
  if (typeof v !== 'string' || !v) throw new Error('tauri.conf.json 里没有 version');
  return v;
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
  const k = argv.indexOf('--package');
  const pkgDir = k >= 0 ? argv[k + 1] : undefined;
  const vi = argv.indexOf('--version');
  const pkgVersion = vi >= 0 ? argv[vi + 1] : undefined;
  const used = new Set([i, i + 1, ...(l >= 0 ? [l, l + 1] : []), ...(k >= 0 ? [k, k + 1] : []), ...(vi >= 0 ? [vi, vi + 1] : [])]);
  const exe = argv.filter((a, j) => !used.has(j))[0];
  const modes = [l >= 0, k >= 0].filter(Boolean).length;
  const bad =
    (envName !== 'production' && envName !== 'preview') ||
    modes > 1 ||
    (l >= 0 && (!latestPath || exe || vi >= 0)) ||
    (k >= 0 && (!pkgDir || !pkgVersion || exe)) ||
    (modes === 0 && (!exe || vi >= 0));
  if (bad) {
    console.error('用法：node build/ci/desktop_scan.mjs --env production|preview <exe 路径>');
    console.error('　或：node build/ci/desktop_scan.mjs --env production|preview --latest <latest.json 路径>');
    console.error('　或：node build/ci/desktop_scan.mjs --env production|preview --package <bundle/nsis 目录> --version <版本号>');
    return 2;
  }
  if (pkgDir) {
    const problems = checkPackage(envName, readdirSync(pkgDir), pkgVersion);
    if (problems.length) {
      console.error(`NSIS 安装包和这次的版本对不上（工作流审查 M2）：${problems.join('；')}`);
      return 1;
    }
    console.error(`安装包核对通过（${envName}）：原名就是“产品名_${pkgVersion}_x64-setup.exe”`);
    console.log(setupName(envName, pkgVersion));
    return 0;
  }
  const envs = parseEnvRs(readFileSync(join(SRC_TAURI, 'src', 'env.rs'), 'utf8'));
  if (latestPath) {
    const version = builtVersion(envName);
    const files = readdirSync(dirname(resolve(latestPath)));
    const problems = checkLatest(JSON.parse(readFileSync(latestPath, 'utf8')), envs[envName], { version, files });
    if (problems.length) {
      console.error(`latest.json 和 env.rs 的 ${envName}、这次编译的版本或要上传的安装包对不上（安全审查 S-3）：${problems.join('；')}`);
      return 1;
    }
    console.log(`latest.json 核对通过（${envName}）：下载地址和 env.rs 的 update_url 同源、同目录，版本 ${version} 和编译配置一致，文件名就是要上传的安装包`);
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
