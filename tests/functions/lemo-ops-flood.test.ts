// lemo-ops 防刷屏（K15 审查返工必改 1 和低几条）：审查员探针（scratchpad\k15\probe.ts）的四个场景、恢复要连续 2 轮、
// 恢复后冷却 6 小时、每天最多 20 封和“已达上限”、钩子告警按小时去重和重试、两个 cron 各用一个状态键、入口不再抛错。
// Resend 每天 100 封的额度和登录验证码共用，监控邮件不能把它耗光。
import { describe, expect, it } from 'vitest';
import { BUDGET_KEY, COOLDOWN_MS, DAILY_MAIL_CAP, stateKey } from '../../workers/lemo-ops/src/alerts.ts';
import { CRON_DAILY, CRON_HEARTBEAT, runHeartbeat } from '../../workers/lemo-ops/src/index.ts';
import { H, M, world } from './lemo-ops-harness.ts';

const DOWN = '【柠檬记监控】监控连不上服务器';
const HOOK = '【柠檬记监控】登录令牌钩子出错，被移除的设备可能还能刷新';

describe('审查员探针的四个场景', () => {
  it('① 时通时断（错误、正常每 15 分钟交替）24 小时：只有第一封和每 6 小时一封“仍未恢复”', async () => {
    const w = world();
    w.freshAll();
    for (let i = 0; i < 96; i++) {
      w.setMode(i % 2 ? 'ok' : 'db_error');
      w.freshAll();
      await w.tick();
      w.advance(15 * M);
    }
    // 原来 96 封；现在每次正常只有 1 轮，到不了“连续 2 轮”，不发“已恢复”
    expect(w.inbox.map((m) => m.subject)).toEqual([DOWN, ...Array<string>(3).fill('【柠檬记监控】仍未恢复：监控连不上服务器')]);
  });

  it('② 503 和 500 交替 24 小时：同一个标题，同样只有 4 封', async () => {
    const w = world();
    for (let i = 0; i < 96; i++) {
      w.setMode(i % 2 ? 'http500' : 'db_error');
      await w.tick();
      w.advance(15 * M);
    }
    expect(w.inbox).toHaveLength(4);
    expect(new Set(w.inbox.map((m) => m.subject.replace('仍未恢复：', '')))).toEqual(new Set([DOWN]));
  });

  // ③ usage-call 失败后恢复：见 lemo-ops-rules.test.ts 的“审查必改 2”用例（同一场景，不重复写）

  it('④ KV 写失败 2 小时：一封都不发（不然每轮当新事重发），也不抛错，只记日志错误码', async () => {
    const w = world();
    w.setMode('db_error');
    w.setKvBroken(true);
    for (let i = 0; i < 8; i++) {
      await w.scheduled(CRON_HEARTBEAT);
      w.advance(15 * M);
    }
    expect(w.inbox).toHaveLength(0);
    expect(w.logs.filter((l) => l === 'kv_write_failed')).toHaveLength(8);
    w.setKvBroken(false);
    await w.scheduled(CRON_HEARTBEAT);
    expect(w.inbox.map((m) => m.subject)).toEqual([DOWN]);
  });
});

describe('恢复和冷却', () => {
  it('正常 1 轮又出错：不发“已恢复”，也不重发告警', async () => {
    const w = world();
    w.setMode('db_error');
    await w.tick();
    w.setMode('ok');
    w.advance(15 * M);
    w.freshAll();
    await w.tick();
    w.setMode('db_error');
    w.advance(15 * M);
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual([DOWN]);
  });

  it('发出“已恢复”后冷却 6 小时：期间只出现 1 轮的只记下；冷却过了出现 1 轮就发', async () => {
    const w = world();
    w.setMode('db_error');
    await w.tick();
    w.setMode('ok');
    for (let i = 0; i < 2; i++) {
      w.advance(15 * M);
      w.freshAll();
      await w.tick();
    }
    expect(w.inbox).toHaveLength(2);
    const recoveredAt = w.now;
    // 冷却期里：出现 1 轮、正常 1 轮交替（每次只出现 1 轮）
    let down = true;
    while (w.now + 15 * M < recoveredAt + COOLDOWN_MS) {
      w.setMode(down ? 'db_error' : 'ok');
      down = !down;
      w.advance(15 * M);
      w.freshAll();
      await w.tick();
    }
    expect(w.inbox).toHaveLength(2);
    const st = JSON.parse(w.kv.get(stateKey('heartbeat')) ?? '{}') as { cooldown: Record<string, number> };
    expect(st.cooldown['unreachable']).toBe(recoveredAt + COOLDOWN_MS);
    // 冷却过了：出现第 1 轮就发
    w.advance(30 * M);
    w.setMode('db_error');
    await w.tick();
    expect(w.inbox.map((m) => m.subject)[2]).toBe(DOWN);
  });

  it('冷却中出现、又连续 2 轮正常：悄悄删掉，不发“已恢复”', async () => {
    const w = world();
    w.setMode('db_error');
    await w.tick();
    w.setMode('ok');
    for (let i = 0; i < 2; i++) {
      w.advance(15 * M);
      w.freshAll();
      await w.tick();
    }
    w.setMode('db_error');
    w.advance(15 * M);
    await w.tick();
    w.setMode('ok');
    for (let i = 0; i < 2; i++) {
      w.advance(15 * M);
      w.freshAll();
      await w.tick();
    }
    expect(w.inbox).toHaveLength(2);
  });
});

describe('每天最多 20 封', () => {
  it('其他告警到 17 封只发一封“今天告警已达上限”，第二天先补发没发出去的，再发“仍未恢复”', async () => {
    const w = world();
    // 用用量的 30 项造出 30 件不同的事（都不是保留额度的两类）
    const names = Array.from({ length: 30 }, (_, i) => `fn-${i}`);
    const OTHER = DAILY_MAIL_CAP - 3;
    w.env.USAGE_CHECK = 'on';
    w.setUsage({ ok: true, items: names.map((n) => ({ key: n, label: n, pct: 75 })) });
    await w.daily();
    expect(w.inbox).toHaveLength(OTHER + 1);
    expect(w.inbox.at(-1)?.subject).toBe('【柠檬记监控】今天告警已达上限');
    // 同一天再跑：一封不发
    await w.daily();
    expect(w.inbox).toHaveLength(OTHER + 1);
    expect(JSON.parse(w.kv.get(BUDGET_KEY) ?? '{}')).toEqual({ day: '2026-10-29', sent: OTHER, capNotice: true });
    // 第二天（UTC）：额度重算，先补发前一天没发出去的 13 件，再发 4 封“仍未恢复”，然后“已达上限”
    w.advance(24 * H);
    await w.daily();
    const day2 = w.inbox.slice(OTHER + 1).map((m) => m.subject);
    expect(day2.slice(0, 13)).toEqual(names.slice(OTHER).map((n) => `【柠檬记监控】${n}超过提醒线`));
    expect(day2.slice(13, OTHER).every((s) => s.startsWith('【柠檬记监控】仍未恢复：'))).toBe(true);
    expect(day2.slice(OTHER)).toEqual(['【柠檬记监控】今天告警已达上限']);
  });

  it('两个 cron 共用一份额度，各自的状态各用一个键', async () => {
    const w = world();
    w.setMode('db_error');
    await w.tick();
    w.setKeepalive(503);
    await w.daily();
    expect(w.kv.has(stateKey('heartbeat'))).toBe(true);
    expect(w.kv.has(stateKey('daily'))).toBe(true);
    expect((JSON.parse(w.kv.get(BUDGET_KEY) ?? '{}') as { sent: number }).sent).toBe(2);
  });

  it('发信失败退回额度', async () => {
    const w = world();
    w.setMode('db_error');
    w.setResendDown(true);
    await w.tick();
    expect((JSON.parse(w.kv.get(BUDGET_KEY) ?? '{}') as { sent: number }).sent).toBe(0);
  });
});

describe('钩子出错告警：按小时去重、发失败重试', () => {
  const hookWorld = () => {
    const w = world();
    let alert = true;
    const fetchFn = async (url: string, init: RequestInit) =>
      url.endsWith('/usage-report') ? new Response(JSON.stringify({ ok: true, heartbeats: [], pending_deletions: [], long_tx: 0, alert })) : w.fetchFn(url, init);
    return { w, fetchFn, setAlert: (v: boolean) => (alert = v) };
  };

  it('同一小时收到两次 alert 只发一封；下一小时再发', async () => {
    const { w, fetchFn } = hookWorld();
    await runHeartbeat(w.env, fetchFn, w.now, () => {});
    await runHeartbeat(w.env, fetchFn, w.now + 15 * M, () => {});
    expect(w.inbox.map((m) => m.subject)).toEqual([HOOK]);
    await runHeartbeat(w.env, fetchFn, w.now + 60 * M, () => {});
    expect(w.inbox.map((m) => m.subject)).toEqual([HOOK, HOOK]);
  });

  it('发失败的下一轮重试（服务器那边只给一次 alert: true）', async () => {
    const { w, fetchFn, setAlert } = hookWorld();
    w.setResendDown(true);
    await runHeartbeat(w.env, fetchFn, w.now, () => {});
    expect(w.inbox).toHaveLength(0);
    setAlert(false);
    w.setResendDown(false);
    await runHeartbeat(w.env, fetchFn, w.now + 15 * M, () => {});
    expect(w.inbox.map((m) => m.subject)).toEqual([HOOK]);
    expect(w.inbox[0]?.text).toContain('20261029T00');
  });
});

describe('入口不再抛错', () => {
  it('缺配置：只记一条含变量名的日志，不抛', async () => {
    const w = world();
    w.env.OPS_SECRET = '';
    await expect(w.scheduled(CRON_DAILY)).resolves.toBeUndefined();
    expect(w.logs).toEqual(['lemo-ops 配置缺：OPS_SECRET']);
  });

  it('其他意外错误：只记错误类型，不带原文', async () => {
    const w = world();
    w.env.OPS_STATE = {
      get: async () => {
        throw new Error('postgres://secret@host');
      },
      put: async () => {},
    };
    await expect(w.scheduled(CRON_HEARTBEAT)).resolves.toBeUndefined();
    expect(w.logs).toEqual(['运行出错：Error']);
  });
});

describe('K15 复审：冷却期内连续出现 2 轮马上发“又出现了”', () => {
  /** 断 1 轮、通 2 轮（发出“已恢复”、进入冷却） */
  async function blipThenRecover(w: ReturnType<typeof world>) {
    w.setMode('db_error');
    await w.tick();
    w.setMode('ok');
    for (let i = 0; i < 2; i++) {
      w.advance(15 * M);
      w.freshAll();
      await w.tick();
    }
  }

  it('短暂恢复后长时间故障：连续第 2 轮（约 30 分钟）就发“又出现了”，不等冷却过完', async () => {
    const w = world();
    await blipThenRecover(w);
    expect(w.inbox).toHaveLength(2);
    w.setMode('db_error');
    w.advance(15 * M);
    await w.tick();
    expect(w.inbox).toHaveLength(2);   // 第 1 轮只记下
    w.advance(15 * M);
    await w.tick();
    expect(w.inbox.map((m) => m.subject)[2]).toBe('【柠檬记监控】又出现了：监控连不上服务器');
    // 之后照常 6 小时一封“仍未恢复”
    for (let i = 0; i < 20; i++) {
      w.advance(15 * M);
      await w.tick();
    }
    expect(w.inbox).toHaveLength(3);
  });

  it('push-dispatch 短暂恢复后又真的停了：同样约 30 分钟发“又出现了”', async () => {
    const w = world();
    w.freshAll();
    w.setHeartbeat('push-dispatch', 6 * M);
    await w.tick();
    for (let i = 0; i < 2; i++) {
      w.advance(15 * M);
      w.freshAll();
      await w.tick();
    }
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】推送服务（push-dispatch）停了', '【柠檬记监控】已恢复：推送服务（push-dispatch）停了']);
    const stoppedAt = w.now;
    for (let i = 0; i < 2; i++) {
      w.advance(15 * M);
      w.freshAll();
      w.setHeartbeat('push-dispatch', w.now - stoppedAt);
      await w.tick();
    }
    expect(w.inbox.map((m) => m.subject)[2]).toBe('【柠檬记监控】又出现了：推送服务（push-dispatch）停了');
  });

  it('断 1 轮、通 2 轮这样抖 24 小时：冷却期里一封不发，每 6 小时多一对“告警 + 已恢复”，合计不超过 8 封', async () => {
    const w = world();
    for (let cycle = 0; cycle < 32; cycle++) {   // 每轮抖动 45 分钟，32 次 = 24 小时
      await blipThenRecover(w);
      w.advance(15 * M);
    }
    expect(w.inbox.length).toBeLessThanOrEqual(8);
    expect(w.inbox.some((m) => m.subject.includes('又出现了'))).toBe(false);
  });

  it('“已恢复”正文写着冷却规则', async () => {
    const w = world();
    await blipThenRecover(w);
    expect(w.inbox[1]?.text).toContain('只出现 1 轮（15 分钟）就消失的只记下、不发信；连续出现 2 轮（30 分钟）及以上会马上发一封“又出现了”');
  });
});

describe('K15 复审：20 封里 3 封留给“连不上服务器”和“推送停了”', () => {
  it('其他告警用满 17 封就发“已达上限”；之后连不上服务器、推送停了仍能发，共用到 20 封', async () => {
    const w = world();
    w.env.USAGE_CHECK = 'on';
    w.setUsage({ ok: true, items: Array.from({ length: 25 }, (_, i) => ({ key: `u${i}`, label: `u${i}`, pct: 99 })) });
    await w.daily();
    expect(w.inbox).toHaveLength(18);
    expect(w.inbox.at(-1)?.subject).toBe('【柠檬记监控】今天告警已达上限');
    // 推送停了：用保留额度
    w.freshAll();
    w.setHeartbeat('push-dispatch', 6 * M);
    await w.tick();
    expect(w.inbox.at(-1)?.subject).toBe('【柠檬记监控】推送服务（push-dispatch）停了');
    // 其他告警（ai-classify 停了）发不出去
    w.advance(15 * M);
    w.freshAll();
    w.setHeartbeat('push-dispatch', 20 * M);
    w.setHeartbeat('ai-classify', 16 * M);
    await w.tick();
    expect(w.inbox).toHaveLength(19);
    // 连不上服务器：用保留额度
    w.setMode('db_error');
    w.advance(15 * M);
    await w.tick();
    expect(w.inbox.at(-1)?.subject).toBe(DOWN);
    expect((JSON.parse(w.kv.get(BUDGET_KEY) ?? '{}') as { sent: number }).sent).toBe(19);
  });
});

describe('K15 复审：坏时间戳报“服务器数据异常”', () => {
  it('usage-report 回 500 bad_data：发“服务器数据异常”，不报“连不上服务器”', async () => {
    const w = world();
    w.setMode('bad_ts');
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】服务器数据异常']);
    w.setMode('ok');
    for (let i = 0; i < 2; i++) {
      w.advance(15 * M);
      w.freshAll();
      await w.tick();
    }
    expect(w.inbox.map((m) => m.subject)[1]).toBe('【柠檬记监控】已恢复：服务器数据异常');
  });
});
