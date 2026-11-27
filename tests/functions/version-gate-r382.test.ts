// version-gate 的 R-382 免查（架构 4.1a 第 4 点）：POST /rest/v1/rpc/session_fate。登录过期的设备用 anon key 查会话是不是被吊销，
// 旧版被 426 挡住就分不出“被移除”和“登录过期”。精确路径、只免 POST；revoke_my_sessions（新版才有的“退出其他所有设备”）照查。后端提改动，前端 B 会审
import { describe, expect, it } from 'vitest';
import { createVersionGate, EXEMPT_RULES, needsVersionCheck } from '../../functions/sb/version-gate.ts';

describe('R-382 免查：POST /rest/v1/rpc/session_fate', () => {
  it('只有一条，精确路径、只免 POST', () => {
    expect(EXEMPT_RULES.filter((r) => r.path.includes('session_fate')).map((r) => [r.method, r.path, r.match])).toEqual([
      ['POST', '/rest/v1/rpc/session_fate', 'exact'],
    ]);
  });
  // GET 本来就不查（读请求一律放行），这里只列 POST
  it.each([['POST', '/rest/v1/rpc/session_fate'], ['post', '/rest/v1/rpc/session_fate'], ['GET', '/rest/v1/rpc/session_fate']])('%s %s → 不查', (m, p) => {
    expect(needsVersionCheck(m, p)).toBe(false);
  });
  it.each([
    ['PATCH', '/rest/v1/rpc/session_fate'],
    ['POST', '/rest/v1/rpc/session_fate/'],
    ['POST', '/rest/v1/rpc/session_fate_impl'],
    ['POST', '/rest/v1/rpc/session_fatex'],
    ['POST', '/rest/v1/rpc/SESSION_FATE'],
    ['POST', '/rest/v1/rpc/revoke_my_sessions'],
  ])('%s %s → 查', (m, p) => {
    expect(needsVersionCheck(m, p)).toBe(true);
  });
  it('旧版调 session_fate 放行，同前缀别的路径照挡', async () => {
    const gate = createVersionGate({ loadMin: async () => '9.0.0' });
    const old = new Headers({ 'X-App-Version': '4.0.0' });
    expect(await gate.check('POST', '/rest/v1/rpc/session_fate', old)).toEqual({ action: 'pass' });
    expect(await gate.check('POST', '/rest/v1/rpc/revoke_my_sessions', old)).toEqual({ action: 'block', min: '9.0.0' });
  });
});
