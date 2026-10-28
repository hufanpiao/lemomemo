// platform/files.ts 的签名和取字节（架构 0.32；14.2 第 3、11 点；5.13 第 3、4 点；任务单 FA-2；TC-B0-114 的客户端部分）
// 用假的 fetch：签名分批、单项不过、ms 只给 .pptx、链接的主机和路径前缀核对、取字节不带 JWT
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGN_BATCH_MAX, TIMEOUT_MS, type SignItem } from '../files.ts';
import { BASE, I, IMG, N, PDF, PPTX, U, client, fakeFetch, json, signed, stalledResponse, type Call } from './files-fake.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('sign：POST /files/v1/sign', () => {
  /** 按请求体逐项回成功（或按 deny 回不过） */
  const echo = (deny: (p: string) => string | null = () => null) => async ({ init }: Call) => {
    const body = JSON.parse(String(init.body)) as { items: SignItem[] };
    return json(200, {
      items: body.items.map((x, i) => {
        const reason = deny(x.path);
        return reason ? { i, ok: false, reason } : { i, ok: true, url: signed(x.bucket, x.path) };
      }),
    });
  };

  it('请求体和头；返回的链接核对通过，带到期时刻', async () => {
    const f = fakeFetch(echo());
    const r = await client(f).sign([
      { bucket: 'images', path: IMG, purpose: 'view' },
      { bucket: 'files', path: PDF, purpose: 'download', d: 'report.pdf' },
    ]);
    expect(r).toEqual([
      { ok: true, url: signed('images', IMG), expiresAt: 1_900_000_000_000 },
      { ok: true, url: signed('files', PDF), expiresAt: 1_900_000_000_000 },
    ]);
    const { url, init } = f.calls[0] as Call;
    expect(url).toBe(`${BASE}sign`);
    expect(init.method).toBe('POST');
    const h = new Headers(init.headers);
    expect(h.get('Authorization')).toBe('Bearer jwt-a');
    expect(h.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      items: [
        { bucket: 'images', path: IMG, purpose: 'view' },
        { bucket: 'files', path: PDF, purpose: 'download', d: 'report.pdf' },
      ],
    });
  });

  it(`超过 ${SIGN_BATCH_MAX} 项自动分批、按顺序发，结果和输入同序`, async () => {
    const f = fakeFetch(echo());
    const items: SignItem[] = Array.from({ length: 250 }, (_, k) => ({
      bucket: 'images',
      path: `${U}/${N}/${k.toString(16).padStart(8, '0')}-2d3f-4a5b-8c9d-0e1f2a3b4c5d.webp`,
      purpose: 'view',
    }));
    const r = await client(f).sign(items);
    expect(f.calls.map((c) => (JSON.parse(String(c.init.body)) as { items: unknown[] }).items.length)).toEqual([100, 100, 50]);
    expect(r).toHaveLength(250);
    r.forEach((x, k) => expect(x.ok && x.url).toBe(signed('images', (items[k] as SignItem).path)));
  });

  it('单项不过只标那一项（TC-B0-114 的客户端部分），reason 映射类别', async () => {
    const other = `${N}/${N}/${I}.webp`;
    const f = fakeFetch(echo((p) => (p === other ? 'not_owner' : p === PDF ? 'not_checked' : null)));
    const r = await client(f).sign([
      { bucket: 'images', path: IMG, purpose: 'view' },
      { bucket: 'images', path: other, purpose: 'view' },
      { bucket: 'files', path: PDF, purpose: 'view' },
    ]);
    expect(r[0]?.ok).toBe(true);
    expect(r[1]).toEqual({ ok: false, kind: 'denied', code: 'not_owner', reason: 'not_owner', status: 200 });
    expect(r[2]).toEqual({ ok: false, kind: 'denied', code: 'not_checked', reason: 'not_checked', status: 200 });
  });

  it('ms 只给附件桶的 .pptx：别的本地就拒，不发请求', async () => {
    const f = fakeFetch(echo());
    const r = await client(f).sign([
      { bucket: 'files', path: PDF, purpose: 'ms' },
      { bucket: 'images', path: IMG, purpose: 'ms' },
      { bucket: 'files', path: PPTX, purpose: 'ms' },
    ]);
    expect(r[0]).toMatchObject({ ok: false, code: 'bad_purpose' });
    expect(r[1]).toMatchObject({ ok: false, code: 'bad_purpose' });
    expect(r[2]?.ok).toBe(true);
    expect((JSON.parse(String(f.calls[0]?.init.body)) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('服务器回的链接不对（别的主机、别的路径、http、多了查询参数、带 ..）→ 那一项 bad_url', async () => {
    const bad = [
      signed('images', IMG).replace('lemomemo.com', 'evil.example'),
      signed('images', `${U}/${N}/${N}.webp`),
      signed('images', IMG).replace('https:', 'http:'),
      `${signed('images', IMG)}&x=1`,
      `${BASE}o/images/${U}/${N}/../${N}/${I}.webp?e=1&d=&s=x`,
      signed('files', IMG),
    ];
    const f = fakeFetch(json(200, { items: bad.map((url, i) => ({ i, ok: true, url })) }));
    const r = await client(f).sign(bad.map(() => ({ bucket: 'images', path: IMG, purpose: 'view' }) as const));
    expect(r.map((x) => !x.ok && x.code)).toEqual(bad.map(() => 'bad_url'));
  });

  it('整批失败：每一项都带同一个错误（429 → retry、426 → upgrade、403 停用 → account）', async () => {
    const two: SignItem[] = [
      { bucket: 'images', path: IMG, purpose: 'view' },
      { bucket: 'files', path: PDF, purpose: 'view' },
    ];
    for (const [status, body, kind] of [
      [429, { code: 'rate_limited' }, 'retry'],
      [426, { code: 'upgrade_required' }, 'upgrade'],
      [403, { code: 'forbidden', reason: 'account_disabled' }, 'account'],
      [401, { code: 'unauthorized' }, 'auth'],
    ] as const) {
      const r = await client(fakeFetch(json(status, body))).sign(two);
      expect(r.map((x) => !x.ok && x.kind)).toEqual([kind, kind]);
    }
  });

  it('响应格式不对、漏了某一项 → bad_response；没登录 → 全部 no_session', async () => {
    const two: SignItem[] = [
      { bucket: 'images', path: IMG, purpose: 'view' },
      { bucket: 'files', path: PDF, purpose: 'view' },
    ];
    expect((await client(fakeFetch(json(200, { nope: 1 }))).sign(two)).map((x) => !x.ok && x.code)).toEqual(['bad_response', 'bad_response']);
    const partial = fakeFetch(json(200, { items: [{ i: 1, ok: true, url: signed('files', PDF) }, { i: 7, ok: true, url: signed('files', PDF) }] }));
    const r = await client(partial).sign(two);
    expect(r[0]).toMatchObject({ ok: false, code: 'bad_response' });
    expect(r[1]?.ok).toBe(true);
    const f = fakeFetch(json(200, {}));
    expect((await client(f, null).sign(two)).map((x) => !x.ok && x.code)).toEqual(['no_session', 'no_session']);
    expect(f.fn).not.toHaveBeenCalled();
  });

  it('响应体卡住（代码审查低 6）：整批 retry/timeout，响应体被取消', async () => {
    vi.useFakeTimers();
    const { res, cancelled } = stalledResponse(200);
    const p = client(fakeFetch(() => res)).sign([{ bucket: 'images', path: IMG, purpose: 'view' }]);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS.sign);
    expect(await p).toEqual([{ ok: false, kind: 'retry', code: 'timeout', status: 0 }]);
    expect(cancelled()).toBe(true);
  });

  it('空列表不发请求', async () => {
    const f = fakeFetch(json(200, { items: [] }));
    expect(await client(f).sign([])).toEqual([]);
    expect(f.fn).not.toHaveBeenCalled();
  });
});

describe('fetchBlob：GET 签名链接', () => {
  it('不带 JWT、不带 cookie、不进 HTTP 缓存；返回字节和类型', async () => {
    const f = fakeFetch(new Response('RIFF....WEBP', { status: 200, headers: { 'Content-Type': 'image/webp' } }));
    const r = await client(f).fetchBlob(signed('images', IMG));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contentType).toBe('image/webp');
      expect(await r.blob.text()).toBe('RIFF....WEBP');
    }
    const { init } = f.calls[0] as Call;
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
  });

  it('响应头到了、10 MB 的响应体读到一半卡住（代码审查低 6）→ retry/timeout，不会一直挂着；响应体被取消', async () => {
    vi.useFakeTimers();
    const { res, cancelled } = stalledResponse(200, { 'Content-Type': 'image/webp' });
    const p = client(fakeFetch(() => res)).fetchBlob(signed('images', IMG));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS.get);
    expect(await p).toEqual({ ok: false, kind: 'retry', code: 'timeout', status: 0 });
    expect(cancelled()).toBe(true);
  });

  it('403 expired、bad_signature → resign（重新签）；404 → denied；断网 → retry', async () => {
    expect(await client(fakeFetch(json(403, { code: 'expired' }))).fetchBlob(signed('images', IMG))).toMatchObject({ kind: 'resign', code: 'expired' });
    expect(await client(fakeFetch(json(403, { code: 'bad_signature' }))).fetchBlob(signed('images', IMG))).toMatchObject({ kind: 'resign', code: 'bad_signature' });
    expect(await client(fakeFetch(json(404, { code: 'not_found' }))).fetchBlob(signed('images', IMG))).toMatchObject({ kind: 'denied' });
    expect(await client(fakeFetch(new TypeError('offline'))).fetchBlob(signed('images', IMG))).toMatchObject({ kind: 'retry', code: 'network' });
  });

  it('不是本站 /files/v1/o/ 的链接一律不取（14.2 第 3 点：核对主机和路径前缀，不只比字符串前缀）', async () => {
    const f = fakeFetch(new Response('x'));
    const c = client(f);
    for (const url of [
      signed('images', IMG).replace('lemomemo.com', 'lemomemo.com.evil.example'),
      signed('images', IMG).replace('https://lemomemo.com', 'https://user@lemomemo.com'),
      `https://lemomemo.com/sb/storage/v1/object/sign/images/${IMG}?token=x`,
      `https://lemomemo.com/files/v1/o/vault-images/${IMG}?e=1&d=&s=x`,
      `https://lemomemo.com/files/v1/o/images/${U}/${N}/..%2F${I}.webp?e=1&d=&s=x`,
      `https://lemomemo.com/files/v1/o/images/${U}%2F${N}/${I}.webp?e=1&d=&s=x`,
      `https://lemomemo.com/files/v1/x/../o/images/${IMG}?e=1&d=&s=x`,
      `https://lemomemo.com/files/v1/o/images/${IMG}`,
      `https://lemomemo.com/files/v1/o/images/${IMG}?e=1&d=`,
      `https://lemomemo.com/files/v1/o/images/${IMG}?e=soon&d=&s=x`,
      `https://lemomemo.com/files/v1/o/images/${IMG}?e=1&e=2&d=&s=x`,
      `${signed('images', IMG)}#frag`,
      `/files/v1/o/images/${IMG}?e=1&d=&s=x`,
      'javascript:alert(1)',
    ]) {
      expect(await c.fetchBlob(url), url).toMatchObject({ ok: false, kind: 'denied', code: 'bad_url' });
    }
    expect(f.fn).not.toHaveBeenCalled();
  });
});
