// 启动关口的快读（B2 FA-6 ①，data/consent-api.ts 的 createRestNoticeRead、noticeState 的 fastRead / envReady）：
// 令牌还新鲜时直接 GET profiles、app_config 两张表，不加载 supabase-js；读不了（令牌快过期、401、形状不对、网络错）一律退回 supabase-js，
// 错误归类和以前一样；超过 slowMs 放弃时中断快读、也不再退回；构建没带 supabase 地址时直接按读失败放行
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../platform/supabase/client.ts';
import { createConsentApi, createRestNoticeRead, tokenExpMs, type FastNoticeRead, type RestNoticeDeps } from '../data/consent-api.ts';

const NOW = Date.UTC(2026, 10, 4, 5, 0, 0);
const V = '2026-10-29';
const MARGIN = 60_000;

/** 一看就是假的 JWT 形状令牌：只有 payload 有意义（exp 秒） */
function fakeJwt(expMs: number): string {
  const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64u({ alg: 'none' })}.${b64u({ exp: Math.floor(expMs / 1000), session_id: 'sid-test' })}.fake-signature`;
}

type Route = { status?: number; body?: unknown; raw?: string } | 'network' | 'hang';

function rest(routes: { profiles?: Route; app_config?: Route }, over: Partial<RestNoticeDeps> = {}) {
  const calls: { url: string; headers: Record<string, string>; signal: AbortSignal | null | undefined; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    // 和真 fetch 一样：请求头里有非法字符时抛 TypeError
    new Headers(init.headers);
    calls.push({ url, headers: init.headers as Record<string, string>, signal: init.signal, init });
    const r = url.includes('/rest/v1/profiles') ? routes.profiles : routes.app_config;
    if (r === 'network') throw new TypeError('Failed to fetch');
    if (r === 'hang') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return new Response(r?.raw ?? JSON.stringify(r?.body ?? []), { status: r?.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  const deps: RestNoticeDeps = {
    supabaseUrl: 'https://lemo.test/sb',
    anonKey: 'anon-key-test',
    readToken: () => fakeJwt(NOW + 3600_000),
    fetch: fetchFn,
    now: () => NOW,
    marginMs: MARGIN,
    ...over,
  };
  return { read: createRestNoticeRead(deps), calls, fetchFn };
}

const signal = () => new AbortController().signal;

/** supabase-js 那条路的替身：记下有没有被用到 */
function slowPath(profile: unknown = { consent_policy_ver: V }, notice: unknown = { policy_ver: V, min_consent_ver: V }) {
  const getDb = vi.fn(async () => ({
    from: (table: string) => ({
      select: () => {
        const reply = table === 'app_config' ? { data: { notice }, error: null } : { data: profile, error: null };
        return { eq: () => ({ maybeSingle: async () => reply }), maybeSingle: async () => reply };
      },
    }),
  }) as unknown as Db);
  return getDb;
}

describe('createRestNoticeRead：两张表的请求和响应形状', () => {
  it('发的就是 supabase-js 的那一对 GET：带 apikey、Bearer 令牌；读到本人版本和 notice', async () => {
    const notice = { policy_ver: V, min_consent_ver: V };
    const r = rest({ profiles: { body: [{ consent_policy_ver: V }] }, app_config: { body: [{ notice }] } });
    expect(await r.read(signal())).toEqual({ mine: V, notice });
    expect(r.calls.map((c) => c.url).sort()).toEqual([
      'https://lemo.test/sb/rest/v1/app_config?select=notice&id=eq.1',
      'https://lemo.test/sb/rest/v1/profiles?select=consent_policy_ver',
    ]);
    for (const c of r.calls) {
      expect(c.headers).toEqual({ apikey: 'anon-key-test', Authorization: `Bearer ${fakeJwt(NOW + 3600_000)}`, Accept: 'application/json' });
      expect(c.signal).toBeTruthy();
      // 安全审查 L1：不走 HTTP 缓存、不跟随重定向
      expect(c.init.cache).toBe('no-store');
      expect(c.init.redirect).toBe('error');
    }
  });

  it('没有 profile 行、没有 app_config 行（空数组）：mine、notice 都是 null（同 maybeSingle 的 data: null）', async () => {
    expect(await rest({ profiles: { body: [] }, app_config: { body: [] } }).read(signal())).toEqual({ mine: null, notice: null });
    expect(await rest({ profiles: { body: [{ consent_policy_ver: null }] }, app_config: { body: [{ notice: null }] } }).read(signal()))
      .toEqual({ mine: null, notice: null });
  });

  it('形状不对一律回 null（退回 supabase-js）：多于一行、不是数组、版本不是字符串、行里没有 notice', async () => {
    const ok = { body: [{ notice: {} }] };
    expect(await rest({ profiles: { body: [{ consent_policy_ver: V }, { consent_policy_ver: V }] }, app_config: ok }).read(signal())).toBeNull();
    expect(await rest({ profiles: { body: { consent_policy_ver: V } }, app_config: ok }).read(signal())).toBeNull();
    expect(await rest({ profiles: { body: [{ consent_policy_ver: 20261029 }] }, app_config: ok }).read(signal())).toBeNull();
    expect(await rest({ profiles: { body: [{ consent_policy_ver: V }] }, app_config: { body: [{ other: 1 }] } }).read(signal())).toBeNull();
    expect(await rest({ profiles: { body: ['x'] }, app_config: ok }).read(signal())).toBeNull();
  });

  it('401（例如本机时钟不准、令牌其实已过期）、403、500：回 null，不在这里判成“被移除”', async () => {
    for (const status of [401, 403, 500]) {
      expect(await rest({ profiles: { status, body: { code: 'PGRST301', message: 'JWT expired' } }, app_config: { body: [] } }).read(signal())).toBeNull();
      expect(await rest({ profiles: { body: [] }, app_config: { status, body: {} } }).read(signal())).toBeNull();
    }
  });

  it('401、403 但返回体是空数组 []（形状像“没有那一行”）：照样回 null，不当成 mine / notice 为 null（安全复审 L8 ②）', async () => {
    for (const status of [401, 403]) {
      expect(await rest({ profiles: { status, body: [] }, app_config: { body: [{ notice: { policy_ver: V, min_consent_ver: V } }] } }).read(signal())).toBeNull();
      expect(await rest({ profiles: { body: [{ consent_policy_ver: V }] }, app_config: { status, body: [] } }).read(signal())).toBeNull();
      expect(await rest({ profiles: { status, body: [] }, app_config: { status, body: [] } }).read(signal())).toBeNull();
    }
  });

  it('网络错：回 null', async () => {
    expect(await rest({ profiles: 'network', app_config: { body: [] } }).read(signal())).toBeNull();
  });

  it('2xx 但返回体不是 JSON（例如转发层回了一页 HTML）：回 null（安全审查 L4）', async () => {
    expect(await rest({ profiles: { raw: '<html>oops</html>' }, app_config: { body: [] } }).read(signal())).toBeNull();
    expect(await rest({ profiles: { body: [] }, app_config: { raw: '' } }).read(signal())).toBeNull();
  });

  it('一张表读不了：立刻中断另一张、马上回 null，不等它回来（安全审查 L2）', async () => {
    for (const bad of [{ status: 401, body: {} }, 'network', { raw: 'not json' }] as const) {
      const r = rest({ profiles: bad, app_config: 'hang' });
      expect(await r.read(signal())).toBeNull();
      expect(r.calls.find((c) => c.url.includes('app_config'))?.signal?.aborted).toBe(true);
    }
  });

  it('令牌里有非法头字符（new Headers 抛 TypeError）：回 null，不往外抛（安全审查 L4）', async () => {
    const r = rest({ profiles: { body: [] }, app_config: { body: [] } }, { readToken: () => `${fakeJwt(NOW + 3600_000)}\nx` });
    expect(await r.read(signal())).toBeNull();
    expect(r.calls).toEqual([]);
  });

  it('令牌快过期（离 exp 不到 marginMs）、已过期、读不出 exp、没有令牌：不发请求，回 null（supabase-js 会先刷新）', async () => {
    for (const token of [fakeJwt(NOW + MARGIN - 1000), fakeJwt(NOW - 1000), 'fake-access-token-not-jwt', 'a.!!!.b', null]) {
      const r = rest({ profiles: { body: [] }, app_config: { body: [] } }, { readToken: () => token });
      expect(await r.read(signal())).toBeNull();
      expect(r.fetchFn).not.toHaveBeenCalled();
    }
    // 刚好还剩 margin 以上：走快读
    const r = rest({ profiles: { body: [] }, app_config: { body: [] } }, { readToken: () => fakeJwt(NOW + MARGIN + 1000) });
    expect(await r.read(signal())).toEqual({ mine: null, notice: null });
  });

  it('构建没带 supabase 地址或 anon key：不发请求，回 null', async () => {
    for (const over of [{ supabaseUrl: '' }, { anonKey: '' }]) {
      const r = rest({}, over);
      expect(await r.read(signal())).toBeNull();
      expect(r.fetchFn).not.toHaveBeenCalled();
    }
  });

  it('tokenExpMs：只解 payload 的 exp（秒 → 毫秒）', () => {
    expect(tokenExpMs(fakeJwt(NOW))).toBe(Math.floor(NOW / 1000) * 1000);
    expect(tokenExpMs('no-dots')).toBeNull();
    expect(tokenExpMs(`x.${btoa(JSON.stringify({ exp: 'soon' }))}.y`)).toBeNull();
  });
});

describe('noticeState 接上快读', () => {
  it('快读读到了：按同一套规则判断，不碰 supabase-js', async () => {
    const getDb = slowPath();
    const cases: [string | null, unknown, string][] = [
      [null, { policy_ver: V, min_consent_ver: V }, 'first'],
      ['2026-10-28', { policy_ver: V, min_consent_ver: V }, 'updated'],
      [V, { policy_ver: V, min_consent_ver: V }, 'none'],
      [V, null, 'none'],
    ];
    for (const [mine, notice, want] of cases) {
      const fastRead: FastNoticeRead = async () => ({ mine, notice });
      expect(await createConsentApi(getDb, 8000, 30000, () => null, { fastRead }).noticeState()).toEqual({ ok: true, value: want });
    }
    expect(getDb).not.toHaveBeenCalled();
  });

  it('快读回 null（例如 401、令牌快过期）：退回 supabase-js，结果以它为准', async () => {
    const getDb = slowPath({ consent_policy_ver: '2026-10-28' });
    const r = rest({ profiles: { status: 401, body: {} }, app_config: { body: [] } });
    const api = createConsentApi(getDb, 8000, 30000, () => null, { fastRead: r.read });
    expect(await api.noticeState()).toEqual({ ok: true, value: 'updated' });
    expect(getDb).toHaveBeenCalledTimes(1);
  });

  it('快读回 null 以后 supabase-js 报错：错误归类和原来一样（401 → revoked 带 sid、网络错 → offline、account_disabled → disabled）（安全审查 L4）', async () => {
    const cases: [unknown, unknown][] = [
      [{ message: 'JWT expired', status: 401 }, { ok: false, error: 'revoked', sid: 'sid-1' }],
      [{ name: 'TypeError', message: 'Failed to fetch' }, { ok: false, error: 'offline' }],
      [{ message: 'account_disabled' }, { ok: false, error: 'disabled', sid: 'sid-1' }],
    ];
    for (const [error, want] of cases) {
      const getDb = vi.fn(async () => ({
        from: () => ({
          select: () => {
            const reply = { data: null, error };
            return { eq: () => ({ maybeSingle: async () => reply }), maybeSingle: async () => reply };
          },
        }),
      }) as unknown as Db);
      const r = rest({ profiles: { status: 401, body: {} }, app_config: { body: [] } });
      const api = createConsentApi(getDb, 8000, 30000, () => 'sid-1', { fastRead: r.read });
      expect(await api.noticeState()).toEqual(want);
      expect(getDb).toHaveBeenCalledTimes(1);
    }
  });

  it('一张表 2xx、另一张挂住直到超时：到 slowMs 回 offline，挂住的那张被中断，不退回 supabase-js（安全审查 L4）', async () => {
    vi.useFakeTimers();
    try {
      const getDb = slowPath();
      const r = rest({ profiles: { body: [{ consent_policy_ver: V }] }, app_config: 'hang' });
      const p = createConsentApi(getDb, 8000, 30000, () => null, { fastRead: r.read }).noticeState();
      await vi.advanceTimersByTimeAsync(8000);
      expect(await p).toEqual({ ok: false, error: 'offline' });
      expect(r.calls.find((c) => c.url.includes('app_config'))?.signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(getDb).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时：快读挂住，到 slowMs 回 offline，中断快读的请求，也不再退回 supabase-js', async () => {
    vi.useFakeTimers();
    try {
      const getDb = slowPath();
      const r = rest({ profiles: 'hang', app_config: 'hang' });
      const p = createConsentApi(getDb, 8000, 30000, () => null, { fastRead: r.read }).noticeState();
      await vi.advanceTimersByTimeAsync(8000);
      expect(await p).toEqual({ ok: false, error: 'offline' });
      expect(r.calls.length).toBe(2);
      for (const c of r.calls) expect(c.signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(getDb).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('envReady 为假（构建没带 supabase 地址）：直接回 unknown（和原来 supabase_env_missing 的归类一样），不下载 supabase-js', async () => {
    const getDb = slowPath();
    const fastRead = vi.fn<FastNoticeRead>(async () => null);
    expect(await createConsentApi(getDb, 8000, 30000, () => null, { fastRead, envReady: false }).noticeState()).toEqual({ ok: false, error: 'unknown' });
    expect(getDb).not.toHaveBeenCalled();
    expect(fastRead).not.toHaveBeenCalled();
    // 对照：原来那条路报 supabase_env_missing 时同样归 unknown
    const missing = vi.fn(async (): Promise<Db> => { throw new Error('supabase_env_missing'); });
    expect(await createConsentApi(missing).noticeState()).toEqual({ ok: false, error: 'unknown' });
  });
});
