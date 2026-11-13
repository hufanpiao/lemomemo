// 插图重新编码（B4 S3；R-108、R-377、R-402；任务单第 67 行）：选的或拍的照片 → 原图 webp + 缩略图 webp，带拍摄时间
// • 解码：createImageBitmap（按 EXIF 方向转正，imageOrientation: 'from-image'）；画到 canvas 再编成 webp。
//   重新编码后原文件的 EXIF 整段都没了（定位、机型一概不带走，R-108），只有拍摄时间从 JPEG 原文件里另读（image-exif.ts）
// • 原图：长边不超过 FULL_EDGE（2048px），质量从 0.85 起，超过 FULL_MAX（2 MB，images 桶上限）就逐步降，降到底还超就缩小一档再来
// • 缩略图：长边不超过 THUMB_EDGE（384px），不超过 THUMB_MAX（128 KB），同样逐步降质量。两个上限和 shared/manifests/notes.ts 的
//   fileSizeLimit、thumbSizeLimit 相等（清单引着 zod，这里不引，单测钉住相等）
// • 每个尺寸只画一次：一张画布既给原生导出用，也给 wasm 取像素用；出了这一档就释放画布（宽高置 0，不等 GC：
//   iPhone Safari 的画布总内存上限很紧，连插几张大图会撞上）、放掉像素（缩略图开始前原图那份已经放掉）
// • 两条路（R-402）：先用浏览器原生导出 webp；交回来的不是 webp（iPhone Safari：要 image/webp 回 png）或 reject，
//   这张图后面就都改走 App 自带的 wasm 编码器（platform/webp-wasm.ts），把同一张画布的像素（getImageData）编成 webp。
//   原生行不行只探测一次：第一次拿到 blob 就把它的 type 记在 NativeMemo 里（App 里整个模块共用一份），以后的图不再白导一次 png；
//   reject、回 null 不算结论（可能只是这张太大），下一张再试。wasm 只从像素编，原文件的 EXIF 一个字节都带不过去（R-108 照旧）
// • 失败码：解不了 → heic_unsupported / decode_failed；设备根本跑不了 wasm（没有 WebAssembly、不认 SIMD、编译被拦）→ wasm_unsupported（R-407；不叫 encode_unsupported：那是 R-402 以前“换个浏览器”的旧码，日志里会混）；
//   wasm 载不进来（离线又没缓存等）→ encode_load_failed；
//   取不到像素、编码出错（内存不足等）→ encode_failed；怎么降都超 → too_big。意料之外的异常也收口成 encode_failed，不往外抛
// • 诊断（diag，每个结果都有）：走哪条路、原生交回的 type、耗时（总、载 wasm、wasm 编码；从解码完算起）、
//   失败在哪一步（decode / load / px / enc）和错误名
//   （只记 e.name，不记 message 和图片内容）。这里不写日志，由上传器把它和压图结果记成一行（image-uploader.ts）
// • 依赖可注入（测试里 jsdom 没有 canvas）
// 纯 TS：不准 import React（A1）
import type { Tz } from '../../../../shared/core/tz.ts';
import { loadWebpWasm, NO_WASM, type RawPixels, type WebpEncode } from '../../../platform/webp-wasm.ts';
import { EXIF_SCAN_BYTES, jpegTakenAt } from './image-exif.ts';

export const FULL_EDGE = 2048;
export const FULL_MAX = 2 * 1024 * 1024;
export const THUMB_EDGE = 384;
export const THUMB_MAX = 128 * 1024;
const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45] as const;
const WEBP = 'image/webp';

/** 一次编码的诊断（给运行日志） */
export interface EncodeDiag {
  path: 'native' | 'wasm';
  /** 原生导出交回的 type：这张图试了原生就是这次的，没试就是记住的结论；没拿到 blob（reject、null）为 null */
  native: string | null;
  /** 总耗时、等 wasm 载入、wasm 编码（毫秒，取整） */
  ms: number;
  loadMs: number;
  encMs: number;
  /** 失败在哪一步：解码、载 wasm、画布或取像素、wasm 编码（意料之外的异常也算 enc） */
  why?: 'decode' | 'load' | 'px' | 'enc';
  /** 错误名（e.name；不像名字的记 Unknown） */
  err?: string;
}

export interface Encoded {
  ok: true;
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  /** 拍摄时间（毫秒），读不出为 null */
  takenAt: number | null;
  diag?: EncodeDiag;
}
export type EncodeFail = { ok: false; code: 'heic_unsupported' | 'decode_failed' | 'wasm_unsupported' | 'encode_load_failed' | 'encode_failed' | 'too_big'; diag?: EncodeDiag };
export type EncodeResult = Encoded | EncodeFail;

/** 解出来的图（ImageBitmap 的子集） */
export interface Decoded {
  width: number;
  height: number;
  close(): void;
}

/** 画好一个尺寸的画布 */
export interface Canvas {
  /** 原生导出 image/webp；交回什么 type 就是什么，导不出回 null（也可以 reject） */
  toBlob(quality: number): Promise<Blob | null>;
  /** RGBA 像素；取不到就抛 */
  pixels(): RawPixels;
  /** 释放画布内存（宽高置 0）；之后不能再用 */
  free(): void;
}

/** 原生能不能导出 webp 的结论：第一次拿到 blob 时记下它的 type（还没拿到过为 undefined） */
export interface NativeMemo {
  type?: string;
}

export interface EncodeDeps {
  decode(file: Blob): Promise<Decoded>;
  /** 把 src 画成 w × h；拿不到 2d 上下文就抛 */
  canvas(src: Decoded, w: number, h: number): Canvas;
  /** 取 wasm 编码器（R-402），载不进来就抛 */
  wasm(): Promise<WebpEncode>;
  native: NativeMemo;
  now(): number;
}

/** 是不是 HEIC / HEIF（iPhone 默认格式） */
export function isHeic(file: { type: string; name?: string }): boolean {
  return /^image\/hei[cf](-sequence)?$/i.test(file.type) || /\.hei[cf]$/i.test(file.name ?? '');
}

/** 按长边缩到不超过 edge（不放大），取整、至少 1 */
export function fitEdge(w: number, h: number, edge: number): { w: number; h: number } {
  const k = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

type Ctx2d = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** 默认画布：有 OffscreenCanvas 用它，没有用 DOM 的；原生导出同步抛错、reject 都回 null */
export function drawCanvas(src: Decoded, w: number, h: number): Canvas {
  const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d') as Ctx2d | null;
  if (!ctx) throw Object.assign(new Error('no_2d_context'), { name: 'NoContext' });
  ctx.drawImage(src as unknown as CanvasImageSource, 0, 0, w, h);
  return {
    async toBlob(quality) {
      try {
        return 'convertToBlob' in c ? await c.convertToBlob({ type: WEBP, quality }) : await new Promise<Blob | null>((res) => c.toBlob(res, WEBP, quality));
      } catch {
        return null;
      }
    },
    pixels: () => ctx.getImageData(0, 0, w, h),
    free() {
      c.width = 0;
      c.height = 0;
    },
  };
}

const defaultDeps: EncodeDeps = {
  decode: (file) => createImageBitmap(file, { imageOrientation: 'from-image' }),
  canvas: drawCanvas,
  wasm: loadWebpWasm,
  native: {},
  now: () => performance.now(),
};

/** 失败停在哪一步（只在本文件里抛和接） */
class Stop {
  readonly why: NonNullable<EncodeDiag['why']>;
  readonly err: string;
  constructor(why: NonNullable<EncodeDiag['why']>, err: string) {
    this.why = why;
    this.err = err;
  }
}
/** 错误名：只认对象上像标识符的 name（Error、DOMException、WebAssembly.CompileError 都是），别的一律 Unknown（不把 message、文件名之类带进日志） */
function errName(e: unknown): string {
  const name: unknown = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : 'Unknown';
}
const MIME_RE = /^[a-z]+\/[a-z0-9.+-]{1,40}$/;

/** 诊断写成运行日志的一段：path=… native=… ms=… loadMs=… encMs=…（失败另带 why=… err=…） */
export function encodeDiagText(d: EncodeDiag): string {
  const native = d.native === null ? 'null' : MIME_RE.test(d.native) ? d.native : 'other';
  return `path=${d.path} native=${native} ms=${d.ms} loadMs=${d.loadMs} encMs=${d.encMs}${d.why ? ` why=${d.why} err=${d.err ?? 'Unknown'}` : ''}`;
}

/** 起一份诊断：原生还没结论或能导出 → 先走原生，已知不行 → 直接走 wasm */
function startDiag(native: NativeMemo): EncodeDiag {
  const known = native.type;
  return { path: known === undefined || known === WEBP ? 'native' : 'wasm', native: known ?? null, ms: 0, loadMs: 0, encMs: 0 };
}

/** 一张图的 webp 编码器：path 和耗时记在 diag 里；size() 给一个尺寸的画布，encode(q) 编一份，出错抛 Stop */
function webpEncoder(deps: EncodeDeps, src: Decoded, diag: EncodeDiag) {
  let wasm: WebpEncode | null = null;
  const step = async <T>(why: Stop['why'], f: () => T | Promise<T>, time?: 'loadMs' | 'encMs'): Promise<T> => {
    const t = deps.now();
    try {
      return await f();
    } catch (e) {
      throw new Stop(why, errName(e));
    } finally {
      if (time) diag[time] += deps.now() - t;
    }
  };
  return {
    async size(w: number, h: number) {
      let c: Canvas | null = await step('px', () => deps.canvas(src, w, h));
      let px: RawPixels | null = null;
      return {
        async encode(q: number): Promise<Blob> {
          if (!c) throw new Stop('px', 'Released');
          if (diag.path === 'native') {
            const b = await c.toBlob(q).catch(() => null);
            diag.native = b ? b.type : null;
            if (b) deps.native.type ??= b.type;
            if (b?.type === WEBP) return b;
            diag.path = 'wasm';
          }
          wasm ??= await step('load', deps.wasm, 'loadMs');
          const enc = wasm;
          const cv = c;
          px ??= await step('px', () => cv.pixels());
          const p = px;
          return step('enc', () => new Blob([enc(p, q)], { type: WEBP }), 'encMs');
        },
        /** 出了这一档：释放画布、放掉像素 */
        release() {
          c?.free();
          c = null;
          px = null;
        },
      };
    },
  };
}
type WebpEncoder = ReturnType<typeof webpEncoder>;

/** 在 edge 以内、按质量表逐步降，找第一份不超过 max 的 webp；长边每次再缩 0.8 倍，最多三档 */
async function shrink(enc: WebpEncoder, src: Decoded, edge: number, max: number): Promise<{ blob: Blob; w: number; h: number } | 'too_big'> {
  let e = edge;
  for (let round = 0; round < 3; round++) {
    const { w, h } = fitEdge(src.width, src.height, e);
    const at = await enc.size(w, h);
    try {
      for (const q of QUALITIES) {
        const b = await at.encode(q);
        if (b.size <= max) return { blob: b, w, h };
      }
    } finally {
      at.release();
    }
    e = Math.round(Math.max(w, h) * 0.8);
  }
  return 'too_big';
}

async function takenAtOf(file: Blob, tz: Tz): Promise<number | null> {
  if (file.type !== 'image/jpeg') return null;
  try {
    return jpegTakenAt(await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer(), tz);
  } catch {
    return null;
  }
}

async function encodeDecoded(enc: WebpEncoder, src: Decoded, file: File, tz: Tz): Promise<EncodeResult> {
  if (!(src.width > 0 && src.height > 0)) return { ok: false, code: 'decode_failed' };
  const full = await shrink(enc, src, FULL_EDGE, FULL_MAX);
  if (full === 'too_big') return { ok: false, code: full };
  const thumb = await shrink(enc, src, THUMB_EDGE, THUMB_MAX);
  if (thumb === 'too_big') return { ok: false, code: thumb };
  return { ok: true, full: full.blob, thumb: thumb.blob, width: full.w, height: full.h, takenAt: await takenAtOf(file, tz) };
}

/** 选的或拍的一张照片 → 原图 + 缩略图（webp）+ 拍摄时间；解码以后的结果都带诊断 */
export async function encodeImage(file: File, tz: Tz, deps: EncodeDeps = defaultDeps): Promise<EncodeResult> {
  const d = startDiag(deps.native);
  let src: Decoded;
  try {
    src = await deps.decode(file);
  } catch (e) {
    return { ok: false, code: isHeic(file) ? 'heic_unsupported' : 'decode_failed', diag: { ...d, why: 'decode', err: errName(e) } };
  }
  const t0 = deps.now();
  let r: EncodeResult;
  try {
    r = await encodeDecoded(webpEncoder(deps, src, d), src, file, tz);
  } catch (e) {
    // Stop 是认得的那几步；别的（意料之外的同步异常等）也收口成 encode_failed，不往外抛，免得上传器那边没提示、没日志
    const s = e instanceof Stop ? e : new Stop('enc', errName(e));
    d.why = s.why;
    d.err = s.err;
    r = { ok: false, code: s.why !== 'load' ? 'encode_failed' : s.err === NO_WASM ? 'wasm_unsupported' : 'encode_load_failed' };
  } finally {
    src.close();
  }
  d.ms = Math.round(deps.now() - t0);
  d.loadMs = Math.round(d.loadMs);
  d.encMs = Math.round(d.encMs);
  return { ...r, diag: d };
}
