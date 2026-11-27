// 服务器函数部署前查 npm 漂移（架构 0.33 第 7 条，方案 C；验收清单 D2、接手清单 P-deno-lock）。
// 背景（10-31 实测）：supabase functions deploy --use-api 只上传源码，不上传 deno.lock，服务器端打包按源码里的
//   npm:包@版本 自己去 npm 取包。直接依赖写的是精确版本，不会变；间接依赖按父包 package.json 里的范围取范围内最高版，
//   例如 @supabase/storage-js@2.118.0 → iceberg-js ^0.8.1：npm 上一出 0.8.2，线上打进去的就是 0.8.2，和锁里核过的 0.8.1 不同。
// 这里在部署前把“线上打包现在会取到的版本”算一遍，和锁里的逐个比：
//   直接依赖（deno.lock 的 specifiers）：范围就是 deno.json 写的精确版本；
//   间接依赖（deno.lock 的 npm.<包@版本>.dependencies，v5 只记名字）：范围取父包这个版本在 npm 上的 dependencies（含 optionalDependencies）。
//   每条“谁引用它、范围”算一次 npm 上范围内最高的正式版（不含预发布），和锁里的版本不一样就列出来，退出码 1。
//   没标 optional 的 peerDependencies 一起比；标了 optional 的不比（Deno 不装，锁里也没有，例如 supabase-js 的 @opentelemetry/api）。
//   npm 上写了、锁里没有的依赖（含可选依赖、非可选 peer）一律判失败，不静默跳过。
//   标了 deprecated 的版本照样算：打包取不取它不确定，宁可多报。
// 另外这些情况也判失败、不放行：锁格式不是 v5、锁里的版本 npm 上没有、锁和 npm 上的依赖名单对不上、
//   范围写法不认识（只认 x.y.z、^、~、x / *、>= > <= <、空格并列、||、A - B，运算符后可带空格；带预发布的范围、单独的运算符不认）、
//   取元数据超时或出错（只发 GET，缩略元数据 Accept: application/vnd.npm.install-v1+json，每个包一次，15 秒超时，不重试）。
// 发现漂移时不要改锁了事：先看新版本的改动，再决定把父包升到写死新版本的那一版，或者接受后重新生成锁（两种都要评审）。
// 只读：不写任何文件。只用 Node 自带的 fetch，不依赖 node_modules（部署任务不装项目依赖）。
//
// 用法：node build/ci/check_deno_drift.mjs [--lock <deno.lock 路径>] [--registry <地址>]
//   默认锁 supabase/functions/deno.lock、registry https://registry.npmjs.org
// 退出码：0 全部一致；1 有漂移或查不了。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_LOCK = resolve(ROOT, 'supabase/functions/deno.lock');
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 15_000;
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

// ---------- 版本范围（只实现 npm 范围里我们用得到的那部分；不认识的写法抛错，调用处判失败） ----------

/** 正式版 → [主, 次, 补丁]；预发布、带构建号的返回 null（不参与比较） */
export function parseStable(v) {
  const m = STABLE.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
/** 第 i 位加一、后面清零（i = -1 表示“没有上界”） */
const bump = (t, i) => (i < 0 ? null : t.map((x, j) => (j < i ? x : j === i ? x + 1 : 0)));

/** "1"、"1.2"、"1.x"、"1.2.3"、"*" → { t: 补零后的三位, k: 写明了几位 }；带预发布或不是数字就抛错 */
function partial(s, range) {
  if (s === '' || s === '*' || s === 'x' || s === 'X') return { t: [0, 0, 0], k: 0 };
  const parts = s.split('.');
  if (parts.length > 3) throw new Error(`不认识的范围：${range}`);
  const t = [0, 0, 0];
  let k = 0;
  for (const p of parts) {
    if (p === 'x' || p === 'X' || p === '*') break;
    if (!/^\d+$/.test(p)) throw new Error(`不认识的范围（不支持预发布或别的写法）：${range}`);
    t[k++] = Number(p);
  }
  return { t, k };
}

/** 一个比较项 → 区间 [lo, hi)（lo 含、hi 不含；null 表示没有这一边的界） */
function comparator(c, range) {
  const m = /^(\^|~|>=|<=|>|<|=)?v?(.*)$/.exec(c);
  const op = m?.[1] ?? '';
  if (op !== '' && (m?.[2] ?? '') === '') throw new Error(`不认识的范围（运算符后面没有版本）：${range}`);
  const { t, k } = partial(m?.[2] ?? '', range);
  switch (op) {
    case '':
    case '=':
      return { lo: t, hi: bump(t, k - 1) };
    case '>=':
      return { lo: t, hi: null };
    case '>':
      return k === 0 ? { lo: [Infinity, 0, 0], hi: null } : { lo: bump(t, k - 1), hi: null };
    case '<':
      return { lo: null, hi: t };
    case '<=':
      return { lo: null, hi: bump(t, k - 1) };
    case '~':
      return { lo: t, hi: bump(t, k <= 1 ? k - 1 : 1) };
    case '^': {
      // 最左边第一个非零位加一；写明的位全是 0 时按写明的最后一位加一（^0.0 → <0.1.0，^0.0.3 → <0.0.4）
      const first = t.slice(0, Math.max(k, 1)).findIndex((x) => x !== 0);
      return { lo: t, hi: bump(t, first >= 0 ? first : k - 1) };
    }
    default:
      throw new Error(`不认识的范围：${range}`);
  }
}

/** 整个范围 → 若干个区间（|| 分开的每一组，组内各项取交集） */
export function parseRange(range) {
  const r = range.trim();
  return r.split('||').map((set) => {
    const s = set.trim();
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (hy) {
      const a = partial(hy[1] ?? '', range);
      const b = partial(hy[2] ?? '', range);
      return { lo: a.t, hi: b.k === 3 ? bump(b.t, 2) : bump(b.t, b.k - 1) };
    }
    let lo = null;
    let hi = null;
    // 运算符和版本之间允许有空格（npm semver 认 “>= 1.2.3”、“^ 1.2.3”）：先粘起来再按空白切，
    // 否则 “>=” 单独成一项、范围变窄，会漏报（安全审查 M1）；粘完还单独剩下的运算符在 comparator 里抛错
    const glued = s.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1');
    for (const c of glued === '' ? [''] : glued.split(/\s+/)) {
      const iv = comparator(c, range);
      if (iv.lo && (!lo || cmp(iv.lo, lo) > 0)) lo = iv.lo;
      if (iv.hi && (!hi || cmp(iv.hi, hi) < 0)) hi = iv.hi;
    }
    return { lo, hi };
  });
}

/** 版本列表里落在范围内的最高正式版；一个都没有返回 undefined */
export function maxSatisfying(versions, range) {
  const sets = parseRange(range);
  let best;
  for (const v of versions) {
    const t = parseStable(v);
    if (!t) continue;
    const ok = sets.some(({ lo, hi }) => (!lo || cmp(t, lo) >= 0) && (!hi || cmp(t, hi) < 0));
    if (ok && (!best || cmp(t, best.t) > 0)) best = { v, t };
  }
  return best?.v;
}

// ---------- 读锁 ----------

/** "name@1.2.3" 或 "@scope/name@1.2.3_peer@x"（Deno 给带 peer 的包加后缀）→ { name, version } */
function splitKey(key) {
  const i = key.indexOf('@', 1);
  if (i < 0) throw new Error(`读不懂锁里的包名：${key}`);
  return { name: key.slice(0, i), version: key.slice(i + 1).split('_')[0] ?? '' };
}

/** 纯函数：deno.lock 文本 → 直接依赖和每个包的依赖名单 */
export function parseLock(text) {
  const lock = JSON.parse(text);
  if (lock.version !== '5') throw new Error(`deno.lock 的 version 是 ${JSON.stringify(lock.version)}，这里只认 "5"（Deno 换了锁格式，先更新本脚本）`);
  const pkgs = new Map();
  for (const [key, val] of Object.entries(lock.npm ?? {})) {
    const { name, version } = splitKey(key);
    pkgs.set(key, { key, name, version, deps: Array.isArray(val?.dependencies) ? val.dependencies : [] });
  }
  const direct = [];
  for (const [spec, resolved] of Object.entries(lock.specifiers ?? {})) {
    if (!spec.startsWith('npm:')) throw new Error(`锁里有 npm 以外的依赖：${spec}（服务器函数只准用 npm:，见 deno.json 的 $comment）`);
    const { name, version: range } = splitKey(spec.slice(4));
    direct.push({ name, range, locked: String(resolved).split('_')[0], by: 'deno.json' });
  }
  return { direct, pkgs };
}

/** 锁里一个依赖条目（"name" 或 "name@版本"）→ 锁里对应的包 */
function lockedChild(entry, pkgs) {
  const hit = pkgs.get(entry);
  if (hit) return hit;
  const same = [...pkgs.values()].filter((p) => p.name === entry);
  if (same.length !== 1) throw new Error(`锁里的依赖 ${entry} 对不上唯一的包（找到 ${same.length} 个）`);
  return same[0];
}

// ---------- 和 npm 比 ----------

/** 默认取元数据：缩略文档，超时或非 200 抛错 */
export function registryFetcher(registry = DEFAULT_REGISTRY, fetchImpl = fetch) {
  return async (name) => {
    const url = `${registry.replace(/\/+$/, '')}/${name.replace('/', '%2f')}`;
    let res;
    try {
      res = await fetchImpl(url, { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new Error(`取 ${name} 的元数据失败：${url}（${e instanceof Error ? e.message : String(e)}）`);
    }
    if (!res.ok) throw new Error(`取 ${name} 的元数据失败：${url} 回 HTTP ${res.status}`);
    const doc = await res.json();
    if (!doc || typeof doc.versions !== 'object' || doc.versions === null) throw new Error(`${name} 的元数据里没有 versions：${url}`);
    return doc;
  };
}

/**
 * 核心：lockText 是 deno.lock 的内容，fetchDoc(name) 返回 npm 缩略元数据。
 * 返回 { drifts: [{ name, range, locked, latest, by }], problems: [文字] }；两者都空才算通过
 */
export async function checkDrift(lockText, fetchDoc) {
  const { direct, pkgs } = parseLock(lockText);
  const names = [...new Set([...direct.map((d) => d.name), ...[...pkgs.values()].map((p) => p.name)])].sort();
  const docs = new Map();
  const problems = [];
  // 同时取，任何一个失败都记下（不放行）
  await Promise.all(names.map(async (n) => {
    try { docs.set(n, await fetchDoc(n)); } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
  }));
  if (problems.length > 0) return { drifts: [], problems: problems.sort() };

  const edges = [...direct];
  for (const p of pkgs.values()) {
    const meta = docs.get(p.name)?.versions?.[p.version];
    if (!meta) { problems.push(`锁里的 ${p.key} 在 npm 上没有这个版本`); continue; }
    // 要比的范围：dependencies、optionalDependencies，加上没标 optional 的 peerDependencies（安全审查 S1）。
    // 标了 optional 的 peer（peerDependenciesMeta.<名>.optional）不装、不比，例如 supabase-js 的 @opentelemetry/api
    const peers = Object.fromEntries(Object.entries(meta.peerDependencies ?? {}).filter(([n]) => meta.peerDependenciesMeta?.[n]?.optional !== true));
    const want = { ...peers, ...(meta.dependencies ?? {}), ...(meta.optionalDependencies ?? {}) };
    const seen = new Set();
    for (const entry of p.deps) {
      let child;
      try { child = lockedChild(entry, pkgs); } catch (e) { problems.push(`${p.key}：${e instanceof Error ? e.message : String(e)}`); continue; }
      seen.add(child.name);
      const range = want[child.name];
      if (range === undefined) { problems.push(`锁里记着 ${p.key} 依赖 ${child.name}，npm 上 ${p.key} 的 package.json 没写`); continue; }
      edges.push({ name: child.name, range, locked: child.version, by: p.key });
    }
    for (const n of Object.keys(want)) {
      // 可选依赖锁里没有也判失败（不静默跳过）：服务器端打包可能装上它，而锁里没核过
      if (!seen.has(n)) problems.push(`npm 上 ${p.key} 依赖 ${n}@${want[n]}，锁里没有这一条（锁和 npm 对不上，重新生成锁再评审）`);
    }
  }

  const drifts = [];
  for (const e of edges) {
    const versions = Object.keys(docs.get(e.name)?.versions ?? {});
    let latest;
    try { latest = maxSatisfying(versions, e.range); } catch (err) { problems.push(`${e.by} → ${e.name}：${err instanceof Error ? err.message : String(err)}`); continue; }
    if (!latest) { problems.push(`${e.by} → ${e.name}@${e.range}：npm 上范围内一个正式版都没有`); continue; }
    if (latest !== e.locked) drifts.push({ ...e, latest });
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  drifts.sort((a, b) => order(a.name, b.name) || order(a.by, b.by));
  return { drifts, problems: problems.sort() };
}

/** 把结果写成给人看的几行 */
export function report({ drifts, problems }, edgesChecked) {
  const out = [];
  for (const d of drifts) out.push(`漂移：${d.name}，范围 ${d.range}（${d.by} 引用），锁里 ${d.locked}，npm 范围内最高 ${d.latest}`);
  for (const p of problems) out.push(`查不了：${p}`);
  if (out.length === 0) out.push(`npm 漂移检查通过：锁里的版本就是线上打包现在会取到的版本${edgesChecked ? `（${edgesChecked} 个包）` : ''}`);
  return out;
}

async function main(argv) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const lockPath = resolve(arg('--lock') ?? DEFAULT_LOCK);
  const registry = arg('--registry') ?? DEFAULT_REGISTRY;
  let result;
  let text;
  try {
    text = readFileSync(lockPath, 'utf8');
    result = await checkDrift(text, registryFetcher(registry));
  } catch (e) {
    console.error(`查不了：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const lines = report(result, parseLock(text).pkgs.size);
  const bad = result.drifts.length + result.problems.length > 0;
  for (const l of lines) (bad ? console.error : console.log)(l);
  if (bad) console.error('部署前 npm 漂移检查没通过：线上打包不读 deno.lock，会取到和锁里不同的包（架构 0.33 第 7 条）。看清新版本的改动再定怎么处理，不要只改锁了事');
  return bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
