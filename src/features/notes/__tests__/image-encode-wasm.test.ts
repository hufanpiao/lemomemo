// R-402：浏览器原生导不出 webp（iPhone Safari 要 image/webp 回 png）时，改用 App 自带的 wasm 编码器（@jsquash/webp）
// • 原生回 png 或 reject → 走 wasm，产物 type 是 image/webp、文件头 RIFF....WEBP（这里跑的是真 wasm，从 node_modules 读 .wasm 给 wasmBinary）
// • 原生能导出 → 一次都不载 wasm、不取像素；原生行不行只探测一次（第一次拿到 blob 就记住，后面的图不再白导一次 png）
// • 每个尺寸只画一次（原生那一试和取像素共用一张画布）；沿用同一张质量表、长边和 FULL_MAX / THUMB_MAX 的逐档降
// • 产物里没有 EXIF、XMP 块，拍摄时间照旧从原 JPEG 读（R-108）
// • 失败分开报：设备跑不了 wasm（R-407）→ wasm_unsupported；wasm 载不进来 → encode_load_failed；取不到像素、编码出错（内存不足）→ encode_failed；
//   诊断（diag）记走哪条路、原生交回的 type、耗时（总、载入、编码）、失败在哪一步和错误名（只记 e.name，不记 message）
// • 编码器载不进来、编码抛错都不记住这份实例，下次重建
// 真浏览器（Chromium 模拟 iPhone）里的整条链路见 tests/e2e/r402-webp-wasm.spec.ts
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { notes } from '../../../../shared/manifests/notes.ts';
import { createWebpWasm, loadWebpCodec, NO_WASM, wasmUsable, type RawPixels, type WebpCodec } from '../../../platform/webp-wasm.ts';
import { drawCanvas, encodeDiagText, encodeImage, FULL_EDGE, FULL_MAX, THUMB_EDGE, THUMB_MAX, type Decoded, type EncodeDeps, type NativeMemo } from '../data/image-encode.ts';
import { bareJpeg, exifApp1, hasAscii, isWebpFile, riffChunks, withExif } from './exif-sample.ts';

const TZ = 'Asia/Seoul';
const wasmBinary = readFileSync(createRequire(import.meta.url).resolve('@jsquash/webp/codec/enc/webp_enc_simd.wasm'));
const realWasm = createWebpWasm(() => loadWebpCodec({ wasmBinary }));
const noMeta = (b: Uint8Array) => !riffChunks(b).some((c) => c === 'EXIF' || c === 'XMP ');
const png = () => Promise.resolve(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }));
const file = () => new File([new Uint8Array(10)], 'a.png', { type: 'image/png' });

/** 一张有点花纹的假像素（全同色压得太小，看不出质量降档） */
function noise(w: number, h: number): RawPixels {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 7;
  for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : (s = (s * 1103515245 + 12345) & 0x7fffffff) >> 23;
  return { data, width: w, height: h };
}

/**
 * 假解码 + 假画布：原生默认只会回 png（模拟 iPhone Safari）；原生导出、像素、wasm 编码器、原生结论都可换。
 * calls 记下：画了哪些尺寸、释放了哪些、原生导了几次、取了哪些尺寸的像素、wasm 编码用的质量
 */
function iphoneDeps(o: { w?: number; h?: number; native?: (q: number, w: number, h: number) => Promise<Blob | null>; pixels?: (w: number, h: number) => RawPixels; wasm?: EncodeDeps['wasm']; memo?: NativeMemo } = {}) {
  const calls = { canvas: [] as string[], freed: [] as string[], toBlob: 0, pixels: [] as string[], qs: [] as number[] };
  const load = o.wasm ?? realWasm;
  const deps: EncodeDeps = {
    decode: () => Promise.resolve({ width: o.w ?? 64, height: o.h ?? 48, close: vi.fn() } satisfies Decoded),
    canvas: (_s, w, h) => {
      calls.canvas.push(`${w}x${h}`);
      return {
        toBlob: (q) => {
          calls.toBlob++;
          return (o.native ?? png)(q, w, h);
        },
        pixels: () => {
          calls.pixels.push(`${w}x${h}`);
          return (o.pixels ?? noise)(w, h);
        },
        free: () => calls.freed.push(`${w}x${h}`),
      };
    },
    wasm: async () => {
      const enc = await load();
      return (img, q) => {
        calls.qs.push(q);
        return enc(img, q);
      };
    },
    native: o.memo ?? {},
    now: () => 0,
  };
  return { deps, calls };
}

/** 按“宽 × 高 × 质量”给大小的假 wasm（真编 2048 的图太慢），只看逐档降的逻辑 */
const sizedWasm: EncodeDeps['wasm'] = () => Promise.resolve((img, q) => new Uint8Array(Math.round(img.width * img.height * q * 0.9)));

describe('R-402 wasm 编码器本身（@jsquash/webp 的 SIMD 版）', () => {
  it('像素 → RIFF....WEBP；没有 EXIF、XMP 块', async () => {
    const out = (await realWasm())(noise(32, 24), 0.85);
    expect(isWebpFile(out)).toBe(true);
    expect(noMeta(out)).toBe(true);
  });
  it('质量照 canvas 的 0～1：低质量产物更小', async () => {
    const enc = await realWasm();
    expect(enc(noise(64, 48), 0.45).length).toBeLessThan(enc(noise(64, 48), 0.85).length);
  });
  it('载不进来就抛，不记住失败：下次再载；载进来以后复用同一份', async () => {
    const load = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockImplementation(() => loadWebpCodec({ wasmBinary }));
    const w = createWebpWasm(load);
    await expect(w()).rejects.toThrow('offline');
    expect(isWebpFile((await w())(noise(8, 8), 0.8))).toBe(true);
    await w();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('编码抛错（超大图内存不足）或编不出：作废这份实例，下一张重建、能恢复', async () => {
    const oom: WebpCodec = { module: { encode: vi.fn(() => { throw new RangeError('oom'); }) }, options: {} };
    const empty: WebpCodec = { module: { encode: vi.fn(() => null) }, options: {} };
    const load = vi.fn().mockResolvedValueOnce(oom).mockResolvedValueOnce(empty).mockImplementation(() => loadWebpCodec({ wasmBinary }));
    const w = createWebpWasm(load);
    const first = await w();
    expect(() => first(noise(8, 8), 0.8)).toThrow(RangeError);
    const second = await w(); // 第一份已作废，重建
    expect(() => second(noise(8, 8), 0.8)).toThrow(expect.objectContaining({ name: 'WebpEncodeEmpty' }));
    expect(isWebpFile((await w())(noise(8, 8), 0.8))).toBe(true); // 第二份也作废，第三份是真 wasm
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('作废只作废出错的那一份：旧实例晚到的错误不会把新实例也扔掉', async () => {
    const codec = (bad: boolean): WebpCodec => ({
      module: {
        encode: () => {
          if (bad) throw new RangeError('oom');
          return new Uint8Array(1);
        },
      },
      options: {},
    });
    const load = vi.fn().mockResolvedValueOnce(codec(true)).mockResolvedValue(codec(false));
    const w = createWebpWasm(load);
    const old = await w();
    expect(() => old(noise(8, 8), 0.8)).toThrow(RangeError); // 作废第一份
    const fresh = await w(); // 重建第二份
    expect(() => old(noise(8, 8), 0.8)).toThrow(RangeError); // 旧的那份又报错：现在的是第二份，不能扔
    expect((await w())(noise(8, 8), 0.8)).toHaveLength(1);
    expect(fresh(noise(8, 8), 0.8)).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('R-402 两条路：原生先试，回的不是 webp 改走 wasm', () => {
  it('toBlob 回 png → 走 wasm：原图、缩略图都是 image/webp，文件头 RIFF....WEBP；diag 记 path=wasm native=image/png', async () => {
    const { deps } = iphoneDeps();
    const r = await encodeImage(file(), TZ, deps);
    if (!r.ok) throw new Error(r.code);
    for (const b of [r.full, r.thumb]) {
      expect(b.type).toBe('image/webp');
      expect(isWebpFile(new Uint8Array(await b.arrayBuffer()))).toBe(true);
    }
    expect([r.width, r.height]).toEqual([64, 48]);
    expect(r.diag && encodeDiagText(r.diag)).toBe('path=wasm native=image/png ms=0 loadMs=0 encMs=0');
  });

  it('原生 reject（或回 null）→ 同样改走 wasm；native=null', async () => {
    const { deps } = iphoneDeps({ native: () => Promise.reject(new Error('x')) });
    const r = await encodeImage(file(), TZ, deps);
    if (!r.ok) throw new Error(r.code);
    expect(r.full.type).toBe('image/webp');
    expect(r.diag).toMatchObject({ path: 'wasm', native: null });
  });

  it('原生能导出 webp → 一次都不载 wasm、不取像素；diag 记 path=native', async () => {
    const wasm = vi.fn(realWasm);
    const { deps, calls } = iphoneDeps({ wasm, native: (_q, w, h) => Promise.resolve(new Blob([new Uint8Array(w * h > 1e6 ? 10 : 5)], { type: 'image/webp' })) });
    const r = await encodeImage(file(), TZ, deps);
    expect(r.ok).toBe(true);
    expect(wasm).not.toHaveBeenCalled();
    expect(calls.pixels).toEqual([]);
    expect(r.diag && encodeDiagText(r.diag)).toBe('path=native native=image/webp ms=0 loadMs=0 encMs=0');
  });

  it('原生只探测一次：第一张拿到 png 就记住，后面的图（含缩略图）都不再白导一次原生', async () => {
    const memo: NativeMemo = {};
    const a = iphoneDeps({ memo, wasm: sizedWasm, w: 4000, h: 3000 });
    expect((await encodeImage(file(), TZ, a.deps)).ok).toBe(true);
    expect(a.calls.toBlob).toBe(1);
    expect(memo.type).toBe('image/png');
    const b = iphoneDeps({ memo, wasm: sizedWasm, w: 4000, h: 3000 });
    const r = await encodeImage(file(), TZ, b.deps);
    expect(b.calls.toBlob).toBe(0);
    expect(r.diag).toMatchObject({ path: 'wasm', native: 'image/png' });
  });

  it('原生 reject 不算结论：下一张图还会再试原生', async () => {
    const memo: NativeMemo = {};
    const reject = () => Promise.reject(new Error('x'));
    const a = iphoneDeps({ memo, native: reject });
    await encodeImage(file(), TZ, a.deps);
    const b = iphoneDeps({ memo, native: reject });
    await encodeImage(file(), TZ, b.deps);
    expect([a.calls.toBlob, b.calls.toBlob, memo.type]).toEqual([1, 1, undefined]);
  });

  it('wasm 那条路沿用长边、质量表、上限逐档降：原图长边 2048、缩略图 384，超了降质量；每个尺寸只画一次、只取一次像素', async () => {
    const { deps, calls } = iphoneDeps({ w: 4000, h: 3000, wasm: sizedWasm });
    const r = await encodeImage(file(), TZ, deps);
    if (!r.ok) throw new Error(r.code);
    expect([r.width, r.height]).toEqual([FULL_EDGE, 1536]);
    expect(r.full.size).toBeLessThanOrEqual(FULL_MAX);
    expect(r.thumb.size).toBeLessThanOrEqual(THUMB_MAX);
    expect(calls.qs[0]).toBe(0.85);
    expect(calls.qs.some((q) => q < 0.85)).toBe(true);
    expect(calls.canvas).toEqual(calls.pixels); // 原生那一试和取像素用的是同一张画布
    expect(new Set(calls.canvas).size).toBe(calls.canvas.length);
    expect(calls.canvas.at(-1)).toBe(`${THUMB_EDGE}x288`);
  });

  it('R-108：带 GPS 的 JPEG 走 wasm，产物里没有 EXIF、XMP 块，找不到 Exif 字样；拍摄时间照旧留着', async () => {
    const jpeg = withExif(bareJpeg(), exifApp1({ date: '2026:10:21 14:05:09', gps: true }));
    expect(hasAscii(jpeg, 'Exif')).toBe(true);
    const { deps } = iphoneDeps();
    const r = await encodeImage(new File([new Uint8Array(jpeg)], 'a.jpg', { type: 'image/jpeg' }), TZ, deps);
    if (!r.ok) throw new Error(r.code);
    for (const b of [r.full, r.thumb]) {
      const bytes = new Uint8Array(await b.arrayBuffer());
      expect(noMeta(bytes)).toBe(true);
      expect(hasAscii(bytes, 'Exif')).toBe(false);
    }
    expect(r.takenAt).toBe(msAt('2026-10-21', 14 * 60 + 5, TZ) + 9000);
  });
});

describe('R-402 失败分开报，诊断写明哪一步、什么错（只记错误名）', () => {
  const fail = async (o: Parameters<typeof iphoneDeps>[0]) => {
    const r = await encodeImage(file(), TZ, iphoneDeps(o).deps);
    if (r.ok) throw new Error('该失败');
    return { code: r.code, text: r.diag ? encodeDiagText(r.diag) : '' };
  };

  it('wasm 载不进来（离线又没缓存）→ encode_load_failed，why=load err=TypeError；下一张再载', async () => {
    const load = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch secret-url')).mockImplementation(() => loadWebpCodec({ wasmBinary }));
    const w = createWebpWasm(load);
    expect(await fail({ wasm: w })).toEqual({ code: 'encode_load_failed', text: 'path=wasm native=image/png ms=0 loadMs=0 encMs=0 why=load err=TypeError' });
    expect((await encodeImage(file(), TZ, iphoneDeps({ wasm: w }).deps)).ok).toBe(true);
  });

  it('浏览器不让编译（CompileError）也是载入失败，错误名照记', async () => {
    const err = Object.assign(new Error('x'), { name: 'CompileError' });
    expect(await fail({ wasm: () => Promise.reject(err) })).toEqual({ code: 'encode_load_failed', text: 'path=wasm native=image/png ms=0 loadMs=0 encMs=0 why=load err=CompileError' });
  });

  it('R-407：设备跑不了 wasm（载入器先探出来，抛 NoWasm）→ wasm_unsupported，不和离线混在一起；下一张照样再探', async () => {
    const noWasm = Object.assign(new Error('wasm_unsupported'), { name: NO_WASM });
    const load = vi.fn().mockRejectedValueOnce(noWasm).mockImplementation(() => loadWebpCodec({ wasmBinary }));
    const w = createWebpWasm(load);
    expect(await fail({ wasm: w })).toEqual({ code: 'wasm_unsupported', text: 'path=wasm native=image/png ms=0 loadMs=0 encMs=0 why=load err=NoWasm' });
    expect((await encodeImage(file(), TZ, iphoneDeps({ wasm: w }).deps)).ok).toBe(true);
  });

  it('取不到像素 → encode_failed，why=px', async () => {
    const r = await fail({
      pixels: () => {
        throw new DOMException('tainted', 'SecurityError');
      },
    });
    expect(r).toEqual({ code: 'encode_failed', text: 'path=wasm native=image/png ms=0 loadMs=0 encMs=0 why=px err=SecurityError' });
  });

  it('编码出错（内存不足）→ encode_failed，why=enc；不记 message', async () => {
    const r = await fail({
      wasm: () =>
        Promise.resolve(() => {
          throw new RangeError('Cannot allocate 2048x1536 IMG_0402');
        }),
    });
    expect(r).toEqual({ code: 'encode_failed', text: 'path=wasm native=image/png ms=0 loadMs=0 encMs=0 why=enc err=RangeError' });
    expect(r.text).not.toContain('IMG_0402');
  });

  it('意料之外的异常（原生导出同步抛错等）也收口成 encode_failed，why=enc，不往外抛', async () => {
    const r = await fail({
      native: () => {
        throw new TypeError('sync');
      },
    });
    expect(r).toEqual({ code: 'encode_failed', text: 'path=native native=null ms=0 loadMs=0 encMs=0 why=enc err=TypeError' });
  });

  it('wasm 交回的东西拼不成 Blob（内存不足）→ encode_failed，why=enc', async () => {
    const bad = {
      toString() {
        throw new RangeError('oom');
      },
    } as unknown as Uint8Array<ArrayBuffer>;
    expect(await fail({ wasm: () => Promise.resolve(() => bad) })).toEqual({ code: 'encode_failed', text: 'path=wasm native=image/png ms=0 loadMs=0 encMs=0 why=enc err=RangeError' });
  });

  it('错误名不像名字（带空格、太长、不是 Error）一律记 Unknown', async () => {
    const odd = Object.assign(new Error('x'), { name: 'a b <c>' });
    expect((await fail({ wasm: () => Promise.reject(odd) })).text).toContain('err=Unknown');
    expect((await fail({ wasm: () => Promise.reject('just a string') })).text).toContain('err=Unknown');
  });

  it('耗时按 now() 算：总、载入、编码分开记（毫秒取整）', async () => {
    let t = 0;
    const { deps } = iphoneDeps({ wasm: sizedWasm });
    deps.now = () => (t += 1.4);
    const r = await encodeImage(file(), TZ, deps);
    expect(r.diag?.ms).toBeGreaterThan(0);
    expect(r.diag?.loadMs).toBe(1);
    expect(r.diag?.encMs).toBeGreaterThan(0);
    for (const k of ['ms', 'loadMs', 'encMs'] as const) expect(Number.isInteger(r.diag?.[k])).toBe(true);
  });
});

describe('画布用完就释放（iPhone Safari 画布总内存很紧，不等 GC）', () => {
  it('每一档用完都释放这张画布：成功、失败都一样', async () => {
    const ok = iphoneDeps({ w: 4000, h: 3000, wasm: sizedWasm });
    expect((await encodeImage(file(), TZ, ok.deps)).ok).toBe(true);
    expect(ok.calls.freed).toEqual(ok.calls.canvas);
    const bad = iphoneDeps({ wasm: () => Promise.reject(new TypeError('offline')) });
    expect((await encodeImage(file(), TZ, bad.deps)).ok).toBe(false);
    expect(bad.calls.freed).toEqual(bad.calls.canvas);
    expect(bad.calls.canvas).toHaveLength(1);
  });

  it('默认画布：free() 之后宽高都是 0；原生导出同步抛错回 null', async () => {
    const made: { width: number; height: number }[] = [];
    class FakeOffscreen {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
        made.push(this);
      }
      getContext() {
        return { drawImage: vi.fn(), getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) };
      }
      convertToBlob(): Promise<Blob> {
        throw new TypeError('sync');
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
    try {
      const c = drawCanvas({ width: 8, height: 6, close: vi.fn() }, 8, 6);
      expect(c.pixels().width).toBe(8);
      await expect(c.toBlob(0.8)).resolves.toBeNull();
      c.free();
      expect(made.map((m) => [m.width, m.height])).toEqual([[0, 0]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('上限和清单一致（R-402 评审 6）', () => {
  it('FULL_MAX、THUMB_MAX 等于 shared/manifests/notes.ts 里 images 桶的 fileSizeLimit、thumbSizeLimit', () => {
    const limits = notes.buckets?.find((b) => b.name === 'images')?.limits;
    expect([FULL_MAX, THUMB_MAX]).toEqual([limits?.fileSizeLimit, limits?.thumbSizeLimit]);
  });
});

describe('R-407 wasmUsable：载之前先探设备能不能跑', () => {
  it('node 里有 WebAssembly、认 SIMD、能编译 → 能跑', () => {
    expect(wasmUsable()).toBe(true);
  });
  it('没有 WebAssembly（锁定模式等）、不认 SIMD、编译被拦（CSP）、探测本身抛错 → 不能跑', () => {
    const as = (w: unknown) => ({ WebAssembly: w as typeof WebAssembly });
    expect(wasmUsable({})).toBe(false);
    expect(wasmUsable(as({ ...WebAssembly, validate: () => false }))).toBe(false);
    expect(wasmUsable(as({ validate: () => true, Module: function () { throw Object.assign(new Error('x'), { name: 'CompileError' }); } }))).toBe(false);
    expect(wasmUsable(as({ validate: () => { throw new TypeError('x'); } }))).toBe(false);
    expect(wasmUsable(as({ validate: WebAssembly.validate, Module: WebAssembly.Module })), '真的这两样就能跑').toBe(true);
  });
  it('跑不了时 loadWebpCodec 不去 import 胶水，直接抛 NoWasm', async () => {
    vi.stubGlobal('WebAssembly', undefined);
    try {
      await expect(loadWebpCodec({ wasmBinary })).rejects.toMatchObject({ name: NO_WASM });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
