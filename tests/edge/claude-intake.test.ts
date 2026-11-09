// token-admin、claude-intake 的 handle（core.ts）和连接码工具（_shared/intake-token.ts）。
// B3 任务单 BE-5、S14、M2；TC-B3-19（第 201 条被拒、180 天过期）、20（只能新增）、25（未同意只走本机规则）、57（本机有把握不调 AI、不扣次数）。
// 门和服务商用内存替身；本机规则、校验、行映射注入真的 shared。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { todayOf } from '../../shared/core/date.ts';
import { isValidTz } from '../../shared/core/tz.ts';
import { captureRow } from '../../shared/logic/capture-map.ts';
import { arrangeHint, confidence, parseSplit, recurHint } from '../../shared/logic/parse/index.ts';
import { checkDefaultDay, checkParseOutput, checkVoiceOutput, normLocale, type AiItem } from '../../shared/schema/ai.ts';
import { insertSchema } from '../../shared/schema/rows.ts';
import { makeParseWithAI } from '../../supabase/functions/_shared/ai/parse-core.ts';
import { logIntakeFail, type StoreAdmin } from '../../supabase/functions/_shared/ai/store.ts';
import { randomToken, TOKEN_RE, TOKEN_TTL_MS, tokenHash, tokenLive } from '../../supabase/functions/_shared/intake-token.ts';
import { ASK_BAD_DAY, ASK_MONTH, ASK_YEAR, DAILY_ITEMS, failFields, StoreError, NOTE_RESEND, TIP_ARRANGE, TIP_RECUR, handle as intakeHandle, HOURLY_LIMIT, hourKey, itemsKey, USER_DAILY_ITEMS, userItemsKey, type Deps as IntakeDeps, type Row, type TokenRow } from '../../supabase/functions/claude-intake/core.ts';
import { cleanLabel, DAILY_LIMIT, MAX_ACTIVE, handle as adminHandle, rateKey, type Deps as AdminDeps } from '../../supabase/functions/token-admin/core.ts';
import { COUNTER_KEY, fakeGate, okJson, UA, used, type GateOpts } from './ai-fakes.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const NOW = Date.UTC(2026, 9, 28, 3, 0);   // 首尔 10-28 12:00
const TID = '7e57a0a0-0000-4000-8000-000000000001';
const DAY = 86_400_000;
const { parseWithAI } = makeParseWithAI<AiItem>({ checkParseOutput, checkVoiceOutput, checkDefaultDay });

describe('连接码（_shared/intake-token.ts）', () => {
  it('lmc_ + 43 位 base64url；库里存 SHA-256 十六进制；180 天内没吊销才有效', async () => {
    const t = randomToken();
    expect(TOKEN_RE.test(t)).toBe(true);
    expect(randomToken()).not.toBe(t);
    expect(await tokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const created = new Date(NOW).toISOString();
    expect(tokenLive({ created_at: created, revoked_at: null }, NOW + TOKEN_TTL_MS - 1)).toBe(true);
    expect(tokenLive({ created_at: created, revoked_at: null }, NOW + TOKEN_TTL_MS)).toBe(false);
    expect(tokenLive({ created_at: created, revoked_at: created }, NOW)).toBe(false);
    expect(tokenLive({ created_at: 'bad', revoked_at: null }, NOW)).toBe(false);
    expect(TOKEN_TTL_MS).toBe(180 * DAY);
  });
});

describe('token-admin', () => {
  function admin(o: { dup?: number; failInsert?: boolean; active?: number } = {}) {
    const counts = new Map<string, number>();
    const inserted: { user_id: string; label: string | null; token_hash: string; scopes: string[] }[] = [];
    let dup = o.dup ?? 0;
    const deps: AdminDeps = {
      authenticate: async () => ({ ok: true, user: { userId: UA } }),
      store: {
        async activeCount(userId, since) {
          expect([userId, since]).toEqual([UA, new Date(NOW - TOKEN_TTL_MS).toISOString()]);
          return (o.active ?? 0) + inserted.length;
        },
        async takeRate(k, limit, w) {
          expect(COUNTER_KEY.test(k)).toBe(true);
          expect([limit, w]).toEqual([DAILY_LIMIT, 86400]);
          const c = (counts.get(k) ?? 0) + 1;
          counts.set(k, c);
          return c <= limit;
        },
        async insertToken(row) {
          if (o.failInsert) throw new Error('db');
          if (dup-- > 0) return 'duplicate';
          inserted.push(row);
          return { id: TID, created_at: new Date(NOW).toISOString() };
        },
      },
      now: () => NOW,
      log: () => {},
    };
    return { deps, inserted, counts };
  }
  const req = (body: unknown, method = 'POST') => new Request('http://kong/functions/v1/token-admin', { method, body: method === 'POST' ? JSON.stringify(body) : null });

  it('create：明文码只在响应里出现一次，库里只存哈希，scopes 固定 {create}，180 天后到期', async () => {
    const { deps, inserted } = admin();
    const res = await adminHandle(req({ action: 'create', label: '  我的电脑  ' }), deps);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { token: string; id: string; expires_at: string };
    expect(TOKEN_RE.test(body.token)).toBe(true);
    expect(body).toEqual({ token: body.token, id: TID, expires_at: new Date(NOW + TOKEN_TTL_MS).toISOString() });
    expect(inserted).toEqual([{ user_id: UA, label: '我的电脑', token_hash: await tokenHash(body.token), scopes: ['create'] }]);
    expect(JSON.stringify(inserted)).not.toContain(body.token);
  });
  // 代码审 M4：鉴权失败原样转发（假鉴权）；没有 profiles 行由 supabase/tests/store-it/ai-fns-store.it.ts 真 requireActiveUser 覆盖
  it('TC-B1-10 token-admin：管理员停用的账号回 403 account_disabled（鉴权失败原样转发），不计次数、不建码', async () => {
    const { deps, inserted, counts } = admin();
    const res = await adminHandle(req({ action: 'create' }), { ...deps, authenticate: async () => ({ ok: false as const, response: new Response('{"error":"account_disabled"}', { status: 403 }) }) });
    expect([res.status, await res.json()]).toEqual([403, { error: 'account_disabled' }]);
    expect([inserted.length, counts.size]).toEqual([0, 0]);
  });
  it('安全审 M2：同时有效的连接码最多 5 个，第 6 个回 409 too_many_tokens，不计次数、不建码', async () => {
    const { deps, inserted, counts } = admin({ active: 3 });
    for (let i = 0; i < 2; i++) expect((await adminHandle(req({ action: 'create' }), deps)).status).toBe(200);
    const res = await adminHandle(req({ action: 'create' }), deps);
    expect([res.status, await res.json()]).toEqual([409, { error: 'too_many_tokens' }]);
    expect([inserted.length, [...counts.values()][0]]).toEqual([2, 2]);
    expect(MAX_ACTIVE).toBe(5);
  });
  it('每人每天 10 次，第 11 次 429；键按 UTC 日期', async () => {
    const { deps } = admin({ active: -100 });
    for (let i = 0; i < DAILY_LIMIT; i++) expect((await adminHandle(req({ action: 'create' }), deps)).status).toBe(200);
    expect((await adminHandle(req({ action: 'create' }), deps)).status).toBe(429);
    expect(rateKey(UA, NOW)).toBe(`token-admin:${UA}:20261028`);
  });
  it('哈希撞了换一个码重试（最多 3 次）；入库失败 503；只收 POST；别的动作、坏 label 400', async () => {
    const twice = admin({ dup: 2 });
    expect((await adminHandle(req({ action: 'create' }), twice.deps)).status).toBe(200);
    expect((await adminHandle(req({ action: 'create' }), admin({ dup: 3 }).deps)).status).toBe(503);
    expect((await adminHandle(req({ action: 'create' }), admin({ failInsert: true }).deps)).status).toBe(503);
    const { deps } = admin();
    expect((await adminHandle(req(null, 'GET'), deps)).status).toBe(405);
    for (const b of [{ action: 'revoke' }, { action: 'create', label: 'a\u202Eb' }, { action: 'create', label: 5 }, [], 'x']) {
      expect((await adminHandle(req(b), deps)).status).toBe(400);
    }
    expect(await (await adminHandle(req({ action: 'create', label: '字'.repeat(41) }), deps)).json()).toEqual({ error: 'label_too_long' });
    expect([cleanLabel(undefined), cleanLabel('  '), cleanLabel('ok'), cleanLabel('\uD800')]).toEqual([null, null, 'ok', 'bad']);
  });
});

// ---------- claude-intake ----------

interface World {
  deps: IntakeDeps<AiItem>;
  token: string;
  rows: Map<string, TokenRow>;
  found: string[];
  counts: Map<string, number>;
  inserted: { userId: string; table: Row['table']; rows: Record<string, unknown>[] }[];
  touched: number[];
  gate: ReturnType<typeof fakeGate>;
  /** 真 isUsable 查过的库对象（account 选项） */
  authSeen: string[];
  /** insertAll 调用次数（一次请求最多一次） */
  readonly insertCalls: number;
  /** 写进 logs 表的 intake_fail（R3） */
  fails: { userId: string; code: string; fields: string[] }[];
}

/** 真 isUsable 用的假 admin（代码审 M4：让停用、冷静期、没有 profiles 行真走到 _shared/auth.ts 的判断）：
 *  account_usable 只在 profile 在且 disabled_at 为空时为真（同 private.account_usable）；不能用时再读 disabled_reason、pending_deletions */
type Account = 'ok' | 'disabled' | 'deletion' | 'no_profile';
// _shared/auth.ts 顶上有 import type … from 'npm:…'（只有 Deno 认）：路径放在变量里，tsc 不去解析（同 tests/functions/account-export-p0-auth.test.ts）
const AUTH_PATH = '../../supabase/functions/_shared/auth.ts';
const { isUsable } = (await import(/* @vite-ignore */ AUTH_PATH)) as { isUsable(admin: unknown, userId: string): Promise<{ ok: boolean }> };
function authAdmin(a: Account, seen: string[]) {
  const profile = a === 'no_profile' ? null : { disabled_at: a === 'ok' ? null : '2026-10-27T00:00:00Z', disabled_reason: a === 'deletion' ? 'deletion' : a === 'disabled' ? 'admin' : null };
  const one = (data: unknown) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) });
  return {
    schema: () => ({
      rpc: async (fn: string) => { seen.push(fn); return { data: profile !== null && profile.disabled_at === null, error: null }; },
      from: (t: string) => { seen.push(t); return one(a === 'deletion' ? { purge_after: '2026-11-03T00:00:00Z' } : null); },
    }),
    from: (t: string) => { seen.push(t); return one(profile); },
  };
}

async function world(o: { gate?: GateOpts; row?: Partial<TokenRow>; usable?: boolean; account?: Account; insertFail?: boolean | Error; touchFail?: boolean; logFail?: boolean; profile?: { current_tz: string; ui_locale: string } | null } = {}): Promise<World> {
  const token = randomToken();
  const rows = new Map<string, TokenRow>([[await tokenHash(token), {
    id: TID, user_id: UA, scopes: ['create'], created_at: new Date(NOW - DAY).toISOString(), revoked_at: null, ...o.row,
  }]]);
  const found: string[] = [];
  const counts = new Map<string, number>();
  const inserted: World['inserted'] = [];
  const touched: number[] = [];
  const authSeen: string[] = [];
  const box = { insertCalls: 0 };
  const fails: World['fails'] = [];
  const gate = fakeGate({ now: NOW, reply: () => okJson({ items: [] }), ...o.gate });
  let n = 0;
  const deps: IntakeDeps<AiItem> = {
    gate,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logic: {
      parseSplit: (text, now, tz, locale, projects, opts) => parseSplit(text, now, tz, locale, projects, { features: [...opts.features] }),
      confidence: (r) => confidence(r as Parameters<typeof confidence>[0]),
      checkParseOutput, parseWithAI,
      captureRow: (item, ctx) => captureRow(item, ctx) as Row | null,
      todayOf, recurHint, arrangeHint, normLocale, isValidTz,
    },
    store: {
      async findToken(h) {
        found.push(h);
        return rows.get(h) ?? null;
      },
      async usable(userId) {
        if (o.account) return (await isUsable(authAdmin(o.account, authSeen), userId)).ok;
        return o.usable ?? true;
      },
      async takeRate(k, limit) {
        expect(COUNTER_KEY.test(k)).toBe(true);
        const c = (counts.get(k) ?? 0) + 1;
        counts.set(k, c);
        return c <= limit;
      },
      async profile() {
        return o.profile === undefined ? { current_tz: 'Asia/Seoul', ui_locale: 'zh-CN' } : o.profile;
      },
      async projects() {
        return ['NEOX'];
      },
      async insertAll(userId, byTable) {
        box.insertCalls++;
        // 同 private.intake_insert：一个事务，失败什么都不留
        if (o.insertFail) throw o.insertFail instanceof Error ? o.insertFail : new StoreError(500);
        for (const table of ['events', 'todos', 'anniversaries'] as const) {
          const r = byTable[table];
          if (r) inserted.push({ userId, table, rows: r });
        }
      },
      async touchToken(_id, at) {
        if (o.touchFail) throw new StoreError(503);
        touched.push(at);
      },
      async logFail(userId, code, fields) {
        if (o.logFail) throw new Error('logs');
        fails.push({ userId, code, fields });
      },
    },
  };
  return { deps, token, rows, found, counts, inserted, touched, gate, authSeen, fails, get insertCalls() { return box.insertCalls; } };
}

const post = (w: { token: string }, body: unknown, auth?: string) =>
  new Request('http://kong/functions/v1/claude-intake', {
    method: 'POST',
    headers: { authorization: auth ?? `Bearer ${w.token}`, 'content-type': 'application/json', 'x-app-version': '4.0.0' },
    body: JSON.stringify(body),
  });
const send = async (w: World, body: unknown, auth?: string) => {
  const res = await intakeHandle(post(w, body, auth), w.deps);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const EV = { kind: 'event', title: '开会', date: '2026-10-29', time: '15:00', date_basis: 'rel' };

describe('claude-intake：鉴权', () => {
  it('格式不对的码不查库（401）；查不到、吊销、过期、没有 create 权限一律 401，不区分', async () => {
    const w = await world();
    for (const a of ['', 'Bearer ', 'Bearer abc', `Basic ${w.token}`, `Bearer ${w.token}x`, `Bearer ${'lmc_' + 'A'.repeat(500)}`]) {
      expect((await send(w, { text: 'x' }, a)).status, a).toBe(401);
    }
    expect(w.found).toEqual([]);
    expect((await send(w, { text: 'x' }, `Bearer lmc_${'B'.repeat(43)}`)).body).toEqual({ error: 'unauthorized' });
    for (const row of [{ revoked_at: new Date(NOW).toISOString() }, { created_at: new Date(NOW - 181 * DAY).toISOString() }, { scopes: ['read'] }, { scopes: null }]) {
      const x = await world({ row });
      expect(await send(x, { text: '买牛奶' }), JSON.stringify(row)).toEqual({ status: 401, body: { error: 'unauthorized' } });
      expect(x.inserted).toEqual([]);
    }
    expect((await send(await world({ row: { created_at: new Date(NOW - 179 * DAY).toISOString() } }), { text: '买牛奶' })).status).toBe(200);
  });
  it('TC-B1-109 claude-intake：管理员停用（disabled_at 有值）的账号经真 isUsable（account_usable 假、disabled_reason admin）回 403，不计次数、不写库', async () => {
    const w = await world({ account: 'disabled' });
    expect(await send(w, { text: '明天下午3点开会' })).toEqual({ status: 403, body: { error: 'account_disabled' } });
    expect([w.inserted.length, w.counts.size, w.touched.length]).toEqual([0, 0, 0]);
    expect(w.authSeen).toEqual(['account_usable', 'profiles']);
  });
  it('TC-B1-109 claude-intake：注销冷静期（disabled_reason = deletion）的账号经真 isUsable（查到 pending_deletions）回 403，不计次数、不写库', async () => {
    const w = await world({ account: 'deletion' });
    expect(await send(w, { text: '明天下午3点开会' })).toEqual({ status: 403, body: { error: 'account_disabled' } });
    expect([w.inserted.length, w.counts.size, w.touched.length]).toEqual([0, 0, 0]);
    expect(w.authSeen).toEqual(['account_usable', 'profiles', 'pending_deletions']);
  });
  it('没有 profiles 行的账号经真 isUsable 回 403；正常账号放行（只查 account_usable 一次）', async () => {
    const none = await world({ account: 'no_profile' });
    expect(await send(none, { text: '明天下午3点开会' })).toEqual({ status: 403, body: { error: 'account_disabled' } });
    expect([none.inserted.length, none.counts.size, none.authSeen]).toEqual([0, 0, ['account_usable', 'profiles']]);
    const ok = await world({ account: 'ok' });
    expect((await send(ok, { text: '明天下午3点开会' })).status).toBe(200);
    expect(ok.authSeen).toEqual(['account_usable']);
  });
  it('账号停用、冷静期 403；每个码每小时 60 次，第 61 次 429；只收 POST', async () => {
    expect((await send(await world({ usable: false }), { text: '买牛奶' })).body).toEqual({ error: 'account_disabled' });
    const w = await world();
    w.counts.set(hourKey(TID, NOW), HOURLY_LIMIT);
    expect((await send(w, { text: '买牛奶' })).status).toBe(429);
    expect(hourKey(TID, NOW)).toBe(`claude-intake:${TID}:2026102803`);
    const g = await intakeHandle(new Request('http://kong/functions/v1/claude-intake', { headers: { authorization: `Bearer ${w.token}` } }), w.deps);
    expect(g.status).toBe(405);
  });
});

describe('claude-intake：记事', () => {
  it('TC-B3-57：本机规则有把握就直接记，服务商 0 次、不扣 AI 次数；source chat、user_id 取自连接码；记最后使用时间', async () => {
    const w = await world();
    const r = await send(w, { text: '明天下午3点开会' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ needs_confirm: [], skipped: 0, over_limit: 0 });
    expect(r.body['created']).toEqual([{ id: expect.any(String), kind: 'event', title: '开会', date: '2026-10-29', time: '15:00' }]);
    expect([w.gate.provider.stub.calls.length, used(w.gate, 'ai:')]).toEqual([0, 0]);
    expect(w.inserted.map((i) => [i.userId, i.table])).toEqual([[UA, 'events']]);
    const row = w.inserted[0]?.rows[0] ?? {};
    expect([row['source'], row['raw_text'], row['tz'], row['short_by']]).toEqual(['chat', '明天下午3点开会', 'Asia/Seoul', null]);
    expect(insertSchema('events').safeParse(row).success).toBe(true);
    expect(w.touched).toEqual([NOW]);
  });
  it('本机没把握、同意了 AI：走 AI（扣 1 次），按 AI 的结果记；AI 失败退回次数、用本机结果', async () => {
    const w = await world({ gate: { reply: () => okJson({ items: [{ kind: 'todo', title: '和老王聊合同', due: '2026-11-02', date_basis: 'rel', short: '合同' }] }) } });
    const r = await send(w, { text: '下周找时间和老王聊聊合同的事' });
    expect((r.body['created'] as { title: string }[]).map((c) => c.title)).toEqual(['和老王聊合同']);
    expect([w.gate.provider.stub.calls.length, used(w.gate, `ai:${UA}`)]).toEqual([1, 1]);
    const row = w.inserted[0]?.rows[0] ?? {};
    expect([row['short'], row['short_by']]).toEqual(['合同', 'ai']);
    expect(insertSchema('todos').safeParse(row).success).toBe(true);
    const bad = await world({ gate: { reply: () => ({ ok: false, reason: 'timeout' }) } });
    const b = await send(bad, { text: '下周找时间和老王聊聊合同的事' });
    expect((b.body['created'] as { title: string }[]).map((c) => c.title)).toEqual(['下周找时间和老王聊聊合同的事']);
    expect(used(bad.gate, 'ai:')).toBe(0);
  });
  it('TC-B3-25：没同意 AI 只走本机规则，服务商 0 次', async () => {
    const w = await world({ gate: { consent: false } });
    const r = await send(w, { text: '下周找时间和老王聊聊合同的事' });
    expect(r.status).toBe(200);
    expect((r.body['created'] as unknown[]).length).toBe(1);
    expect(w.gate.provider.stub.calls.length).toBe(0);
  });
  it('过去的月日要问：聊天里问不了，不存，回在 needs_confirm 里，写清两个候选日子和问法', async () => {
    const w = await world({ gate: { consent: false } });
    const r = await send(w, { text: '10月1号交报告' });
    expect(r.body).toMatchObject({ created: [], needs_confirm: [{ kind: 'todo', title: '交报告', candidates: ['2026-10-01', '2027-10-01'], ask: ASK_YEAR }], note: NOTE_RESEND });
    expect(w.inserted).toEqual([]);
  });
  it('架构审第九节第 4 条：同一请求里其他条照常保存，created 和 needs_confirm 分开列；几号已过问“本月还是下个月”', async () => {
    const w = await world();
    const r = await send(w, { items: [EV, { kind: 'todo', title: '交房租', due: '2026-10-03', date_basis: 'd' }, { kind: 'event', title: '体检', date: '2026-05-03', date_basis: 'md' }] });
    expect((r.body['created'] as { title: string }[]).map((c) => c.title)).toEqual(['开会']);
    expect(r.body['needs_confirm']).toEqual([
      { kind: 'todo', title: '交房租', candidates: ['2026-10-03', '2026-11-03'], ask: ASK_MONTH },
      { kind: 'event', title: '体检', candidates: ['2026-05-03', '2027-05-03'], ask: ASK_YEAR },
    ]);
    expect(w.inserted.flatMap((i) => i.rows.map((x) => x['title']))).toEqual(['开会']);
    // 用户答了以后 Claude 带完整日期重发：变成 ymd，不再问
    const again = await send(w, { items: [{ kind: 'todo', title: '交房租', due: '2026-11-03', date_basis: 'ymd' }] });
    expect([(again.body['created'] as unknown[]).length, again.body['needs_confirm'], 'note' in again.body]).toEqual([1, [], false]);
  });
  it('月份没有的日子（bad_day）：没日子的那条不存，提示原话和月日；有日子的照常保存', async () => {
    const w = await world({ gate: { consent: false } });
    const r = await send(w, { text: '11月31号开会' });
    expect(r.body).toMatchObject({ created: [], bad_day: { month: 11, day: 31, raw_text: '11月31号开会', ask: ASK_BAD_DAY }, note: NOTE_RESEND });
    expect(w.inserted).toEqual([]);
  });
  it('{items}：按 AI 输出同一套校验，不合格整份 400；类型开关关着不收', async () => {
    const w = await world();
    expect((await send(w, { items: [EV] })).status).toBe(200);
    expect(w.inserted.map((i) => i.table)).toEqual(['events']);
    expect(await send(w, { items: [{ ...EV, date_basis: null }] })).toEqual({ status: 400, body: { error: 'invalid_items', invalid_reasons: ['missing_date_basis'] } });
    expect((await send(w, { items: [{ ...EV, user_id: 'x' }] })).body).toMatchObject({ invalid_reasons: ['not_whitelisted'] });
    const off = await world({ gate: { features: ['event', 'todo'] } });
    expect((await send(off, { items: [{ kind: 'anniv', title: '生日', anniv: { type: 'birthday', calendar: 'solar', month: 1, day: 2 } }] })).status).toBe(400);
  });
  it('请求体：text 和 items 只能有一个；空、超 2000 字、不是对象都 400；profile 读不出 503', async () => {
    const w = await world();
    for (const b of [{}, { text: 'a', items: [] }, { text: '   ' }, { text: '字'.repeat(2001) }, { items: 'x' }, ['x']]) expect((await send(w, b)).status, JSON.stringify(b).slice(0, 30)).toBe(400);
    expect((await send(await world({ profile: null }), { text: '买牛奶' })).status).toBe(503);
    // 超过 32 KB 边读边计数回 413，不查 profile、不写库（安全审建议 1）
    const big = await send(w, { items: [{ ...EV, title: 'x'.repeat(40_000) }] });
    expect(big).toEqual({ status: 413, body: { error: 'too_large' } });
  });
  it('TC-B3-19：每个码每天 200 条：只剩 1 条额度时记 1 条、over_limit 1；用完 429 daily_limit', async () => {
    const w = await world();
    w.counts.set(itemsKey(TID, NOW), DAILY_ITEMS - 1);
    const r = await send(w, { items: [EV, { ...EV, title: '第二件' }] });
    expect(r.body).toMatchObject({ over_limit: 1 });
    expect((r.body['created'] as unknown[]).length).toBe(1);
    expect(await send(w, { items: [EV] })).toEqual({ status: 429, body: { error: 'daily_limit' } });
    expect(itemsKey(TID, NOW)).toBe(`claude-intake-items:${TID}:20261028`);
  });
  it('安全审 M2：每人每天 200 条（换一个连接码也算在同一个人头上），第 201 条被拒', async () => {
    const w = await world();
    w.counts.set(userItemsKey(UA, NOW), USER_DAILY_ITEMS - 1);   // 别的连接码已经替这个人记了 199 条，这个码自己一条没记
    const r = await send(w, { items: [EV, { ...EV, title: '第二件' }] });
    expect([(r.body['created'] as unknown[]).length, r.body['over_limit']]).toEqual([1, 1]);
    expect(await send(w, { items: [EV] })).toEqual({ status: 429, body: { error: 'daily_limit' } });
    expect(w.counts.get(itemsKey(TID, NOW))).toBe(1);
    expect(userItemsKey(UA, NOW)).toBe(`claude-intake-user:${UA}:20261028`);
  });
  it('TC-B3-20：只能新增——store 只有 insertAll，index.ts 对条目表只经 private.intake_insert（迁移里只 insert），不 update / delete / upsert', () => {
    const src = readFileSync(join(ROOT, 'supabase', 'functions', 'claude-intake', 'index.ts'), 'utf8');
    expect(/\.(update|delete|upsert)\s*\(/g.exec(src.replace(/\.from\('api_tokens'\)\.update\(\{ last_used_at:/, ''))).toBe(null);
    expect(src).toContain(".from('api_tokens').update({ last_used_at:");
    const part = src.slice(src.indexOf('async insertAll('), src.indexOf('async touchToken('));
    expect(part).toContain(".rpc('intake_insert', { p_user: userId, p_rows: rows })");
    expect(/\.(update|delete|upsert|from)\s*\(/.test(part)).toBe(false);
    const sql = readFileSync(join(ROOT, 'supabase', 'migrations', '20261107100000_core_my_ai_usage.sql'), 'utf8');
    const fn = sql.slice(sql.indexOf('create function private.intake_insert'), sql.indexOf('grant execute on function private.intake_insert'));
    expect(fn).toContain("'insert into public.%1$I (user_id, %2$s)");
    expect(/\b(update|delete|upsert|on conflict)\b/i.test(fn.replace(/--[^\n]*/g, ''))).toBe(false);
  });
  it('安全审复查：intake_insert 按表写死的列名单盖住 capture-map 产出的每一列；系统列的值正好是名单里的固定值', () => {
    const sql = readFileSync(join(ROOT, 'supabase', 'migrations', '20261107100000_core_my_ai_usage.sql'), 'utf8');
    const lit = (name: string): Record<string, unknown> => {
      const m = new RegExp(`${name} constant jsonb := '([^']*)'`).exec(sql);
      if (!m?.[1]) throw new Error(`迁移里找不到 ${name}`);
      return JSON.parse(m[1]) as Record<string, unknown>;
    };
    const allowed = lit('allowed') as Record<string, string[]>;
    const fixed = lit('fixed') as Record<string, Record<string, unknown>>;
    const base = { title: '开会', date: '2026-10-29', time: null, duration_min: null, due: null, important: false, project: null, body: null, short: '会', anniv: null } as const;
    const ctx = { id: 'e1000000-0000-4000-8000-000000000001', batchId: 'e3000000-0000-4000-8000-000000000001', now: 1761620000000, today: '2026-10-29', tz: 'Asia/Seoul', source: 'chat', rawText: '开会', origin: 'ai' } as const;
    const rows = [
      captureRow({ ...base, kind: 'event' }, ctx),
      captureRow({ ...base, kind: 'event', time: '15:00' }, { ...ctx, origin: 'rule' }),
      captureRow({ ...base, kind: 'todo' }, ctx),
      captureRow({ ...base, kind: 'todo', time: '09:30' }, ctx),
      captureRow({ ...base, kind: 'anniv', anniv: { type: 'birthday', calendar: 'lunar', month: 8, day: 15, is_leap: false, year: null } }, ctx),
    ];
    const seen = new Set<string>();
    for (const r of rows) {
      expect(r).not.toBe(null);
      if (!r) continue;
      seen.add(r.table);
      for (const [k, v] of Object.entries(r.row)) {
        const fx = fixed[r.table] ?? {};
        const ok = (allowed[r.table] ?? []).includes(k) || (Object.hasOwn(fx, k) && JSON.stringify(fx[k]) === JSON.stringify(v));
        expect(ok, `${r.table}.${k}=${JSON.stringify(v)}`).toBe(true);
      }
    }
    expect([...seen].sort()).toEqual(['anniversaries', 'events', 'todos']);
    // 系统列一律不在内容名单里
    for (const t of Object.keys(allowed)) for (const k of ['user_id', 'ai_status', 'pushed_for', 'defer_until', 'remind_at', 'deleted_at', 'notified_for', 'snooze_at']) expect(allowed[t]).not.toContain(k);
  });
  it('代码审建议 3：三张表一次写完（一次 insertAll）；写不进回 503、什么都没留', async () => {
    const text = '明天下午3点开会，后天交报告';
    const w = await world({ insertFail: true, gate: { consent: false } });
    const bad = await send(w, { text });
    // R3：错误码 not_saved、created 为空，让 Claude 知道没存上
    expect([bad.status, bad.body]).toEqual([503, { error: 'not_saved', created: [] }]);
    expect([w.insertCalls, w.inserted.length, w.touched.length]).toEqual([1, 0, 0]);
    // logs 表一行 intake_fail：只有错误码、HTTP 状态、类型名，不带条目内容
    expect(w.fails).toEqual([{ userId: UA, code: 'not_saved', fields: ['status=500', 'type=StoreError'] }]);
    expect(JSON.stringify(w.fails)).not.toMatch(/开会|报告/);
    const ok = await world({ gate: { consent: false } });
    expect((await send(ok, { text })).status).toBe(200);
    expect([ok.insertCalls, ok.inserted.map((i) => i.table)]).toEqual([1, ['events', 'todos']]);
  });
  it('R3：logs 只记固定字段——别的异常只记类型名（不记 message）；记最后使用时间失败照常回成功、记 touch_token_failed；写 logs 失败不影响回答', async () => {
    expect(failFields(new StoreError(409))).toEqual(['status=409', 'type=StoreError']);
    expect(failFields(new TypeError('明天开会 secret'))).toEqual(['type=TypeError']);
    expect(failFields('x')).toEqual(['type=unknown']);
    const odd = Object.assign(new Error('x'), { name: '奇怪的名字' });
    expect(failFields(odd)).toEqual(['type=unknown']);
    const thrown = await world({ insertFail: new TypeError('明天下午3点开会 secret'), gate: { consent: false } });
    expect((await send(thrown, { text: '明天下午3点开会' })).status).toBe(503);
    expect(thrown.fails).toEqual([{ userId: UA, code: 'not_saved', fields: ['type=TypeError'] }]);
    const touch = await world({ touchFail: true, gate: { consent: false } });
    const t = await send(touch, { text: '明天下午3点开会' });
    expect([t.status, touch.inserted.length, touch.fails]).toEqual([200, 1, [{ userId: UA, code: 'touch_token_failed', fields: ['status=503', 'type=StoreError'] }]]);
    const noLog = await world({ insertFail: true, logFail: true, gate: { consent: false } });
    expect((await send(noLog, { text: '明天下午3点开会' })).body).toEqual({ error: 'not_saved', created: [] });
    expect(noLog.gate.logs).toContain('log_write_failed');
    const ok = await world({ gate: { consent: false } });
    await send(ok, { text: '明天下午3点开会' });
    expect(ok.fails).toEqual([]);
  });
  it('R3：logIntakeFail 写进 logs 的一行：kind intake、act intake_fail、src claude-intake，只有错误码和字段；写失败抛错', async () => {
    const got: unknown[] = [];
    const admin = (error: unknown) => ({ from: (t: string) => ({ insert: async (row: unknown) => { got.push([t, row]); return { error }; } }) });
    await logIntakeFail(admin(null) as unknown as StoreAdmin, UA, 'not_saved', ['status=500', 'type=StoreError'], NOW);
    expect(got).toEqual([['logs', { user_id: UA, t: NOW, kind: 'intake', act: 'intake_fail', src: 'claude-intake', fields: ['status=500', 'type=StoreError'], code: 'not_saved' }]]);
    await expect(logIntakeFail(admin({ message: 'x' }) as unknown as StoreAdmin, UA, 'not_saved', [], NOW)).rejects.toThrow();
  });
  it('代码审建议 4：带重复说法回 tips“只记了最近一次”，带“帮我安排时间”回“具体时间请自己排”；都没有不带 tips', async () => {
    const w = await world({ gate: { consent: false } });
    expect((await send(w, { text: '每周一早上九点开周会' })).body['tips']).toEqual([TIP_RECUR]);
    expect((await send(w, { text: '这周五之前完成报价单，帮我安排时间' })).body['tips']).toEqual([TIP_ARRANGE]);
    expect((await send(w, { text: '明天下午3点开会' })).body['tips']).toBeUndefined();
  });
});
