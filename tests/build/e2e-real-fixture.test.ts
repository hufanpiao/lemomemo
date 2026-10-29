// e2e 真后端共用夹具的护栏（tests/e2e/real-backend.ts；需求记录 R-255，接手清单 E2E-REAL 第 4 步）
// 只测纯函数和“没设环境变量时一个请求都不发”；不起子进程、不连任何服务
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_ENV, assertE2eOrigins, assertLocalBackendUrl, createAccount, otpFromMailpit, realBackend, sessionKeyFor } from '../e2e/real-backend.ts';

describe('assertLocalBackendUrl：白名单，只许 127.0.0.1 的 55321、55324、8789', () => {
  it('lemo-e2e 的地址放行', () => {
    expect(assertLocalBackendUrl('http://127.0.0.1:55321', 'x').port).toBe('55321');
    expect(assertLocalBackendUrl('http://127.0.0.1:55324/', 'x').port).toBe('55324');
    expect(assertLocalBackendUrl('http://127.0.0.1:8789', 'x').port).toBe('8789');
  });

  it.each([
    ['http://127.0.0.1:54321', '本机 lemomemo 的 API'],
    ['http://127.0.0.1:54324', '本机 lemomemo 的 Mailpit'],
    ['http://127.0.0.1:54300', '543xx 下限'],
    ['http://127.0.0.1:54399', '543xx 上限'],
    ['http://127.0.0.1:58321', 'lemo-qadb'],
    ['http://127.0.0.1:55322', 'lemo-e2e 的数据库端口也不在白名单'],
    ['http://127.0.0.1:55323', '553xx 里没用到的'],
    ['http://127.0.0.1:8788', '无后端组的端口'],
    ['http://127.0.0.1:8790', '临时端口'],
    ['http://127.0.0.1:9198', '假 Supabase'],
    ['http://127.0.0.1:80', '默认端口'],
    ['http://localhost:55321', '主机名不是 127.0.0.1'],
    ['http://[::1]:55321', 'IPv6 本机也不许'],
    ['http://10.0.0.5:55321', '别的主机'],
    ['https://127.0.0.1:55321', '不是 http'],
    ['http://127.0.0.1', '没写端口'],
    ['not a url', '不是地址'],
  ])('%s 抛错（%s）', (url) => {
    expect(() => assertLocalBackendUrl(url, 'X')).toThrow();
  });
});

describe('没设环境变量：直接抛错，不发请求（不会去连 54321）', () => {
  const saved: Record<string, string | undefined> = {};
  const fetchSpy = vi.fn(() => Promise.reject(new Error('不该发请求')));
  beforeEach(() => {
    for (const k of Object.values(REAL_ENV)) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('realBackend()、createAccount()、otpFromMailpit() 都抛“没设”，fetch 一次没调', async () => {
    expect(() => realBackend()).toThrow(/没设 LEMO_E2E_SB_API/);
    await expect(createAccount()).rejects.toThrow(/没设 LEMO_E2E_SB_API/);
    await expect(otpFromMailpit('e2e-x@lemomemo.test')).rejects.toThrow(/没设 LEMO_E2E_MAILPIT_URL/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('环境变量指向 54321（别人的库）：抛错，也不发请求', async () => {
    process.env[REAL_ENV.api] = 'http://127.0.0.1:54321';
    process.env[REAL_ENV.anonKey] = 'x';
    process.env[REAL_ENV.serviceKey] = 'x';
    await expect(createAccount()).rejects.toThrow(/543xx/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('sessionKeyFor：和 supabase-js、src/platform/session.ts 的键名口径一致', () => {
  it('e2e-real 构建的 supabaseUrl → sb-127-auth-token', () => {
    expect(sessionKeyFor('http://127.0.0.1:8789/sb')).toBe('sb-127-auth-token');
    expect(sessionKeyFor('https://abcd.supabase.co')).toBe('sb-abcd-auth-token');
  });
});

describe('assertE2eOrigins：配置每次加载都查，API、SUPABASE_UPSTREAM 正好 55321，Mailpit 正好 55324', () => {
  const ok = { api: 'http://127.0.0.1:55321', upstream: 'http://127.0.0.1:55321', mailpit: 'http://127.0.0.1:55324' };
  it('lemo-e2e 的地址放行（结尾带不带 / 都行）', () => {
    expect(() => assertE2eOrigins(ok)).not.toThrow();
    expect(() => assertE2eOrigins({ ...ok, api: 'http://127.0.0.1:55321/', mailpit: 'http://127.0.0.1:55324/' })).not.toThrow();
  });
  it.each([
    ['api', 'http://127.0.0.1:54321'],
    ['api', 'http://127.0.0.1:55324'],
    ['api', 'http://127.0.0.1:8789'],
    ['api', 'http://localhost:55321'],
    ['api', 'http://127.0.0.1:55321/rest/v1'],
    ['upstream', 'http://127.0.0.1:54321'],
    ['upstream', 'https://abcd.supabase.co'],
    ['upstream', 'http://127.0.0.1:55321?x=1'],
    ['mailpit', 'http://127.0.0.1:55321'],
    ['mailpit', 'http://127.0.0.1:54324'],
    ['mailpit', ''],
  ])('%s = %s 拒', (k, v) => {
    expect(() => assertE2eOrigins({ ...ok, [k]: v })).toThrow();
  });
});
