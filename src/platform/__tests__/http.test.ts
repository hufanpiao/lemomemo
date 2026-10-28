// X-App-Version（架构 0.27 第 1 点）：supabase-js 的 global.headers 和直接 fetch 都带上，且调用方改不掉
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION_HEADER, appFetch, withAppVersion } from '../http.ts';
import { clientOptions } from '../supabase/client.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('X-App-Version', () => {
  it('withAppVersion：补上版本头，同名头以构建版本为准', () => {
    const h = withAppVersion({ 'X-App-Version': '0.0.1', 'Content-Type': 'application/json' }, '4.0.0');
    expect(h.get(APP_VERSION_HEADER)).toBe('4.0.0');
    expect(h.get('content-type')).toBe('application/json');
  });

  it('默认用构建版本（__APP_VERSION__）', () => {
    expect(withAppVersion(undefined).get(APP_VERSION_HEADER)).toBe('4.0.0');
  });

  it('appFetch：真的把头带进 fetch，也保留 Request 自己的头', async () => {
    const spy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response('ok')));
    vi.stubGlobal('fetch', spy);
    await appFetch('https://example.invalid/functions/v1/x', { method: 'POST', headers: { a: '1' } });
    await appFetch(new Request('https://example.invalid/y', { headers: { b: '2' } }));
    const h1 = new Headers(spy.mock.calls[0]?.[1]?.headers);
    const h2 = new Headers(spy.mock.calls[1]?.[1]?.headers);
    expect(h1.get(APP_VERSION_HEADER)).toBe('4.0.0');
    expect(h1.get('a')).toBe('1');
    expect(spy.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(h2.get(APP_VERSION_HEADER)).toBe('4.0.0');
    expect(h2.get('b')).toBe('2');
  });

  it('supabase-js：global.headers 带版本，global.fetch 走同一个封装', () => {
    const o = clientOptions('4.1.0');
    expect(o.global.headers[APP_VERSION_HEADER]).toBe('4.1.0');
    expect(o.global.fetch).toBe(appFetch);
  });
});
