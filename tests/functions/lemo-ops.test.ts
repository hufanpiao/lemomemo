// 独立 Worker lemo-ops 的测试（架构 6.1、0.29 续第 116、143 条）：TC-B1-94 ②～⑤、TC-B1-102 ③～⑤ 的 lemo-ops 部分；
// usage-report 自己的部分（TC-B1-94 ①、TC-B1-102 ⑤ 列出 purge_started_at）见 usage-report.test.ts，其余规则见 lemo-ops-rules.test.ts。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESEND_AFTER_MS, stateKey } from '../../workers/lemo-ops/src/alerts.ts';

const HB_KEY = stateKey('heartbeat');
const DOWN = '【柠檬记监控】监控连不上服务器';
import { parseHeartbeatReport } from '../../workers/lemo-ops/src/rules.ts';
import { DB_TIMEOUT_MS } from '../../supabase/functions/usage-report/core.ts';
import { USAGE_REPORT_TIMEOUT_MS } from '../../workers/lemo-ops/src/http.ts';
import { SITE_ORIGIN, VERSION_JSON_PATH } from '../../workers/lemo-ops/src/version.ts';
import { H, M, world } from './lemo-ops-harness.ts';

const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

/**
 * 等到假时钟上挂了 n 个计时器再推进。全程假时钟，不真等 5 秒、10 秒。
 * 以前的写法是“每让出一次事件循环就推 100 ms，推满 6 秒 / 11 秒为止”：usage-report 鉴权里的
 * crypto.subtle.digest 走真线程池，全量跑、机器忙时迟迟不回来，假时钟先推完了，超时计时器才设上，
 * 之后再没人推时钟，tick 永远不返回，于是偶尔报 Test timed out in 5000ms。
 * 现在用真的 setImmediate 让出（它没交给假时钟），直到计时器都设上，再从这一刻起推假时钟，和机器快慢无关。
 */
async function waitForTimers(n: number): Promise<void> {
  while (vi.getTimerCount() < n) await new Promise((r) => setImmediate(r));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TC-B1-94 ②～④：连不上数据库 → 告警一次、6 小时内不重复、恢复后发“已恢复”', () => {
  it('完整的一段：发 1 封 → 6 小时内每 15 分钟一轮都不再发 → 连续 2 轮正常发 1 封“已恢复”', async () => {
    const w = world();
    w.freshAll();
    await w.tick();
    expect(w.inbox).toHaveLength(0);

    // ① 注入数据库错误 → usage-report 回 503 db_unreachable；② lemo-ops 发 1 封
    w.setMode('db_error');
    w.advance(15 * M);
    await w.tick();
    expect(w.inbox).toHaveLength(1);
    expect(w.inbox[0]?.subject).toBe(DOWN);
    expect(w.inbox[0]?.text).toContain('服务器连不上数据库');
    expect(w.inbox[0]?.text).toContain('503 db_unreachable');
    expect(w.inbox[0]?.to).toEqual(['owner@example.test']);
    expect(w.inbox[0]?.auth).toBe('Bearer test-resend');

    // ③ 之后 6 小时内每 15 分钟一轮都还连不上：不再发
    for (let i = 0; i < 23; i++) {
      w.advance(15 * M);
      await w.tick();
    }
    expect(w.inbox).toHaveLength(1);

    // ④ 数据库恢复：第 1 轮正常先不发，连续第 2 轮正常发 1 封“已恢复”
    w.setMode('ok');
    w.advance(15 * M);
    w.freshAll();
    await w.tick();
    expect(w.inbox).toHaveLength(1);
    w.advance(15 * M);
    w.freshAll();
    await w.tick();
    expect(w.inbox).toHaveLength(2);
    expect(w.inbox[1]?.subject).toBe(`【柠檬记监控】已恢复：监控连不上服务器`);
    w.advance(15 * M);
    w.freshAll();
    await w.tick();
    expect(w.inbox).toHaveLength(2);
    const st = JSON.parse(w.kv.get(HB_KEY) ?? '{}') as { issues: object; cooldown: Record<string, number> };
    expect(st.issues).toEqual({});
    expect(Object.keys(st.cooldown)).toEqual(['unreachable']);
  });

  it('查库超过 5 秒也一样告警（usage-report 约 5 秒回 503）', async () => {
    fakeTimers();
    const w = world();
    w.setMode('db_slow');
    const p = w.tick();
    // 同时在取的 version.json（R-270）也有一个 10 秒计时器：先等它读完、计时器清掉（w.siteDone），再等剩下两个
    await w.siteDone;
    await waitForTimers(2);   // lemo-ops 调 usage-report 的 10 秒 + usage-report 查库的 5 秒
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS);
    await p;
    expect(w.inbox.map((m) => m.subject)).toEqual([DOWN]);
    expect(w.inbox[0]?.text).toContain('服务器连不上数据库');
  });

  it('满 6 小时还没恢复：再发一封“仍未恢复”（同一件事 6 小时内只发一次）', async () => {
    const w = world();
    w.setMode('db_error');
    await w.tick();
    w.advance(RESEND_AFTER_MS - 1);
    await w.tick();
    expect(w.inbox).toHaveLength(1);
    w.advance(1);
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual([DOWN, '【柠檬记监控】仍未恢复：监控连不上服务器']);
  });

  it('发信失败不记成已发：下一轮再发', async () => {
    const w = world();
    w.setMode('db_error');
    w.setResendDown(true);
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    expect(w.logs).toContain('mail_send_failed');
    w.setResendDown(false);
    w.advance(15 * M);
    await w.tick();
    expect(w.inbox).toHaveLength(1);
  });

  it('调不通的时候，心跳那几件事查不了：不判“已恢复”，原样留着', async () => {
    const w = world();
    w.freshAll();
    w.setHeartbeat('push-dispatch', 6 * M);
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】推送服务（push-dispatch）停了']);
    w.setMode('db_error');
    w.advance(15 * M);
    await w.tick();
    expect(w.inbox.map((m) => m.subject).slice(1)).toEqual([DOWN]);
    const st = JSON.parse(w.kv.get(HB_KEY) ?? '{}') as { issues: Record<string, unknown> };
    expect(Object.keys(st.issues).sort()).toEqual(['hb:push-dispatch', 'unreachable']);
  });
});

describe('TC-B1-94 ⑤：另外三种调不通都发告警（外加网络错误）', () => {
  it.each([
    ['http500', 'usage-report 回 500'],
    ['bad_body', '返回体解析不了'],
    ['network', '网络出错'],
  ] as const)('%s', async (mode, text) => {
    const w = world();
    w.setMode(mode);
    await w.tick();
    expect(w.inbox).toHaveLength(1);
    expect(w.inbox[0]?.subject).toBe(DOWN);
    expect(w.inbox[0]?.text).toContain(text);
  });

  it('整体超时（10 秒）', async () => {
    fakeTimers();
    const w = world();
    w.setMode('hang');
    const p = w.tick();
    await w.siteDone;         // version.json（R-270）读完、它的计时器已清掉
    await waitForTimers(1);   // lemo-ops 调 usage-report 的 10 秒（hang 模式不进 usage-report）
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(USAGE_REPORT_TIMEOUT_MS - 1);
    expect(w.inbox).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(w.inbox).toHaveLength(1);
    expect(w.inbox[0]?.text).toContain('超时');
  });

  it('200 但形状不对（缺字段）也算解析不了', async () => {
    const w = world();
    expect(parseHeartbeatReport({ ok: true, heartbeats: [] })).toBeNull();
    expect(parseHeartbeatReport({ ok: true, heartbeats: [{ name: 'x' }], pending_deletions: [], long_tx: 0 })).toBeNull();
    expect(parseHeartbeatReport({ ok: true, heartbeats: [], pending_deletions: [], long_tx: 0 })).not.toBeNull();
    w.freshAll();
    await w.tick();
    expect(w.inbox).toHaveLength(0);
  });

  it('换了原因（数据库 → 500）标题不变、仍是同一件事，不重复发', async () => {
    const w = world();
    w.setMode('db_error');
    await w.tick();
    for (let i = 0; i < 4; i++) {
      w.setMode(i % 2 ? 'db_error' : 'http500');
      w.advance(15 * M);
      await w.tick();
    }
    expect(w.inbox.map((m) => m.subject)).toEqual([DOWN]);
  });

  it('usage-report 调用带 x-ops-secret 和 anon key，直连 supabase.co', async () => {
    const w = world();
    w.freshAll();
    await w.tick();
    // 第二个是 R-270 的线上版本比对（只读公开的 version.json，不带任何密钥；见 lemo-ops-version.test.ts）
    expect(w.calls).toEqual(['POST https://ref.supabase.co/functions/v1/usage-report', `GET ${SITE_ORIGIN}${VERSION_JSON_PATH}?t=${w.now}`]);
  });
});

describe('TC-B1-102 ③～⑤：注销到期删除的三种告警', () => {
  it('③ 有 purge_after 超过 1 天还没执行的行 → 发告警；刚好 1 天不发', async () => {
    const w = world();
    w.freshAll();
    w.setPending([{ afterAgo: 24 * H, startedAgo: null }]);
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    w.advance(15 * M);
    w.freshAll();
    w.setPending([{ afterAgo: 24 * H + M, startedAgo: null }, { afterAgo: -2 * 24 * H, startedAgo: null }]);
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】注销冷静期已满、超过 1 天还没删除']);
    expect(w.inbox[0]?.text).toContain('有 1 个账号');
  });

  it('④ account-purge 心跳停 26 小时 1 分 → 发告警；25 小时 59 分不发', async () => {
    const w = world();
    w.freshAll();
    w.setHeartbeat('account-purge', 25 * H + 59 * M);
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    w.setHeartbeat('account-purge', 26 * H + M);
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】注销到期删除（account-purge）停了']);
    expect(w.inbox[0]?.text).toContain('26 小时 1 分前');
  });

  it('⑤ purge_started_at 26 小时 1 分前、还没删完 → 发告警，邮件里列出 purge_started_at；25 小时 59 分不发', async () => {
    const w = world();
    w.freshAll();
    w.setPending([{ afterAgo: 30 * H, startedAgo: 25 * H + 59 * M }]);
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    w.setPending([{ afterAgo: 30 * H, startedAgo: 26 * H + M }]);
    await w.tick();
    expect(w.inbox).toHaveLength(1);
    expect(w.inbox[0]?.subject).toBe('【柠檬记监控】注销删除认领了没删完');
    expect(w.inbox[0]?.text).toContain(new Date(w.now - 26 * H - M).toISOString());
    // 已认领的行不再算“到期没执行”
    expect(w.inbox[0]?.subject).not.toContain('还没删除');
  });

  it('删完以后（行没了、心跳更新）连续 2 轮正常发“已恢复”', async () => {
    const w = world();
    w.freshAll();
    w.setHeartbeat('account-purge', 27 * H);
    w.setPending([{ afterAgo: 30 * H, startedAgo: null }]);
    await w.tick();
    expect(w.inbox).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      w.advance(15 * M);
      w.freshAll();
      w.setPending([]);
      await w.tick();
    }
    expect(w.inbox.slice(2).map((m) => m.subject).sort()).toEqual([
      '【柠檬记监控】已恢复：注销冷静期已满、超过 1 天还没删除',
      '【柠檬记监控】已恢复：注销到期删除（account-purge）停了',
    ]);
  });
});
