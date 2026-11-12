// R-402：浏览器原生导不出 webp（iPhone Safari 要 image/webp 回 png）时，改用 App 自带的 wasm 编码器（@jsquash/webp）
// • 原生回 png → 走 wasm，产物 type 是 image/webp、文件头 RIFF....WEBP（这里跑的是真 wasm，从 node_modules 读 .wasm 给 wasmBinary）
// • 原生能导出 → 一次都不载 wasm
// • wasm 那条路沿用同一张质量表、长边和 FULL_MAX / THUMB_MAX 的逐档降；产物里没有 EXIF、XMP 块，拍摄时间照旧从原 JPEG 读（R-108）
// • wasm 载不进来 → encode_unsupported；失败不记住，下次再载
// • 运行日志一行：notes img enc path=… ms=…
// 真浏览器（Chromium 模拟 iPhone）里的整条链路见 tests/e2e/r402-webp-wasm.spec.ts
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { createWebpWasm, loadWebpCodec, type RawPixels } from '../../../platform/webp-wasm.ts';
import { encodeImage, FULL_EDGE, THUMB_EDGE, type Decoded, type EncodeDeps } from '../data/image-encode.ts';
import { bareJpeg, exifApp1, hasAscii, withExif } from './exif-sample.ts';

const TZ = 'Asia/Seoul';
const wasmBinary = readFileSync(createRequire(import.meta.url).resolve('@jsquash/webp/codec/enc/webp_enc_simd.wasm'));
const realWasm = createWebpWasm(() => loadWebpCodec({ wasmBinary }));

/** RIFF....WEBP 文件头 */
const isWebpFile = (b: Uint8Array) =>
  String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP';
/** webp 里按 RIFF 块列出块名（VP8 、VP8L、VP8X、ALPH、EXIF、XMP …） */
function chunks(b: Uint8Array): string[] {
  const out: string[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 12; i + 8 <= b.length; ) {
    out.push(String.fromCharCode(...b.subarray(i, i + 4)));
    i += 8 + v.getUint32(i + 4, true) + (v.getUint32(i + 4, true) & 1);
  }
  return out;
}
/** 一张有点花纹的假像素（全同色压得太小，看不出质量降档） */
function noise(w: number, h: number): RawPixels {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 7;
  for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : (s = (s * 1103515245 + 12345) & 0x7fffffff) >> 23;
  return { data, width: w, height: h };
}

/** 假解码 + 原生只会回 png 的画布（模拟 iPhone Safari）；像素和 wasm 编码器可换 */
function iphoneDeps(o: { w?: number; h?: number; wasm?: EncodeDeps['wasmWebp'] } = {}) {
  const log: string[] = [];
  const sizes: { w: number; h: number }[] = [];
  const qs: number[] = [];
  const wasm = o.wasm ?? realWasm;
  const deps: EncodeDeps = {
    decode: () => Promise.resolve({ width: o.w ?? 64, height: o.h ?? 48, close: vi.fn() } satisfies Decoded),
    render: () => Promise.resolve(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })),
    pixels: (_s, w, h) => {
      sizes.push({ w, h });
      return Promise.resolve(noise(w, h));
    },
    wasmWebp: (img, q) => {
      qs.push(q);
      return wasm(img, q);
    },
    log: (l) => log.push(l),
    now: () => 0,
  };
  return { deps, log, sizes, qs };
}

describe('R-402 wasm 编码器本身（@jsquash/webp 的 SIMD 版）', () => {
  it('像素 → RIFF....WEBP；没有 EXIF、XMP 块', async () => {
    const out = await realWasm(noise(32, 24), 0.85);
    expect(isWebpFile(out)).toBe(true);
    expect(chunks(out).some((c) => c === 'EXIF' || c === 'XMP ')).toBe(false);
  });
  it('质量照 canvas 的 0～1：低质量产物更小', async () => {
    const hi = await realWasm(noise(64, 48), 0.85);
    const lo = await realWasm(noise(64, 48), 0.45);
    expect(lo.length).toBeLessThan(hi.length);
  });
  it('载不进来就抛，不记住失败：下次再载', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(() => loadWebpCodec({ wasmBinary }));
    const enc = createWebpWasm(load);
    await expect(enc(noise(8, 8), 0.8)).rejects.toThrow('offline');
    expect(isWebpFile(await enc(noise(8, 8), 0.8))).toBe(true);
    await enc(noise(8, 8), 0.8);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('R-402 两条路：原生先试，回的不是 webp 改走 wasm', () => {
  it('toBlob 回 png → 走 wasm：原图、缩略图都是 image/webp，文件头 RIFF....WEBP；日志记 path=wasm', async () => {
    const { deps, log } = iphoneDeps();
    const r = await encodeImage(new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }), TZ, deps);
    if (!r.ok) throw new Error(r.code);
    for (const b of [r.full, r.thumb]) {
      expect(b.type).toBe('image/webp');
      expect(isWebpFile(new Uint8Array(await b.arrayBuffer()))).toBe(true);
    }
    expect([r.width, r.height]).toEqual([64, 48]);
    expect(log).toEqual(['notes img enc path=wasm ms=0']);
  });

  it('原生能导出 webp → 一次都不载 wasm；日志记 path=native', async () => {
    const load = vi.fn(() => loadWebpCodec({ wasmBinary }));
    const wasm = createWebpWasm(load);
    const { deps, log } = iphoneDeps({ wasm });
    deps.render = (_s, w, h) => Promise.resolve(new Blob([new Uint8Array(w * h > 1e6 ? 10 : 5)], { type: 'image/webp' }));
    const pixels = vi.spyOn(deps, 'pixels');
    const r = await encodeImage(new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }), TZ, deps);
    expect(r.ok).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(pixels).not.toHaveBeenCalled();
    expect(log).toEqual(['notes img enc path=native ms=0']);
  });

  it('wasm 那条路沿用长边、质量表、上限逐档降：原图长边 2048、缩略图 384，超了降质量；同一尺寸只取一次像素', async () => {
    // 编码器换成按“宽 × 高 × 质量”给大小的假字节（真编 2048 的图太慢），只看逐档降的逻辑
    const fake: EncodeDeps['wasmWebp'] = (img, q) => {
      const n = Math.round(img.width * img.height * q * 0.9);
      return Promise.resolve(new Uint8Array(n));
    };
    const { deps, sizes, qs } = iphoneDeps({ w: 4000, h: 3000, wasm: fake });
    const r = await encodeImage(new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }), TZ, deps);
    if (!r.ok) throw new Error(r.code);
    expect([r.width, r.height]).toEqual([FULL_EDGE, 1536]);
    expect(r.full.size).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(r.thumb.size).toBeLessThanOrEqual(128 * 1024);
    expect(qs[0]).toBe(0.85);
    expect(qs.some((q) => q < 0.85)).toBe(true);
    expect(Math.max(sizes.at(-1)?.w ?? 0, sizes.at(-1)?.h ?? 0)).toBe(THUMB_EDGE);
    // 每个尺寸只取一次像素（降质量重编不重画）
    expect(new Set(sizes.map((s) => `${s.w}x${s.h}`)).size).toBe(sizes.length);
  });

  it('R-108：带 GPS 的 JPEG 走 wasm，产物里没有 EXIF、XMP 块，找不到 Exif 字样；拍摄时间照旧留着', async () => {
    const jpeg = withExif(bareJpeg(), exifApp1({ date: '2026:10:21 14:05:09', gps: true }));
    expect(hasAscii(jpeg, 'Exif')).toBe(true);
    const { deps } = iphoneDeps();
    const r = await encodeImage(new File([new Uint8Array(jpeg)], 'a.jpg', { type: 'image/jpeg' }), TZ, deps);
    if (!r.ok) throw new Error(r.code);
    for (const b of [r.full, r.thumb]) {
      const bytes = new Uint8Array(await b.arrayBuffer());
      expect(chunks(bytes).some((c) => c === 'EXIF' || c === 'XMP ')).toBe(false);
      expect(hasAscii(bytes, 'Exif')).toBe(false);
    }
    expect(r.takenAt).toBe(msAt('2026-10-21', 14 * 60 + 5, TZ) + 9000);
  });

  it('wasm 载不进来（离线又没缓存）或取不到像素 → encode_unsupported，日志带 fail=', async () => {
    const off = iphoneDeps({ wasm: createWebpWasm(() => Promise.reject(new Error('offline'))) });
    expect(await encodeImage(new File([], 'a.png', { type: 'image/png' }), TZ, off.deps)).toEqual({ ok: false, code: 'encode_unsupported' });
    expect(off.log).toEqual(['notes img enc path=wasm ms=0 fail=encode_unsupported']);
    const nopx = iphoneDeps();
    nopx.deps.pixels = () => Promise.resolve(null);
    expect(await encodeImage(new File([], 'a.png', { type: 'image/png' }), TZ, nopx.deps)).toEqual({ ok: false, code: 'encode_unsupported' });
  });
});
