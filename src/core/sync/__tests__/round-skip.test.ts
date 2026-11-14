// 一轮拉取里一张表失败（core/sync/round.ts）：401 照旧整轮停（交给引擎刷新令牌）；别的失败只跳过这一张、记日志，
// 接着拉后面的表和墓碑，整轮回 net（lastPullAt 不更新，下一轮再拉这张）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../boot.ts';
import { clock, setup } from '../../__tests__/outbox-fixtures.ts';
import { clearAllCollections } from '../../store.ts';
import { pullRound, type RoundCtx } from '../round.ts';
import type { SendFailure } from '../types.ts';
import { fakeTransport, identityParse } from './fake-server.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

async function round(failTable: string, failure: SendFailure) {
  const { cache, outbox } = await setup();
  const t = fakeTransport();
  const orig = t.pullRows.bind(t);
  t.pullRows = (table, q) => (table === failTable ? Promise.resolve({ ok: false, error: failure }) : orig(table, q));
  const log = vi.fn();
  const c: RoundCtx = {
    boot: { refetch: {} } as unknown as BootResult, cache, pendingFull: new Set([failTable]), refetch: { done: false }, withConfig: false, schemaV: 1,
    d: { cache, outbox, transport: t, parseRows: identityParse, gated: () => false, now: () => clock.t, log },
  };
  return { c, t, log, tables: cache.syncTables };
}

describe('一张表拉取失败', () => {
  it('断网、5xx：只跳过这一张、记 sync_pull_skip，后面的表和墓碑照拉；整轮回 net，这张表留着整表重拉', async () => {
    const { c, t, log, tables } = await round('notes', { status: 503 });
    expect(await pullRound(c, t)).toBe('net');
    const after = tables.slice(tables.indexOf('notes') + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const table of after) expect(t.calls).toContain(`pull:${table}`);
    expect(t.calls).toContain('tombstones');
    expect(log).toHaveBeenCalledWith('sync_pull_skip', { coll: 'notes', code: 'net' });
    expect(c.pendingFull.has('notes')).toBe(true);
  });

  it('401：照旧整轮停（交给引擎刷新令牌），不拉墓碑', async () => {
    const { c, t } = await round('notes', { status: 401 });
    expect(await pullRound(c, t)).toBe('auth');
    expect(t.calls).not.toContain('tombstones');
  });
});
