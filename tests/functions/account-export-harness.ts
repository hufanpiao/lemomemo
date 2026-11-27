// account export 两步（start、part）测试共用的小工具（架构 0.47 续 ①）：按清单挑表、造 uuid、开始一次导出、一片一片取完再拼起来解开。
// 用 account-fakes.ts 的内存库；只经 core.ts 的 handle 调，和客户端一样。
import { exportTablesOf, handle } from '../../supabase/functions/account/core.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { accountDeps, accountReq, type FakeDb, type Outbox } from './account-fakes.ts';

export const TABLES = exportTablesOf(allManifests);
export const NEXT = 'x-lemo-export-next';

/** 第 i 个 uuid（前缀 8 位十六进制区分表），按 i 排序和按字符串排序一致 */
export function uid(prefix: string, i: number): string {
  return `${prefix}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
}

type Over = Parameters<typeof accountDeps>[2];

/** 调一次 handle（deps 的 exportTables 默认按清单），等后台的事做完 */
export async function call(db: FakeDb, box: Outbox[], body: Record<string, unknown>, over: Over = {}, headers: Record<string, string> = {}): Promise<Response> {
  const deps = accountDeps(db, box, { exportTables: TABLES, ...over });
  const r = await handle(accountReq(body, headers), deps);
  await Promise.all(deps.bg);
  return r;
}

export async function start(db: FakeDb, box: Outbox[], body: Record<string, unknown> = {}, over: Over = {}, headers: Record<string, string> = {}) {
  return call(db, box, { action: 'export', step: 'start', ...body }, over, headers);
}

export async function part(db: FakeDb, box: Outbox[], exportId: string, cursor: unknown, over: Over = {}, headers: Record<string, string> = {}) {
  return call(db, box, { action: 'export', step: 'part', export_id: exportId, cursor }, over, headers);
}

/**
 * 解开一片（一个 gzip 成员）。整份文件是各片首尾相接的多成员 gzip，按 RFC 1952 等于各片原文首尾相接，所以整份 = 各片原文拼起来。
 * 不在这里用 DecompressionStream 解整份：Node 的实现遇到第二个成员报 “Trailing junk found after the end of the compressed stream”
 * （多成员拼接用 Node zlib 解的核对在 tests/build/export-size-tables.test.ts）
 */
export async function gunzip(bytes: Uint8Array): Promise<string> {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).text();
}

export interface Run {
  exportId: string; exportedAt: string; parts: Uint8Array[]; raws: string[]; doc: Record<string, unknown>; cursors: string[];
}

/** 开始一次导出，一片一片取到 done；每片单独解开，原文拼起来就是整份 */
export async function runExport(db: FakeDb, box: Outbox[], over: Over = {}, headers: Record<string, string> = {}, maxParts = 500): Promise<Run> {
  const s = await start(db, box, {}, over, headers);
  if (s.status !== 200) throw new Error(`start ${s.status} ${await s.text()}`);
  const { export_id: exportId, exported_at: exportedAt } = (await s.json()) as { export_id: string; exported_at: string };
  const parts: Uint8Array[] = [];
  const raws: string[] = [];
  const cursors: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxParts; i++) {
    const r = await part(db, box, exportId, cursor, over, headers);
    if (r.status !== 200) throw new Error(`part ${i} ${r.status} ${await r.text()}`);
    const b = new Uint8Array(await r.arrayBuffer());
    parts.push(b);
    raws.push(await gunzip(b));   // 每一片单独也是完整的 gzip 成员
    const next = r.headers.get(NEXT) ?? '';
    cursors.push(next);
    if (next === 'done') return { exportId, exportedAt, parts, raws, cursors, doc: JSON.parse(raws.join('')) as Record<string, unknown> };
    cursor = next;
  }
  throw new Error('too_many_parts');
}

export const tablesOf = (doc: Record<string, unknown>) => doc.tables as Record<string, Record<string, unknown>[]>;
