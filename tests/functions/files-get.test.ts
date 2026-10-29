// /files/v1/* 第二部分：GET 取对象、HMAC、预检和杂项、待 Docker 的整条链路（第一部分见 files.test.ts）。
import { describe, expect, it } from 'vitest';
import { ttlFor } from '../../functions/_lib/files-rules.ts';
import { contentDisposition, msUrl, objectUrl, sanitizeFilename, sigHeaderValue, sign, verify } from '../../functions/_lib/files-sign.ts';
import { CLOCK_SKEW_S, onRequest, parseRoute, sigFrom, type FilesEnv } from '../../functions/files/[[path]].ts';
import { AVATAR, B_IMG, BASE, ENV, EXE, getReq, IMG, PDF, PPTX, put, setup, signOne, signReq, T0, THUMB, type SignedItem } from './files-harness.ts';
import { ID1, ID2, NOTE, UA, webp } from './files-fakes.ts';
import { liveObjStore, OBJSTORE_LIVE } from '../shared/objstore-live.ts';

const flip = (x: string) => (x.endsWith('A') ? x.slice(0, -1) + 'B' : x.slice(0, -1) + 'A');
const PPTX_CT = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

describe('GET 取对象（TC-B0-110、111、113；B1 P-files-sig：view、download 的签名在请求头）', () => {
  async function uploadAndSign(s: ReturnType<typeof setup>, item: Record<string, unknown>, body: Uint8Array): Promise<SignedItem> {
    const bucket = item.bucket as string;
    const path = item.path as string;
    expect((await s.call(put(path, body, { bucket }))).status).toBe(200);
    const r = await signOne(s, item);
    expect(r.ok).toBe(true);
    return r;
  }

  it('TC-B0-110：签了立即带请求头取 → 200、内容一致、响应头齐；拨到过期（120 秒）后 → 403 expired', async () => {
    const s = setup();
    const it0 = await uploadAndSign(s, { bucket: 'images', path: IMG, purpose: 'view' }, webp(64));
    expect(it0.url).toBe(`${BASE}/files/v1/o/images/${IMG}`); // 不带查询串
    const r = await s.call(getReq(it0));
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(webp(64));
    expect(r.headers.get('Content-Type')).toBe('image/webp');
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    expect(r.headers.get('Content-Disposition')).toBeNull();
    s.c.advance(120); // B1 P-files-sig ①：120 秒边界，正好到期那一秒还能取，过 1 秒就 expired
    expect((await s.call(getReq(it0))).status).toBe(200);
    s.c.advance(1);
    const late = await s.call(getReq(it0));
    expect([late.status, await late.json()]).toEqual([403, { code: 'expired' }]);
  });

  it('TC-B0-111：改桶、路径、p、e、d、s 任一个字符，签名搬进查询串，换掉 FILES_URL_SECRET → 全部 403 bad_signature', async () => {
    const s = setup();
    const it0 = await uploadAndSign(s, { bucket: 'files', path: PDF, purpose: 'download', d: 'report.pdf' }, new Uint8Array([1]));
    await s.call(put(`${UA}/${NOTE}/${ID1}.pdf`, new Uint8Array([2])));
    const url = it0.url ?? '';
    const sig = it0.sig ?? '';
    const e = /e=(\d+)/.exec(sig)?.[1] ?? '';
    const ss = /s=([^&]+)/.exec(sig)?.[1] ?? '';
    const tampered: { url: string; sig?: string }[] = [
      { url: url.replace('/o/files/', '/o/images/'), sig },
      { url: url.replace(`${ID2}.pdf`, `${ID1}.pdf`), sig },
      { url, sig: sig.replace('p=download', 'p=view') },
      { url, sig: sig.replace('p=download', 'p=ms') },
      { url, sig: sig.replace(`e=${e}`, `e=${Number(e) + 1}`) },
      { url, sig: sig.replace(`e=${e}`, `e=${Number(e) - 1}`) },
      { url, sig: sig.replace('d=report.pdf', 'd=report.exe') },
      { url, sig: sig.replace('d=report.pdf', 'd=') },
      { url, sig: sig.replace(`s=${ss}`, `s=${flip(ss)}`) },
      { url, sig: sig.replace(`s=${ss}`, 's=') },
      { url, sig: sig + '&x=1' },
      { url, sig: sig + '&s=' + ss },
      { url, sig: '' },
      { url }, // 没带请求头
      // 签名搬回查询串：不认（查询串只当 ms 核对）
      { url: `${url}?${sig}` },
      { url: `${url}?e=${e}&d=report.pdf&s=${ss}` },
      { url: `${url}?e=${e}&s=${ss}` },
      // 请求头和查询串一起带：不认
      { url: `${url}?e=${e}&s=${ss}`, sig },
    ];
    for (const t of tampered) {
      const r = await s.call(getReq(t));
      expect(r.status, JSON.stringify(t)).toBe(403);
      expect(((await r.json()) as { code: string }).code, JSON.stringify(t)).toBe('bad_signature');
    }
    const r2 = await s.call(getReq(it0), { ...ENV, FILES_URL_SECRET: 'another-fake-files-url-secret-0000000000' });
    expect([r2.status, await r2.json()]).toEqual([403, { code: 'bad_signature' }]);
    // 原签名仍然有效（证明上面是因为改动才失败）
    expect((await s.call(getReq(it0))).status).toBe(200);
  });

  it('ms 只认查询串：链接带 e、s（没有 d）能取；搬进请求头、当 view/download 用都不认；view 的签名放进查询串也不认', async () => {
    const s = setup();
    expect((await s.call(put(PPTX, new Uint8Array([1]), { ct: PPTX_CT }))).status).toBe(200);
    const r = await signOne(s, { bucket: 'files', path: PPTX, purpose: 'ms' });
    expect(r.ok).toBe(true);
    expect(r.sig).toBeUndefined();
    const u = new URL(r.url ?? '');
    expect([...u.searchParams.keys()]).toEqual(['e', 's']);
    const got = await s.call(getReq({ url: r.url ?? '' }));
    expect(got.status).toBe(200);
    expect(got.headers.get('Content-Disposition')).toBeNull();
    const e = Number(u.searchParams.get('e'));
    const ss = u.searchParams.get('s') ?? '';
    const bare = objectUrl(BASE, 'files', PPTX);
    for (const t of [
      { url: bare, sig: `p=view&e=${e}&d=&s=${ss}` },
      { url: bare, sig: `p=download&e=${e}&d=&s=${ss}` },
      { url: bare, sig: `p=ms&e=${e}&d=&s=${ss}` },
      { url: `${r.url ?? ''}&d=a.pptx` },
      { url: r.url ?? '', sig: `p=view&e=${e}&d=&s=${ss}` },
    ]) {
      const x = await s.call(getReq(t));
      expect(x.status, JSON.stringify(t)).toBe(403);
    }
    const vs = await sign(ENV.FILES_URL_SECRET, 'view', 'files', PPTX, e, '');
    expect((await s.call(new Request(msUrl(BASE, 'files', PPTX, e, vs)))).status).toBe(403);
  });

  it('ms 的签名就算是真的，用在 .pptx 以外也拒（GET 再核一次）', async () => {
    const s = setup();
    await s.call(put(PDF, new Uint8Array([1])));
    const e = T0 / 1000 + 60;
    const ms = await sign(ENV.FILES_URL_SECRET, 'ms', 'files', PDF, e, '');
    expect((await s.call(new Request(msUrl(BASE, 'files', PDF, e, ms)))).status).toBe(403);
  });

  it('TC-B0-111：只认 GET——HEAD、POST 到对象地址 → 405', async () => {
    const s = setup();
    const it0 = await uploadAndSign(s, { bucket: 'images', path: IMG, purpose: 'view' }, webp(20));
    expect((await s.call(getReq(it0, { method: 'HEAD' }))).status).toBe(405);
    expect((await s.call(getReq(it0, { method: 'POST', body: 'x' }))).status).toBe(405);
  });

  it('签名对但有效期超过 600 秒（不是我们按规矩签的）→ 403 bad_signature', async () => {
    const s = setup();
    await s.call(put(IMG, webp(20)));
    const e = T0 / 1000 + 3600;
    const sig = await sign(ENV.FILES_URL_SECRET, 'view', 'images', IMG, e, '');
    const r = await s.call(getReq({ url: objectUrl(BASE, 'images', IMG), sig: sigHeaderValue('view', e, '', sig) }));
    expect(r.status).toBe(403);
  });

  it('有效期按用途和类型收紧（安全审查低）：签名是真的、没超 600 秒，但超过这一项该有的时长 → 403；正好等于 → 放行', async () => {
    const s = setup();
    const nowS = T0 / 1000;
    const cases: [string, 'view' | 'download' | 'ms', string, string, number][] = [
      ['images', 'view', IMG, '', 120],
      ['images', 'view', AVATAR, '', 60],
      ['files', 'view', PDF, '', 60],
      ['files', 'download', PDF, 'a.pdf', 60],
      ['files', 'ms', PPTX, '', 300],
    ];
    for (const [bucket, purpose, path, d, cap] of cases) {
      const req = async (e: number) => {
        const sg = await sign(ENV.FILES_URL_SECRET, purpose, bucket, path, e, d);
        return purpose === 'ms'
          ? new Request(msUrl(BASE, bucket, path, e, sg))
          : getReq({ url: objectUrl(BASE, bucket, path), sig: sigHeaderValue(purpose, e, d, sg) });
      };
      const over = await s.call(await req(nowS + cap + CLOCK_SKEW_S + 1)); // 上限有 5 秒时钟余量
      expect([over.status, await over.json()], `${purpose} ${path}`).toEqual([403, { code: 'bad_signature' }]);
      // 对象没传：过了签名和有效期检查才会走到 404
      expect((await s.call(await req(nowS + cap + CLOCK_SKEW_S))).status, `${purpose} ${path}`).toBe(404);
    }
    expect(s.logs.filter((l) => l.code === 'get_ttl_over_purpose')).toHaveLength(cases.length);
  });

  it('签名格式只有一种合法写法：p=view 带了 d、p=download 没带 d、没有 d 键 → 403（就算 HMAC 是真的）', async () => {
    const s = setup();
    await s.call(put(PDF, new Uint8Array([1])));
    const e = T0 / 1000 + 30;
    const url = objectUrl(BASE, 'files', PDF);
    const vd = await sign(ENV.FILES_URL_SECRET, 'view', 'files', PDF, e, 'a.pdf');
    const dn = await sign(ENV.FILES_URL_SECRET, 'download', 'files', PDF, e, '');
    const v0 = await sign(ENV.FILES_URL_SECRET, 'view', 'files', PDF, e, '');
    for (const sig of [sigHeaderValue('view', e, 'a.pdf', vd), sigHeaderValue('download', e, '', dn), `p=view&e=${e}&s=${v0}`]) {
      const r = await s.call(getReq({ url, sig }));
      expect([r.status, await r.json()], sig).toEqual([403, { code: 'bad_signature' }]);
    }
    expect((await s.call(getReq({ url, sig: sigHeaderValue('view', e, '', v0) }))).status).toBe(200);
  });

  it('不需要 JWT、不查版本；对象不在 → 404', async () => {
    const s = setup({ min: '9.9.9' });
    const e = T0 / 1000 + 60;
    const sig = await sign(ENV.FILES_URL_SECRET, 'view', 'images', IMG, e, '');
    const r = await s.call(getReq({ url: objectUrl(BASE, 'images', IMG), sig: sigHeaderValue('view', e, '', sig) }));
    expect([r.status, await r.json()]).toEqual([404, { code: 'not_found' }]);
  });

  it('TC-B0-113：下载文件名清理过（../、U+202E、CON、a:b），用 filename*=UTF-8', async () => {
    const s = setup();
    const it0 = await uploadAndSign(s, { bucket: 'files', path: PDF, purpose: 'download', d: '../evil‮fdp.exe' }, new Uint8Array([1]));
    const r = await s.call(getReq(it0));
    const cd = r.headers.get('Content-Disposition') ?? '';
    expect(cd.startsWith("attachment; filename*=UTF-8''")).toBe(true);
    expect(decodeURIComponent(cd.split("''")[1] ?? '')).toBe('_evilfdp.exe');
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('con.pdf')).toBe('_con.pdf');
    expect(sanitizeFilename('a:b.pdf')).toBe('a_b.pdf');
    expect(sanitizeFilename('..')).toBe('file');
    expect(sanitizeFilename('报告 (最终).pdf')).toBe('报告 (最终).pdf');
    expect(contentDisposition("it's (1).pdf")).toBe("attachment; filename*=UTF-8''it%27s%20%281%29.pdf");
    expect([...sanitizeFilename('x'.repeat(400) + '.pdf')].length).toBe(150);
    expect(sanitizeFilename('x'.repeat(400) + '.pdf').endsWith('.pdf')).toBe(true);
  });

  it('TC-B0-113 / S-B0 ⑥：日志只有错误码和耗时，没有 URL、查询串、路径、签名', async () => {
    const s = setup();
    const it0 = await uploadAndSign(s, { bucket: 'images', path: IMG, purpose: 'view' }, webp(20));
    await s.call(getReq(it0));
    await s.call(getReq({ url: it0.url ?? '', sig: (it0.sig ?? '').replace('e=', 'e=1') }));
    await s.call(put(B_IMG, webp(10)));
    expect(s.logs.length).toBeGreaterThan(3);
    for (const l of s.logs) {
      expect(l.code).toMatch(/^[a-z0-9_]+$/);
      expect(typeof l.ms).toBe('number');
    }
  });
});

describe('HMAC（S-B0 ④：每个字段被改都失败）', () => {
  it('sign / verify 来回；用途、桶、路径、e、d、密钥各改一处都不过', async () => {
    const k = ENV.FILES_URL_SECRET;
    const s0 = await sign(k, 'download', 'images', IMG, 100, 'd');
    expect(s0).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verify(k, 'download', 'images', IMG, 100, 'd', s0)).toBe(true);
    expect(await verify(k, 'view', 'images', IMG, 100, 'd', s0)).toBe(false);
    expect(await verify(k, 'ms', 'images', IMG, 100, 'd', s0)).toBe(false);
    expect(await verify(k, 'download', 'files', IMG, 100, 'd', s0)).toBe(false);
    expect(await verify(k, 'download', 'images', THUMB, 100, 'd', s0)).toBe(false);
    expect(await verify(k, 'download', 'images', IMG, 101, 'd', s0)).toBe(false);
    expect(await verify(k, 'download', 'images', IMG, 100, '', s0)).toBe(false);
    expect(await verify(k + 'x', 'download', 'images', IMG, 100, 'd', s0)).toBe(false);
    expect(await verify(k, 'download', 'images', IMG, 100, 'd', s0 + 'A')).toBe(false);
    expect(await verify(k, 'download', 'images', IMG, 100, 'd', '!'.repeat(43))).toBe(false);
  });

  it('签名串里的换行分隔不能被路径里的字符伪造（路径只许小写字母数字 . - /）', () => {
    expect(parseRoute(`${BASE}/files/v1/o/images/${UA}%0Afiles/x.webp`)).toBeNull();
    expect(ttlFor({ bucket: 'images', segment: 'image', variant: { kind: 'image', suffix: '.webp', contentType: 'image/webp', maxBytes: 1, webp: true }, owner: UA }, 'view')).toBe(120);
  });

  it('sigFrom：请求头只认 p=view|download；查询串只当 ms、不收 d；两处都有或都没有 → null', () => {
    expect(sigFrom('p=view&e=1&d=&s=x', '')).toEqual({ purpose: 'view', e: '1', d: '', s: 'x' });
    expect(sigFrom('p=download&e=1&d=a%20b.pdf&s=x', '')).toEqual({ purpose: 'download', e: '1', d: 'a b.pdf', s: 'x' });
    expect(sigFrom('p=ms&e=1&s=x', '')).toBeNull();
    expect(sigFrom('e=1&s=x', '')).toBeNull();
    expect(sigFrom('p=view&e=1&s=x', '')).toBeNull(); // 没有 d 键
    expect(sigFrom('p=view&e=1&d=a.pdf&s=x', '')).toBeNull();
    expect(sigFrom('p=download&e=1&d=&s=x', '')).toBeNull();
    expect(sigFrom('p=download&e=1&s=x', '')).toBeNull();
    expect(sigFrom('p=view&e=1&d=&s=x', 'e=1&s=x')).toBeNull();
    expect(sigFrom(null, 'e=1&s=x')).toEqual({ purpose: 'ms', e: '1', d: '', s: 'x' });
    expect(sigFrom(null, 'e=1&d=a&s=x')).toBeNull();
    expect(sigFrom(null, 'p=view&e=1&s=x')).toBeNull();
    expect(sigFrom(null, '')).toBeNull();
  });
});

describe('预检和杂项', () => {
  it('OPTIONS：exe 来源回 204 和 CORS；别的来源不带 CORS 头', async () => {
    const s = setup();
    const ok = await s.call(new Request(`${BASE}/files/v1/sign`, { method: 'OPTIONS', headers: { Origin: EXE } }));
    expect(ok.status).toBe(204);
    // 安全审查 低 4 ②：/files 的预检只给实际支持的方法，不带 /sb 的 PATCH、DELETE
    expect(ok.headers.get('Access-Control-Allow-Methods')).toBe('GET, PUT, POST, OPTIONS');
    expect(ok.headers.get('X-Content-Type-Options')).toBe('nosniff');
    // B1 P-files-sig：/files 的预检放行 X-Files-Sig
    expect((ok.headers.get('Access-Control-Allow-Headers') ?? '').split(', ')).toContain('x-files-sig');
    const obj = await s.call(new Request(`${BASE}/files/v1/o/images/${IMG}`, { method: 'OPTIONS', headers: { Origin: EXE } }));
    expect(obj.headers.get('Access-Control-Allow-Methods')).toBe('GET, PUT, POST, OPTIONS');
    expect((obj.headers.get('Access-Control-Allow-Headers') ?? '').split(', ')).toContain('x-files-sig'); // /sb 不放行见 sb-proxy.test.ts
    const no = await s.call(new Request(`${BASE}/files/v1/sign`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }));
    expect(no.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // 代码审查 低 5、安全审查 低 4 ①：onRequest 建 store 出错的 500 也带齐安全头和 CORS
  it('Pages 入口：R2 配置不合规（建 store 抛错）→ 500 files_misconfigured，带安全头和 CORS', async () => {
    for (const R2_ENDPOINT of ['http://r2.evil.example', 'not a url', '']) {
      const env: FilesEnv = { ...ENV, R2_ENDPOINT };
      const ctx = { request: new Request(`${BASE}/files/v1/sign`, { method: 'POST', headers: { Origin: EXE } }), env } as unknown as Parameters<typeof onRequest>[0];
      const r = await onRequest(ctx);
      expect(r.status, R2_ENDPOINT).toBe(500);
      expect(await r.json()).toEqual({ code: 'files_misconfigured' });
      expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(r.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
      expect(r.headers.get('Cache-Control')).toBe('private, no-store');
      expect(r.headers.get('Access-Control-Allow-Origin')).toBe(EXE);
      expect(r.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    }
  });

  it('FILES_URL_SECRET 太短 → 500 files_misconfigured，不签也不放行', async () => {
    const s = setup();
    const r = await s.call(signReq([{ bucket: 'images', path: IMG, purpose: 'view' }]), { ...ENV, FILES_URL_SECRET: 'short' });
    expect(r.status).toBe(500);
  });
});

// 架构 0.33 第 13 条（代码审查中 2 ②）：/files 的上传、签名、取对象打真的 S3 替身（TC-B0-106～115 的存储一侧），没设 OBJSTORE_ENDPOINT 时跳过。
// files_authorize 仍用 fakeAuthz（打本地 Supabase 的一遍在 tests/e2e/files.spec.ts 和预览环境）；对象真的写进 LocalStack、条件写真的回 412。
// 用户 id 每次随机，跑完删掉这个前缀。
describe.skipIf(!OBJSTORE_LIVE)('/files 打真的 S3 替身（没设 OBJSTORE_ENDPOINT 时跳过）', () => {
  it('PUT → 同一路径再 PUT 回 409 exists → sign → GET 内容和类型一致；B 的路径 403；对象确实在替身里', async () => {
    const store = liveObjStore();
    const s = setup({ store });
    const u = crypto.randomUUID();
    const img = `${u}/${NOTE}/${ID1}.webp`;
    const pdf = `${u}/${NOTE}/${ID2}.pdf`;
    const body = webp(64);
    try {
      expect((await s.call(put(img, body, { uid: u }))).status).toBe(200);
      const again = await s.call(put(img, webp(32), { uid: u }));
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ code: 'exists' });
      expect((await s.call(put(pdf, new TextEncoder().encode('%PDF-1.7\n'), { uid: u }))).status).toBe(200);
      expect((await s.call(put(`${UA}/${NOTE}/${ID1}.webp`, body, { uid: u }))).status).toBe(403);

      const r = await s.call(signReq([{ bucket: 'images', path: img, purpose: 'view' }, { bucket: 'files', path: pdf, purpose: 'download', d: 'a.pdf' }], u));
      const items = ((await r.json()) as { items: SignedItem[] }).items;
      expect(items.map((i) => i.ok)).toEqual([true, true]);
      const got = await s.call(getReq(items[0] ?? {}));
      expect(got.status).toBe(200);
      expect(got.headers.get('Content-Type')).toBe('image/webp');
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(body); // 第二次 PUT 没覆盖
      const doc = await s.call(getReq(items[1] ?? {}));
      expect(doc.status).toBe(200);
      expect(doc.headers.get('Content-Disposition')).toContain('attachment');
      expect(await doc.text()).toBe('%PDF-1.7\n');

      expect((await store.listAll('images', `${u}/`)).map((o) => o.key)).toEqual([img]);
      expect((await store.listAll('files', `${u}/`)).map((o) => o.key)).toEqual([pdf]);
    } finally {
      for (const b of ['images', 'files']) await store.deletePrefix(b, `${u}/`);
    }
  });
});

// QA D-03、架构 0.33 第 1 条：TC-B0-116 整条链路挪到 B4b-1（要 file-check），不留空的 it，写成 todo
describe('TC-B0-116 整条链路（架构 0.33 第 1 条挪到 B4b-1）', () => {
  it.todo('上传后 file-check 读到同一个对象、sha256 一致、check_status 变 ok、sign 能签出（要 B4b-1 的 file-check、本地 Supabase 和 S3 替身）');
});
