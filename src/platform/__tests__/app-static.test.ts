// 拉 App 自带的静态 JSON（B2 FA-3：节假日）：只认同源的相对路径；拿不到一律 null、不抛错
import { describe, expect, it, vi } from 'vitest';
import { appStaticUrl, fetchAppJson, fetchAppJsonStatus } from '../app-static.ts';

const BASE = 'https://lemomemo.com/app/';
const URL_CN = 'https://lemomemo.com/app/holidays/cn/2026.json';

describe('appStaticUrl', () => {
  it('相对 App 根目录拼成同源地址', () => {
    expect(appStaticUrl('holidays/cn/2026.json', BASE)).toBe(URL_CN);
  });

  it('拼不出别的源、也不出 App 目录：绝对地址、//、..、反斜杠、问号、不是 .json 都拒', () => {
    const bad = ['https://evil.com/a.json', '//evil.com/a.json', '/holidays/a.json', '../x.json', 'a/../../x.json', String.raw`a\b.json`, 'a.json?x=1', 'a.js', ' a.json'];
    for (const p of bad) expect(appStaticUrl(p, BASE), p).toBeNull();
  });
});

describe('fetchAppJson', () => {
  it('成功返回 JSON；404、网络错误、不是 JSON 都返回 null', async () => {
    const ok = vi.fn(async () => new Response('{"a":1}', { status: 200 }));
    await expect(fetchAppJson('holidays/cn/2026.json', ok as unknown as typeof fetch, BASE)).resolves.toEqual({ a: 1 });
    expect(ok).toHaveBeenCalledWith(URL_CN, { method: 'GET' });
    const nf = vi.fn(async () => new Response('', { status: 404 }));
    await expect(fetchAppJson('holidays/cn/2026.json', nf as unknown as typeof fetch, BASE)).resolves.toBeNull();
    const boom = vi.fn(async () => {
      throw new TypeError('offline');
    });
    await expect(fetchAppJson('holidays/cn/2026.json', boom as unknown as typeof fetch, BASE)).resolves.toBeNull();
    const html = vi.fn(async () => new Response('<html>', { status: 200 }));
    await expect(fetchAppJson('holidays/cn/2026.json', html as unknown as typeof fetch, BASE)).resolves.toBeNull();
  });

  it('路径不合规时不发请求', async () => {
    const f = vi.fn();
    await expect(fetchAppJson('../x.json', f as unknown as typeof fetch, BASE)).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('fetchAppJsonStatus（代码审查 M2：分清“没有”和“没拉到”）', () => {
  const P = 'holidays/cn/2026.json';
  const run = (f: () => Promise<Response>) => fetchAppJsonStatus(P, vi.fn(f) as unknown as typeof fetch, BASE);
  it('200 + JSON：ok', async () => {
    await expect(run(async () => new Response('{"a":1}', { status: 200 }))).resolves.toEqual({ kind: 'ok', json: { a: 1 } });
  });
  it('404、不是 JSON、路径不合规：missing（可以记住“没有”）', async () => {
    await expect(run(async () => new Response('', { status: 404 }))).resolves.toEqual({ kind: 'missing' });
    await expect(run(async () => new Response('<html>', { status: 200 }))).resolves.toEqual({ kind: 'missing' });
    await expect(fetchAppJsonStatus('../x.json', vi.fn() as unknown as typeof fetch, BASE)).resolves.toEqual({ kind: 'missing' });
  });
  it('断网（fetch 抛错）、5xx：failed（不要记死，联网后再拉）', async () => {
    await expect(
      run(async () => {
        throw new TypeError('offline');
      }),
    ).resolves.toEqual({ kind: 'failed' });
    await expect(run(async () => new Response('', { status: 503 }))).resolves.toEqual({ kind: 'failed' });
  });
});
