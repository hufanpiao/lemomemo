// invite-signup 出站地址可配（接手清单 INVITE-mailpit，10-30）：supabase/functions/invite-signup/outbound.ts 的 resolveOutboundUrl，
// index.ts 的接法（读哪两个变量、不合规时当没配好）是源码核对，要读文件，放在 tests/build/e2e-real-backend-env.test.ts（本目录是 Workers 类型）。
// 口径：不设 / 空串 → 官方地址（和改之前一样）；全空白任何环境都拒（D4）；一字不差的官方地址任何环境都认；
// 回环地址（原文字面写 127.0.0.1 或 localhost，localhost 不分大小写；http 或 https）只有本机环境认（D5）；
// 原文任何位置有空白或控制字符（首尾、中间；空格、\t、\n、\r、U+3000、NBSP、U+0000–U+001F、U+007F）任何环境都拒，官方地址、回环地址一样；回环地址端口写成 0（:0、:00、:000）也拒；官方地址只认一字不差（前后空白、换行、大小写不同都拒，各环境一样）；
// 其余一律拒（选的是“直接拒”：index.ts 回 500 misconfigured，不悄悄回落到官方地址）。
import { describe, expect, it } from 'vitest';
import {
  LOOPBACK_HOSTS, RESEND_EMAILS_URL, TURNSTILE_SITEVERIFY_URL, resolveOutboundUrl,
} from '../../supabase/functions/invite-signup/outbound.ts';
import type { EnvKind } from '../../supabase/functions/_shared/env-kind.ts';

const ENVS: EnvKind[] = ['prod', 'preview', 'local'];
const OFFICIAL = [TURNSTILE_SITEVERIFY_URL, RESEND_EMAILS_URL];

describe('官方默认值（线上不设变量时和改之前完全一样）', () => {
  it('两个官方地址一字不差', () => {
    expect(TURNSTILE_SITEVERIFY_URL).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(RESEND_EMAILS_URL).toBe('https://api.resend.com/emails');
  });

  it.each(ENVS)('%s：不设、空串 → 官方地址，不算改过', (env) => {
    for (const official of OFFICIAL) {
      for (const raw of [undefined, '']) {
        expect(resolveOutboundUrl(raw, official, env)).toEqual({ ok: true, url: official, overridden: false });
      }
    }
  });

  it.each(ENVS)('%s：全空白（空格、制表符、换行）不算没设，拒（D4）', (env) => {
    for (const official of OFFICIAL) {
      for (const raw of ['   ', '\t', '\n', ' \t\r\n ']) {
        expect(resolveOutboundUrl(raw, official, env), JSON.stringify(raw)).toEqual({ ok: false });
      }
    }
  });

  it.each(ENVS)('%s：设成一字不差的官方地址也认（就是官方地址）', (env) => {
    for (const official of OFFICIAL) expect(resolveOutboundUrl(official, official, env)).toEqual({ ok: true, url: official, overridden: false });
  });

  it.each(ENVS)('%s：官方地址前后多了空白或换行，不算一字不差，拒', (env) => {
    for (const official of OFFICIAL) {
      for (const raw of [`${official}\n`, `${official}\r\n`, `${official} `, ` ${official}`]) {
        expect(resolveOutboundUrl(raw, official, env), `${env} ${JSON.stringify(raw)}`).toEqual({ ok: false });
      }
    }
  });

  it.each(ENVS)('%s：官方地址大小写不同（HTTPS://、主机大写）不算一字不差，拒', (env) => {
    for (const [raw, official] of [
      ['HTTPS://api.resend.com/emails', RESEND_EMAILS_URL],
      ['https://API.RESEND.COM/emails', RESEND_EMAILS_URL],
      ['https://api.resend.com/EMAILS', RESEND_EMAILS_URL],
      ['HTTPS://challenges.cloudflare.com/turnstile/v0/siteverify', TURNSTILE_SITEVERIFY_URL],
    ] as const) {
      expect(resolveOutboundUrl(raw, official, env), `${env} ${raw}`).toEqual({ ok: false });
    }
  });
});

describe('本机环境可以换成回环地址', () => {
  it('回环主机只有 127.0.0.1、localhost', () => {
    expect(LOOPBACK_HOSTS).toEqual(['127.0.0.1', 'localhost']);
  });

  it.each([
    ['http://127.0.0.1:8081/e2e-fake-outbound/siteverify', 'http://127.0.0.1:8081/e2e-fake-outbound/siteverify'],
    ['http://localhost:9000/emails', 'http://localhost:9000/emails'],
    ['https://127.0.0.1/x', 'https://127.0.0.1/x'],
    ['http://LOCALHOST:1/a', 'http://localhost:1/a'],
    ['HTTP://LocalHost/a', 'http://localhost/a'],
    ['http://127.0.0.1', 'http://127.0.0.1/'],
    ['http://localhost?x=1', 'http://localhost/?x=1'],
  ])('local：%s → 认（规范化成 %s）', (raw, url) => {
    expect(resolveOutboundUrl(raw, RESEND_EMAILS_URL, 'local')).toEqual({ ok: true, url, overridden: true });
  });

  it('回归：e2e 假出站服务的地址照样放行（tools/e2e/real-backend.mjs 写的就是它）', () => {
    const raw = 'http://127.0.0.1:8081/e2e-fake-outbound/siteverify';
    expect(resolveOutboundUrl(raw, TURNSTILE_SITEVERIFY_URL, 'local')).toEqual({ ok: true, url: raw, overridden: true });
  });

  it.each(ENVS)('%s：回环地址首尾带空白（末尾 \\n、\\r\\n、空格，前面空格、\\t）一律拒', (env) => {
    for (const base of ['http://127.0.0.1:8081/e2e-fake-outbound/siteverify', 'http://localhost:9000/emails']) {
      expect(resolveOutboundUrl(base, TURNSTILE_SITEVERIFY_URL, 'local')).toEqual({ ok: true, url: base, overridden: true });
      for (const raw of [`${base}\n`, `${base}\r\n`, `${base} `, ` ${base}`, `\t${base}`]) {
        expect(new URL(raw).href, JSON.stringify(raw)).toBe(base);
        expect(resolveOutboundUrl(raw, TURNSTILE_SITEVERIFY_URL, env), `${env} ${JSON.stringify(raw)}`).toEqual({ ok: false });
      }
    }
  });

  it.each([
    'http://127.0.0.1:0/',
    'http://localhost:0/x',
    'http://127.0.0.1:00/',
    'https://localhost:000',
    'http://127.0.0.1:000/x',
    'http://localhost:00/x',
    'http://LOCALHOST:0/a',
    'http://127.0.0.1:0?x=1',
  ])('local：端口写成 0（%s）肯定连不上，误配，拒', (raw) => {
    expect(new URL(raw).port).toBe('0');
    expect(resolveOutboundUrl(raw, TURNSTILE_SITEVERIFY_URL, 'local')).toEqual({ ok: false });
  });

  it.each([
    ['http://127.0.0.1:8081/e2e-fake-outbound/siteverify', 'http://127.0.0.1:8081/e2e-fake-outbound/siteverify'],
    ['http://127.0.0.1:10/a', 'http://127.0.0.1:10/a'],
    ['http://localhost:65535/a', 'http://localhost:65535/a'],
    ['http://127.0.0.1:080/a', 'http://127.0.0.1/a'],
  ])('local：非 0 端口（%s）照旧放行，不被端口 0 的规则误伤', (raw, url) => {
    expect(resolveOutboundUrl(raw, TURNSTILE_SITEVERIFY_URL, 'local')).toEqual({ ok: true, url, overridden: true });
  });

  it.each([
    ['127.1 简写', 'http://127.1:8081/a'],
    ['十进制整数', 'http://2130706433/x'],
    ['十六进制', 'http://0x7f000001/x'],
    ['全角数字', 'http://１２７.0.0.1/x'],
    ['百分号编码', 'http://%31%32%37.0.0.1/x'],
    ['末尾带点', 'http://127.0.0.1./x'],
    ['末尾带点的 localhost', 'http://localhost./x'],
    ['前面带空白', ' http://127.0.0.1/x'],
  ])('local：%s（%s）解析后虽是回环，原文不是字面写法，拒（D5）', (_what, raw) => {
    expect(new URL(raw.trim()).hostname).toMatch(/^(?:127\.0\.0\.1|localhost)\.?$/);
    expect(resolveOutboundUrl(raw, RESEND_EMAILS_URL, 'local')).toEqual({ ok: false });
  });
});

describe('不合规一律拒（{ok: false}，index.ts 当没配好回 misconfigured）', () => {
  it.each([
    ['端口中间夹 \\t（解析后会变成 8081）', 'http://127.0.0.1:80\t81/x', 'http://127.0.0.1:8081/x'],
    ['路径中间夹 \\n（解析后会被删掉）', 'http://127.0.0.1:8081/e\nx', 'http://127.0.0.1:8081/ex'],
    ['端口后面夹 \\t（解析后会被删掉）', 'http://127.0.0.1:8081\t/x', 'http://127.0.0.1:8081/x'],
    ['路径中间夹 \\r', 'http://localhost:9000/em\rails', 'http://localhost:9000/emails'],
  ])('原文中间有空白或控制字符：%s，任何环境都拒', (_what, raw, parsed) => {
    expect(new URL(raw).href).toBe(parsed);
    for (const env of ENVS) expect(resolveOutboundUrl(raw, TURNSTILE_SITEVERIFY_URL, env), `${env} ${JSON.stringify(raw)}`).toEqual({ ok: false });
  });

  it.each([
    ['全角空格 U+3000', '　'],
    ['不换行空格 NBSP U+00A0', ' '],
    ['普通空格', ' '],
    ['NUL U+0000', '\u0000'],
    ['ESC U+001B', '\u001b'],
    ['DEL U+007F', '\u007f'],
  ])('原文中间夹 %s：回环地址、官方地址都拒，任何环境', (_what, ch) => {
    const cases = [
      [`http://127.0.0.1:8081/e2e${ch}-fake-outbound/siteverify`, TURNSTILE_SITEVERIFY_URL],
      [`http://localhost:9000/${ch}emails`, RESEND_EMAILS_URL],
      [`https://api.resend.com/em${ch}ails`, RESEND_EMAILS_URL],
    ] as const;
    for (const [raw, official] of cases) {
      for (const env of ENVS) expect(resolveOutboundUrl(raw, official, env), `${env} ${JSON.stringify(raw)}`).toEqual({ ok: false });
    }
  });

  it.each(['prod', 'preview'] as const)('%s：回环地址也拒（线上主机的 localhost 是平台内部服务）', (env) => {
    for (const raw of ['http://127.0.0.1:8081/e2e-fake-outbound/emails', 'http://localhost/emails', 'https://127.0.0.1/x']) {
      expect(resolveOutboundUrl(raw, RESEND_EMAILS_URL, env), raw).toEqual({ ok: false });
    }
  });

  it.each([
    ['别的主机', 'https://evil.example.com/emails'],
    ['官方主机换路径', 'https://api.resend.com/emails/x'],
    ['官方地址多斜杠', 'https://api.resend.com/emails/'],
    ['官方地址带空白', ' https://api.resend.com/emails'],
    ['另一个官方地址（串了）', TURNSTILE_SITEVERIFY_URL],
    ['像回环的域名', 'http://localhost.example.com/emails'],
    ['回环前缀的域名', 'http://127.0.0.1.nip.io/emails'],
    ['带用户名', 'http://user@127.0.0.1/emails'],
    ['带用户名密码伪装主机', 'http://127.0.0.1:x@evil.example.com/emails'],
    ['IPv6 回环（不在名单）', 'http://[::1]/emails'],
    ['127.0.0.2', 'http://127.0.0.2/emails'],
    ['0.0.0.0', 'http://0.0.0.0/emails'],
    ['host.docker.internal', 'http://host.docker.internal:55330/emails'],
    ['别的协议', 'ftp://127.0.0.1/emails'],
    ['file 协议', 'file:///etc/passwd'],
    ['解析不了', 'not a url'],
    ['只有主机名', '127.0.0.1:8081'],
    ['写 kong（envKind 认它是本机，出站不认）', 'http://kong:8000/functions/v1/e2e-fake-outbound/emails'],
    ['十进制整数', 'http://2130706433/x'],
    ['百分号编码', 'http://%31%32%37.0.0.1/x'],
  ])('%s（%s）：任何环境都拒', (_what, raw) => {
    for (const env of ENVS) expect(resolveOutboundUrl(raw, RESEND_EMAILS_URL, env), `${env} ${raw}`).toEqual({ ok: false });
  });
});
