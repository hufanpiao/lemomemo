// 告知与同意页的接口（架构 15.5、3.3 D；0.40 R-238、R-239）：每次现读 notice.policy_ver 再调 record_consent(policy_ver, revoke)；
// notice 为空或认不出不调 RPC（no_policy）；告知状态 first / updated / none；错误按码归类；慢网先 onSlow、太久回 unsure
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../platform/supabase/client.ts';
import { createConsentApi, mapConsentError, policyVerAtLeast } from '../data/consent-api.ts';

type Reply = { data: unknown; error: unknown };
const V = '2026-10-29';
const NOTICE = { notice: { policy_ver: V, min_consent_ver: V } };

function fakeDb(opts: { notice?: Reply; profile?: Reply; rpc?: Reply | 'hang'; noticeDelayMs?: number } = {}) {
  const log: string[] = [];
  const signals: AbortSignal[] = [];
  const db = {
    from(table: string) {
      return {
        select(cols: string) {
          log.push(`select ${table}.${cols}`);
          const reply = table === 'app_config'
            ? opts.notice ?? { data: NOTICE, error: null }
            : opts.profile ?? { data: { consent_policy_ver: null }, error: null };
          const later = async (): Promise<Reply> => {
            if (opts.noticeDelayMs) await new Promise((r) => setTimeout(r, opts.noticeDelayMs));
            return reply;
          };
          return {
            eq(c: string, v: unknown) { log.push(`eq ${c}=${String(v)}`); return { maybeSingle: later }; },
            maybeSingle: async () => reply,
          };
        },
      };
    },
    rpc(fn: string, args: unknown) {
      log.push(`rpc ${fn} ${JSON.stringify(args)}`);
      const r = opts.rpc ?? { data: null, error: null };
      return {
        abortSignal(signal: AbortSignal) {
          signals.push(signal);
          if (r !== 'hang') return Promise.resolve(r);
          // 挂住的请求：abort 时像 fetch 一样以 AbortError 结束
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
        },
      };
    },
  };
  return { getDb: async () => db as unknown as Db, log, signals };
}

describe('record：调 record_consent', () => {
  it('同意：先读 app_config 的 notice.policy_ver，再 record_consent(policy_ver, revoke=false)', async () => {
    const { getDb, log } = fakeDb();
    expect(await createConsentApi(getDb).record(true)).toEqual({ ok: true, value: undefined });
    expect(log).toEqual(['select app_config.notice', 'eq id=1', `rpc record_consent {"policy_ver":"${V}","revoke":false}`]);
  });

  it('不同意：record_consent(policy_ver, revoke=true)（记下拒绝的那一版）', async () => {
    const { getDb, log } = fakeDb();
    expect((await createConsentApi(getDb).record(false)).ok).toBe(true);
    expect(log.at(-1)).toBe(`rpc record_consent {"policy_ver":"${V}","revoke":true}`);
  });

  it('R-239：notice 为空、没有 policy_ver、policy_ver 不是 R-238 写法：不调 RPC，回 no_policy', async () => {
    for (const notice of [null, {}, { policy_ver: '' }, { policy_ver: 3 }, { policy_ver: '4.0.1' }, { policy_ver: '2026-1-5' }, { policy_ver: '2026-10-29-0' }]) {
      const { getDb, log } = fakeDb({ notice: { data: { notice }, error: null } });
      expect(await createConsentApi(getDb).record(true), JSON.stringify(notice)).toEqual({ ok: false, error: 'no_policy' });
      expect(log.some((l) => l.startsWith('rpc'))).toBe(false);
    }
    const none = fakeDb({ notice: { data: null, error: null } });
    expect(await createConsentApi(none.getDb).record(false)).toEqual({ ok: false, error: 'no_policy' });
  });

  it('服务器报 policy_ver_mismatch（刚好升版）→ version_changed；session_revoked → revoked', async () => {
    const a = fakeDb({ rpc: { data: null, error: { code: 'P0001', message: 'policy_ver_mismatch' } } });
    expect(await createConsentApi(a.getDb).record(true)).toEqual({ ok: false, error: 'version_changed' });
    const b = fakeDb({ rpc: { data: null, error: { code: 'P0001', message: 'session_revoked' } } });
    expect(await createConsentApi(b.getDb).record(false)).toEqual({ ok: false, error: 'revoked' });
  });

  it('服务器报 account_disabled（账号停用、没有 profile 行、一行都没更新）→ disabled，同意和不同意都一样', async () => {
    for (const agree of [true, false]) {
      const a = fakeDb({ rpc: { data: null, error: { code: 'P0001', message: 'account_disabled' } } });
      expect(await createConsentApi(a.getDb).record(agree)).toEqual({ ok: false, error: 'disabled' });
    }
  });

  it('读 notice 出错、拿客户端抛异常：按错误归类，不调 RPC', async () => {
    const a = fakeDb({ notice: { data: null, error: { message: 'TypeError: Failed to fetch' } } });
    expect(await createConsentApi(a.getDb).record(true)).toEqual({ ok: false, error: 'offline' });
    expect(a.log.some((l) => l.startsWith('rpc'))).toBe(false);
    const api = createConsentApi(async () => { throw new Error('boom'); });
    expect(await api.record(true)).toEqual({ ok: false, error: 'unknown' });
  });

  it('慢网：超过 slowMs 先调 onSlow、仍在等；超过 hardMs 才回 unsure（不说“没记下”）', async () => {
    vi.useFakeTimers();
    try {
      const { getDb } = fakeDb({ rpc: 'hang' });
      const onSlow = vi.fn();
      let done: unknown;
      void createConsentApi(getDb, 1000, 5000).record(true, onSlow).then((r) => { done = r; });
      await vi.advanceTimersByTimeAsync(999);
      expect(onSlow).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onSlow).toHaveBeenCalledOnce();
      expect(done).toBeUndefined();
      await vi.advanceTimersByTimeAsync(4000);
      expect(done).toEqual({ ok: false, error: 'unsure' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('CONSENT-wire ⑧：超过 hardMs 放弃时中断还在路上的 rpc（abortSignal 被 abort）', async () => {
    vi.useFakeTimers();
    try {
      const { getDb, signals } = fakeDb({ rpc: 'hang' });
      let done: unknown;
      void createConsentApi(getDb, 1000, 5000).record(true).then((r) => { done = r; });
      await vi.advanceTimersByTimeAsync(10);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(done).toEqual({ ok: false, error: 'unsure' });
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CONSENT-wire ⑧：读 notice 时就已经放弃了：读完也不再调 rpc（不会晚到一条同意）', async () => {
    vi.useFakeTimers();
    try {
      const { getDb, log } = fakeDb({ noticeDelayMs: 8000 });
      let done: unknown;
      void createConsentApi(getDb, 1000, 5000).record(true).then((r) => { done = r; });
      await vi.advanceTimersByTimeAsync(5000);
      expect(done).toEqual({ ok: false, error: 'unsure' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(log.some((l) => l.startsWith('rpc'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('正常返回：rpc 也带了 abortSignal，返回后 abort 不影响结果', async () => {
    const { getDb, signals } = fakeDb();
    expect(await createConsentApi(getDb).record(false)).toEqual({ ok: true, value: undefined });
    expect(signals).toHaveLength(1);
  });

  it('很快回来：不调 onSlow', async () => {
    vi.useFakeTimers();
    try {
      const { getDb } = fakeDb();
      const onSlow = vi.fn();
      expect((await createConsentApi(getDb, 1000, 5000).record(true, onSlow)).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      expect(onSlow).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('noticeState：弹哪一屏（R-239）', () => {
  const state = async (mine: string | null, notice: unknown) => {
    const a = fakeDb({ profile: { data: { consent_policy_ver: mine }, error: null }, notice: { data: { notice }, error: null } });
    return createConsentApi(a.getDb).noticeState();
  };

  it('consent_policy_ver 为空 → first（不管 notice）', async () => {
    expect(await state(null, NOTICE.notice)).toEqual({ ok: true, value: 'first' });
    expect(await state(null, null)).toEqual({ ok: true, value: 'first' });
  });

  it('有值且低于 min_consent_ver → updated；等于或高于 → none', async () => {
    expect(await state('2026-10-28', NOTICE.notice)).toEqual({ ok: true, value: 'updated' });
    expect(await state(V, { policy_ver: '2026-10-29-1', min_consent_ver: '2026-10-29-1' })).toEqual({ ok: true, value: 'updated' });
    expect(await state(V, NOTICE.notice)).toEqual({ ok: true, value: 'none' });
    expect(await state('2026-11-01', NOTICE.notice)).toEqual({ ok: true, value: 'none' });
  });

  it('notice 为空或 min_consent_ver 认不出 → none（不弹“隐私说明更新了”）', async () => {
    expect(await state(V, null)).toEqual({ ok: true, value: 'none' });
    expect(await state('2026-10-28', { policy_ver: V })).toEqual({ ok: true, value: 'none' });
    expect(await state('2026-10-28', { policy_ver: V, min_consent_ver: '4.0.1' })).toEqual({ ok: true, value: 'none' });
  });

  it('读不出来：回错误，不当成 none', async () => {
    const a = fakeDb({ profile: { data: null, error: { status: 503, message: 'try_later' } } });
    expect(await createConsentApi(a.getDb).noticeState()).toEqual({ ok: false, error: 'try_later' });
  });
});

describe('policyVerAtLeast（和服务器 _shared/consent.ts 同一批样例）', () => {
  it('R-238 写法按段比，缺段按 0；空或格式不对一律 false', () => {
    expect(policyVerAtLeast('2026-10-29', '2026-10-28')).toBe(true);
    expect(policyVerAtLeast('2026-10-29-10', '2026-10-29-9')).toBe(true);
    expect(policyVerAtLeast(V, '2026-10-29-1')).toBe(false);
    expect(policyVerAtLeast(V, V)).toBe(true);
    for (const b of [null, undefined, '', '4.0.1', '2026-1-5', '2026-10-29-0', '2026-10-29-100', '2026-10-29-01']) {
      expect(policyVerAtLeast(b, V), String(b)).toBe(false);
      expect(policyVerAtLeast('2099-12-31', b), String(b)).toBe(false);
    }
  });
});

describe('mapConsentError', () => {
  it('按码归类', () => {
    expect(mapConsentError({ message: 'unauthorized' })).toBe('revoked');
    expect(mapConsentError({ status: 401 })).toBe('revoked');
    expect(mapConsentError({ code: 'P0001', message: 'account_disabled' })).toBe('disabled');
    expect(mapConsentError({ code: 'account_disabled' })).toBe('disabled');
    expect(mapConsentError({ name: 'AuthRetryableFetchError', status: 0 })).toBe('offline');
    expect(mapConsentError({ message: 'Load failed' })).toBe('offline');
    expect(mapConsentError({ code: 'try_later' })).toBe('try_later');
    expect(mapConsentError({ message: 'something else' })).toBe('unknown');
    expect(mapConsentError(null)).toBe('unknown');
  });
});
