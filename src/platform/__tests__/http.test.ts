// X-App-Version（架构 0.27 第 1 点）：supabase-js 的 global.headers 和直接 fetch 都带上，且调用方改不掉
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION_HEADER, appFetch, onUpgradeRequired, readUpgradeRequired, withAppVersion } from '../http.ts';
import { clientOptions } from '../supabase/client.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('X-App-Version', () => {
  it('头名和转发层、契约用例（tests/compat/headers.test.ts 写死的）一致', () => {
    expect(APP_VERSION_HEADER).toBe('X-App-Version');
  });

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

describe('426 upgrade_required（0.27 第 1 点）', () => {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('readUpgradeRequired：426 读出 min；min 格式不对或没有为 null；4xx 的 code = upgrade_required 也算；其他不算', async () => {
    expect(await readUpgradeRequired(json(426, { code: 'upgrade_required', min: '4.1.0' }))).toEqual({ code: 'upgrade_required', min: '4.1.0' });
    expect(await readUpgradeRequired(json(426, { code: 'upgrade_required', min: '<script>' }))).toEqual({ code: 'upgrade_required', min: null });
    expect(await readUpgradeRequired(new Response('', { status: 426 }))).toEqual({ code: 'upgrade_required', min: null });
    expect(await readUpgradeRequired(json(400, { code: 'upgrade_required', min: '4.2.0' }))).toEqual({ code: 'upgrade_required', min: '4.2.0' });
    expect(await readUpgradeRequired(json(400, { code: 'invalid' }))).toBeNull();
    expect(await readUpgradeRequired(json(200, { code: 'upgrade_required' }))).toBeNull();
  });

  it('不吃掉响应体：调用方还能再读', async () => {
    const res = json(426, { code: 'upgrade_required', min: '4.1.0' });
    await readUpgradeRequired(res);
    expect(await res.json()).toEqual({ code: 'upgrade_required', min: '4.1.0' });
  });

  it('appFetch 收到 426 时通知订阅者，响应原样返回；取消订阅后不再通知', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(426, { code: 'upgrade_required', min: '4.1.0' }))));
    const seen = vi.fn();
    const off = onUpgradeRequired(seen);
    const res = await appFetch('https://example.invalid/sb/rest/v1/todos', { method: 'POST' });
    expect(res.status).toBe(426);
    expect(seen).toHaveBeenCalledWith({ code: 'upgrade_required', min: '4.1.0' });
    off();
    await appFetch('https://example.invalid/sb/rest/v1/todos', { method: 'POST' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('正常响应不通知', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(201, {}))));
    const seen = vi.fn();
    const off = onUpgradeRequired(seen);
    await appFetch('https://example.invalid/x');
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});
