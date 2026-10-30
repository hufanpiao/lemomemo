// account 函数 export 的单元测试之四：内存探针和分片响应（架构 0.47 第 21 条；安全审查 K1、K2）。
//   探针要 EXPORT_MEM_PROBE=1 且本机才开，线上误设记 mem_probe_ignored；日志只有 export_mem_peak / export_mem_start 的整数 MB 和片序号；
//   没开探针时不打；每片的 Content-Length 等于实际字节数，各片照样能解开。
import { describe, expect, it } from 'vitest';
import { memProbeFor, newWorkerId } from '../../supabase/functions/account/core.ts';
import { PREVIEW_REF } from '../../supabase/functions/_shared/env-kind.ts';
import { A, accountSetup as setup } from './account-fakes.ts';
import { gunzip, NEXT, part, start, uid } from './account-export-harness.ts';

const MB = 1024 * 1024;
const todos = (n: number, width: number) => Array.from({ length: n }, (_, i) => ({ id: uid('33333333', i), user_id: A, title: 'x'.repeat(width) }));

describe('memProbeFor（K1：两个条件同时满足才开）', () => {
  const read = () => ({ heap: 1, total: 2 });
  it.each([
    ['没设', undefined, 'http://kong:8000'],
    ['值不是 1', 'true', 'http://127.0.0.1:54321'],
  ])('%s：不开、不记日志', (_n, flag, url) => {
    const logs: string[] = [];
    let made = 0;
    expect(memProbeFor(flag, url, read, (c) => logs.push(c), () => { made += 1; return 'x'; })).toBeUndefined();
    expect(logs).toEqual([]);
    expect(made).toBe(0);   // 不开不生成 worker 标识
  });
  it.each(['http://kong:8000', 'http://127.0.0.1:54321', 'http://localhost:54321'])('本机（%s）且 =1：开，带上 worker 标识', (url) => {
    const p = memProbeFor('1', url, read);
    expect(p?.read).toBe(read);
    expect(p?.w).toMatch(/^[0-9a-f]{12}$/);
  });
  it.each([
    ['预览', `https://${PREVIEW_REF}.supabase.co`],
    ['正式', 'https://uvlnwawwsdfihziaielj.supabase.co'],
    ['拿不准', undefined],
    ['像本机但多一截', 'http://localhost.evil.com'],
  ])('%s 误设 =1：不开，只记一次 mem_probe_ignored', (_n, url) => {
    const logs: string[] = [];
    let made = 0;
    expect(memProbeFor('1', url, read, (c) => logs.push(c), () => { made += 1; return 'x'; })).toBeUndefined();
    expect(logs).toEqual(['mem_probe_ignored']);
    expect(made).toBe(0);   // 线上不生成 worker 标识
  });
});

describe('newWorkerId（安全审查：随机、8～16 位十六进制）', () => {
  it('12 位小写十六进制，每次不同；不含进程号、时间戳', () => {
    const ids = Array.from({ length: 200 }, () => newWorkerId());
    for (const w of ids) expect(w).toMatch(/^[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(ids.length);
    const now = Date.now().toString(16);
    for (const w of ids) {
      expect(w).not.toContain(String(process.pid));
      expect(w).not.toContain(now.slice(0, 8));
    }
  });
});

/** 取完所有片；返回每片的响应（字节已读出）和日志 */
async function runAll(over: Record<string, unknown>) {
  const { db, box } = setup();
  db.tables.set('todos', todos(300, 400));
  const logs: string[] = [];
  const s = await start(db, box, {}, { log: (c: string) => logs.push(c), ...over });
  const { export_id: id } = (await s.json()) as { export_id: string };
  const parts: { len: string | null; bytes: Uint8Array }[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await part(db, box, id, cursor, { log: (c: string) => logs.push(c), ...over });
    expect(r.status).toBe(200);
    parts.push({ len: r.headers.get('content-length'), bytes: new Uint8Array(await r.arrayBuffer()) });
    const next = r.headers.get(NEXT) ?? '';
    if (next === 'done') break;
    cursor = next;
  }
  return { parts, logs, id };
}

describe('account export part：内存探针日志（0.47 第 21 条、K1）', () => {
  it('开了探针：每片两行，只有整数 MB、片序号和 worker 标识；峰值取各次采样的最大值', async () => {
    let n = 0;
    const probe = () => { n += 1; return { heap: 20 * MB, total: (30 + n) * MB }; };   // 每采一次涨 1 MB
    const { parts, logs, id } = await runAll({ memProbe: { read: probe, w: '0a1b2c3d4e5f' }, exportLimits: { partRawBytes: 40_000 } });
    expect(parts.length).toBeGreaterThan(2);
    const mem = logs.filter((l) => l.startsWith('export_mem_'));
    expect(mem).toHaveLength(parts.length * 2);
    for (const l of mem) expect(l).toMatch(/^export_mem_(peak|start) mb=\d+ part=\d+ w=0a1b2c3d4e5f$/);
    expect(mem.filter((l) => l.startsWith('export_mem_peak')).map((l) => Number(/part=(\d+)/.exec(l)?.[1]))).toEqual(parts.map((_p, i) => i + 1));
    for (const l of mem.filter((x) => x.startsWith('export_mem_start'))) expect(l).toMatch(/^export_mem_start mb=20 /);
    // 峰值是这一片里最后一次采样（每次 +1 MB，最后最大），比第一次采样大：说明每页、收尾前、返回前都采了
    const peaks = mem.filter((l) => l.startsWith('export_mem_peak')).map((l) => Number(/mb=(\d+)/.exec(l)?.[1]));
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]).toBeGreaterThan(peaks[i - 1] ?? 0);
    // 不带 user_id、export_id
    expect(mem.join('\n')).not.toContain(A);
    expect(mem.join('\n')).not.toContain(id);
  });

  it('没开探针：不打 export_mem_ 日志', async () => {
    const { logs } = await runAll({ exportLimits: { partRawBytes: 40_000 } });
    expect(logs.filter((l) => l.startsWith('export_mem_'))).toEqual([]);
  });
});

describe('account export part：响应按块发出（0.47 第 21 条、K2）', () => {
  it('每片 Content-Length 等于实际字节数；每片单独能解开，拼起来是完整文件', async () => {
    const { parts } = await runAll({ exportLimits: { partRawBytes: 40_000 } });
    expect(parts.length).toBeGreaterThan(2);
    let text = '';
    for (const p of parts) {
      expect(p.len).toBe(String(p.bytes.byteLength));
      text += await gunzip(p.bytes);
    }
    const doc = JSON.parse(text) as { tables: { todos: unknown[] } };
    expect(doc.tables.todos).toHaveLength(300);
  });
});
