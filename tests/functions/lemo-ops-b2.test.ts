// lemo-ops 的 B2 改动（任务单 O-3；架构审 D2 ①、D3 第 4 点）：
// ① 推送失败比例加 claimed：claimed − sent 当成“没发成”，和“失败过半”同一条规则（没有 claimed 时照旧用 sent、failed）；
// ② 网关回的 401（UNAUTHORIZED_*）和 usage-report 自己回的 401（{"error":"unauthorized"}）分开报；
// ③ 调 usage-report 不再带 anon Bearer（Authorization 头一律不发），只靠 x-ops-secret。
// claimed 的字段名、usage-report 白名单含 claimed：11-03 push-dispatch 落地后已核对（见 rules.ts 的 PUSH_DETAIL_FIELDS 注释；对齐测试在 tests/edge/push-dispatch.test.ts 末尾）。
import { describe, expect, it } from 'vitest';
import { callUsageReport, classify401, type FetchFn } from '../../workers/lemo-ops/src/http.ts';
import { readConfig } from '../../workers/lemo-ops/src/index.ts';
import { evaluatePush, evaluateUnreachable, HEARTBEAT_LIMITS, HEARTBEAT_SCOPES, PUSH_DETAIL_FIELDS } from '../../workers/lemo-ops/src/rules.ts';
import { M, world } from './lemo-ops-harness.ts';

describe('O-3 ①：push-dispatch 规则对一遍任务单的口径', () => {
  it('心跳超过 5 分钟告警', () => {
    expect(HEARTBEAT_LIMITS['push-dispatch']?.limitS).toBe(5 * 60);
  });

  it('detail 字段：claimed、sent、failed', () => {
    expect([...PUSH_DETAIL_FIELDS]).toEqual(['claimed', 'sent', 'failed']);
  });

  it.each([
    // [detail, 告警吗]
    [{ claimed: 10, sent: 5, failed: 5 }, false], // 刚好一半不报
    [{ claimed: 10, sent: 4, failed: 6 }, true],
    [{ claimed: 10, sent: 4, failed: 0 }, true], // 失败数是 0，但认领了没发出：照“失败过半”同一条规则看（D3 第 4 点）
    [{ claimed: 10, sent: 6, failed: 0 }, false],
    [{ claimed: 0, sent: 0, failed: 0 }, false],
    [{ claimed: 1, sent: 0 }, true], // 没有 failed 也照判
    [{ claimed: 3, sent: 5, failed: 0 }, 'bad'], // claimed < sent：坏数据，不判失败比例，单独报“推送心跳数据异常”（S5）
  ] as const)('有 claimed：%o → %s', (detail, want) => {
    const r = evaluatePush(detail);
    if (want === 'bad') {
      expect(r?.key).toBe('push-bad-data');
      expect(r?.title).toBe('推送心跳数据异常');
      return;
    }
    expect(r !== null).toBe(want === true);
    if (r) {
      expect(r.key).toBe('push-failed');
      expect(r.title).toBe('推送一轮里超过一半失败');
      expect(r.lines[0]).toContain(`认领 ${detail.claimed} 条、成功 ${detail.sent} 条`);
    }
  });

  // B2 代码审查 S5：claimed < sent 不能悄悄吞掉
  it('claimed < sent：单独一件“推送心跳数据异常”，正文写出两个数，不当成“失败过半”；数据恢复正常后能报“已恢复”（在心跳的检查范围里）', () => {
    const r = evaluatePush({ claimed: 3, sent: 5 });
    expect(r?.key).toBe('push-bad-data');
    expect(r?.lines.join('\n')).toContain('认领 3 条、成功 5 条');
    expect(r?.lines.join('\n')).not.toContain('超过一半');
    expect(HEARTBEAT_SCOPES).toContain('push-bad-data');
  });

  it('经真的 usage-report/core.ts 走一遍：claimed < sent 时发“推送心跳数据异常”，下一轮正常了发“已恢复”', async () => {
    const w = world();
    w.freshAll();
    w.setPushDetail({ claimed: 3, sent: 5, failed: 0 });
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】推送心跳数据异常']);
    expect(w.inbox[0]?.text).toContain('认领 3 条、成功 5 条');
    // 连续 2 轮正常才发“已恢复”（alerts.ts）
    for (let i = 0; i < 2; i++) {
      w.advance(15 * M);
      w.freshAll();
      w.setPushDetail({ claimed: 5, sent: 5, failed: 0 });
      await w.tick();
    }
    expect(w.inbox).toHaveLength(2);
    expect(`${w.inbox[1]?.subject ?? ''}\n${w.inbox[1]?.text ?? ''}`).toContain('推送心跳数据异常');
  });

  it('认领了没发出的条数写进正文；提醒换钥匙后一段时间失败过半是预期内的', () => {
    const r = evaluatePush({ claimed: 10, sent: 2, failed: 5 });
    expect(r?.lines.join('\n')).toContain('有 3 条认领了却没发出');
    expect(r?.lines.join('\n')).toContain('刚换过 VAPID 钥匙');
    const onlyFailed = evaluatePush({ claimed: 10, sent: 2, failed: 8 });
    expect(onlyFailed?.lines.join('\n')).not.toContain('认领了却没发出');
  });

  it('没有 claimed（旧版函数、usage-report 白名单还没加）：照旧 failed × 2 > sent + failed', () => {
    expect(evaluatePush({ sent: 5, failed: 5 })).toBeNull();
    expect(evaluatePush({ sent: 4, failed: 6 })?.lines).toEqual(['最近一轮成功 4 条、失败 6 条。']);
    expect(evaluatePush(null)).toBeNull();
    expect(evaluatePush({ sent: '4', failed: 6 })).toBeNull();
  });

  it('经真的 usage-report/core.ts 走一遍：旧口径照常告警', async () => {
    const w = world();
    w.freshAll();
    w.setPushDetail({ claimed: 10, sent: 4, failed: 6 });
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】推送一轮里超过一半失败']);
    // usage-report 的 DETAIL_FIELDS 现在没有 claimed（归后端加）：走到 lemo-ops 的是旧口径。加了以后这一行会变成“认领 10 条”
    expect(w.inbox[0]?.text).toMatch(/成功 4 条、失败 6 条|认领 10 条、成功 4 条/u);
  });
});

describe('O-3 ②：网关 401 和函数 401 分开报', () => {
  it.each([
    ['{"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}', 'gateway_401'],
    ['{"code":"UNAUTHORIZED_INVALID_JWT_FORMAT","message":"Invalid JWT"}', 'gateway_401'],
    ['{"msg":"blocked: UNAUTHORIZED_LEGACY_API_KEY"}', 'gateway_401'],
    ['{"error":"unauthorized"}', 'fn_401'],
    ['{"message":"Invalid JWT"}', 'http_401'],
    ['Unauthorized', 'http_401'],
  ])('%s → %s', (text, want) => {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    expect(classify401(text, body)).toBe(want);
  });

  it('邮件正文：网关拒绝写“查 verify_jwt 或 key”，函数拒绝写 x-ops-secret；标题同一件事（换原因不算新的一件）', () => {
    const g = evaluateUnreachable('gateway_401').active[0];
    const f = evaluateUnreachable('fn_401').active[0];
    expect(g?.lines[0]).toContain('网关拒绝，查 verify_jwt 或 key');
    expect(f?.lines[0]).toContain('x-ops-secret 对不上');
    expect(g?.title).toBe(f?.title);
    expect(g?.key).toBe(f?.key);
  });

  it('经真的 usage-report/core.ts：OPS_SECRET 不对时报“函数自己回 401”', async () => {
    const w = world();
    w.freshAll();
    w.env.OPS_SECRET = 'wrong-ops-secret-xxxxxxxxxxxxxxxxxxxxxxx';
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】监控连不上服务器']);
    expect(w.inbox[0]?.text).toContain('usage-report 自己回 401');
    expect(w.inbox[0]?.text).not.toContain('wrong-ops-secret');
  });
});

describe('O-3 ③：调 usage-report 不再带 anon Bearer', () => {
  const cfg = readConfig(world().env);
  const stub = (status: number, text: string) => {
    const seen: Headers[] = [];
    const fn: FetchFn = async (_url, init) => {
      seen.push(new Headers(init.headers));
      return new Response(text, { status });
    };
    return { fn, seen };
  };

  it('请求头：有 x-ops-secret，没有 Authorization', async () => {
    const s = stub(200, '{"ok":true}');
    expect(await callUsageReport(s.fn, cfg, 'heartbeat', M)).toEqual({ ok: true, body: { ok: true } });
    const h = s.seen[0];
    expect(h?.get('x-ops-secret')).toBe(cfg.opsSecret);
    expect(h?.has('authorization')).toBe(false);
  });

  it('网关 401、函数 401 经 callUsageReport 分别得到 gateway_401、fn_401', async () => {
    expect(await callUsageReport(stub(401, '{"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}').fn, cfg, 'heartbeat', M)).toEqual({ ok: false, reason: 'gateway_401' });
    expect(await callUsageReport(stub(401, '{"error":"unauthorized"}').fn, cfg, 'heartbeat', M)).toEqual({ ok: false, reason: 'fn_401' });
    expect(await callUsageReport(stub(403, '{"error":"unauthorized"}').fn, cfg, 'heartbeat', M)).toEqual({ ok: false, reason: 'http_403' });
  });
});
