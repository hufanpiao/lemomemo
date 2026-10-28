// platform/files.ts（架构 0.32；14.2 第 3、11 点；5.13 第 2、4 点；任务单 FA-2；TC-B0-108 的客户端部分）
// 用假的 fetch：核对发出去的请求、每个错误码映射成哪一类、409 exists 当成功、签名分批和链接核对
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIMEOUT_MS, checkMsUrl, checkObjectUrl, checkSig, classify, filesBaseFrom, isSafePath, type FileError } from '../files.ts';
import { BASE, I, IMG, N, PDF, PPTX, U, client, fakeFetch, json, msSigned, objUrl, sigOf, stalledResponse, type Call } from './files-fake.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('upload：PUT /files/v1/o/<桶>/<路径>', () => {
  it('请求：方法、地址、JWT、X-App-Version、Content-Type、原样的 body；不带 cookie、不进 HTTP 缓存、不跟重定向', async () => {
    const f = fakeFetch(json(200, { etag: '"e1"' }));
    const blob = new Blob(['x'], { type: 'image/webp' });
    const r = await client(f).upload('images', IMG, blob, 'image/webp');
    expect(r).toEqual({ ok: true, etag: '"e1"', existed: false });
    const { url, init } = f.calls[0] as Call;
    expect(url).toBe(`${BASE}o/images/${IMG}`);
    expect(init.method).toBe('PUT');
    const h = new Headers(init.headers);
    expect(h.get('Authorization')).toBe('Bearer jwt-a');
    expect(h.get('X-App-Version')).toBe('4.0.0');
    expect(h.get('Content-Type')).toBe('image/webp');
    expect(init.body).toBe(blob);
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
  });

  it('成功但 body 不是 JSON：用响应头的 ETag', async () => {
    const f = fakeFetch(new Response('', { status: 200, headers: { ETag: '"h1"' } }));
    expect(await client(f).upload('files', PDF, new Blob(['%PDF-']), 'application/pdf')).toEqual({ ok: true, etag: '"h1"', existed: false });
  });

  it('409 exists 当成功（重试时对象已在，TC-B0-108）；409 别的码不算', async () => {
    const f = fakeFetch(json(409, { code: 'exists' }, { ETag: '"old"' }));
    expect(await client(f).upload('files', PDF, new Blob(['x']), 'application/pdf')).toEqual({ ok: true, etag: '"old"', existed: true });
    const g = fakeFetch(json(409, { code: 'conflict' }));
    expect(await client(g).upload('files', PDF, new Blob(['x']), 'application/pdf')).toMatchObject({ ok: false, kind: 'denied', code: 'conflict', status: 409 });
  });

  // 14.2 第 11 点的错误码表，逐个核对映射
  it.each([
    [400, { code: 'bad_path' }, 'denied'],
    [401, { code: 'unauthorized' }, 'auth'],
    [403, { code: 'forbidden', reason: 'not_owner' }, 'denied'],
    [403, { code: 'forbidden', reason: 'not_pending' }, 'not_pending'],
    [403, { code: 'forbidden', reason: 'no_row' }, 'denied'],
    [403, { code: 'forbidden', reason: 'account_disabled' }, 'account'],
    [403, { code: 'forbidden', reason: 'session_revoked' }, 'account'],
    [404, { code: 'not_found' }, 'denied'],
    [405, { code: 'method_not_allowed' }, 'denied'],
    [413, { code: 'too_large' }, 'too_big'],
    [415, { code: 'bad_type' }, 'bad_type'],
    [426, { code: 'upgrade_required' }, 'upgrade'],
    [429, { code: 'rate_limited' }, 'retry'],
    [403, { code: 'forbidden', reason: 'rate_limited' }, 'retry'],
    [503, { code: 'try_later' }, 'retry'],
    [502, { code: 'bad_gateway' }, 'retry'],
  ] as const)('%i %j → %s', async (status, body, kind) => {
    const f = fakeFetch(json(status, body));
    const r = await client(f).upload('images', IMG, new Blob(['x']), 'image/webp');
    const want: Partial<FileError> = { ok: false, kind, code: body.code, status };
    if ('reason' in body) want.reason = body.reason;
    expect(r).toEqual(want);
  });

  // 架构 0.33 第 5 条（代码审查低 9）：PUT 回 403 not_pending = 这一行已经不在 pending（file-check 判过了，或行已删）。
  // 不是失败、不重传：单独报给 data 层，由它读这一行的 check_status 决定当成功、“没能加上”还是丢掉
  it('403 forbidden/not_pending 单独报出（kind not_pending），不并进 denied、不算 retry', async () => {
    const f = fakeFetch(json(403, { code: 'forbidden', reason: 'not_pending' }));
    const r = await client(f).upload('files', PDF, new Blob(['x']), 'application/pdf');
    expect(r).toEqual({ ok: false, kind: 'not_pending', code: 'forbidden', reason: 'not_pending', status: 403 });
    expect(f.calls).toHaveLength(1); // 客户端自己不重传
  });

  it('not_pending 只认 403 forbidden 带的 reason：别的码、别的 reason 照旧', async () => {
    expect(classify(403, 'forbidden', 'not_pending')).toBe('not_pending');
    expect(classify(403, 'forbidden', 'not_owner')).toBe('denied');
    expect(classify(403, 'forbidden', 'no_row')).toBe('denied');
    // 签名里单项不过的 reason（code 就是 reason，不是 forbidden）不算，签名不会遇到 pending 的问题
    expect(classify(200, 'not_pending', 'not_pending')).toBe('denied');
    expect(classify(404, 'not_found', 'not_pending')).toBe('denied');
  });

  it('错误响应不是 JSON（例如 Cloudflare 的默认错误页）：按状态码算', async () => {
    for (const [status, code, kind] of [
      [500, 'http_500', 'retry'],
      [503, 'try_later', 'retry'],
      [413, 'too_large', 'too_big'],
      [426, 'upgrade_required', 'upgrade'],
      [404, 'not_found', 'denied'],
    ] as const) {
      const f = fakeFetch(new Response('<html>error</html>', { status }));
      expect(await client(f).upload('images', IMG, new Blob(['x']), 'image/webp')).toEqual({ ok: false, kind, code, status });
    }
  });

  it('网络断开 → retry/network；超时 → retry/timeout', async () => {
    const f = fakeFetch(new TypeError('Failed to fetch'));
    expect(await client(f).upload('images', IMG, new Blob(['x']), 'image/webp')).toEqual({ ok: false, kind: 'retry', code: 'network', status: 0 });

    vi.useFakeTimers();
    const hang = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const p = client(hang).upload('files', PDF, new Blob(['x']), 'application/pdf');
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS.upload);
    expect(await p).toEqual({ ok: false, kind: 'retry', code: 'timeout', status: 0 });
  });

  // 代码审查低 6：响应头到了、响应体卡住，也要在同一个超时里折成 retry/timeout，并取消响应体
  it('响应头到了但响应体卡住（成功、409、出错三种都读体）→ retry/timeout，响应体被取消', async () => {
    vi.useFakeTimers();
    for (const status of [200, 409, 500]) {
      const { res, cancelled } = stalledResponse(status);
      const f = fakeFetch(() => res);
      const p = client(f).upload('files', PDF, new Blob(['x']), 'application/pdf');
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS.upload - 1);
      let settled = false;
      void p.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled, `${status}：超时之前不该结束`).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual({ ok: false, kind: 'retry', code: 'timeout', status: 0 });
      expect(cancelled(), `${status}：响应体要取消`).toBe(true);
    }
  });

  it('没登录：不发请求，auth/no_session', async () => {
    const f = fakeFetch(json(200, {}));
    expect(await client(f, null).upload('images', IMG, new Blob(['x']), 'image/webp')).toEqual({ ok: false, kind: 'auth', code: 'no_session', status: 0 });
    expect(f.fn).not.toHaveBeenCalled();
  });

  it('本地先挡：vault-* 和别的桶、不像样的路径一律不发请求（bad_path）', async () => {
    const f = fakeFetch(json(200, {}));
    const c = client(f);
    for (const [bucket, path] of [
      ['vault-images', IMG],
      ['vault-files', PDF],
      ['backups', IMG],
      ['images', `${U}/../${I}.webp`],
      ['images', `${U}/${N}/${I.toUpperCase()}.webp`],
      ['images', `${U}%2F${N}/${I}.webp`],
      ['images', `${U}\\${N}/${I}.webp`],
      ['images', `/${U}/${N}/${I}.webp`],
      ['images', `${U}//${I}.webp`],
      ['images', `${U}/a/b/c/d.webp`],
      ['images', `${U}`],
    ] as const) {
      expect(await c.upload(bucket as 'images', path, new Blob(['x']), 'image/webp'), `${bucket} ${path}`).toMatchObject({ ok: false, code: 'bad_path', status: 0 });
    }
    expect(f.fn).not.toHaveBeenCalled();
  });
});

describe('纯函数', () => {
  it('classify：类别表', () => {
    expect(classify(0, 'network')).toBe('retry');
    expect(classify(409, 'exists')).toBe('denied'); // 409 当成功由 upload 自己判断，不靠类别
    expect(classify(403, 'forbidden', 'session_revoked')).toBe('account');
    expect(classify(403, 'expired')).toBe('resign');
  });

  it('isSafePath：三种桶内路径形状都认', () => {
    expect(isSafePath(IMG)).toBe(true);
    expect(isSafePath(`${U}/${N}/${I}.t.webp`)).toBe(true);
    expect(isSafePath(`${U}/anniv/${N}/${I}.webp`)).toBe(true);
    expect(isSafePath(PPTX)).toBe(true);
    expect(isSafePath(`${U}/${N}/.hidden`)).toBe(false);
    expect(isSafePath(`${U}/${N}/a..b`)).toBe(false);
  });

  it('checkObjectUrl：只认来源、路径都对、不带查询串的地址', () => {
    expect(checkObjectUrl(objUrl('files', PDF), BASE)).toBe(true);
    expect(checkObjectUrl(objUrl('files', PDF), BASE, { bucket: 'files', path: PDF })).toBe(true);
    expect(checkObjectUrl(objUrl('files', PDF), BASE, { bucket: 'images', path: PDF })).toBe(false);
    expect(checkObjectUrl(objUrl('files', PDF), 'https://preview.lemomemo.com/files/v1/')).toBe(false);
    expect(checkObjectUrl(`${objUrl('files', PDF)}?e=1&s=x`, BASE)).toBe(false);
  });

  it('checkMsUrl：查询串只有 e、s；返回到期毫秒', () => {
    expect(checkMsUrl(msSigned('files', PPTX, 1_800_000_000), BASE)).toBe(1_800_000_000_000);
    expect(checkMsUrl(msSigned('files', PPTX), BASE, { bucket: 'files', path: PPTX })).not.toBeNull();
    expect(checkMsUrl(`${objUrl('files', PPTX)}?e=1&d=&s=x`, BASE)).toBeNull();
    expect(checkMsUrl(objUrl('files', PPTX), BASE)).toBeNull();
  });

  it('checkSig：p=view|download、e 是数字、s 不空、只有可打印 ASCII；want 给了就核用途', () => {
    expect(checkSig(sigOf('view', 1_800_000_000))).toBe(1_800_000_000_000);
    expect(checkSig(sigOf('download'), 'download')).not.toBeNull();
    expect(checkSig(sigOf('download'), 'view')).toBeNull();
    expect(checkSig('p=ms&e=1&d=&s=x')).toBeNull();
    expect(checkSig('p=view&e=1&d=a b&s=x')).toBeNull();
    expect(checkSig('p=view&e=1&d=&s=x&p=view')).toBeNull();
  });

  it('filesBaseFrom：和数据接口同一个来源；没配时用页面自己的来源', () => {
    expect(filesBaseFrom('https://lemomemo.com/sb', 'http://tauri.localhost')).toBe('https://lemomemo.com/files/v1/');
    expect(filesBaseFrom('https://preview.lemomemo.com/sb', 'x:')).toBe('https://preview.lemomemo.com/files/v1/');
    expect(filesBaseFrom('', 'http://127.0.0.1:8788')).toBe('http://127.0.0.1:8788/files/v1/');
  });
});
