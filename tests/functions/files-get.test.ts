// /files/v1/* 第二部分：GET 取对象、HMAC、预检和杂项、待 Docker 的整条链路（第一部分见 files.test.ts）。
import { describe, expect, it } from 'vitest';
import { ttlFor } from '../../functions/_lib/files-rules.ts';
import { contentDisposition, sanitizeFilename, sign, signedUrl, verify } from '../../functions/_lib/files-sign.ts';
import { parseRoute } from '../../functions/files/[[path]].ts';
import { B_IMG, BASE, ENV, EXE, IMG, PDF, put, setup, signOne, signReq, T0, THUMB } from './files-harness.ts';
import { ID1, ID2, NOTE, UA, webp } from './files-fakes.ts';

describe('GET 取对象（TC-B0-110、111、113）', () => {
  async function uploadAndSign(s: ReturnType<typeof setup>, item: Record<string, unknown>, body: Uint8Array) {
    const bucket = item.bucket as string;
    const path = item.path as string;
    expect((await s.call(put(path, body, { bucket }))).status).toBe(200);
    const r = await signOne(s, item);
    expect(r.ok).toBe(true);
    return r.url ?? '';
  }

  it('TC-B0-110：签了立即取 → 200、内容一致、响应头齐；拨到过期后 → 403 expired', async () => {
    const s = setup();
    const url = await uploadAndSign(s, { bucket: 'images', path: IMG, purpose: 'view' }, webp(64));
    const r = await s.call(new Request(url));
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(webp(64));
    expect(r.headers.get('Content-Type')).toBe('image/webp');
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    expect(r.headers.get('Content-Disposition')).toBeNull();
    s.c.advance(601);
    const late = await s.call(new Request(url));
    expect(late.status).toBe(403);
    expect(await late.json()).toEqual({ code: 'expired' });
  });

  it('TC-B0-111：改桶、路径、e、d、s 任一个字符，换掉 FILES_URL_SECRET → 全部 403 bad_signature', async () => {
    const s = setup();
    const url = await uploadAndSign(s, { bucket: 'files', path: PDF, purpose: 'download', d: 'report.pdf' }, new Uint8Array([1]));
    await s.call(put(`${UA}/${NOTE}/${ID1}.pdf`, new Uint8Array([2])));
    const u = new URL(url);
    const e = u.searchParams.get('e') ?? '';
    const sig = u.searchParams.get('s') ?? '';
    const flip = (x: string) => (x.endsWith('A') ? x.slice(0, -1) + 'B' : x.slice(0, -1) + 'A');
    const tampered = [
      url.replace('/o/files/', '/o/images/'),
      url.replace(`${ID2}.pdf`, `${ID1}.pdf`),
      url.replace(`e=${e}`, `e=${Number(e) + 1}`),
      url.replace(`e=${e}`, `e=${Number(e) - 1}`),
      url.replace('d=report.pdf', 'd=report.exe'),
      url.replace('d=report.pdf', 'd='),
      url.replace(`s=${sig}`, `s=${flip(sig)}`),
      url.replace(`s=${sig}`, 's='),
      url + '&x=1',
      url + '&s=' + sig,
    ];
    for (const t of tampered) {
      const r = await s.call(new Request(t));
      expect(r.status, t).toBe(403);
      expect(((await r.json()) as { code: string }).code, t).toBe('bad_signature');
    }
    const r2 = await s.call(new Request(url), { ...ENV, FILES_URL_SECRET: 'another-fake-files-url-secret-0000000000' });
    expect(r2.status).toBe(403);
    expect(await r2.json()).toEqual({ code: 'bad_signature' });
    // 原链接仍然有效（证明上面是因为改动才失败）
    expect((await s.call(new Request(url))).status).toBe(200);
  });

  it('TC-B0-111：只认 GET——HEAD、POST 到链接 → 405', async () => {
    const s = setup();
    const url = await uploadAndSign(s, { bucket: 'images', path: IMG, purpose: 'view' }, webp(20));
    expect((await s.call(new Request(url, { method: 'HEAD' }))).status).toBe(405);
    expect((await s.call(new Request(url, { method: 'POST', body: 'x' }))).status).toBe(405);
  });

  it('签名对但有效期超过 600 秒（不是我们按规矩签的）→ 403 bad_signature', async () => {
    const s = setup();
    await s.call(put(IMG, webp(20)));
    const e = T0 / 1000 + 3600;
    const sig = await sign(ENV.FILES_URL_SECRET, 'images', IMG, e, '');
    const r = await s.call(new Request(signedUrl(BASE, 'images', IMG, e, '', sig)));
    expect(r.status).toBe(403);
  });

  it('不需要 JWT、不查版本；对象不在 → 404', async () => {
    const s = setup({ min: '9.9.9' });
    const e = T0 / 1000 + 60;
    const sig = await sign(ENV.FILES_URL_SECRET, 'images', IMG, e, '');
    const r = await s.call(new Request(signedUrl(BASE, 'images', IMG, e, '', sig)));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ code: 'not_found' });
  });

  it('TC-B0-113：下载文件名清理过（../、U+202E、CON、a:b），用 filename*=UTF-8', async () => {
    const s = setup();
    const url = await uploadAndSign(s, { bucket: 'files', path: PDF, purpose: 'download', d: '../evil‮fdp.exe' }, new Uint8Array([1]));
    const r = await s.call(new Request(url));
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

  it('TC-B0-113 / S-B0 ⑥：日志只有错误码和耗时，没有 URL、查询串、路径', async () => {
    const s = setup();
    const url = await uploadAndSign(s, { bucket: 'images', path: IMG, purpose: 'view' }, webp(20));
    await s.call(new Request(url));
    await s.call(new Request(url.replace('e=', 'e=1')));
    await s.call(put(B_IMG, webp(10)));
    expect(s.logs.length).toBeGreaterThan(3);
    for (const l of s.logs) {
      expect(l.code).toMatch(/^[a-z0-9_]+$/);
      expect(typeof l.ms).toBe('number');
    }
  });
});

describe('HMAC（S-B0 ④：每个字段被改都失败）', () => {
  it('sign / verify 来回；桶、路径、e、d、密钥各改一处都不过', async () => {
    const k = ENV.FILES_URL_SECRET;
    const s0 = await sign(k, 'images', IMG, 100, 'd');
    expect(s0).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verify(k, 'images', IMG, 100, 'd', s0)).toBe(true);
    expect(await verify(k, 'files', IMG, 100, 'd', s0)).toBe(false);
    expect(await verify(k, 'images', THUMB, 100, 'd', s0)).toBe(false);
    expect(await verify(k, 'images', IMG, 101, 'd', s0)).toBe(false);
    expect(await verify(k, 'images', IMG, 100, '', s0)).toBe(false);
    expect(await verify(k + 'x', 'images', IMG, 100, 'd', s0)).toBe(false);
    expect(await verify(k, 'images', IMG, 100, 'd', s0 + 'A')).toBe(false);
    expect(await verify(k, 'images', IMG, 100, 'd', '!'.repeat(43))).toBe(false);
  });

  it('签名串里的换行分隔不能被路径里的字符伪造（路径只许小写字母数字 . - /）', () => {
    expect(parseRoute(`${BASE}/files/v1/o/images/${UA}%0Afiles/x.webp`)).toBeNull();
    expect(ttlFor({ bucket: 'images', segment: 'image', variant: { kind: 'image', suffix: '.webp', contentType: 'image/webp', maxBytes: 1, webp: true }, owner: UA }, 'view')).toBe(600);
  });
});

describe('预检和杂项', () => {
  it('OPTIONS：exe 来源回 204 和 CORS；别的来源不带 CORS 头', async () => {
    const s = setup();
    const ok = await s.call(new Request(`${BASE}/files/v1/sign`, { method: 'OPTIONS', headers: { Origin: EXE } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    const no = await s.call(new Request(`${BASE}/files/v1/sign`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }));
    expect(no.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('FILES_URL_SECRET 太短 → 500 files_misconfigured，不签也不放行', async () => {
    const s = setup();
    const r = await s.call(signReq([{ bucket: 'images', path: IMG, purpose: 'view' }]), { ...ENV, FILES_URL_SECRET: 'short' });
    expect(r.status).toBe(500);
  });
});

// 【待 Docker】TC-B0-116：经 /files PUT 附件 → file-check {action: check} 经 shared/objstore.ts 读到同一个对象、sha256 一致、
// check_status 变 ok → sign 能签出。要本地 Supabase（files_authorize、note_files）、S3 替身（运维 O-1）和后端的 file-check。
// 本机没有 Docker，替身起不来；本机端到端改用 tests/e2e/files.spec.ts（wrangler pages dev + tests/e2e/fake-backends.ts）。
describe.skip('TC-B0-116（待 Docker：本地 Supabase + S3 替身 + file-check）', () => {
  it('上传后 file-check 读到同一个对象', () => {});
});
