// export-full-account.mjs 的共用部分（架构 0.47 续 ⑤）：按两步协议跑一次导出（start → 一片一片取到 done），逐片记大小和耗时，
// 最后把各片首尾相接、用 Node zlib 整份解开、解析，数每张表的行数。本机和预览两种跑法都用它。
// 只打印条数、字节数、毫秒数和错误码：不打印任何行内容、响应体、令牌（M4 第 3 条）。
/* global fetch -- Node 24 的全局 */
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';

export const NEXT = 'x-lemo-export-next';
/** 数据清单里 export: json 的表（和迁移 20261031100000 的 export_size_over、account 的 exportTablesOf 一致） */
export const EXPORT_TABLES = ['profiles', 'settings', 'devices', 'logs', 'events', 'todos', 'categories', 'notes', 'note_images', 'note_files', 'anniversaries'];

/** 错误回包只取 error 码（不带别的字段，免得把内容打出来） */
async function errCode(res) {
  try {
    const j = JSON.parse(await res.text());
    return typeof j?.error === 'string' && /^[a-z_]{1,40}$/.test(j.error) ? j.error : '?';
  } catch {
    return '?';
  }
}

/**
 * 跑一次导出。fnUrl：account 函数地址；headers：鉴权头（只在内存里）；hooks.beforePart/afterPart 给本机量 CPU、内存用；hooks.fetch 给单测换替身（默认全局 fetch）。
 * 返回 { start: {status, ms, code?}, exportId?, exportedAt?, parts: [{status, ms, gzBytes, rawBytes, code?}], doc?, rows?, totalGz, totalRaw, error? }
 */
export async function runExport(fnUrl, headers, hooks = {}, maxCalls = 60) {
  const f = hooks.fetch ?? fetch;
  const call = (body) => f(fnUrl, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = { start: {}, parts: [], totalGz: 0, totalRaw: 0 };
  let t = performance.now();
  const s = await call({ action: 'export', step: 'start' });
  out.start = { status: s.status, ms: Math.round(performance.now() - t) };
  if (s.status !== 200) {
    out.start.code = await errCode(s);
    return out;
  }
  const sb = await s.json();
  out.exportId = sb.export_id;
  out.exportedAt = sb.exported_at;
  out.startKeys = Object.keys(sb).sort().join(',');
  const bufs = [];
  let cursor = null;
  for (let i = 0; i < maxCalls; i++) {
    await hooks.beforePart?.(i);
    t = performance.now();
    const r = await call({ action: 'export', step: 'part', export_id: out.exportId, cursor });
    const p = { status: r.status, ms: 0 };
    if (r.status !== 200) {
      p.code = await errCode(r);
      p.ms = Math.round(performance.now() - t);
      out.parts.push(p);
      out.error = `part ${i + 1}：HTTP ${r.status} ${p.code}`;
      return out;
    }
    const b = Buffer.from(await r.arrayBuffer());
    p.ms = Math.round(performance.now() - t);
    p.contentEncoding = r.headers.get('content-encoding');
    p.gzBytes = b.length;
    p.rawBytes = gunzipSync(b).length;   // 每片单独也是完整的 gzip 成员
    Object.assign(p, (await hooks.afterPart?.(i)) ?? {});
    out.parts.push(p);
    bufs.push(b);
    const next = r.headers.get(NEXT) ?? '';
    p.cursorBytes = next.length;
    if (next === 'done') break;
    if (!next || next.length > 512) {
      out.error = `part ${i + 1}：游标头不对（长度 ${next.length}）`;
      return out;
    }
    cursor = next;
    if (i === maxCalls - 1) out.error = `取了 ${maxCalls} 片还没完`;
  }
  if (out.error) return out;
  const all = Buffer.concat(bufs);
  out.totalGz = all.length;
  out.gzFile = all;   // 多成员原样（--save-gz 存盘给别的解压工具核对，TC-B1-129）
  const raw = gunzipSync(all);   // 多成员整份解开（Node zlib）
  out.totalRaw = raw.length;
  const doc = JSON.parse(raw.toString('utf8'));
  out.head = { format: doc.format, version: doc.version, vault: doc.vault, exportedAtMatches: doc.exported_at === out.exportedAt };
  out.rows = Object.fromEntries(Object.entries(doc.tables).map(([k, v]) => [k, v.length]));
  out.userIdMatches = (uid) => doc.user_id === uid && Object.values(doc.tables).flat().every((x) => x.user_id === uid);
  return out;
}

/** 汇总一次导出的数字（打印用，不含内容） */
export function summary(r) {
  const parts = r.parts.filter((p) => p.status === 200);
  const max = (k) => Math.max(0, ...parts.map((p) => p[k] ?? 0));
  return {
    start: r.start, startKeys: r.startKeys, parts: r.parts.length, error: r.error ?? null,
    rawMB: +(r.totalRaw / 1048576).toFixed(1), gzMB: +(r.totalGz / 1048576).toFixed(1), ratio: r.totalGz ? +(r.totalRaw / r.totalGz).toFixed(2) : null,
    partMaxRawMB: +(max('rawBytes') / 1048576).toFixed(2), partMaxGzMB: +(max('gzBytes') / 1048576).toFixed(2), partMaxMs: max('ms'),
    partMaxCpuMs: parts.some((p) => p.cpuMs !== undefined) ? max('cpuMs') : null,
    // 内存（架构 0.47 第 21 条）：单次调用峰值取探针（heapUsed + external）；容器 cgroup 只记这一片期间的增量，作参考
    partMaxProbeMB: parts.some((p) => p.probePeakMB !== undefined) ? max('probePeakMB') : null,
    partMaxCgDeltaMB: parts.some((p) => p.cgDeltaMB !== undefined) ? max('cgDeltaMB') : null,
    contentEncoding: [...new Set(parts.map((p) => p.contentEncoding ?? null))], cursorMaxBytes: max('cursorBytes'),
    head: r.head ?? null, rows: r.rows ?? null,
    // 每片：[状态, 墙钟 ms, 原文 MB, gzip MB, 容器 CPU ms, 探针峰值 MB, 这一片开始时 heapUsed MB, 容器内存增量 MB]
    perPart: r.parts.map((p) => [p.status, p.ms, +((p.rawBytes ?? 0) / 1048576).toFixed(2), +((p.gzBytes ?? 0) / 1048576).toFixed(2), p.cpuMs ?? null,
      p.probePeakMB ?? null, p.probeStartMB ?? null, p.cgDeltaMB ?? null]),
  };
}

/** 常用区段的随机汉字（比真实文字更难压缩，gzip 比偏保守） */
export function zh(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(19968 + Math.floor(Math.random() * 3000));
  return s;
}
