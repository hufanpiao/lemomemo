// App 自带的 webp 编码器（R-402，11-13 负责人定）：iPhone Safari 的 canvas 导不出 webp（toBlob / convertToBlob 要 image/webp 交回 png），
// images 桶只收 webp（库约束、/files 文件头检查都锁着），这里拿 canvas 的像素（getImageData）自己编
// • 库：@jsquash/webp 1.5.0（Squoosh 的 libwebp 编成 wasm；jSquash 是 Apache-2.0，libwebp 是 BSD-3，许可文本随产物发在
//   /app/licenses/webp-wasm.txt），只用编码；直接引它的 SIMD 版，不走包入口（入口按 wasm-feature-detect 在 SIMD 版和普通版之间挑，
//   两份 wasm 都会发出去）。最低 iOS 16.4 起就有 wasm SIMD
// • 按需加载：第一次要用时才动态 import，不进首屏；wasm 由 Vite 当作资源发到 /app/assets/（同源，CSP 的 script-src 加了 'wasm-unsafe-eval'），
//   SW 的预缓存清单按 /app/ 下的全部产物生成，自动带上，离线也拿得到
// • 载入失败（离线又没缓存、浏览器不让编译 wasm）：抛错，由调用方分类；不记住失败，下次再载
// • 编码抛错（超大图内存不足等）或编不出：抛错，并作废这份实例（wasm 的堆坏了不能一直坏下去），下次重建；
//   只作废出错的那一份（if (ready === p)），旧实例晚到的错误不会把新建的也扔掉
// 只管编码，不联网（wasm 文件的取用由浏览器和 SW 管）

/** canvas 取出的像素（ImageData 的子集：RGBA，每像素 4 字节） */
export interface RawPixels {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** 编码一张：quality 和 canvas 的一样是 0～1；返回 webp 文件的字节。出错就抛 */
export type WebpEncode = (img: RawPixels, quality: number) => Uint8Array<ArrayBuffer>;

/** 载好的编码器（emscripten 模块 + libwebp 默认参数） */
export interface WebpCodec {
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
