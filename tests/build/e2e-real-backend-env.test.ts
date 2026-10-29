// tools/e2e/real-backend.mjs 里取状态（pickEnv）和边缘函数假值环境（E2E_FUNCTIONS_ENV、functionsEnvText）的单测，
// 从 e2e-real-backend.test.ts 原样拆出免超 max-lines（E2E-REAL ⑦，10-30），断言不变。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  E2E_FAKE_FN, E2E_FAKE_OUTBOUND, E2E_FN_ENV_RULES, E2E_FUNCTIONS_ENV, E2E_MAILPIT_INTERNAL_HOST, E2E_NO_PROXY_HOSTS,
  functionsEnvProblems, functionsEnvText, pickEnv, rewriteConfig, checkGuard,
} from '../../tools/e2e/real-backend.mjs';
import { FAKE_PROXY_SECRET } from '../e2e/fake-values.ts';
import { RESEND_EMAILS_URL, TURNSTILE_SITEVERIFY_URL, resolveOutboundUrl } from '../../supabase/functions/invite-signup/outbound.ts';

const ROOT = join(import.meta.dirname, '..', '..');

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

  it('NO_PROXY 只放行 npm 源和 lemo-e2e 内部地址（kong、库、Mailpit、本机），不含 resend、cloudflare', () => {
    const want = [
      'registry.npmjs.org', 'kong', 'supabase_kong_lemo-e2e', 'supabase_db_lemo-e2e', 'supabase_inbucket_lemo-e2e',
      'localhost', '127.0.0.1',
    ];
    expect(E2E_NO_PROXY_HOSTS).toEqual(want);
    expect(E2E_FUNCTIONS_ENV.NO_PROXY.split(',')).toEqual(want);
    expect(E2E_FUNCTIONS_ENV.no_proxy).toBe(E2E_FUNCTIONS_ENV.NO_PROXY);
    expect(E2E_FUNCTIONS_ENV.NO_PROXY).not.toMatch(/resend|cloudflare|\*/);
  });

  it('不设 SUPABASE_ 开头的变量；TURNSTILE_SECRET 是假值（invite-signup 没有它就 misconfigured，INVITE-mailpit）', () => {
    expect(Object.keys(E2E_FUNCTIONS_ENV).filter((k) => /^supabase_/i.test(k))).toEqual([]);
    expect(E2E_FUNCTIONS_ENV.TURNSTILE_SECRET).toMatch(/^fake-.*e2e-only$/);
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

describe('invite-signup 的假出站服务（INVITE-mailpit，10-30）', () => {
  it('两个出站地址指函数容器里的 127.0.0.1:8081/e2e-fake-outbound/…', () => {
    expect(E2E_FAKE_FN).toBe('e2e-fake-outbound');
    expect(E2E_FAKE_OUTBOUND).toEqual({
      TURNSTILE_SITEVERIFY_URL: 'http://127.0.0.1:8081/e2e-fake-outbound/siteverify',
      RESEND_EMAILS_URL: 'http://127.0.0.1:8081/e2e-fake-outbound/emails',
    });
    expect(E2E_FUNCTIONS_ENV.TURNSTILE_SITEVERIFY_URL).toBe(E2E_FAKE_OUTBOUND.TURNSTILE_SITEVERIFY_URL);
    expect(E2E_FUNCTIONS_ENV.RESEND_EMAILS_URL).toBe(E2E_FAKE_OUTBOUND.RESEND_EMAILS_URL);
  });

  it('函数那边认这两个值（本机环境：lemo-e2e 的 SUPABASE_URL 是 http://kong:8000）；正式、预览环境照样拒', () => {
    const pairs = [[E2E_FAKE_OUTBOUND.TURNSTILE_SITEVERIFY_URL, TURNSTILE_SITEVERIFY_URL], [E2E_FAKE_OUTBOUND.RESEND_EMAILS_URL, RESEND_EMAILS_URL]] as const;
    for (const [raw, official] of pairs) {
      expect(resolveOutboundUrl(raw, official, 'local')).toEqual({ ok: true, url: raw, overridden: true });
      expect(resolveOutboundUrl(raw, official, 'prod')).toEqual({ ok: false });
      expect(resolveOutboundUrl(raw, official, 'preview')).toEqual({ ok: false });
    }
  });

  it('假服务转 Mailpit 用的主机在 NO_PROXY 白名单里；源码里只有这一个出站地址', () => {
    const src = readFileSync(join(ROOT, 'tools', 'e2e', 'fake-outbound-fn.mjs'), 'utf8');
    const urls = src.match(/https?:\/\/[^\s'"`]+/g) ?? [];
    expect(urls).toEqual([`http://${E2E_MAILPIT_INTERNAL_HOST}:8025/api/v1/send`]);
    expect(E2E_NO_PROXY_HOSTS).toContain(E2E_MAILPIT_INTERNAL_HOST);
  });

  it('config 副本给假服务 verify_jwt = false（只这一个函数），改写幂等，副本照样过护栏', () => {
    const repoToml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
    const once = rewriteConfig(repoToml);
    const twice = rewriteConfig(once);
    const block = /\[functions\.e2e-fake-outbound\]\r?\nverify_jwt = false/;
    for (const t of [once, twice]) {
      expect(t.split('[functions.e2e-fake-outbound]').length).toBe(2);
      expect(t).toMatch(block);
      expect(checkGuard(t)).toEqual([]);
    }
    expect(repoToml).not.toContain('e2e-fake-outbound');
    // 小节已写成 verify_jwt = true 时改回 false，不重复加
    const flipped = rewriteConfig(`${repoToml}\n[functions.e2e-fake-outbound]\nverify_jwt = true\n`);
    expect(flipped.split('[functions.e2e-fake-outbound]').length).toBe(2);
    expect(flipped).toMatch(block);
  });
});

describe('函数环境护栏 functionsEnvProblems（INVITE-mailpit，10-30；E2E-guard-sugg2 ① 收紧）', () => {
  /** 在完整的 E2E_FUNCTIONS_ENV 上改几个键（值为 undefined 就删掉这个键） */
  const tweak = (vars: Record<string, string | undefined>) => {
    const out: Record<string, string> = { ...E2E_FUNCTIONS_ENV };
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out;
  };

  it('E2E_FUNCTIONS_ENV 原样放行；键正好是 E2E_FN_ENV_RULES 那些', () => {
    expect(functionsEnvProblems(E2E_FUNCTIONS_ENV)).toEqual([]);
    expect(Object.keys(E2E_FUNCTIONS_ENV).sort()).toEqual(Object.keys(E2E_FN_ENV_RULES).sort());
    expect(E2E_FN_ENV_RULES.PROXY_SECRET?.fixed).toBe(FAKE_PROXY_SECRET);
  });

  it.each([
    ['出站地址换了端口（55324）', { RESEND_EMAILS_URL: 'http://127.0.0.1:55324/api/v1/send' }, '必须正好是'],
    ['出站地址换了端口（54324，别人的 Mailpit）', { RESEND_EMAILS_URL: 'http://127.0.0.1:54324/e2e-fake-outbound/emails' }, '必须正好是'],
    ['出站地址换了主机', { TURNSTILE_SITEVERIFY_URL: 'http://host.docker.internal:8081/e2e-fake-outbound/siteverify' }, '必须正好是'],
    ['出站地址指到官方', { TURNSTILE_SITEVERIFY_URL: 'https://challenges.cloudflare.com/turnstile/v0/siteverify' }, '必须正好是'],
    ['表外的 _URL 变量', { OTHER_API_URL: 'http://127.0.0.1:8081/x' }, '键只许'],
    ['小写的表外 _url 变量', { resend_emails_url: 'http://127.0.0.1:8081/e2e-fake-outbound/emails' }, '键只许'],
    ['多一个不像地址的键', { FOO: 'bar' }, '键只许'],
    ['R2_ENDPOINT 指 host.docker.internal:54321（lemomemo）', { R2_ENDPOINT: 'http://host.docker.internal:54321' }, '键只许'],
    ['R2_ENDPOINT 指回环', { R2_ENDPOINT: 'http://127.0.0.1:55321' }, '键只许'],
    ['ALL_PROXY', { ALL_PROXY: 'http://127.0.0.1:9' }, 'ALL_PROXY 不许设'],
    ['all_proxy', { all_proxy: 'socks5://127.0.0.1:9' }, 'ALL_PROXY 不许设'],
    ['All_Proxy', { All_Proxy: 'http://127.0.0.1:9' }, 'ALL_PROXY 不许设'],
    ['大小写混写的代理键', { Https_Proxy: 'http://127.0.0.1:9' }, '键只许'],
    ['代理换了', { HTTPS_PROXY: 'http://127.0.0.1:8080' }, '127.0.0.1:9'],
    ['小写代理换了', { http_proxy: 'http://proxy.example.com:3128' }, '127.0.0.1:9'],
    ['小写 https_proxy 和大写不一致', { https_proxy: 'http://proxy.example.com:3128' }, 'https_proxy 和 HTTPS_PROXY 不一致'],
    ['小写 http_proxy 和大写不一致', { http_proxy: 'http://127.0.0.1:8080' }, 'http_proxy 和 HTTP_PROXY 不一致'],
    ['小写 no_proxy 和大写不一致（都在白名单里）', { no_proxy: 'kong' }, 'no_proxy 和 NO_PROXY 不一致'],
    ['少了大写代理（只剩小写）', { HTTPS_PROXY: undefined }, 'HTTPS_PROXY：缺了'],
    ['少了小写代理', { http_proxy: undefined }, 'http_proxy：缺了'],
    ['少了一个假密钥', { CRON_SECRET: undefined }, 'CRON_SECRET：缺了'],
    ['假密钥换成别的值', { RESEND_API_KEY: 're_live_123' }, '必须正好是'],
    ['NO_PROXY 多了 resend', { NO_PROXY: 'kong,api.resend.com' }, '白名单外'],
    ['NO_PROXY 里有 host.docker.internal', { NO_PROXY: `${E2E_FUNCTIONS_ENV.NO_PROXY},host.docker.internal` }, '白名单外的主机：host.docker.internal'],
    ['no_proxy 里有 host.docker.internal', { no_proxy: 'kong,host.docker.internal' }, '白名单外的主机：host.docker.internal'],
    ['NO_PROXY 有空项', { NO_PROXY: 'kong,,localhost' }, '白名单外'],
    ['no_proxy 是通配', { no_proxy: '*' }, '白名单外'],
  ])('%s：拒', (_what, vars, msg) => {
    const env = tweak(vars);
    const p = functionsEnvProblems(env);
    expect(p.some((x) => x.includes(msg)), p.join(' | ')).toBe(true);
    // 写 .env 时也拦（* 先被“怪字符”那道拦下，别的走护栏）
    expect(() => functionsEnvText(env)).toThrow(/函数环境护栏不放行|怪字符/);
  });
});

describe('invite-signup/index.ts 的出站地址接法（源码核对；INVITE-mailpit）', () => {
  const src = readFileSync(join(ROOT, 'supabase', 'functions', 'invite-signup', 'index.ts'), 'utf8');

  it('读 TURNSTILE_SITEVERIFY_URL、RESEND_EMAILS_URL，按 envKind 的环境解析，官方地址只从 outbound.ts 来', () => {
    expect(src).toContain("resolveOutboundUrl(Deno.env.get('TURNSTILE_SITEVERIFY_URL'), TURNSTILE_SITEVERIFY_URL, env)");
    expect(src).toContain("resolveOutboundUrl(Deno.env.get('RESEND_EMAILS_URL'), RESEND_EMAILS_URL, env)");
    expect(src).not.toMatch(/'https:\/\/(?:challenges\.cloudflare\.com|api\.resend\.com)/);
  });

  it('不合规：记 outbound_url_invalid、configured 为 false（core 回 500 misconfigured），不悄悄回落', () => {
    expect(src).toContain("if (!siteverify.ok || !emails.ok) log('outbound_url_invalid');");
    expect(src).toContain('configured: siteverify.ok && emails.ok,');
  });

  it('siteverify、发信都用解析出来的地址', () => {
    expect(src).toContain('postWithTimeout(siteverifyUrl,');
    expect(src).toContain('postWithTimeout(emailsUrl,');
  });
});
