// invite-signup 出站地址可配（接手清单 INVITE-mailpit，10-30）：supabase/functions/invite-signup/outbound.ts 的 resolveOutboundUrl，
// index.ts 的接法（读哪两个变量、不合规时当没配好）是源码核对，要读文件，放在 tests/build/e2e-real-backend-env.test.ts（本目录是 Workers 类型）。
// 口径：不设 / 空串 → 官方地址（和改之前一样）；全空白任何环境都拒（D4）；一字不差的官方地址任何环境都认；
// 回环地址（原文字面写 127.0.0.1 或 localhost，localhost 不分大小写；http 或 https）只有本机环境认（D5）；
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
