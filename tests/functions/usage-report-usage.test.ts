// usage-report {part: "usage"} 的单元测试（B7a：架构 3.4 用量盯防、6.1 第二条；B0-R2 任务单 R2 提醒线）。
// 只测 core.ts、usage.ts、r2-ops.ts（index.ts 只是把 supabase-js、R2、Cloudflare 接上），读取由假对象代替。
import { describe, expect, it, vi } from 'vitest';
import { handle, type Deps, type UsageDb } from '../../supabase/functions/usage-report/core.ts';
import { EXPORT_PART_DAILY_LIMIT, LIMITS, exportDays, pctOf, type UsageSources } from '../../supabase/functions/usage-report/usage.ts';
import { backupDate as seoulDate } from '../../supabase/functions/_shared/backup-format.ts';
import { CF_GRAPHQL_URL, monthStart, readR2Ops, readR2Storage, STORAGE_LOOKBACK_MS, sumOps, sumStorage } from '../../supabase/functions/usage-report/r2-ops.ts';
import { EXPORT_LIMITS } from '../../supabase/functions/account/common.ts';
import { USAGE_LINES, parseUsageItems } from '../../workers/lemo-ops/src/rules.ts';

const SECRET = 'test-ops-secret-xxxxxxxxxxxxxxxxxxxxxx';
const NOW = Date.parse('2026-11-27T00:07:00Z');

const db: UsageDb = { heartbeats: async () => [], pendingDeletions: async () => [], longTxCount: async () => 0 };
const STATS = { db_bytes: 250e6, vectors_bytes: 1e6, storage_bytes: '950000000', media_max_pct: 93, media_near_full: 2, export_capped: 1 };

function deps(usage: UsageSources | undefined, over: Partial<Deps> = {}): Deps {
  return { opsSecret: SECRET, db, now: () => NOW, ...(usage ? { usage } : {}), ...over };
}

/** usage.ts 的返回体（测试里只读这几项） */
interface UsageBody {
  items: { key: string; label: string; pct: number }[];
  unreadable: { key: string; label: string }[];
  bytes: unknown;
  [k: string]: unknown;
}
const bodyOf = async (r: Response) => (await r.json()) as UsageBody;

const req = () => new Request('https://x.supabase.co/functions/v1/usage-report', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-ops-secret': SECRET },
  body: JSON.stringify({ part: 'usage' }),
});

describe('usage-report {part: usage}', () => {
  it('没接用量读取时照旧回 501；接了以后鉴权照旧（带错 401，不读）', async () => {
    expect((await handle(req(), deps(undefined))).status).toBe(501);
    const stats = vi.fn();
    const bad = new Request(req(), { headers: { 'x-ops-secret': 'wrong' } });
    expect((await handle(bad, deps({ stats, backupMissing: async () => 0 }))).status).toBe(401);
    expect(stats).not.toHaveBeenCalled();
  });

  it('全读到：items 每项都有数字 pct，lemo-ops 的 parseUsageItems 认得；只回个数和字节，不回 user_id', async () => {
    const stats = vi.fn(async () => STATS);
    const r = await handle(req(), deps({ stats, r2Bytes: async () => 8.5e9, r2Ops: async () => ({ write: 750_000, read: 1_000_000 }), backupMissing: async () => 0 }));
    expect(r.status).toBe(200);
    const body = await bodyOf(r);
    expect(stats).toHaveBeenCalledWith(['20261126', '20261127'], EXPORT_PART_DAILY_LIMIT, expect.any(AbortSignal));
    expect(body.items.map((i) => [i.key, i.pct])).toEqual([
      ['db', 50], ['supabase_storage', 95], ['user_media', 93], ['r2_storage', 85], ['r2_ops_write', 75], ['r2_ops_read', 10],
    ]);
    expect(parseUsageItems(body)).not.toBeNull();
    expect(body).toMatchObject({ ok: true, unreadable: [], media_near_full: 2, export_capped: 1, backup_missing: 0 });
    expect(body.bytes).toEqual({ db: 250e6, vectors: 1e6, supabase_storage: 950e6, r2: 8.5e9 });
    expect(JSON.stringify(body)).not.toMatch(/user_id|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('R2 没配、Cloudflare 令牌没配：不出 r2_* 那几项（不是读不到）', async () => {
    const body = await bodyOf(await handle(req(), deps({ stats: async () => STATS, backupMissing: async () => 0 })));
    expect(body.items.map((i) => i.key)).toEqual(['db', 'supabase_storage', 'user_media']);
    expect(body.unreadable).toEqual([]);
  });

  it('某项出错、超时、数字不对：挪进 unreadable，其余照常 200；日志只记错误码', async () => {
    const log = vi.fn();
    const r = await handle(req(), deps({
      stats: async () => ({ ...STATS, db_bytes: -1 }),
      r2Bytes: () => new Promise(() => {}),
      r2Ops: async () => { throw new Error('token=secret'); },
      backupMissing: async () => 'x',
    }, { log, usageTimeoutMs: 20 }));
    expect(r.status).toBe(200);
    const body = await bodyOf(r);
    expect(body.items).toEqual([]);
    expect(body.unreadable.map((x) => x.key)).toEqual(['db', 'supabase_storage', 'user_media', 'r2_storage', 'r2_ops_write', 'r2_ops_read', 'backup_missing']);
    expect(body).toMatchObject({ media_near_full: null, export_capped: null, backup_missing: null });
    expect(parseUsageItems(body)).toEqual([]);
    expect(log.mock.calls.map((c) => c[0]).sort()).toEqual(['backup_missing:bad_data', 'r2_bytes:timeout', 'r2_ops:error', 'stats:bad_data']);
  });

  it('百分比向下取整，超过 100 照报；提醒线表里有 user_media', () => {
    expect(pctOf(699, 1000)).toBe(69);
    expect(pctOf(LIMITS.r2_bytes * 1.2, LIMITS.r2_bytes)).toBe(120);
    expect(USAGE_LINES['user_media']).toEqual({ warn: 90 });
  });

  it('导出分片上限和 account 的 EXPORT_LIMITS 是同一个数；日期按 UTC 取昨天和今天', () => {
    expect(EXPORT_PART_DAILY_LIMIT).toBe(EXPORT_LIMITS.partDailyLimit);
    expect(exportDays(Date.parse('2026-12-01T00:07:00Z'))).toEqual(['20261130', '20261201']);
  });

  it('B7a 评审第 11 条：backup_missing 按首尔今天查，原样回个数（只是个数）', async () => {
    const backupMissing = vi.fn(async () => 3);
    const body = await bodyOf(await handle(req(), deps({ stats: async () => STATS, backupMissing })));
    expect(backupMissing).toHaveBeenCalledWith('2026-11-27', expect.any(AbortSignal));
    expect(body.backup_missing).toBe(3);
    // UTC 15:00 已是首尔第二天 0 点
    expect(seoulDate(Date.parse('2026-11-26T14:59:59Z'))).toBe('2026-11-26');
    expect(seoulDate(Date.parse('2026-11-26T15:00:00Z'))).toBe('2026-11-27');
  });
});

describe('R2 存储量（Cloudflare GraphQL，B7a 评审第 14 条）', () => {
  const body = (acc: Record<string, unknown>) => ({ data: { viewer: { accounts: [acc] } } });

  it('四个桶各取最近一个快照的 payloadSize + metadataSize 相加；没有快照的桶算 0', () => {
    expect(sumStorage(body({
      b0: [{ max: { payloadSize: 100, metadataSize: 5 } }], b1: [], b2: [{ max: { payloadSize: 7, metadataSize: 0 } }], b3: [],
    }), 4)).toBe(112);
  });

  it('带 errors、少了某个桶、数字不对抛错', () => {
    expect(() => sumStorage({ errors: [{ message: 'x' }] }, 1)).toThrow();
    expect(() => sumStorage(body({ b0: [] }), 2)).toThrow();
    expect(() => sumStorage(body({ b0: [{ max: { payloadSize: '1', metadataSize: 0 } }] }), 1)).toThrow();
  });

  it('请求：每个桶一个别名、按真实桶名过滤；令牌只在请求头；往回看两天；非 2xx 抛错', async () => {
    const calls: [string, RequestInit][] = [];
    const f = async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify(body({ b0: [{ max: { payloadSize: 1, metadataSize: 1 } }], b1: [] })), { status: 200 });
    };
    const ac = new AbortController();
    expect(await readR2Storage(f, 'acc123', 'tok', ['p-images', 'p-files'], NOW, ac.signal)).toBe(2);
    const [url, init] = calls[0]!;
    expect(url).toBe(CF_GRAPHQL_URL);
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    const sent = JSON.parse(String(init.body));
    expect(sent.variables).toEqual({ acc: 'acc123', start: new Date(NOW - STORAGE_LOOKBACK_MS).toISOString(), end: '2026-11-27T00:07:00.000Z', b0: 'p-images', b1: 'p-files' });
    expect(sent.query).toContain('b1: r2StorageAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_leq: $end, bucketName: $b1}, orderBy: [datetime_DESC])');
    expect(String(init.body)).not.toContain('tok');
    await expect(readR2Storage(async () => new Response('', { status: 403 }), 'a', 't', ['x'], NOW, ac.signal)).rejects.toThrow();
  });
});

describe('R2 本月操作次数（Cloudflare GraphQL）', () => {
  const body = (groups: unknown) => ({ data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: groups }] } } });

  it('A 类算写、B 类算读，删除等免费操作不计', () => {
    expect(sumOps(body([
      { sum: { requests: 10 }, dimensions: { actionType: 'PutObject' } },
      { sum: { requests: 5 }, dimensions: { actionType: 'ListObjects' } },
      { sum: { requests: 100 }, dimensions: { actionType: 'GetObject' } },
      { sum: { requests: 7 }, dimensions: { actionType: 'HeadObject' } },
      { sum: { requests: 99 }, dimensions: { actionType: 'DeleteObject' } },
    ]))).toEqual({ write: 15, read: 107 });
  });

  it('带 errors、形状不对抛错', () => {
    expect(() => sumOps({ errors: [{ message: 'x' }] })).toThrow();
    expect(() => sumOps(body(null))).toThrow();
    expect(() => sumOps(body([{ sum: { requests: '1' }, dimensions: { actionType: 'PutObject' } }]))).toThrow();
  });

  it('请求：固定地址、令牌只在请求头、时间段是 UTC 月初到现在；非 2xx 抛错', async () => {
    const calls: [string, RequestInit][] = [];
    const f = async (url: string, init: RequestInit) => { calls.push([url, init]); return new Response(JSON.stringify(body([])), { status: 200 }); };
    const ac = new AbortController();
    expect(await readR2Ops(f, 'acc123', 'tok', NOW, ac.signal)).toEqual({ write: 0, read: 0 });
    const [url, init] = calls[0]!;
    expect(url).toBe(CF_GRAPHQL_URL);
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    const sent = JSON.parse(String(init.body));
    expect(sent.variables).toEqual({ acc: 'acc123', start: '2026-11-01T00:00:00.000Z', end: '2026-11-27T00:07:00.000Z' });
    expect(String(init.body)).not.toContain('tok');
    expect(monthStart(Date.parse('2026-12-31T23:59:59Z'))).toBe('2026-12-01T00:00:00.000Z');
    await expect(readR2Ops(async () => new Response('', { status: 403 }), 'a', 't', NOW, ac.signal)).rejects.toThrow();
  });
});
