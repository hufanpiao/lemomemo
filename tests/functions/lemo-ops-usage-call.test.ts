// lemo-ops 调 usage-report 的四种结果（接手清单 USAGE-REPORT-gateway-401，12ba238 已按做法 ② + ① 落地；11-04 协调方要求四种情况各钉一条）：
// 网关 401（返回体 UNAUTHORIZED_*）、函数自己的 401（{"error":"unauthorized"}）、正常 200、网络错误，全部经 callUsageReport。
// 返回体格式照 workers/lemo-ops/src/http.ts 的 classify401 注释和 tests/functions/lemo-ops-b2.test.ts 已用的真实格式。
import { describe, expect, it } from 'vitest';
import { callUsageReport, type FetchFn } from '../../workers/lemo-ops/src/http.ts';
import { readConfig } from '../../workers/lemo-ops/src/index.ts';
import { evaluateUnreachable } from '../../workers/lemo-ops/src/rules.ts';
import { M, world } from './lemo-ops-harness.ts';

const cfg = readConfig(world().env);
const reply = (status: number, text: string): FetchFn => async () => new Response(text, { status });

describe('callUsageReport：网关 401、函数 401、正常、网络错误分开', () => {
  it('网关 401（UNAUTHORIZED_*，请求没到函数）→ gateway_401，告警写“网关拒绝，查 verify_jwt 或 key”', async () => {
    const r = await callUsageReport(reply(401, '{"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}'), cfg, 'heartbeat', M);
    expect(r).toEqual({ ok: false, reason: 'gateway_401' });
    expect(evaluateUnreachable('gateway_401').active[0]?.lines[0]).toContain('网关拒绝，查 verify_jwt 或 key');
  });
  it('函数自己的 401（x-ops-secret 不对）→ fn_401，和网关 401 是两种原因', async () => {
    const r = await callUsageReport(reply(401, '{"error":"unauthorized"}'), cfg, 'heartbeat', M);
    expect(r).toEqual({ ok: false, reason: 'fn_401' });
    const line = evaluateUnreachable('fn_401').active[0]?.lines[0];
    expect(line).toContain('x-ops-secret 对不上');
    expect(line).not.toContain('网关拒绝');
  });
  it('正常 200 → ok，返回体原样交回', async () => {
    const body = { heartbeat: { 'push-dispatch': { at: 1 } } };
    expect(await callUsageReport(reply(200, JSON.stringify(body)), cfg, 'heartbeat', M)).toEqual({ ok: true, body });
  });
  it('网络错误（fetch 抛错）→ network，不是 401 那两种', async () => {
    const boom: FetchFn = async () => {
      throw new TypeError('fetch failed');
    };
    const r = await callUsageReport(boom, cfg, 'heartbeat', M);
    expect(r).toEqual({ ok: false, reason: 'network' });
    expect(evaluateUnreachable('network').active[0]?.lines[0]).toContain('网络出错');
  });
});
