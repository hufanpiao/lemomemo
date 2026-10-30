// 登录页的 account 小封装（data/account-gate.ts；R-256 ③、架构第 6 节“account 的错误码”）：
// 手写的 status 判断和 shared/schema/account.ts 的 accountStatusResponse 对得上；四种探测结果；restore 的错误码；日期按 fmtWhen 口径
import { describe, expect, it, vi } from 'vitest';
import { accountStatusResponse } from '../../../../shared/schema/account.ts';
import { apiError } from '../../../../shared/schema/api.ts';
import { httpError } from '../../../platform/account-status.ts';
import type { Db } from '../../../platform/supabase/client.ts';
import { createAccountGateApi, parseStatus, purgeWhen, restoreError } from '../data/account-gate.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

/** 把 purgeWhen 的各部分填进词条 auth.restore.when（同界面的 t） */
function fill(tpl: string, p: Record<string, string> | null): string | null {
  return p ? tpl.replace(/\{(\w+)\}/g, (_, k: string) => p[k] ?? '') : null;
}
const fmtPurgeAfter = (iso: string | null, loc: 'zh-CN' | 'ko-KR', tz?: string) =>
  fill(loc === 'ko-KR' ? ko['auth.restore.when'] : zh['auth.restore.when'], purgeWhen(iso, tz) as Record<string, string> | null);

/** supabase-js 的 FunctionsHttpError：context 是原始 Response */
function httpErr(status: number, body: unknown) {
  return { name: 'FunctionsHttpError', context: new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) };
}

function fakeDb(invoke: (fn: string, o: { body: unknown }) => Promise<{ data: unknown; error: unknown }>) {
  const db = { functions: { invoke: vi.fn(invoke) }, auth: { signOut: vi.fn(async () => ({ error: null })) } };
  return { db, getDb: async () => db as unknown as Db };
}

describe('parseStatus：和 accountStatusResponse（zod）一致', () => {
  const samples: unknown[] = [
    { ok: true, status: 'active' },
    { ok: true, status: 'pending_deletion', purge_after: '2026-11-05T05:30:00.000Z' },
    { ok: true, status: 'pending_deletion', purge_after: null },
    { ok: true, status: 'disabled' },
    { ok: true, status: 'pending_deletion' },
    { ok: true, status: 'pending_deletion', purge_after: 5 },
    { ok: false, status: 'active' },
    { status: 'disabled' },
    { ok: true, status: 'deleted' },
    { ok: true },
    null,
    'active',
  ];
  for (const b of samples) {
    it(JSON.stringify(b), () => {
      const z = accountStatusResponse.safeParse(b);
      const mine = parseStatus(b);
      const o = b as { ok?: unknown; status?: unknown } | null;
      // 审查建议 2：pending_deletion 缺 purge_after 或格式不对，zod 不通过，这里仍按冷静期、purgeAfter 为 null
      if (!z.success && o?.ok === true && o.status === 'pending_deletion') expect(mine).toEqual({ kind: 'pending_deletion', purgeAfter: null });
      else if (!z.success) expect(mine).toEqual({ kind: 'unknown' });
      else expect(mine.kind).toBe(z.data.status);
    });
  }

  it('后端审查 10-30：200 {ok:true, status:"disabled"} 认成停用，不因为 ok:true 当成 active', () => {
    expect(parseStatus({ ok: true, status: 'disabled' })).toEqual({ kind: 'disabled' });
  });
});

describe('httpError 的错误码：和 apiError（zod）一致（REVIEW-1030-be-sugg ①；登录页不带 zod，所以手写、在这里对照）', () => {
  const samples: [string, string][] = [
    ['正常码', JSON.stringify({ error: 'restore_too_late' })],
    ['空串', JSON.stringify({ error: '' })],
    ['65 字', JSON.stringify({ error: 'x'.repeat(65) })],
    ['正好 64 个 x', JSON.stringify({ error: 'x'.repeat(64) })],
    // 66 个 UTF-16 码元、33 个码位：zod 4 按码位数，算 33 个，通过
    ['33 个 emoji', JSON.stringify({ error: '\u{1F600}'.repeat(33) })],
    // 130 个码元、65 个码位：超过 64，两边都不通过
    ['65 个 emoji', JSON.stringify({ error: '\u{1F600}'.repeat(65) })],
    ['只有 1 个字', JSON.stringify({ error: 'x' })],
    ['不是字符串', JSON.stringify({ error: 5 })],
    ['老写法 {code}', JSON.stringify({ code: 'restore_too_late' })],
    ['带 purge_after', JSON.stringify({ error: 'account_pending_deletion', purge_after: '2026-11-05T05:30:00Z' })],
    ['不是 JSON', '<html>bad gateway</html>'],
  ];
  for (const [name, text] of samples) {
    it(name, async () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const z = apiError.safeParse(parsed);
      const h = await httpError({ name: 'FunctionsHttpError', context: new Response(text, { status: 400 }) });
      expect(h?.code).toBe(z.success ? z.data.error : '');
    });
  }
});

describe('createAccountGateApi.status：四种探测结果', () => {
  it('调 account {action:"status"}；active、pending_deletion（带 purge_after）、disabled 原样认出', async () => {
    for (const [data, want] of [
      [{ ok: true, status: 'active' }, { kind: 'active' }],
      [{ ok: true, status: 'pending_deletion', purge_after: '2026-11-05T05:30:00.000Z' }, { kind: 'pending_deletion', purgeAfter: '2026-11-05T05:30:00.000Z' }],
      [{ ok: true, status: 'disabled' }, { kind: 'disabled' }],
    ] as const) {
      const { db, getDb } = fakeDb(async () => ({ data, error: null }));
      expect(await createAccountGateApi(getDb).status()).toEqual(want);
      expect(db.functions.invoke).toHaveBeenCalledWith('account', { body: { action: 'status' } });
    }
  });

  it('try_later（503）、session_revoked、unauthorized、断网、拿不到客户端、超时：一律 unknown（不挡）', async () => {
    const cases: (() => Promise<{ data: unknown; error: unknown }>)[] = [
      async () => ({ data: null, error: httpErr(503, { error: 'try_later' }) }),
      async () => ({ data: null, error: httpErr(401, { error: 'session_revoked' }) }),
      async () => ({ data: null, error: httpErr(401, { error: 'unauthorized' }) }),
      async () => ({ data: null, error: { name: 'FunctionsFetchError' } }),
      async () => {
        throw new TypeError('Failed to fetch');
      },
    ];
    for (const c of cases) expect(await createAccountGateApi(fakeDb(c).getDb).status()).toEqual({ kind: 'unknown' });
    expect(await createAccountGateApi(async () => Promise.reject(new Error('supabase_env_missing'))).status()).toEqual({ kind: 'unknown' });
    const hang = fakeDb(() => new Promise(() => undefined));
    expect(await createAccountGateApi(hang.getDb, { statusTimeoutMs: 5 }).status()).toEqual({ kind: 'unknown' });
  });

  it('万一回的是 403 account_disabled / account_pending_deletion 也认', async () => {
    const a = fakeDb(async () => ({ data: null, error: httpErr(403, { error: 'account_disabled' }) }));
    expect(await createAccountGateApi(a.getDb).status()).toEqual({ kind: 'disabled' });
    const b = fakeDb(async () => ({ data: null, error: httpErr(403, { error: 'account_pending_deletion', purge_after: '2026-11-05T05:30:00Z' }) }));
    expect(await createAccountGateApi(b.getDb).status()).toEqual({ kind: 'pending_deletion', purgeAfter: '2026-11-05T05:30:00Z' });
  });
});

describe('restore 的错误码（架构第 6 节错误码表）', () => {
  it('表里的码原样认；session_revoked、unauthorized 归 reauth_required；429 → rate_limited、503 → try_later；断网 → offline', async () => {
    for (const c of ['reauth_required', 'restore_too_late', 'rate_limited', 'account_disabled', 'not_pending', 'try_later'] as const) {
      expect(await restoreError(httpErr(409, { error: c }))).toBe(c);
    }
    expect(await restoreError(httpErr(401, { error: 'session_revoked' }))).toBe('reauth_required');
    expect(await restoreError(httpErr(401, { error: 'unauthorized' }))).toBe('reauth_required');
    expect(await restoreError(httpErr(429, {}))).toBe('rate_limited');
    // 审查建议 1：401 且回包没有 error 字段 → reauth_required
    expect(await restoreError(httpErr(401, {}))).toBe('reauth_required');
    expect(await restoreError(httpErr(401, 'not json'))).toBe('reauth_required');
    expect(await restoreError(httpErr(503, 'x'))).toBe('try_later');
    expect(await restoreError(httpErr(400, { error: 'constructor' }))).toBe('unknown');
    expect(await restoreError({ name: 'FunctionsFetchError' })).toBe('offline');
  });

  it('错误码按 apiError 的口径（REVIEW-1030-be-sugg ①）：空串、不是字符串、超长、老写法 {code} 都不算码', async () => {
    // 10-30 主持人定：401 加超长 error（超过 64 字，只可能是坏响应）按“没有 error 字段”算，归 reauth_required（原来是 unknown）
    expect(await restoreError(httpErr(401, { error: 'x'.repeat(65) }))).toBe('reauth_required');
    // 下面三条改前改后一致
    expect(await restoreError(httpErr(401, { error: '' }))).toBe('reauth_required');
    expect(await restoreError(httpErr(401, { error: 5 }))).toBe('reauth_required');
    expect(await restoreError(httpErr(409, { code: 'restore_too_late' }))).toBe('unknown');
  });

  it('createAccountGateApi.restore：调 {action:"restore"}；成功 ok；超时按 try_later', async () => {
    const { db, getDb } = fakeDb(async () => ({ data: { ok: true }, error: null }));
    expect(await createAccountGateApi(getDb).restore()).toEqual({ ok: true });
    expect(db.functions.invoke).toHaveBeenCalledWith('account', { body: { action: 'restore' } });
    const bad = fakeDb(async () => ({ data: null, error: httpErr(401, { error: 'reauth_required' }) }));
    expect(await createAccountGateApi(bad.getDb).restore()).toEqual({ ok: false, error: 'reauth_required' });
    const hang = fakeDb(() => new Promise(() => undefined));
    expect(await createAccountGateApi(hang.getDb, { restoreTimeoutMs: 5 }).restore()).toEqual({ ok: false, error: 'try_later' });
  });

  it('signOutLocal 只用 scope local；prior 的会话已被换掉时不调 supabase-js', async () => {
    const { db, getDb } = fakeDb(async () => ({ data: null, error: null }));
    expect(await createAccountGateApi(getDb).signOutLocal()).toBe(true);
    expect(db.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    // 本机没有会话（测试环境读不出 sid）：prior.sid 为 null 时不算换掉，照常调
    db.auth.signOut.mockClear();
    await createAccountGateApi(getDb).signOutLocal({ sid: null, token: null, budgetMs: 100 });
    expect(db.auth.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('purgeWhen + 词条 auth.restore.when：口径同邮件的 fmtWhen', () => {
  it('按给定时区写“日期 时刻”；中韩两种写法；null、解析不了为 null；时区不能用按首尔', () => {
    const iso = '2026-11-05T05:30:00.000Z';
    expect(fmtPurgeAfter(iso, 'zh-CN', 'Asia/Seoul')).toBe('2026年11月5日 14:30（Asia/Seoul）');
    expect(fmtPurgeAfter(iso, 'ko-KR', 'Asia/Seoul')).toBe('2026년 11월 5일 14:30 (Asia/Seoul)');
    expect(fmtPurgeAfter(iso, 'zh-CN', 'Asia/Shanghai')).toBe('2026年11月5日 13:30（Asia/Shanghai）');
    expect(fmtPurgeAfter(iso, 'zh-CN', 'Not/AZone')).toBe('2026年11月5日 14:30（Asia/Seoul）');
    expect(fmtPurgeAfter(null, 'zh-CN')).toBeNull();
    expect(fmtPurgeAfter('soon', 'zh-CN')).toBeNull();
  });
});
