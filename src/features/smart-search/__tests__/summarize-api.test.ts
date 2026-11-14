// 调 ai-summarize（data/summarize-api.ts；架构 5.14 第 4 点；契约 shared/schema/summarize.ts）：请求形状、各种返回的归类、超时 / 断网 / 没登录；
// 送之前等这几条发出去（waitSent）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUMMARY_ASK_MAX } from '../../../../shared/schema/summarize.ts';
import type { FnDeps } from '../data/fn-call.ts';
import { summarize, SUMMARY_TIMEOUT_MS, waitSent, type SumReq } from '../data/summarize-api.ts';

const ID = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';
const REQ: SumReq = { ids: [{ kind: 'todo', id: ID }, { kind: 'note', id: ID2 }], ask: '总结一下这周', now: 1_700_000_000_000, tz: 'Asia/Seoul', locale: 'zh' };

function deps(res: (init: RequestInit) => Promise<Response>, token: string | null = 'jwt'): FnDeps & { seen: { url: string; init: RequestInit }[] } {
  const seen: { url: string; init: RequestInit }[] = [];
  return {
    seen,
    accessToken: async () => token,
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return res(init);
    }) as never,
    base: 'https://x/functions/v1',
    anonKey: 'anon',
  };
}
const reply = (body: unknown, status = 200) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const sig = () => new AbortController().signal;

afterEach(() => {
  vi.useRealTimers();
});

describe('summarize：请求', () => {
  it('POST 到 ai-summarize，带令牌；请求体 ids、ask、now、tz、locale、scope=main；ask 截到上限', async () => {
    const d = deps(reply({ summary: '这周两件事', cited: [ID], missing: [], quota_left: 9 }));
    await summarize({ ...REQ, ask: '字'.repeat(SUMMARY_ASK_MAX + 20) }, sig(), d);
    expect(d.seen[0]?.url).toBe('https://x/functions/v1/ai-summarize');
    expect(d.seen[0]?.init.headers).toMatchObject({ authorization: 'Bearer jwt', apikey: 'anon' });
    const body = JSON.parse(String(d.seen[0]?.init.body));
    expect(body).toEqual({ ids: REQ.ids, ask: '字'.repeat(SUMMARY_ASK_MAX), now: REQ.now, tz: 'Asia/Seoul', locale: 'zh', scope: 'main' });
  });
});

describe('summarize：返回归类', () => {
  it('成功：summary、cited、missing、quotaLeft', async () => {
    const d = deps(reply({ summary: '这周两件事', cited: [ID], missing: [ID2], quota_left: 9 }));
    expect(await summarize(REQ, sig(), d)).toEqual({ ok: true, summary: '这周两件事', cited: [ID], missing: [ID2], quotaLeft: 9 });
  });
  it.each([
    [{ consent_required: true }, 200, { reason: 'consent', code: 'consent_required' }],
    [{ quota_out: true, quota_left: 0 }, 200, { reason: 'quota', code: 'quota_out' }],
    [{ fallback: true, reason: 'quota' }, 200, { reason: 'quota', code: 'quota' }],
    [{ fallback: true, reason: 'timeout' }, 200, { reason: 'failed', code: 'timeout' }],
    [{ fallback: true, reason: 'feature_off' }, 200, { reason: 'failed', code: 'feature_off' }],
    [{ error: 'all_missing' }, 400, { reason: 'all_missing', code: 'all_missing' }],
    [{ error: 'mixed_scope' }, 400, { reason: 'failed', code: 'mixed_scope' }],
    [{ error: 'boom' }, 500, { reason: 'failed', code: 'boom' }],
    ['not json', 502, { reason: 'failed', code: '502' }],
    [{ summary: '', cited: [], missing: [], quota_left: 1 }, 200, { reason: 'failed', code: 'bad_response' }],
    ['not json', 200, { reason: 'failed', code: 'bad_response' }],
  ])('返回 %j（HTTP %i）→ %j', async (body, status, want) => {
    expect(await summarize(REQ, sig(), deps(reply(body, status)))).toEqual({ ok: false, ...want });
  });
  it('没登录：no_session，不发请求', async () => {
    const d = deps(reply({}), null);
    expect(await summarize(REQ, sig(), d)).toEqual({ ok: false, reason: 'failed', code: 'no_session' });
    expect(d.seen).toHaveLength(0);
  });
  it('断网（fetch 抛错）：network', async () => {
    const d = deps(async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await summarize(REQ, sig(), d)).toEqual({ ok: false, reason: 'failed', code: 'network' });
  });
  it(`等满 ${SUMMARY_TIMEOUT_MS} 毫秒算超时；调用方取消也算 timeout`, async () => {
    vi.useFakeTimers();
    const hang = (init: RequestInit) => new Promise<Response>((_r, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('a', 'AbortError'))));
    const p = summarize(REQ, sig(), deps(hang));
    await vi.advanceTimersByTimeAsync(SUMMARY_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ ok: false, reason: 'failed', code: 'timeout' });
    vi.useRealTimers();
    const ac = new AbortController();
    const q = summarize(REQ, ac.signal, deps(hang));
    ac.abort();
    expect(await q).toEqual({ ok: false, reason: 'failed', code: 'timeout' });
  });
});

describe('waitSent：等这几条发出去', () => {
  it('outbox 里没有这几条：立刻回 false，只看一次；看的是这几个 id', async () => {
    const has = vi.fn(async (_s: ReadonlySet<string>) => false);
    expect(await waitSent(REQ.ids, sig(), 3000, has)).toBe(false);
    expect(has).toHaveBeenCalledTimes(1);
    expect([...(has.mock.calls[0]?.[0] ?? [])]).toEqual([ID, ID2]);
  });
  it('一直有：等满 ms 回 true（还剩没发的）', async () => {
    vi.useFakeTimers();
    const has = vi.fn(async () => true);
    let done: boolean | null = null;
    void waitSent(REQ.ids, sig(), 1000, has).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(900);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(400);
    expect(done).toBe(true);
    expect(has.mock.calls.length).toBeGreaterThan(1);
  });
  it('中途发完了：回 false', async () => {
    vi.useFakeTimers();
    let n = 0;
    const has = vi.fn(async () => (n += 1) < 3);
    const p = waitSent(REQ.ids, sig(), 3000, has);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe(false);
    expect(has).toHaveBeenCalledTimes(3);
  });
  it('signal 取消：回 false，不再看', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const has = vi.fn(async () => true);
    const p = waitSent(REQ.ids, ac.signal, 3000, has);
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toBe(false);
    const calls = has.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(has.mock.calls.length).toBe(calls);
  });
});
