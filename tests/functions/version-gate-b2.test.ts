// version-gate 的 B2 免查规则（S-B2 P0，TC-B2-27；架构 0.49 第 2 条、第 75 条、5.3）：
//   DELETE /rest/v1/devices（退出登录时删本机这台的行，连带推送订阅）、POST /rest/v1/rpc/claim_endpoint（换账号后认领推送）。
// 都是精确路径、只免这一个方法；低版本客户端调这两条不被 426 挡，同前缀、别的方法、别的表照样挡。后端提改动，前端 B 会审
import { describe, expect, it } from 'vitest';
import { createVersionGate, EXEMPT_RULES, needsVersionCheck } from '../../functions/sb/version-gate.ts';

function headers(v?: string): Headers {
  const h = new Headers();
  if (v !== undefined) h.set('X-App-Version', v);
  return h;
}

describe('B2 免查：DELETE /rest/v1/devices、POST /rest/v1/rpc/claim_endpoint', () => {
  it('两条都是精确路径、只免一个方法', () => {
    const b2 = EXEMPT_RULES.filter((r) => r.path === '/rest/v1/devices' || r.path === '/rest/v1/rpc/claim_endpoint');
    expect(b2.map((r) => [r.method, r.path, r.match])).toEqual([
      ['DELETE', '/rest/v1/devices', 'exact'],
      ['POST', '/rest/v1/rpc/claim_endpoint', 'exact'],
    ]);
  });

  it.each([
    ['DELETE', '/rest/v1/devices'],
    ['delete', '/rest/v1/devices'],
    ['POST', '/rest/v1/rpc/claim_endpoint'],
  ])('%s %s → 不查', (m, p) => {
    expect(needsVersionCheck(m, p)).toBe(false);
  });

  it.each([
    // devices 的其他写方法照查（改 label、加行都要新版）
    ['POST', '/rest/v1/devices'],
    ['PATCH', '/rest/v1/devices'],
    ['PUT', '/rest/v1/devices'],
    // 同前缀、尾斜杠、大小写
    ['DELETE', '/rest/v1/devices/'],
    ['DELETE', '/rest/v1/devices_x'],
    ['DELETE', '/rest/v1/device'],
    ['DELETE', '/rest/v1/DEVICES'],
    // 别的表的 DELETE 照查
    ['DELETE', '/rest/v1/todos'],
    ['DELETE', '/rest/v1/sessions'],
    // claim_endpoint 只免 POST、只认整条路径
    ['POST', '/rest/v1/rpc/claim_endpoint_impl'],
    ['POST', '/rest/v1/rpc/claim_endpoint/'],
    ['POST', '/rest/v1/rpc/claim_endpoints'],
    ['POST', '/rest/v1/rpc/CLAIM_ENDPOINT'],
    ['PATCH', '/rest/v1/rpc/claim_endpoint'],
    ['DELETE', '/rest/v1/rpc/claim_endpoint'],
    ['POST', '/rest/v1/claim_endpoint'],
  ])('%s %s → 查', (m, p) => {
    expect(needsVersionCheck(m, p)).toBe(true);
  });

  it('低版本客户端（4.0.0 < 最低 9.0.0）：两条不被 426 挡；同前缀、别的方法照样挡', async () => {
    const gate = createVersionGate({ loadMin: async () => '9.0.0' });
    const old = headers('4.0.0');
    expect(await gate.check('DELETE', '/rest/v1/devices', old)).toEqual({ action: 'pass' });
    expect(await gate.check('POST', '/rest/v1/rpc/claim_endpoint', old)).toEqual({ action: 'pass' });
    expect(await gate.check('DELETE', '/rest/v1/devices', headers())).toEqual({ action: 'pass' });
    expect(await gate.check('PATCH', '/rest/v1/devices', old)).toEqual({ action: 'block', min: '9.0.0' });
    expect(await gate.check('DELETE', '/rest/v1/todos', old)).toEqual({ action: 'block', min: '9.0.0' });
    expect(await gate.check('POST', '/rest/v1/rpc/claim_endpoint_impl', old)).toEqual({ action: 'block', min: '9.0.0' });
    expect(await gate.check('POST', '/rest/v1/rpc/claim_endpoint/', old)).toEqual({ action: 'block', min: '9.0.0' });
  });
});
