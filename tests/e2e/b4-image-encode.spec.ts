// TC-B4-02 JPEG 那一半（B4 插图 S3；R-108、R-377）：真浏览器里重新编码。
// 在 Node 侧用 esbuild 把真的 src/features/notes/data/image-encode.ts（连同 image-exif.ts、shared/core/date.ts）打成 IIFE 注入同源空白页
// （写法同 idb-tx-helpers.ts），页面里用 canvas 画一张 3000 × 2000 的 JPEG，插上带拍摄时间和 GPS 定位的 EXIF（造法在 exif-sample.ts），调真的 encodeImage：
//   · 原图是 image/webp、长边 2048、不超过 2 MB；缩略图长边 384、不超过 128 KB
//   · 输入里另外插一段 XMP（APP1，带 GPS 字样）和一段 COM 注释（安全审建议 1）
//   · 两份产物的 RIFF 块只在白名单 {VP8X, ICCP, VP8, VP8L, ALPH} 里，没有 EXIF、XMP 块；字节里找不到 Exif、XMP、注释原文，定位跟着丢了；
//     拍摄时间按 current_tz 留在结果里
//   · type 是 image/heic、浏览器解不了的 → heic_unsupported（R-377 提示“请先转成 JPG”）。没有真 HEIC 样张：
//     这里用假字节，只证明“解不了时走这条路”；WebKit 能不能解真 HEIC 没验证（见回报）
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { msAt } from '../../shared/core/date.ts';
import { exifApp1 } from '../../src/features/notes/__tests__/exif-sample.ts';
import { expect, test } from './csp-fixture.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BUNDLE = buildSync({
  stdin: {
    contents: "export { encodeImage, FULL_MAX, THUMB_MAX } from './src/features/notes/data/image-encode.ts';",
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: '__encMod',
  platform: 'browser',
  target: 'es2022',
  write: false,
}).outputFiles[0]?.text;
if (!BUNDLE) throw new Error('esbuild 没产出 image-encode.ts 的包');

const BLANK = '/__b4-image-encode.html';
const TZ = 'Asia/Seoul';

test.beforeEach(async ({ page }) => {
  await page.route(`**${BLANK}`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>enc</title>' }));
  await page.addInitScript({ content: `${BUNDLE}\nwindow.__enc = __encMod;` });
  await page.goto(BLANK);
});

test('带 GPS 的 JPEG → webp：没有 EXIF、尺寸和大小在上限内，拍摄时间留着（TC-B4-02）', async ({ page }) => {
  const app1 = [...exifApp1({ date: '2026:10:21 14:05:09', gps: true })];
  const r = await page.evaluate(
    async ({ app1, tz }) => {
      type Enc = { encodeImage(f: File, tz: string): Promise<{ ok: true; full: Blob; thumb: Blob; width: number; height: number; takenAt: number | null } | { ok: false; code: string }> };
      const M = (window as unknown as { __enc: Enc }).__enc;
      const c = document.createElement('canvas');
      c.width = 3000;
      c.height = 2000;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no_ctx');
      const g = ctx.createLinearGradient(0, 0, 3000, 2000);
      g.addColorStop(0, '#f2df4a');
      g.addColorStop(1, '#1f77a6');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 3000, 2000);
      for (let i = 0; i < 400; i++) {
        ctx.fillStyle = `hsl(${(i * 37) % 360} 70% 50%)`;
        ctx.fillRect((i * 97) % 3000, (i * 53) % 2000, 60, 40);
      }
      const jpeg = new Uint8Array(await (await new Promise<Blob>((res) => c.toBlob((b) => res(b as Blob), 'image/jpeg', 0.9))).arrayBuffer());
      // XMP（APP1 + Adobe 命名空间）和 COM（FFFE）：长度两字节含自身
      const seg = (marker: number, body: Uint8Array) => {
        const n = body.length + 2;
        return Uint8Array.from([0xff, marker, n >> 8, n & 0xff, ...body]);
      };
      const enc = new TextEncoder();
      const xmp = seg(0xe1, enc.encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>37,33.5N</exif:GPSLatitude></x:xmpmeta>'));
      const com = seg(0xfe, enc.encode('LEMO-SECRET-COMMENT'));
      const extra = [app1, xmp, com];
      const withExif = new Uint8Array(jpeg.length + extra.reduce((n, x) => n + x.length, 0));
      withExif.set(jpeg.subarray(0, 2));
      let at = 2;
      for (const x of extra) {
        withExif.set(x, at);
        at += x.length;
      }
      withExif.set(jpeg.subarray(2), at);
      const has = (b: Uint8Array, s: string) => {
        const n = [...s].map((x) => x.charCodeAt(0));
        outer: for (let i = 0; i + n.length <= b.length; i++) {
          for (let j = 0; j < n.length; j++) if (b[i + j] !== n[j]) continue outer;
          return true;
        }
        return false;
      };
      const out = await M.encodeImage(new File([withExif], 'IMG_0001.JPG', { type: 'image/jpeg' }), tz);
      if (!out.ok) return { ok: false, code: out.code, inputHasExif: has(withExif, 'Exif') };
      const full = new Uint8Array(await out.full.arrayBuffer());
      const thumb = new Uint8Array(await out.thumb.arrayBuffer());
      const head = (b: Uint8Array) => String.fromCharCode(...b.subarray(0, 4)) + String.fromCharCode(...b.subarray(8, 12));
      // RIFF 里的块名：从第 12 字节起，每块 4 字节名 + 4 字节小端长度 + 内容（奇数补 1）
      const chunks = (b: Uint8Array) => {
        const out: string[] = [];
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        for (let i = 12; i + 8 <= b.length; ) {
          const size = dv.getUint32(i + 4, true);
          out.push(String.fromCharCode(...b.subarray(i, i + 4)));
          i += 8 + size + (size % 2);
        }
        return out;
      };
      return {
        ok: true,
        inputHasExif: has(withExif, 'Exif'),
        fullType: out.full.type,
        thumbType: out.thumb.type,
        fullHead: head(full),
        thumbHead: head(thumb),
        fullSize: full.length,
        thumbSize: thumb.length,
        width: out.width,
        height: out.height,
        inputHasXmp: has(withExif, 'xap/1.0') && has(withExif, 'LEMO-SECRET-COMMENT'),
        fullExif: has(full, 'Exif') || has(full, 'EXIF'),
        thumbExif: has(thumb, 'Exif') || has(thumb, 'EXIF'),
        leak: ['XMP ', 'xap/1.0', 'GPSLatitude', 'LEMO-SECRET-COMMENT'].filter((x) => has(full, x) || has(thumb, x)),
        fullChunks: chunks(full),
        thumbChunks: chunks(thumb),
        takenAt: out.takenAt,
      };
    },
    { app1, tz: TZ },
  );
  expect(r).toMatchObject({ ok: true, inputHasExif: true, fullType: 'image/webp', thumbType: 'image/webp', fullHead: 'RIFFWEBP', thumbHead: 'RIFFWEBP', width: 2048, height: 1365 });
  expect(r.fullSize).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(r.thumbSize).toBeLessThanOrEqual(128 * 1024);
  expect(r.fullExif).toBe(false);
  expect(r.thumbExif).toBe(false);
  expect(r.inputHasXmp).toBe(true);
  expect(r.leak).toEqual([]);
  const allow = ['VP8X', 'ICCP', 'VP8 ', 'VP8L', 'ALPH'];
  for (const c of [...(r.fullChunks ?? []), ...(r.thumbChunks ?? [])]) expect(allow, `RIFF 块 ${c}`).toContain(c);
  expect(r.fullChunks?.length).toBeGreaterThan(0);
  expect(r.takenAt).toBe(msAt('2026-10-21', 14 * 60 + 5, TZ) + 9000);
});

test('浏览器解不了的 HEIC → heic_unsupported（R-377；假字节）', async ({ page }) => {
  const code = await page.evaluate(async () => {
    type Enc = { encodeImage(f: File, tz: string): Promise<{ ok: boolean; code?: string }> };
    const M = (window as unknown as { __enc: Enc }).__enc;
    const r = await M.encodeImage(new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])], 'IMG_1.HEIC', { type: 'image/heic' }), 'Asia/Seoul');
    return r.ok ? 'ok' : r.code;
  });
  expect(code).toBe('heic_unsupported');
});
