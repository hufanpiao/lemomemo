// version-gate 的 B3 免查（S-B3 免查名单 P0，TC-B3-23；架构 0.27 第 1 点免查名单）：
//   PATCH /rest/v1/api_tokens（设置里“断开连接”只改 revoked_at，由库里的 guard_token_revoke 管）、POST /functions/v1/claude-intake（add.ps1 带连接码调）。
// 都是精确路径、只免这一个方法；低版本客户端调这两条不被 426 挡，同前缀、别的方法、别的表照样挡。后端提改动，前端 B 会审
import { describe, expect, it } from 'vitest';
import { createVersionGate, EXEMPT_FUNCTIONS, EXEMPT_RULES, needsVersionCheck } from '../../functions/sb/version-gate.ts';

function headers(v?: string): Headers {
  const h = new Headers();
  if (v !== undefined) h.set('X-App-Version', v);
  return h;
}

describe('B3 免查：PATCH /rest/v1/api_tokens、POST /functions/v1/claude-intake', () => {
  it('api_tokens 一条是精确路径、只免 PATCH；claude-intake 只免 POST', () => {
    expect(EXEMPT_RULES.filter((r) => r.path.includes('api_tokens')).map((r) => [r.method, r.path, r.match])).toEqual([
      ['PATCH', '/rest/v1/api_tokens', 'exact'],
    ]);
    expect(EXEMPT_FUNCTIONS.filter((f) => f.name === 'claude-intake').map((f) => [...f.methods])).toEqual([['POST']]);
  });

  it.each([
    ['PATCH', '/rest/v1/api_tokens'],
    ['patch', '/rest/v1/api_tokens'],
    ['POST', '/functions/v1/claude-intake'],
  ])('%s %s → 不查', (m, p) => {
    expect(needsVersionCheck(m, p)).toBe(false);
  });

  it.each([
    // api_tokens 别的写方法照查（新建连接码走 token-admin，删行没有授权，都要新版）
    ['POST', '/rest/v1/api_tokens'],
    ['PUT', '/rest/v1/api_tokens'],
    ['DELETE', '/rest/v1/api_tokens'],
    // 同前缀、尾斜杠、大小写、别的表
    ['PATCH', '/rest/v1/api_tokens/'],
    ['PATCH', '/rest/v1/api_tokens_x'],
    ['PATCH', '/rest/v1/api_token'],
    ['PATCH', '/rest/v1/API_TOKENS'],
    ['PATCH', '/rest/v1/todos'],
    ['PATCH', '/rest/v1/profiles'],
    // claude-intake 只免 POST；token-admin、ai-parse 照查
    ['GET', '/functions/v1/claude-intake'],
    ['PUT', '/functions/v1/claude-intake'],
    ['POST', '/functions/v1/claude-intake-x'],
    ['POST', '/functions/v1/token-admin'],
    ['POST', '/functions/v1/ai-parse'],
    ['POST', '/functions/v1/ai-voice'],
  ])('%s %s → 查', (m, p) => {
    expect(needsVersionCheck(m, p)).toBe(true);
  });

  it('前端 B 会审：POST /functions/v1/claude-intake/任意子路径 也免查（和 account 同一套函数名前缀机制）；子路径换别的方法照查', async () => {
    for (const p of ['/functions/v1/claude-intake/', '/functions/v1/claude-intake/x', '/functions/v1/claude-intake/a/b']) {
      expect(needsVersionCheck('POST', p), p).toBe(false);
      expect(needsVersionCheck('GET', p), p).toBe(true);
    }
    const gate = createVersionGate({ loadMin: async () => '9.0.0' });
    expect(await gate.check('POST', '/functions/v1/claude-intake/anything', headers('4.0.0'))).toEqual({ action: 'pass' });
    expect(await gate.check('PUT', '/functions/v1/claude-intake/anything', headers('4.0.0'))).toEqual({ action: 'block', min: '9.0.0' });
  });

  it('TC-B3-23：低版本客户端（4.0.0 < 最低 9.0.0）：两条不被 426 挡；同前缀、别的方法、别的函数照样挡', async () => {
    const gate = createVersionGate({ loadMin: async () => '9.0.0' });
    const old = headers('4.0.0');
    expect(await gate.check('PATCH', '/rest/v1/api_tokens', old)).toEqual({ action: 'pass' });
    expect(await gate.check('POST', '/functions/v1/claude-intake', old)).toEqual({ action: 'pass' });
    expect(await gate.check('POST', '/functions/v1/claude-intake', headers())).toEqual({ action: 'pass' });
    expect(await gate.check('DELETE', '/rest/v1/api_tokens', old)).toEqual({ action: 'block', min: '9.0.0' });
    expect(await gate.check('PATCH', '/rest/v1/api_tokens_x', old)).toEqual({ action: 'block', min: '9.0.0' });
    expect(await gate.check('POST', '/functions/v1/token-admin', old)).toEqual({ action: 'block', min: '9.0.0' });
  });
});
