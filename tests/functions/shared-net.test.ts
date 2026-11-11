// 服务器函数出站请求的唯一出口 _shared/net.ts（timedFetch、postOut）和发信出口 _shared/mail-send.ts（sendMail）。
// 超时用 setTimeout 计（不是 AbortSignal.timeout）：测试的假计时器管得到，Gemini、推送的超时用例才能按毫秒推进。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NET_TIMEOUT_MS, postOut, timedFetch } from '../../supabase/functions/_shared/net.ts';
import { MAIL_FROM, RESEND_EMAILS_URL, sendMail } from '../../supabase/functions/_shared/mail-send.ts';
import { ROOT } from '../arch/fixture-header.ts';

/** 只在 signal 被中止时拒绝（拒绝的值就是 signal.reason，同真的 fetch） */
function hang() {
  const seen: RequestInit[] = [];
  const base = (_u: string, init: RequestInit) => {
    seen.push(init);
    return new Promise<Response>((_, rej) => {
      const s = init.signal;
      if (s?.aborted) rej(s.reason);
      s?.addEventListener('abort', () => rej(s.reason));
    });
  };
  return { base, seen };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('timedFetch', () => {
  it('① 到点（20 ms）以 TimeoutError 中止；差 1 ms 时还没中止（假计时器管得到）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { base } = hang();
    let settled: unknown = null;
    const p = timedFetch(base, 20)('https://x.test/a').catch((e: unknown) => { settled = e; });
    await vi.advanceTimersByTimeAsync(19);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect((settled as Error).name).toBe('TimeoutError');
  });

  it('② 调用方自己的 signal 先中止：请求同样中止（两个 signal 谁先到算谁）', async () => {
    const { base } = hang();
    const ac = new AbortController();
    const p = timedFetch(base, 60_000)('https://x.test/a', { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('③ 调用方没传 signal：交给底层的也带着 signal；别的参数原样转交', async () => {
    const { base, seen } = hang();
    void timedFetch(base)('https://x.test/a', { method: 'PUT', headers: { a: '1' } }).catch(() => {});
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.signal?.aborted).toBe(false);
    expect([seen[0]?.method, seen[0]?.headers]).toEqual(['PUT', { a: '1' }]);
    expect(NET_TIMEOUT_MS).toBe(8_000);
  });
});

describe('postOut', () => {
  it('④ 一律 POST、不跟重定向（覆盖调用方给的 method、redirect），带超时', async () => {
    const calls: [string, RequestInit][] = [];
    const base = async (u: string, init: RequestInit) => { calls.push([u, init]); return new Response('ok'); };
    await postOut(base, 'https://x.test/post', { method: 'GET', redirect: 'follow', body: 'b' });
    expect(calls).toHaveLength(1);
    const [u, init] = calls[0] ?? ['', {}];
    expect([u, init.method, init.redirect, init.body]).toEqual(['https://x.test/post', 'POST', 'error', 'b']);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('sendMail（经全局 fetch 发到 Resend）', () => {
  it('⑤ 地址、authorization、发件人、收件人数组、标题正文原样；2xx 才算发出，500 回 false；网络错照常抛', async () => {
    const calls: [string, RequestInit][] = [];
    let status = 200;
    vi.stubGlobal('fetch', async (u: string, init: RequestInit) => { calls.push([u, init]); return new Response('{}', { status }); });
    expect(await sendMail('re_key', 'a@example.com', { subject: '主题', text: '正文' })).toBe(true);
    const [u, init] = calls[0] ?? ['', {}];
    expect([u, init.method, init.redirect]).toEqual([RESEND_EMAILS_URL, 'POST', 'error']);
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer re_key');
    expect(JSON.parse(String(init.body))).toEqual({ from: MAIL_FROM, to: ['a@example.com'], subject: '主题', text: '正文' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    status = 500;
    expect(await sendMail('re_key', 'a@example.com', { subject: 's', text: 't' }, 'https://mail.test/emails')).toBe(false);
    expect(calls[1]?.[0]).toBe('https://mail.test/emails');
    vi.stubGlobal('fetch', async () => { throw new TypeError('network'); });
    await expect(sendMail('re_key', 'a@example.com', { subject: 's', text: 't' })).rejects.toThrow('network');
  });
});

describe('接线：三个定时函数的 supabase-js、account-purge 的 R2 都经 timedFetch', () => {
  const src = (fn: string) => readFileSync(join(ROOT, 'supabase', 'functions', fn, 'index.ts'), 'utf8');
  it.each(['account-purge', 'ai-classify', 'push-dispatch'])('%s：createClient 带 global.fetch = timedFetch(fetch, …)', (fn) => {
    expect(src(fn)).toMatch(/createClient\([^\n]*global: \{ fetch: timedFetch\(fetch, [A-Z_]+\) \}/);
  });
  it('account-purge：R2 客户端的 fetch 经 timedFetch', () => {
    expect(src('account-purge')).toMatch(/createObjStore\(\{[^}]*fetch: \(url, init\) => timedFetch\(fetch\)\(url, init as RequestInit\)/s);
  });
});
