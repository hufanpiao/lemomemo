// R-261“发信失败另记心跳”的测试（架构 15.6 第 4d 条 ①）：lemo-ops 发信失败时另写 KV 键 mail-fail:v1，下一封发成功的告警带中韩两句“此前有 N 次告警发信失败”，这个键读写出错不影响告警。
// 从 lemo-ops.test.ts 拆出（W1 每个文件不超过 300 行），用例和断言原样搬过来。
import { describe, expect, it } from 'vitest';
import { MAIL_FAIL_KEY, RESEND_AFTER_MS, runAlerts, stateKey, type MailFail, type StateStore } from '../../workers/lemo-ops/src/alerts.ts';
import { parseMailFail } from '../../workers/lemo-ops/src/mail-fail.ts';
import type { Evaluation } from '../../workers/lemo-ops/src/rules.ts';
import { H, M, world } from './lemo-ops-harness.ts';

const HB_KEY = stateKey('heartbeat');
const DOWN = '【柠檬记监控】监控连不上服务器';

describe('R-261：发信失败另记 mail-fail:v1（架构 15.6 第 4d 条 ①）', () => {
  const failOf = (w: ReturnType<typeof world>) => JSON.parse(w.kv.get(MAIL_FAIL_KEY) ?? 'null') as MailFail | null;
  const iso = (ms: number) => new Date(ms).toISOString();
  const ZH = (n: number) => `此前有 ${n} 次告警发信失败`;
  const KO = (n: number) => `이전에 알림 메일 발송이 ${n}회 실패했습니다`;

  it('发失败计数：每封发不出加 1，记第一封和最近一次的时刻、Resend 的 HTTP 码；不记收件人、邮箱、标题、正文', async () => {
    const w = world();
    w.setMode('db_error');
    w.setResendDown(true);
    const t0 = w.now;
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    expect(failOf(w)).toEqual({ first_at: iso(t0), last_at: iso(t0), count: 1, last_status: 500, last_ok_at: null });
    w.advance(15 * M);
    await w.tick();
    expect(failOf(w)).toEqual({ first_at: iso(t0), last_at: iso(w.now), count: 2, last_status: 500, last_ok_at: null });
    const raw = w.kv.get(MAIL_FAIL_KEY) ?? '';
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(['count', 'first_at', 'last_at', 'last_ok_at', 'last_status']);
    for (const s of ['owner@example.test', 'ops@example.test', '@', '柠檬记', '监控', 'test-resend']) expect(raw).not.toContain(s);
    expect(w.logs.filter((l) => l === 'mail_send_failed')).toHaveLength(2);
  });

  it('发成功：写 last_ok_at、count 清零（first_at 置空，last_at、last_status 留作历史）；这封末尾带中文、韩文两句“此前有 N 次告警发信失败”，再下一封不带', async () => {
    const w = world();
    w.setMode('db_error');
    w.setResendDown(true);
    const t0 = w.now;
    await w.tick();
    w.advance(15 * M);
    await w.tick();
    const tFail = w.now;
    w.setResendDown(false);
    w.advance(15 * M);
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual([DOWN]);
    const text = w.inbox[0]?.text ?? '';
    expect(text).toContain(ZH(2));
    expect(text).toContain(KO(2));
    expect(text).toContain('HTTP 500');
    expect(text).toContain(MAIL_FAIL_KEY);
    // 措辞保守（审查建议 10-30）：不承诺一定重发
    expect(text).toContain('没发出的事项一般会在下一轮重发');
    expect(text).toContain('보내지 못한 항목은 보통 다음 회차에 다시 보냅니다');
    expect(text).not.toContain('接着重发');
    expect(text).toContain(`第一次失败是 ${new Date(t0 + 9 * H).toISOString().replace('T', ' ').slice(0, 16)}（首尔）`);
    // 提示接在原文之后、空一行，两行：先中文后韩文
    const tail = text.split('\n').slice(-3);
    expect(tail[0]).toBe('');
    expect(tail[1]?.startsWith(ZH(2))).toBe(true);
    expect(tail[2]?.startsWith(KO(2))).toBe(true);
    expect(failOf(w)).toEqual({ first_at: null, last_at: iso(tFail), count: 0, last_status: 500, last_ok_at: iso(w.now) });

    // 6 小时后“仍未恢复”：已清零，不再带提示；last_ok_at 更新
    w.advance(RESEND_AFTER_MS);
    await w.tick();
    expect(w.inbox).toHaveLength(2);
    expect(w.inbox[1]?.text).not.toContain('此前有');
    expect(w.inbox[1]?.text).not.toContain('회 실패했습니다');
    expect(failOf(w)?.last_ok_at).toBe(iso(w.now));
    expect(failOf(w)?.count).toBe(0);
  });

  it('一轮发几封：提示只带在第一封发成功的信上', async () => {
    const w = world();
    w.kv.set(MAIL_FAIL_KEY, JSON.stringify({ first_at: iso(w.now - H), last_at: iso(w.now - 30 * M), count: 3, last_status: 429, last_ok_at: null }));
    w.freshAll();
    w.setHeartbeat('account-purge', 27 * H);
    w.setPending([{ afterAgo: 30 * H, startedAgo: null }]);
    await w.tick();
    expect(w.inbox).toHaveLength(2);
    expect(w.inbox[0]?.text).toContain(ZH(3));
    expect(w.inbox[0]?.text).toContain(KO(3));
    expect(w.inbox[0]?.text).toContain('HTTP 429');
    expect(w.inbox[1]?.text).not.toContain('此前有');
    expect(failOf(w)?.count).toBe(0);
  });

  it('mail-fail:v1 写不进去：不影响发信和告警状态（只记 mail_fail_write_failed）；发失败那轮照样退回、下一轮重发', async () => {
    const w = world();
    const base = w.env.OPS_STATE;
    w.env.OPS_STATE = {
      get: (k) => base.get(k),
      put: async (k, v) => {
        if (k === MAIL_FAIL_KEY) throw new Error('kv down');
        await base.put(k, v);
      },
    };
    w.setMode('db_error');
    w.setResendDown(true);
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    expect(w.logs).toEqual(['mail_send_failed', 'mail_fail_write_failed']);
    expect(w.kv.has(MAIL_FAIL_KEY)).toBe(false);
    const st = JSON.parse(w.kv.get(HB_KEY) ?? '{}') as { issues: Record<string, { notified: boolean }> };
    expect(st.issues['unreachable']?.notified).toBe(false);

    w.setResendDown(false);
    w.advance(15 * M);
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual([DOWN]);
    expect(w.logs.slice(2)).toEqual(['mail_fail_write_failed']);
    const st2 = JSON.parse(w.kv.get(HB_KEY) ?? '{}') as { issues: Record<string, { notified: boolean }> };
    expect(st2.issues['unreachable']?.notified).toBe(true);
  });

  it('mail-fail:v1 读不出来：照样发信，这一轮不写它（免得把之前的计数冲掉），只记 mail_fail_read_failed', async () => {
    const w = world();
    const before = JSON.stringify({ first_at: iso(w.now - H), last_at: iso(w.now - H), count: 5, last_status: 500, last_ok_at: null });
    w.kv.set(MAIL_FAIL_KEY, before);
    const base = w.env.OPS_STATE;
    w.env.OPS_STATE = {
      get: async (k) => {
        if (k === MAIL_FAIL_KEY) throw new Error('kv down');
        return base.get(k);
      },
      put: (k, v) => base.put(k, v),
    };
    w.setMode('db_error');
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual([DOWN]);
    expect(w.inbox[0]?.text).not.toContain('此前有');
    expect(w.logs).toEqual(['mail_fail_read_failed']);
    expect(w.kv.get(MAIL_FAIL_KEY)).toBe(before);
  });

  it('坏了的 mail-fail:v1 当从零开始；没有要发的信时不读也不写它', async () => {
    const w = world();
    w.kv.set(MAIL_FAIL_KEY, '{not json');
    w.freshAll();
    await w.tick();
    expect(w.kv.get(MAIL_FAIL_KEY)).toBe('{not json');
    w.setMode('db_error');
    w.advance(15 * M);
    await w.tick();
    expect(w.inbox[0]?.text).not.toContain('此前有');
    expect(failOf(w)).toEqual({ first_at: null, last_at: null, count: 0, last_status: null, last_ok_at: iso(w.now) });
  });

  it('主状态 KV 写不进（这一轮一封不发）时不动 mail-fail:v1', async () => {
    const w = world();
    w.setKvBroken(true);
    w.setMode('db_error');
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    expect(w.logs).toEqual(['kv_write_failed']);
    expect(w.kv.has(MAIL_FAIL_KEY)).toBe(false);
  });

  it('runAlerts 直接调：Resend 回 429 记 429；超时 / 网络出错（没有回应）记 null，提示写“没有回应”；send 抛错也算发失败', async () => {
    const kv = new Map<string, string>();
    const store: StateStore = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) };
    const ev = (key: string): Evaluation[] => [{ active: [{ key, title: `事项 ${key}`, lines: ['x'] }], scopes: [key] }];
    const logs: string[] = [];
    const t = Date.parse('2026-10-30T00:00:00Z');
    await runAlerts(store, 'daily', ev('a'), t, async () => ({ ok: false, status: 429 }), (c) => logs.push(c));
    expect((JSON.parse(kv.get(MAIL_FAIL_KEY) ?? '{}') as MailFail).last_status).toBe(429);
    await runAlerts(store, 'daily', ev('a'), t + 15 * M, async () => ({ ok: false, status: null }), (c) => logs.push(c));
    await runAlerts(store, 'daily', ev('a'), t + 30 * M, async () => {
      throw new Error('boom');
    }, (c) => logs.push(c));
    expect(JSON.parse(kv.get(MAIL_FAIL_KEY) ?? '{}')).toEqual({ first_at: iso(t), last_at: iso(t + 30 * M), count: 3, last_status: null, last_ok_at: null });
    const got: string[] = [];
    const sent = await runAlerts(store, 'daily', ev('a'), t + 45 * M, async (m) => {
      got.push(m.text);
      return { ok: true, status: 200 };
    }, (c) => logs.push(c));
    expect(sent).toHaveLength(1);
    expect(got[0]).toContain(ZH(3));
    expect(got[0]).toContain('没有回应（超时或网络出错）');
    expect(got[0]).toContain('응답 없음');
    expect(sent[0]?.text).toBe(got[0]);
    expect(logs).toEqual(['mail_send_failed', 'mail_send_failed', 'mail_send_failed']);
  });

  it('parseMailFail：count 为 0（或坏掉当成 0）时 first_at 一律置 null，下一串失败不会沿用旧时刻', () => {
    const old = iso(Date.parse('2026-10-01T00:00:00Z'));
    expect(parseMailFail(JSON.stringify({ first_at: old, last_at: old, count: 0, last_status: 500, last_ok_at: null })).first_at).toBeNull();
    expect(parseMailFail(JSON.stringify({ first_at: old, count: -1 })).first_at).toBeNull();
    expect(parseMailFail(JSON.stringify({ first_at: old, count: '3' })).first_at).toBeNull();
    expect(parseMailFail(JSON.stringify({ first_at: old, count: 2 })).first_at).toBe(old);
  });
});
