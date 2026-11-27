// lemo-ops 的“没有 profile 的 auth 用户”告警（接手清单 ORPHAN-alert；架构 0.38 第 29 条）：workers/lemo-ops/src/orphans.ts。
// 共用的假环境在 lemo-ops-harness.ts（假 fetch 接真的 usage-report/core.ts）；usage-report 那一半在 usage-report-orphan.test.ts，
// 数据库那一半在 supabase/tests/rls/27_orphan_auth_users.test.sql。
import { describe, expect, it } from 'vitest';
import { evaluateHeartbeat, evaluateOrphans, parseHeartbeatReport } from '../../workers/lemo-ops/src/rules.ts';
import { H, M, world } from './lemo-ops-harness.ts';

const ALERT = '【柠檬记监控】有注册到一半的账号（auth 里有、没有资料）';
const UNREADABLE = '【柠檬记监控】没有资料的账号数读不到';
const BASE = { ok: true, heartbeats: [], pending_deletions: [], long_tx: 0 };
const parsed = (v: unknown) => {
  const r = parseHeartbeatReport(v);
  if (r === null) throw new Error('解析失败');
  return r;
};

describe('孤儿用户告警（ORPHAN-alert）', () => {
  const subj = (w: ReturnType<typeof world>) => w.inbox.map((m) => m.subject);
  const step = async (w: ReturnType<typeof world>, n = 1) => {
    for (let i = 0; i < n; i++) {
      w.advance(15 * M);
      w.freshAll();
      await w.tick();
    }
  };
  const ago = (w: ReturnType<typeof world>, ms: number) => new Date(w.now - ms).toISOString();

  it('判断：0 个不报、大于 0 报；读不到只报“读不到”、不碰 orphan:users；标题不带个数，正文不带 id、邮箱', () => {
    expect(evaluateOrphans({ count: 0, latest_age_s: null })).toEqual({ active: [], scopes: ['orphan:unreadable', 'orphan:users'] });
    const one = evaluateOrphans({ count: 2, latest_age_s: 3 * 3600 + 5 * 60 });
    expect(one.active.map((i) => i.key)).toEqual(['orphan:users']);
    expect(one.active[0]?.title).not.toMatch(/\d/);
    const text = one.active[0]?.lines.join('\n') ?? '';
    expect(text).toContain('现在有 2 个 auth 用户建号超过 10 分钟仍没有 profile，最近一个建于 3 小时 5 分前');
    expect(text).toContain('上线与回滚手册第八节');
    expect(text).toContain('这些账号用不了（能收到验证码，进去没有资料），占用的那一次邀请码不会自动退回');
    expect(text).not.toMatch(/@|[0-9a-f]{8}-/);
    expect(evaluateOrphans({ count: 7, latest_age_s: 9999 }).active[0]?.title).toBe(one.active[0]?.title);   // 个数变了不算新的一件事
    expect(evaluateOrphans(null)).toEqual({ active: [expect.objectContaining({ key: 'orphan:unreadable' })], scopes: ['orphan:unreadable'] });
  });

  it('没接（usage-report 不带 orphan_users）：不查，orphan: 整组进 drop；接了：两个 key 都在 scopes 里', () => {
    const none = evaluateHeartbeat(parsed(BASE), []);
    expect(none.drop).toContain('orphan:');
    expect(none.scopes.filter((k) => k.startsWith('orphan:'))).toEqual([]);
    const on = evaluateHeartbeat(parsed({ ...BASE, orphan_users: { count: 0, latest_age_s: null } }), []);
    expect(on.drop ?? []).not.toContain('orphan:');
    expect(on.scopes).toEqual(expect.arrayContaining(['orphan:users', 'orphan:unreadable']));
  });

  it('返回体里 orphan_users 形状不对只降级成 null（报“读不到”），不让整份返回体解析失败', () => {
    for (const bad of [null, 'x', [], {}, { count: -1, latest_age_s: 1 }, { count: 1.5, latest_age_s: 1 }, { count: 2, latest_age_s: null }, { count: 2, latest_age_s: 'x' }]) {
      const r = parseHeartbeatReport({ ...BASE, orphan_users: bad });
      expect(r).not.toBeNull();
      expect(r?.orphan_users).toBeNull();
    }
    expect(parseHeartbeatReport({ ...BASE, orphan_users: { count: 0 } })?.orphan_users).toEqual({ count: 0, latest_age_s: null });
    expect(parseHeartbeatReport({ ...BASE, orphan_users: { count: 1, latest_age_s: 60, extra: 'y' } })?.orphan_users).toEqual({ count: 1, latest_age_s: 60 });
    expect(parseHeartbeatReport(BASE)?.orphan_users).toBeUndefined();
  });

  it('端到端：没接不告警；出现孤儿发一封，之后几轮（个数变了也算同一件事）不重发；处理掉后发“已恢复”', async () => {
    const w = world();
    w.freshAll();
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    w.setOrphans({ count: 0, latest_at: null });
    await step(w);
    expect(w.inbox).toHaveLength(0);
    w.setOrphans({ count: 1, latest_at: ago(w, 2 * H) });
    await step(w);
    expect(subj(w)).toEqual([ALERT]);
    expect(w.inbox[0]?.text).toContain('最近一个建于 2 小时 15 分前');
    w.setOrphans({ count: 2, latest_at: ago(w, 20 * M) });
    await step(w, 3);
    expect(subj(w)).toEqual([ALERT]);
    w.setOrphans({ count: 0, latest_at: null });
    await step(w, 2);
    expect(subj(w)).toContain('【柠檬记监控】已恢复：有注册到一半的账号（auth 里有、没有资料）');
  });

  it('读不到：报“读不到”，已在报的孤儿告警不判成已恢复；读到后发“已恢复：读不到”。usage-report 日志只记 orphans:error', async () => {
    const w = world();
    w.freshAll();
    w.setOrphans({ count: 1, latest_at: ago(w, H) });
    await w.tick();
    expect(subj(w)).toEqual([ALERT]);
    w.setOrphans('error');
    await step(w, 3);
    expect(subj(w)).toEqual([ALERT, UNREADABLE]);
    w.setOrphans({ count: 1, latest_at: ago(w, 2 * H) });
    await step(w, 2);
    expect(subj(w)).toContain('【柠檬记监控】已恢复：没有资料的账号数读不到');
    expect(subj(w).filter((s) => s.startsWith('【柠檬记监控】已恢复：有注册到一半'))).toEqual([]);
  });

  it('没接以后（orphan_users 不再出现）：留下的状态悄悄删掉，不发“已恢复”', async () => {
    const w = world();
    w.freshAll();
    w.setOrphans({ count: 3, latest_at: ago(w, H) });
    await w.tick();
    expect(w.inbox).toHaveLength(1);
    w.setOrphans(undefined);
    await step(w, 3);
    expect(w.inbox).toHaveLength(1);
  });
});
