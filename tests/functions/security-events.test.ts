// 安全计数 security_events（R-382 复审建议 3）：usage-report 读 private.security_events()、lemo-ops 大于 0 告警。
// 数据库那一半在 supabase/tests/rls/47_session_fate.test.sql。
import { describe, expect, it, vi } from 'vitest';
import { handle, securityFromRpc, type Deps, type UsageDb } from '../../supabase/functions/usage-report/core.ts';
import { evaluateHeartbeat, evaluateSecurity, parseHeartbeatReport } from '../../workers/lemo-ops/src/rules.ts';

const SECRET = 'test-ops-secret-xxxxxxxxxxxxxxxxxxxxxx';
const fakeDb = (over: Partial<UsageDb> = {}): UsageDb => ({ heartbeats: async () => [], pendingDeletions: async () => [], longTxCount: async () => 0, ...over });
const deps = (over: Partial<Deps> = {}): Deps => ({ opsSecret: SECRET, db: fakeDb(), now: () => 0, ...over });
const req = () => new Request('https://x.supabase.co/functions/v1/usage-report', { method: 'POST', headers: { 'x-ops-secret': SECRET }, body: '{"part":"heartbeat"}' });
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe('usage-report：security_events', () => {
  it('没接不出键；读到一行的数组给两个计数', async () => {
    expect('security_events' in (await body(await handle(req(), deps())))).toBe(false);
    const db = fakeDb({ securityEvents: async () => securityFromRpc([{ sfate_capped: 2, pw_revoke_failed: 0 }]) });
    expect((await body(await handle(req(), deps({ db }))))['security_events']).toEqual({ sfate_capped: 2, pw_revoke_failed: 0 });
  });
  it('出错、超时、数字不对：只让 security_events 为 null，心跳照样 200', async () => {
    for (const [read, code] of [
      [async () => { throw new Error('x'); }, 'security:error'],
      [() => new Promise(() => {}), 'security:timeout'],
      [async () => securityFromRpc([{ sfate_capped: -1, pw_revoke_failed: 0 }]), 'security:bad_data'],
      [async () => securityFromRpc([]), 'security:bad_data'],
    ] as const) {
      const log = vi.fn();
      const r = await handle(req(), deps({ db: fakeDb({ securityEvents: read }), log, sideTimeoutMs: 5 }));
      expect(r.status).toBe(200);
      expect((await body(r))['security_events']).toBeNull();
      expect(log.mock.calls).toEqual([[code]]);
    }
  });
});

describe('lemo-ops：security_events 告警', () => {
  const BASE = { ok: true, heartbeats: [], pending_deletions: [], long_tx: 0 };
  const parsed = (v: unknown) => {
    const r = parseHeartbeatReport(v);
    if (r === null) throw new Error('解析失败');
    return r;
  };
  it('都是 0 不报；大于 0 各报一件、标题不带个数；读不到只报“读不到”', () => {
    expect(evaluateSecurity({ sfate_capped: 0, pw_revoke_failed: 0 }).active).toEqual([]);
    const both = evaluateSecurity({ sfate_capped: 3, pw_revoke_failed: 1 });
    expect(both.active.map((i) => i.key)).toEqual(['security:sfate-capped', 'security:pwrevoke-fail']);
    expect(both.active.every((i) => !/\d/.test(i.title))).toBe(true);
    expect(evaluateSecurity(null)).toEqual({ active: [expect.objectContaining({ key: 'security:unreadable' })], scopes: ['security:unreadable'] });
  });
  it('没带键：security: 整组进 drop；形状不对降级成 null、不连累整份返回体', () => {
    expect(evaluateHeartbeat(parsed(BASE), []).drop).toContain('security:');
    const bad = parsed({ ...BASE, security_events: { sfate_capped: 'x' } });
    expect(bad.security_events).toBeNull();
    expect(evaluateHeartbeat(bad, []).active.map((i) => i.key)).toContain('security:unreadable');
  });
});
