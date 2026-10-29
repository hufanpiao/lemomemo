// tools/e2e/real-backend.mjs 里取状态（pickEnv）和边缘函数假值环境（E2E_FUNCTIONS_ENV、functionsEnvText）的单测，
// 从 e2e-real-backend.test.ts 原样拆出免超 max-lines（E2E-REAL ⑦，10-30），断言不变。
import { describe, expect, it } from 'vitest';
import { E2E_FUNCTIONS_ENV, functionsEnvText, pickEnv } from '../../tools/e2e/real-backend.mjs';
import { FAKE_PROXY_SECRET } from '../e2e/fake-values.ts';

describe('pickEnv', () => {
  const base = { API_URL: 'http://127.0.0.1:55321', ANON_KEY: 'a', SERVICE_ROLE_KEY: 's', MAILPIT_URL: 'http://127.0.0.1:55324' };

  it('挑出四个字段', () => {
    expect(pickEnv({ ...base, DB_URL: 'x' })).toEqual(base);
  });

  it('旧字段名 INBUCKET_URL 也认', () => {
    const { MAILPIT_URL, ...rest } = base;
    expect(pickEnv({ ...rest, INBUCKET_URL: MAILPIT_URL }).MAILPIT_URL).toBe(MAILPIT_URL);
  });

  it('缺字段抛错', () => {
    expect(() => pickEnv({ API_URL: base.API_URL })).toThrow(/ANON_KEY/);
  });

  it('API_URL 不是 55321（比如连到了 lemomemo 的 54321）就拒绝', () => {
    expect(() => pickEnv({ ...base, API_URL: 'http://127.0.0.1:54321' })).toThrow(/55321/);
  });
});

/** 某个小节下的 键 → 值原文 */

describe('边缘函数的假值环境 E2E_FUNCTIONS_ENV（第 6 步，10-30）', () => {
  it('PROXY_SECRET 和转发层用的 FAKE_PROXY_SECRET 一样（不一样函数就不信 x-proxy-secret）', () => {
    expect(E2E_FUNCTIONS_ENV.PROXY_SECRET).toBe(FAKE_PROXY_SECRET);
  });

  it('account 要的 RESEND_API_KEY 有（没有就 misconfigured），而且一看就是假的', () => {
    expect(E2E_FUNCTIONS_ENV.RESEND_API_KEY).toMatch(/^fake-.*e2e-only$/);
    for (const [k, v] of Object.entries(E2E_FUNCTIONS_ENV)) {
      if (/SECRET|KEY/.test(k)) expect(v, k).toMatch(/^fake-.*e2e-only$/);
    }
  });

  it('http、https 出站一律指向没人听的 127.0.0.1:9（大小写两种写法都设；10-30 审查建议 1）', () => {
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const) {
      expect(E2E_FUNCTIONS_ENV[k], k).toBe('http://127.0.0.1:9');
    }
  });

  it('NO_PROXY 只放行 npm 源和 lemo-e2e 内部地址（kong、库、本机），不含 resend', () => {
    const want = ['registry.npmjs.org', 'kong', 'supabase_kong_lemo-e2e', 'supabase_db_lemo-e2e', 'localhost', '127.0.0.1', 'host.docker.internal'];
    expect(E2E_FUNCTIONS_ENV.NO_PROXY.split(',')).toEqual(want);
    expect(E2E_FUNCTIONS_ENV.no_proxy).toBe(E2E_FUNCTIONS_ENV.NO_PROXY);
    expect(E2E_FUNCTIONS_ENV.NO_PROXY).not.toMatch(/resend|\*/);
  });

  it('不设 SUPABASE_ 开头的变量、不设 TURNSTILE_SECRET', () => {
    expect(Object.keys(E2E_FUNCTIONS_ENV).filter((k) => /^supabase_/i.test(k) || k === 'TURNSTILE_SECRET')).toEqual([]);
  });

  it('functionsEnvText 一行一个 KEY=VALUE，首行是注释', () => {
    const lines = functionsEnvText().trimEnd().split(String.fromCharCode(10));
    expect(lines[0]).toMatch(/^# /);
    expect(lines.slice(1)).toEqual(Object.entries(E2E_FUNCTIONS_ENV).map(([k, v]) => `${k}=${v}`));
  });

  it.each([
    [{ SUPABASE_URL: 'x' }, '变量名不认'],
    [{ 'A-B': 'x' }, '变量名不认'],
    [{ A: 'has space' }, '怪字符'],
    [{ A: 'q"uote' }, '怪字符'],
    [{ A: 'x#y' }, '怪字符'],
  ])('functionsEnvText(%o) 抛错', (vars, msg) => {
    expect(() => functionsEnvText(vars)).toThrow(msg);
  });
});
