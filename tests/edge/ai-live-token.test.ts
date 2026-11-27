// ai-live-token 的 handle（supabase/functions/ai-live-token/core.ts；11-24 按住“＋”走 Gemini 实时转写）。
// 计数用 ai-fakes.ts 的内存替身（和 counters 的 check 约束同一条键规则），令牌接口用记账的假 fetch：方法、鉴权、门、请求体（整份配置锁进令牌、没有 fieldMask）、
// 一句话只扣一次 50 次（发令牌只看不扣、不占 AI 共用的每分钟键）、令牌自己的每天上限、失败退回和写 logs、回包和日志不带长期密钥。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_API, LIVE_MODEL, LIVE_NEW_SESSION_S, LIVE_PER_MINUTE, LIVE_PER_USER_DEFAULT, LIVE_TOKEN_TTL_S, LIVE_TOKEN_URL, MINT_TIMEOUT_MS,
  handle, liveSetup, readLiveConfig, type Deps,
} from '../../supabase/functions/ai-live-token/core.ts';
import { userQuotaKey } from '../../supabase/functions/_shared/ai/gate.ts';
import { fakeGate, used, UA, type GateOpts } from './ai-fakes.ts';

const NOW = Date.UTC(2026, 10, 24, 3, 0);
const KEY = 'AIza-secret-long-term-key';
const TOKEN = 'auth_tokens/abc123';
const call = async (res: Response) => ({ status: res.status, text: await res.text() });
const body = async (res: Response) => JSON.parse((await call(res)).text) as Record<string, unknown>;

interface Sent { url: string; headers: Record<string, string>; body: Record<string, unknown> }
interface World {
  /** app_config.ai 原样（默认 50 次、全项目 1000） */
  ai?: unknown;
  live?: boolean;
  own?: boolean | 'throw';
  key?: string | null;
  reply?: (signal: AbortSignal) => Promise<Response>;
  logFail?: Deps['logFail'];
}

function world(o: GateOpts = {}, w: World = {}) {
  const g = fakeGate({ now: NOW, ...o });
  const sent: Sent[] = [];
  const failed: { userId: string; code: string; fields: string[] }[] = [];
  const liveAsked: string[] = [];
  const deps: Deps = {
    authenticate: async () => ({ ok: true as const, user: { userId: UA } }),
    consent: g.consent,
    liveOn: async (_u, v) => {
      liveAsked.push(v);
      return w.live ?? true;
    },
    config: async () => {
      if (o.config === 'throw') throw new Error('db');
      return w.ai ?? { provider: 'gemini', model: 'gemini-x', per_user_daily: 50, global_daily: 1000 };
    },
    key: async () => (w.key === undefined ? KEY : w.key),
    own: async () => {
      if (w.own === 'throw') throw new Error('db');
      return w.own ?? false;
    },
    isAdmin: g.isAdmin,
    rate: g.rate,
    quota: g.quota,
    quotaUsed: async (k) => g.counts.get(k) ?? 0,
    logFail: w.logFail ?? (async (userId, code, fields) => {
      failed.push({ userId, code, fields });
    }),
    fetch: async (url, init) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return (w.reply ?? (async () => new Response(JSON.stringify({ name: TOKEN }), { status: 200 })))(init.signal as AbortSignal);
    },
    now: g.now,
    log: g.log,
  };
  return { g, deps, sent, failed, liveAsked };
}
const req = (locale: string | null = 'zh-CN', method = 'POST') =>
  new Request('http://x/functions/v1/ai-live-token', { method, headers: { 'x-app-version': '4.0.7', ...(locale === null ? {} : { 'x-locale': locale }) } });
/** 50 次那个键（ai:<uid>:<日期>）、令牌两个键 */
const aiUsed = (g: ReturnType<typeof fakeGate>) => used(g, 'ai:');
const liveUsed = (g: ReturnType<typeof fakeGate>) => [used(g, `live:${UA}`), used(g, 'live:global')];

afterEach(() => {
  vi.useRealTimers();
});

describe('ai-live-token：方法、鉴权、同意、开关', () => {
  it('只收 POST：GET 回 405，不过门、不调令牌接口', async () => {
    const { g, deps, sent } = world();
    expect((await handle(req('zh-CN', 'GET'), deps)).status).toBe(405);
    expect([g.counts.size, sent.length]).toEqual([0, 0]);
  });
  const disabled = () => {
    const x = world();
    x.deps.authenticate = async () => ({ ok: false, response: new Response('{"error":"account_disabled"}', { status: 403 }) });
    return x;
  };
  it('TC-B1-10 ai-live-token：管理员停用的账号回 403 account_disabled，不过门、不扣次数、不调令牌接口', async () => {
    const { g, deps, sent } = disabled();
    expect(await call(await handle(req(), deps))).toEqual({ status: 403, text: '{"error":"account_disabled"}' });
    expect([g.counts.size, sent.length]).toEqual([0, 0]);
  });
  it('TC-B1-10 ai-live-token：没有 profiles 行的账号回 403 account_disabled，不读配置', async () => {
    const { g, deps, sent, liveAsked } = disabled();
    expect(await body(await handle(req(), deps))).toMatchObject({ error: 'account_disabled' });
    expect([g.counts.size, sent.length, liveAsked.length]).toEqual([0, 0, 0]);
  });
  it('没同意或关了 AI：consent_required，不计数、不调令牌接口；读同意出错 503', async () => {
    const { g, deps, sent } = world({ consent: false });
    expect(await body(await handle(req(), deps))).toEqual({ consent_required: true });
    expect([g.counts.size, sent.length]).toEqual([0, 0]);
    const t = world({ consent: 'throw' });
    expect((await handle(req(), t.deps)).status).toBe(503);
  });
  it('features.live 没开（或 AI 类型全关）：fallback feature_off，带上 x-app-version 去判，不计数', async () => {
    const { g, deps, sent, liveAsked } = world({}, { live: false });
    expect(await body(await handle(req(), deps))).toEqual({ fallback: true, reason: 'feature_off' });
    expect(liveAsked).toEqual(['4.0.7']);
    expect([g.counts.size, sent.length]).toEqual([0, 0]);
  });
  it('读 app_config.ai 出错、服务器上没配 Gemini 密钥：fallback error，不计数、不调令牌接口', async () => {
    for (const x of [world({ config: 'throw' }), world({}, { key: null })]) {
      expect(await body(await handle(req(), x.deps))).toEqual({ fallback: true, reason: 'error' });
      expect([x.g.counts.size, x.sent.length]).toEqual([0, 0]);
    }
  });
});

describe('ai-live-token：一句话只扣一次 50 次（评审第 2 条）', () => {
  it('发令牌不扣 50 次：成功以后 ai:<uid> 和 ai:global 都是 0，令牌自己的两个键各 1', async () => {
    const { g, deps } = world();
    expect((await handle(req(), deps)).status).toBe(200);
    expect(aiUsed(g)).toBe(0);
    expect(liveUsed(g)).toEqual([1, 1]);
  });
  it('不占 AI 共用的每分钟 6 次（ai-rate 键一次都不碰），另有独立的 ai-live-rate 键', async () => {
    const { g, deps } = world();
    await handle(req(), deps);
    const keys = [...g.counts.keys()];
    expect(keys.some((k) => k.startsWith('ai-rate:'))).toBe(false);
    expect(keys.filter((k) => k.startsWith('ai-live-rate:'))).toHaveLength(1);
  });
  it(`令牌每分钟 ${LIVE_PER_MINUTE} 次超了：429 rate_limited，不调令牌接口；管理员不限`, async () => {
    const { deps, sent } = world({ minuteLimitHit: true });
    expect((await handle(req(), deps)).status).toBe(429);
    expect(sent.length).toBe(0);
    const a = world({ minuteLimitHit: true, admin: true });
    expect((await handle(req(), a.deps)).status).toBe(200);
  });
  it('今天 50 次已经用完：quota_out（客户端直接按“今天用完”收尾），不调令牌接口、令牌键不计', async () => {
    const { g, deps, sent } = world();
    g.counts.set(userQuotaKey(UA, NOW), 50);
    expect(await body(await handle(req(), deps))).toEqual({ quota_out: true, quota_left: 0 });
    expect(sent.length).toBe(0);
    expect(g.counts.get(userQuotaKey(UA, NOW))).toBe(50);
    expect(liveUsed(g)).toEqual([0, 0]);
  });
  it('评审第 9 条：“只看不扣”是只读计数，50 次的键一次都不预扣、不退回（不再“先扣再退”）', async () => {
    const { g, deps } = world();
    g.counts.set(userQuotaKey(UA, NOW), 49);
    const take = vi.spyOn(deps.quota, 'take');
    const refund = vi.spyOn(deps.quota, 'refund');
    expect(await body(await handle(req(), deps))).toMatchObject({ token: TOKEN });
    expect(take.mock.calls.filter(([k]) => k.startsWith('ai:')), '不预扣 50 次的键').toEqual([]);
    expect(refund.mock.calls.filter(([k]) => k.startsWith('ai:')), '不退回 50 次的键').toEqual([]);
  });

  it('还剩 1 次：只看不扣，照样发令牌，50 次的计数不动', async () => {
    const { g, deps } = world();
    g.counts.set(userQuotaKey(UA, NOW), 49);
    expect(await body(await handle(req(), deps))).toMatchObject({ token: TOKEN });
    expect(g.counts.get(userQuotaKey(UA, NOW))).toBe(49);
  });
  it('自带密钥的（R-494）、管理员：50 次用完也照样发（不占柠檬记的 50 次）；读自带密钥出错按没有算', async () => {
    for (const [o, w] of [[{}, { own: true }], [{ admin: true }, {}]] as const) {
      const { g, deps } = world(o, w);
      g.counts.set(userQuotaKey(UA, NOW), 50);
      expect(await body(await handle(req(), deps))).toMatchObject({ token: TOKEN });
    }
    const t = world({}, { own: 'throw' });
    t.g.counts.set(userQuotaKey(UA, NOW), 50);
    expect(await body(await handle(req(), t.deps))).toEqual({ quota_out: true, quota_left: 0 });
    expect(t.g.logs).toContain('own_read_failed');
  });
});

describe('ai-live-token：令牌自己的每天上限（成本保护）', () => {
  it(`每人每天默认 ${LIVE_PER_USER_DEFAULT} 个，app_config.ai.live.per_user_daily 可改；格式不对按默认`, () => {
    expect(readLiveConfig({}).perUser).toBe(LIVE_PER_USER_DEFAULT);
    expect(readLiveConfig({ live: { per_user_daily: 7 } }).perUser).toBe(7);
    for (const bad of [-1, 1.5, '9', null]) expect(readLiveConfig({ live: { per_user_daily: bad } }).perUser).toBe(LIVE_PER_USER_DEFAULT);
  });
  it('个人这一项用完：fallback live_quota，不调令牌接口', async () => {
    const { g, deps, sent } = world({}, { ai: { per_user_daily: 50, global_daily: 1000, live: { per_user_daily: 1 } } });
    expect((await handle(req(), deps)).status).toBe(200);
    expect(await body(await handle(req(), deps))).toEqual({ fallback: true, reason: 'live_quota' });
    expect(sent.length).toBe(1);
    expect(g.logs).toContain('live_user_out');
    expect(liveUsed(g)).toEqual([1, 1]);
  });
  it('全项目沿用 ai.global_daily：用完（或没配当 0）fallback live_quota，退回刚扣的个人那一次；管理员也拦', async () => {
    for (const [o, ai] of [[{}, { per_user_daily: 50, global_daily: 0 }], [{}, { per_user_daily: 50 }], [{ admin: true }, { per_user_daily: 50, global_daily: 0 }]] as const) {
      const { g, deps, sent } = world(o, { ai });
      expect(await body(await handle(req(), deps))).toEqual({ fallback: true, reason: 'live_quota' });
      expect(sent.length).toBe(0);
      expect(g.logs).toContain('live_global_out');
      expect(liveUsed(g)).toEqual([0, 0]);
    }
  });
  it('管理员个人这一项不设上限', async () => {
    const { deps } = world({ admin: true }, { ai: { per_user_daily: 50, global_daily: 1000, live: { per_user_daily: 0 } } });
    expect(await body(await handle(req(), deps))).toMatchObject({ token: TOKEN });
  });
});

describe('ai-live-token：发令牌', () => {
  it('成功：令牌接口 v1beta/auth_tokens，密钥只在 x-goog-api-key；只能用 1 次、30 秒内连上、120 秒作废，整份配置锁进令牌、没有 fieldMask', async () => {
    const { g, deps, sent } = world();
    const r = await call(await handle(req('zh-CN'), deps));
    expect(r.status).toBe(200);
    const setup = { model: `models/${LIVE_MODEL}`, generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes: ['zh-CN'] } };
    expect(JSON.parse(r.text)).toEqual({ token: TOKEN, expire_at: NOW + 120_000, model: LIVE_MODEL, api: 'v1beta', setup });
    expect([LIVE_TOKEN_TTL_S, LIVE_NEW_SESSION_S, LIVE_API]).toEqual([120, 30, 'v1beta']);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(LIVE_TOKEN_URL);
    expect(LIVE_TOKEN_URL).toBe(`https://generativelanguage.googleapis.com/${LIVE_API}/auth_tokens`);
    expect(sent[0]?.headers).toEqual({ 'content-type': 'application/json', 'x-goog-api-key': KEY });
    // 官方 AuthToken.fieldMask：为空且带了 bidiGenerateContentSetup 时，连接里发的 setup 一概不认（整份锁死）
    expect(sent[0]?.body).toEqual({
      uses: 1,
      expireTime: new Date(NOW + 120_000).toISOString(),
      newSessionExpireTime: new Date(NOW + 30_000).toISOString(),
      bidiGenerateContentSetup: setup,
    });
    expect('fieldMask' in (sent[0]?.body ?? {})).toBe(false);
    // 长期密钥不进回包、不进日志
    expect(r.text.includes(KEY)).toBe(false);
    expect(g.logs.some((l) => l.includes(KEY))).toBe(false);
    expect(g.logs).toContain('minted');
  });
  it('韩文界面偏向 ko-KR；不认识的语言、没带 x-locale 不带 languageCodes（自动识别）', async () => {
    expect(liveSetup('ko-KR').inputAudioTranscription).toEqual({ languageCodes: ['ko-KR'] });
    for (const l of ['en-US', null]) {
      const { deps, sent } = world();
      await handle(req(l), deps);
      expect((sent[0]?.body.bidiGenerateContentSetup as Record<string, unknown>).inputAudioTranscription, String(l)).toEqual({});
    }
  });
  it('令牌接口非 2xx、回包没有 name、网络出错：fallback error，退回令牌两个键，写 logs（只写固定码和 status=），日志只记码和状态', async () => {
    for (const [reply, code, logCode, fields] of [
      [async () => new Response('{"error":{"message":"x"}}', { status: 403 }), 'mint_http 403', 'mint_http', ['status=403']],
      [async () => new Response('{}', { status: 200 }), 'mint_bad_body', 'mint_bad_body', []],
      [async () => new Response('not json', { status: 200 }), 'mint_bad_body', 'mint_bad_body', []],
      [async () => { throw new TypeError('net'); }, 'mint_err', 'mint_err', []],
    ] as const) {
      const { g, deps, failed } = world({}, { reply });
      expect(await body(await handle(req(), deps)), code).toEqual({ fallback: true, reason: 'error' });
      expect(liveUsed(g), code).toEqual([0, 0]);
      expect(aiUsed(g), code).toBe(0);
      expect(g.logs, code).toContain(code);
      expect(failed, code).toEqual([{ userId: UA, code: logCode, fields: [...fields] }]);
    }
  });
  it('写 logs 出错：照样回 fallback error，只记 log_write_failed', async () => {
    const { g, deps } = world({}, { reply: async () => new Response('', { status: 500 }), logFail: async () => { throw new Error('db'); } });
    expect(await body(await handle(req(), deps))).toEqual({ fallback: true, reason: 'error' });
    expect(g.logs).toContain('log_write_failed');
  });
  it(`令牌接口 ${MINT_TIMEOUT_MS} 毫秒不回：中止、fallback error、退回令牌两个键`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { g, deps } = world({}, { reply: (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) });
    const p = handle(req(), deps);
    await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS + 10);
    expect(await body(await p)).toEqual({ fallback: true, reason: 'error' });
    expect(g.logs).toContain('mint_timeout');
    expect(liveUsed(g)).toEqual([0, 0]);
  });
});
