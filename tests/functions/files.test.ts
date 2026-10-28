// /files/v1/*（架构 0.32、14.2 第 11 点、3.3 G“R2 起”；测试用例 v4 第 3.2b 节；任务单 FB-3、FB-4）。
// 函数层：内存对象存储 + 假 files_authorize，不连数据库、不连 S3。
// 要本地 Supabase 和 S3 替身的整条链路（TC-B0-116 file-check 读到同一个对象）【待 Docker】，见文末。
import { describe, expect, it } from 'vitest';
import { parseRoute } from '../../functions/files/[[path]].ts';
import { matchPath } from '../../functions/_lib/files-rules.ts';
import { AVATAR, B_IMG, BASE, EXE, IMG, PDF, PPTX, put, setup, signOne, signReq, T0, THUMB } from './files-harness.ts';
import { bearer, ID1, ID2, NOTE, png, UA, webp } from './files-fakes.ts';

describe('规则表和路由', () => {
  it('路径对得上清单的正则才认；分出缩略图、头像、附件类型', () => {
    expect(matchPath('images', IMG)?.variant.kind).toBe('image');
    expect(matchPath('images', THUMB)?.variant.kind).toBe('thumb');
    expect(matchPath('images', AVATAR)?.segment).toBe('avatar');
    expect(matchPath('files', PDF)?.variant.contentType).toBe('application/pdf');
    expect(matchPath('files', `${UA}/${NOTE}/${ID1}.t.webp`)?.variant.maxBytes).toBe(2 * 1024 * 1024);
    expect(matchPath('files', PDF)?.variant.maxBytes).toBe(10 * 1024 * 1024);
    for (const bad of [`${UA}/${NOTE}/${ID1}.png`, `${UA}/${NOTE}/x/${ID1}.webp`, `${UA}/${NOTE}/ABCDEF00-0000-4000-8000-000000000002.webp`, `${UA}/${ID1}.webp`]) {
      expect(matchPath('images', bad)).toBeNull();
    }
    expect(matchPath('images', PDF)).toBeNull();
  });

  it('原始路径里有 ..、%2F、双斜杠、大写一律不认（404）', () => {
    for (const p of [`/files/v1/o/images/${UA}/../x.webp`, `/files/v1/o/images/${UA}%2Fx.webp`, `/files/v1/o/images//${IMG}`, `/files/v1/o/IMAGES/${IMG}`, '/files/v1/x', '/files/v2/sign']) {
      expect(parseRoute(BASE + p)).toBeNull();
    }
    expect(parseRoute(`${BASE}/files/v1/sign`)).toEqual({ kind: 'sign' });
  });
});

describe('PUT 上传（TC-B0-106～109、115）', () => {
  it('正常上传：200 {etag}，带 ETag 头；exe 来源能读到 ETag（CORS expose）', async () => {
    const s = setup();
    const r = await s.call(put(IMG, webp(1000), { origin: EXE }));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { etag: string };
    expect(j.etag).toBe(r.headers.get('ETag'));
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(EXE);
    expect(r.headers.get('Access-Control-Expose-Headers')).toContain('ETag');
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    expect(s.store.objects.get(`images/${IMG}`)?.contentType).toBe('image/webp');
    expect(s.authz.calls).toEqual([{ op: 'put', items: [{ bucket: 'images', path: IMG }] }]);
  });

  it('TC-B0-106：图片 2 MB + 1、附件 10 MB + 1 → 413，不调授权、不留对象', async () => {
    const s = setup();
    expect((await s.call(put(IMG, webp(2 * 1024 * 1024 + 1)))).status).toBe(413);
    expect((await s.call(put(PDF, new Uint8Array(10 * 1024 * 1024 + 1)))).status).toBe(413);
    expect(s.authz.calls).toHaveLength(0);
    expect(s.store.objects.size).toBe(0);
  });

  it.each([false, true])('TC-B0-106：Content-Length 写 1 KB、实际发 3 MB → 413，读到上限就断，没有对象（流式 %s）', async (fixed) => {
    const s = setup({ fixed });
    const big = webp(3 * 1024 * 1024);
    const r = await s.call(put(IMG, new Response(big).body as ReadableStream<Uint8Array>, { len: 1024 }));
    expect(r.status).toBe(413);
    expect(((await r.json()) as { code: string }).code).toBe('too_large');
    expect(s.store.objects.size).toBe(0);
  });

  it('实际比 Content-Length 少 → 400，没有对象', async () => {
    const s = setup();
    const r = await s.call(put(IMG, new Response(webp(100)).body as ReadableStream<Uint8Array>, { len: 5000 }));
    expect(r.status).toBe(400);
    expect(s.store.objects.size).toBe(0);
  });

  it('TC-B0-107：声明 image/png、声明 webp 但内容是 PNG、pdf 路径声明 application/zip → 415，没有对象', async () => {
    const s = setup();
    for (const req of [put(IMG, webp(100), { ct: 'image/png' }), put(IMG, png(100)), put(PDF, new Uint8Array(100), { ct: 'application/zip' })]) {
      const r = await s.call(req);
      expect(r.status).toBe(415);
      expect(((await r.json()) as { code: string }).code).toBe('bad_type');
    }
    expect(s.store.objects.size).toBe(0);
  });

  it('TC-B0-108：同一路径再传一次 → 409 exists，内容还是第一次的', async () => {
    const s = setup();
    expect((await s.call(put(PDF, new Uint8Array([1, 2, 3])))).status).toBe(200);
    const r = await s.call(put(PDF, new Uint8Array([9, 9, 9, 9])));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ code: 'exists' });
    expect([...(s.store.objects.get(`files/${PDF}`)?.body ?? [])]).toEqual([1, 2, 3]);
  });

  it('TC-B0-109：没有 Authorization → 401；令牌过期（RPC 回 401）→ 401；版本低 → 426 带 CORS 和安全头；DELETE → 405', async () => {
    const s = setup({ min: '4.1.0' });
    const low = await s.call(put(IMG, webp(100), { origin: EXE }));
    expect(low.status).toBe(426);
    expect(low.headers.get('Access-Control-Allow-Origin')).toBe(EXE);
    expect(low.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(low.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    const noVer = await s.call(put(IMG, webp(100), { v: '' }));
    expect(noVer.status).toBe(426);

    const s2 = setup();
    expect((await s2.call(put(IMG, webp(100), { uid: null }))).status).toBe(401);
    const expired = new Request(`${BASE}/files/v1/o/images/${IMG}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer expired.token.value', 'Content-Type': 'image/webp', 'Content-Length': '100', 'X-App-Version': '4.0.0' },
      body: webp(100),
    });
    expect((await s2.call(expired)).status).toBe(401);
    const del = await s2.call(new Request(`${BASE}/files/v1/o/images/${IMG}`, { method: 'DELETE', headers: { Authorization: bearer(UA) } }));
    expect(del.status).toBe(405);
    expect(s2.store.objects.size).toBe(0);
  });

  it('TC-B0-36：直接往 vault-images 传 → 403 bad_bucket；路径不对 → 400 bad_path；都不调授权', async () => {
    const s = setup();
    const r = await s.call(put(IMG, webp(100), { bucket: 'vault-images' }));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ code: 'forbidden', reason: 'bad_bucket' });
    const bp = await s.call(put(`${UA}/${NOTE}/${ID1}.png`, webp(100), { bucket: 'images' }));
    expect(bp.status).toBe(400);
    expect(s.authz.calls).toHaveLength(0);
  });

  it('授权不过：别人的路径 403 not_owner；没有行 403 no_row；账号停用 403 account_disabled（两种写法）；会话撤销 401；限流 429', async () => {
    const s = setup();
    expect(await (await s.call(put(B_IMG, webp(100)))).json()).toEqual({ code: 'forbidden', reason: 'not_owner' });
    s.authz.deny.set(`put:images/${IMG}`, 'no_row');
    expect(await (await s.call(put(IMG, webp(100)))).json()).toEqual({ code: 'forbidden', reason: 'no_row' });
    s.authz.deny.clear();
    s.authz.batchError = 'account_disabled';
    expect(await (await s.call(put(IMG, webp(100)))).json()).toEqual({ code: 'forbidden', reason: 'account_disabled' });
    s.authz.raise = true;
    s.authz.batchError = 'session_revoked';
    expect(await (await s.call(put(IMG, webp(100)))).json()).toEqual({ code: 'unauthorized', reason: 'session_revoked' });
    s.authz.batchError = 'rate_limited';
    expect((await s.call(put(IMG, webp(100)))).status).toBe(429);
    expect(s.store.objects.size).toBe(0);
  });

  it('后端入参校验 raise 22023 → 400 bad_path，没碰存储', async () => {
    const s = setup();
    s.authz.badInput = 'put_one_item';
    const r = await s.call(put(IMG, webp(100)));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ code: 'bad_path' });
    expect(s.store.objects.size).toBe(0);
  });

  it('TC-B0-115：files_authorize 超时 → 503 try_later，没碰存储', async () => {
    const s = setup({ timeoutMs: 50 });
    s.authz.delayMs = 300;
    const r = await s.call(put(IMG, webp(100)));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ code: 'try_later' });
    expect(s.store.puts).toBe(0);
  });

  it('没有 Content-Length → 411；空文件 → 400', async () => {
    const s = setup();
    expect((await s.call(put(IMG, new Response(webp(100)).body as ReadableStream<Uint8Array>, { len: null }))).status).toBe(411);
    expect((await s.call(put(PDF, new Uint8Array(0)))).status).toBe(400);
  });

  it('缩略图和头像也只认 webp', async () => {
    const s = setup();
    expect((await s.call(put(THUMB, webp(50), { bucket: 'images' }))).status).toBe(200);
    expect((await s.call(put(AVATAR, png(50), { bucket: 'images', ct: 'image/webp' }))).status).toBe(415);
    expect((await s.call(put(`${UA}/${NOTE}/${ID2}.t.webp`, webp(50), { bucket: 'files' }))).status).toBe(200);
  });
});

describe('POST sign（TC-B0-110、112、114）', () => {
  it('TC-B0-112：有效期按用途和类型；ms 只给 .pptx；都不超过 600 秒', async () => {
    const s = setup();
    const nowS = T0 / 1000;
    const cases: [Record<string, unknown>, number | null][] = [
      [{ bucket: 'images', path: IMG, purpose: 'view' }, 600],
      [{ bucket: 'images', path: AVATAR, purpose: 'view' }, 60],
      [{ bucket: 'files', path: PDF, purpose: 'view' }, 60],
      [{ bucket: 'files', path: PDF, purpose: 'download', d: '报告.pdf' }, 60],
      [{ bucket: 'files', path: PDF, purpose: 'ms' }, null],
      [{ bucket: 'files', path: PPTX, purpose: 'ms' }, 300],
    ];
    for (const [item, ttl] of cases) {
      const r = await signOne(s, item);
      if (ttl === null) {
        expect(r).toEqual({ i: 0, ok: false, reason: 'bad_purpose' });
      } else {
        expect(r.ok).toBe(true);
        expect((r.e ?? 0) - nowS).toBe(ttl);
        expect((r.e ?? 0) - nowS <= 600).toBe(true);
      }
    }
  });

  it('签出的链接：同源、路径前缀 /files/v1/o/<桶>/，查询串只有 e、d、s（src/platform/files.ts 的 checkSignedUrl 认这个格式）', async () => {
    const s = setup();
    const r = await signOne(s, { bucket: 'files', path: PDF, purpose: 'download', d: 'a b.pdf' });
    const u = new URL(r.url ?? '');
    expect(u.origin).toBe(BASE);
    expect(u.pathname).toBe(`/files/v1/o/files/${PDF}`);
    expect([...u.searchParams.keys()]).toEqual(['e', 'd', 's']);
    expect(u.searchParams.get('d')).toBe('a b.pdf');
  });

  it('TC-B0-114：混进别人的一张图 → 只有那一项 not_owner，自己的照常签', async () => {
    const s = setup();
    const r = await s.call(signReq([{ bucket: 'images', path: B_IMG, purpose: 'view' }, { bucket: 'images', path: IMG, purpose: 'view' }]));
    const j = (await r.json()) as { items: { i: number; ok: boolean; url?: string; reason?: string }[] };
    expect(j.items[0]).toEqual({ i: 0, ok: false, reason: 'not_owner' });
    expect(j.items[1]?.ok).toBe(true);
    expect(j.items[1]?.url).toContain(IMG);
  });

  it('本地就能判断不对的项不送去授权；桶、路径、用途各报各的', async () => {
    const s = setup();
    const r = await s.call(signReq([
      { bucket: 'vault-images', path: IMG, purpose: 'view' },
      { bucket: 'images', path: '../x', purpose: 'view' },
      { bucket: 'images', path: IMG, purpose: 'print' },
      { bucket: 'images', path: IMG, purpose: 'view' },
    ]));
    const j = (await r.json()) as { items: { reason?: string; ok: boolean }[] };
    expect(j.items.map((x) => x.reason ?? 'ok')).toEqual(['bad_bucket', 'bad_path', 'bad_purpose', 'ok']);
    expect(s.authz.calls).toEqual([{ op: 'get', items: [{ bucket: 'images', path: IMG }] }]);
  });

  it('超过 100 项、空的、不是 JSON → 400；没有 JWT → 401', async () => {
    const s = setup();
    const many = Array.from({ length: 101 }, () => ({ bucket: 'images', path: IMG, purpose: 'view' }));
    expect((await s.call(signReq(many))).status).toBe(400);
    expect((await s.call(signReq([]))).status).toBe(400);
    expect((await s.call(new Request(`${BASE}/files/v1/sign`, { method: 'POST', headers: { Authorization: bearer(UA) }, body: '{x' }))).status).toBe(400);
    expect((await s.call(new Request(`${BASE}/files/v1/sign`, { method: 'POST', body: '{}' }))).status).toBe(401);
  });

  it('不查版本（旧版也能看图，TC-B0-51）', async () => {
    const s = setup({ min: '9.9.9' });
    expect((await s.call(signReq([{ bucket: 'images', path: IMG, purpose: 'view' }]))).status).toBe(200);
  });
});
