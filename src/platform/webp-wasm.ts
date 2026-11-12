// App 自带的 webp 编码器（R-402，11-13 负责人定）：iPhone Safari 的 canvas 导不出 webp（toBlob / convertToBlob 要 image/webp 交回 png），
// images 桶只收 webp（库约束、/files 文件头检查都锁着），这里拿 canvas 的像素（getImageData）自己编
// • 库：@jsquash/webp 1.5.0（Squoosh 的 libwebp 编成 wasm，Apache-2.0），只用编码；直接引它的 SIMD 版，
//   不走包入口（入口按 wasm-feature-detect 在 SIMD 版和普通版之间挑，两份 wasm 都会发出去）。最低 iOS 16.4 起就有 wasm SIMD
// • 按需加载：第一次要用时才动态 import，不进首屏；wasm 由 Vite 当作资源发到 /app/assets/（同源，CSP 的 script-src 加了 'wasm-unsafe-eval'），
//   SW 的预缓存清单按 /app/ 下的全部产物生成，自动带上，离线也拿得到
// • 加载失败（离线又没缓存、浏览器不让编译 wasm）：抛错，由调用方回现有的失败码；失败不记住，下次再试
// 只管编码，不联网（wasm 文件的取用由浏览器和 SW 管）

/** canvas 取出的像素（ImageData 的子集：RGBA，每像素 4 字节） */
export interface RawPixels {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** 编码一张：quality 和 canvas 的一样是 0～1；返回 webp 文件的字节 */
export type WebpWasmEncode = (img: RawPixels, quality: number) => Promise<Uint8Array<ArrayBuffer>>;

interface WebpCodec {
  module: { encode(data: BufferSource, width: number, height: number, options: Record<string, number>): Uint8Array<ArrayBuffer> | null };
  /** libwebp 的默认参数（包里 meta.js 的 defaultOptions），编码时只换 quality */
  options: Record<string, number>;
}

/**
 * 载入 wasm 编码器。overrides 原样交给 emscripten 的模块工厂：App 里不给（胶水代码按 import.meta.url 去取同目录的 .wasm）；
 * 单测在 node 里给 wasmBinary（node 的 fetch 取不了 file: 地址）
 */
export async function loadWebpCodec(overrides: { wasmBinary?: Uint8Array } = {}): Promise<WebpCodec> {
  const [codec, meta] = await Promise.all([import('@jsquash/webp/codec/enc/webp_enc_simd.js'), import('@jsquash/webp/meta.js')]);
  // noInitialRun：只要导出的 encode，不跑 main
  const module = (await codec.default({ noInitialRun: true, ...overrides })) as unknown as WebpCodec['module'];
  return { module, options: { ...meta.defaultOptions } };
}

export function createWebpWasm(load: () => Promise<WebpCodec> = loadWebpCodec): WebpWasmEncode {
  let ready: Promise<WebpCodec> | null = null;
  return async (img, quality) => {
    ready ??= load();
    let m: WebpCodec;
    try {
      m = await ready;
    } catch (e) {
      ready = null; // 这次没载进来（离线、被拦）：不记住，下次再试
      throw e;
    }
    const q = Math.round(Math.min(1, Math.max(0, quality)) * 100);
    const out = m.module.encode(img.data, img.width, img.height, { ...m.options, quality: q });
    if (!out) throw new Error('webp_encode_failed');
    return out;
  };
}

/** App 里共用的一份（模块只载一次） */
export const encodeWebpWasm: WebpWasmEncode = createWebpWasm();
