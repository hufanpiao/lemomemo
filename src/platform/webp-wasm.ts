// App 自带的 webp 编码器：iPhone Safari 的 canvas 导不出 webp（交回 png），而 images 桶只收 webp，所以拿 canvas 像素自己编
// • 直接引 @jsquash/webp 的 SIMD 版，不走包入口（入口会让两份 wasm 都发出去）。许可原文由 build/gen_licenses.mjs 收进 /app/licenses.txt
// • 按需动态 import，不进首屏；载入失败不记住，下次再载
// • 载之前先探 wasmUsable，跑不了抛 NoWasm（界面单独提示，不和离线混）：emscripten 胶水各种失败都 abort 成 RuntimeError，事后分不出
// • 编码出错作废这份实例（wasm 的堆坏了不能一直坏下去），下次重建；只作废出错的那一份

/** canvas 取出的 RGBA 像素（ImageData 的子集） */
export interface RawPixels {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** 编码一张：quality 和 canvas 的一样是 0～1；返回 webp 文件的字节。出错就抛 */
export type WebpEncode = (img: RawPixels, quality: number) => Uint8Array<ArrayBuffer>;

export interface WebpCodec {
  module: { encode(data: BufferSource, width: number, height: number, options: Record<string, number>): Uint8Array<ArrayBuffer> | null };
  /** libwebp 的默认参数，编码时只换 quality */
  options: Record<string, number>;
}

/** 设备跑不了 wasm 编码器时抛的错名（image-encode.ts 按它分出 wasm_unsupported） */
export const NO_WASM = 'NoWasm';

/** 最小的合法模块：编译它看 CSP、锁定模式让不让编译 */
const EMPTY_MODULE = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
/** 用到一条 SIMD 指令的模块（照抄 wasm-feature-detect），validate 不过说明不认 SIMD */
const SIMD_PROBE = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11);

/** 这台设备能不能跑 SIMD 版的 wasm 编码器；探测本身出任何错都算不能。env 可注入（测试） */
export function wasmUsable(env: { WebAssembly?: typeof WebAssembly } = globalThis): boolean {
  try {
    const W = env.WebAssembly;
    if (typeof W !== 'object' || W === null || !W.validate(SIMD_PROBE)) return false;
    new W.Module(EMPTY_MODULE);
    return true;
  } catch {
    return false;
  }
}

/**
 * 载入 wasm 编码器。overrides 交给 emscripten 模块工厂：App 里不给；单测在 node 里给 wasmBinary（node 的 fetch 取不了 file: 地址）
 */
export async function loadWebpCodec(overrides: { wasmBinary?: Uint8Array } = {}): Promise<WebpCodec> {
  if (!wasmUsable()) throw Object.assign(new Error('wasm_unsupported'), { name: NO_WASM });
  const [codec, meta] = await Promise.all([import('@jsquash/webp/codec/enc/webp_enc_simd.js'), import('@jsquash/webp/meta.js')]);
  // noInitialRun：只要导出的 encode，不跑 main
  const module = (await codec.default({ noInitialRun: true, ...overrides })) as unknown as WebpCodec['module'];
  return { module, options: { ...meta.defaultOptions } };
}

/** 编不出（encode 回 null）时抛的错，名字给运行日志用 */
function emptyError(): Error {
  return Object.assign(new Error('webp_encode_empty'), { name: 'WebpEncodeEmpty' });
}

/** 返回“取编码器”：第一次调用才载；载好的复用，载入失败或编码出错就作废，下次重建 */
export function createWebpWasm(load: () => Promise<WebpCodec> = loadWebpCodec): () => Promise<WebpEncode> {
  let ready: Promise<WebpCodec> | null = null;
  return async () => {
    const p = (ready ??= load());
    const drop = (): void => {
      if (ready === p) ready = null;
    };
    let m: WebpCodec;
    try {
      m = await p;
    } catch (e) {
      drop();
      throw e;
    }
    return (img, quality) => {
      const q = Math.round(Math.min(1, Math.max(0, quality)) * 100);
      try {
        const out = m.module.encode(img.data, img.width, img.height, { ...m.options, quality: q });
        if (!out) throw emptyError();
        return out;
      } catch (e) {
        drop();
        throw e;
      }
    };
  };
}

/** App 里共用的一份（模块只载一次） */
export const loadWebpWasm: () => Promise<WebpEncode> = createWebpWasm();
