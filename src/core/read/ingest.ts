// 宽容读取的落库一半（架构 0.27 第 1 点；数据字典 10.3“待补拉列表”）：K8 的拉取、Realtime、补拉都经这里写进本机缓存
// readRows（纯函数）→ outbox.applyServer（更新 server、rebase 出 view、带上 ro）→ 维护 meta 的 refetch:<表> → 写日志
// • 解析不了的行：id 记进 refetch:<表>（下次启动 boot.ts 交给 K8 单独补拉），日志只记表名、列名、错误码和 id，不记内容
// • 解析成功的行：如果在待补拉列表里，顺手去掉
// • 隐私记行（含判断不了的）解析不了时：本机这一行换成只读空壳（只有 id 和 flag 列），明文立即清掉，再进待补拉（R-229）
// • 任何一步抛 CacheClosedError（换账号、被移除、别的标签页升级本机库）都原样抛出，调用方照 outbox-types.ts 的约定直接停下
// 纯 TS：不准 import React 和任何功能（A1）
import type { Cache } from '../cache.ts';
import { META } from '../cache-schema.ts';
import type { Manifest } from '../manifest.ts';
import type { Outbox } from '../outbox-types.ts';
import { readRows, type ReadBatch, type ReadLog } from './lenient.ts';

/** 每张表的待补拉列表最多记这么多（超过的丢掉最早的，免得一直解析不了的行把 meta 撑大） */
export const MAX_REFETCH = 500;

export interface IngestDeps {
  cache: Cache;
  outbox: Pick<Outbox, 'applyServer'>;
  /** 写一条 logs（act = row_unknown）；不传就不记 */
  log?: (e: ReadLog) => void;
  /** 测试用 */
  manifests?: readonly Manifest[];
}

const refetchKey = (table: string): `refetch:${string}` => `refetch:${table}`;

/**
 * 改某张表的待补拉列表（一个 meta 事务里读改写，拉取和 Realtime 同时到也不会互相覆盖）：
 * 先去掉 remove，再把 add 里还没有的追加到末尾；空了就删键
 */
export async function updateRefetch(
  cache: Cache,
  table: string,
  add: readonly string[],
  remove: readonly string[] = [],
): Promise<readonly string[]> {
  const key = refetchKey(table);
  // 先只读看一眼：没有要改的就不开读写事务（每次拉取都会调，平时待补拉是空的）
  const before = asIds(await cache.getMeta(key));
  const changes = remove.some((id) => before.includes(id)) || add.some((id) => !before.includes(id));
  if (!changes) return before;
  return cache.tx([META], 'readwrite', async (t) => {
    // 读写事务里重新读一次：两次之间别的拉取、Realtime 可能改过
    const rec = await t.get<{ key: string; value: unknown }>(META, key);
    const old = asIds(rec?.value);
    const gone = new Set(remove);
    const next = old.filter((id) => !gone.has(id));
    for (const id of add) if (!next.includes(id)) next.push(id);
    const capped = next.length > MAX_REFETCH ? next.slice(next.length - MAX_REFETCH) : next;
    if (capped.length === 0) {
      if (rec) await t.delete(META, key);
    } else if (capped.length !== old.length || capped.some((id, i) => id !== old[i]) || !Array.isArray(rec?.value)) {
      await t.put(META, { key, value: capped });
    }
    return capped;
  });
}

/** meta 里读到的待补拉列表：不是字符串数组（旧格式、被写坏）按空处理，只留字符串 */
function asIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * K8 补拉时，服务器已经没有的行（硬删、30 天清理）：从待补拉列表去掉，不然每次启动都去拉
 */
export function clearRefetch(cache: Cache, table: string, ids: readonly string[]): Promise<readonly string[]> {
  return updateRefetch(cache, table, [], ids);
}

/**
 * 服务器来的一批原始行（PostgREST 的 select、Realtime 的 new、补拉）→ 宽容读取 → 写进本机缓存。
 * 返回读取结果（只读行、丢掉的行），K8 可以据此统计；表不认识时整批跳过（记一条日志），不抛错
 */
export async function ingestServerRows(deps: IngestDeps, table: string, raw: readonly unknown[]): Promise<ReadBatch> {
  const batch = readRows(table, raw, deps.manifests);
  // applyServer 没收的行（K6，同一读写事务里判断）：比本机旧、不高于空壳门槛 shell_rev、
  // 以及本机原来没有这一行的 R-229 空壳（不建空壳，只进待补拉、记日志）。这些这次不算读成功，不从待补拉去掉
  const skipped = new Set(batch.rows.length ? ((await deps.outbox.applyServer(table, batch.rows))?.skipped ?? []) : []);
  if (skipped.size) batch.readonlyIds = batch.readonlyIds.filter((id) => !skipped.has(id));
  const add = batch.dropped.flatMap((d) => (d.id === null ? [] : [d.id]));
  // 隐私记行的只读空壳（R-229）也在 rows 里，但它这次没读成功，不能从待补拉去掉
  const remove = batch.rows.map((r) => r.row.id).filter((id) => !add.includes(id) && !skipped.has(id));
  await updateRefetch(deps.cache, table, add, remove);   // 没有要改的只做一次只读查询
  if (deps.log) for (const e of batch.logs) deps.log(e);
  return batch;
}
