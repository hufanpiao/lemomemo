// Rive 运行库和 wasm：真要显示吉祥物时才下载，全 App 一份；wasm 自托管（/app/assets/）。下载失败不记住，下次再试
import type * as RiveNs from '@rive-app/canvas';

type RiveModule = typeof RiveNs;

/** Vite 按这个写法把 wasm 发到 assets/rive-<哈希>.wasm（SW、exe 打包都按这个名字认） */
const WASM_URL = new URL('../../node_modules/@rive-app/canvas/rive.wasm', import.meta.url).href;

let runtime: Promise<RiveModule> | null = null;

export function loadRive(): Promise<RiveModule> {
  runtime ??= import('@rive-app/canvas')
    .then((m) => {
      const mod = ((m as unknown as { default?: RiveModule }).default ?? m) as RiveModule;
      mod.RuntimeLoader.setWasmUrl(WASM_URL);
      // Rive 默认失败后去第三方 CDN 再下一次：关掉，只用自家这一份，失败就不显示
      mod.RuntimeLoader.setWasmFallbackUrl(null);
      return mod;
    })
    .catch((e: unknown) => {
      runtime = null;
      throw e;
    });
  return runtime;
}

/** 吉祥物静态图：下载、解码好再交给舞台（换上时不用再等解码、不闪）；失败（含没有 decode 的环境）抛错，舞台就等 Rive。
 *  重复读走 SW 缓存（lemo-mascot） */
export async function loadStill(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

/** 不在内存里留一份：重复读走 SW 缓存（lemo-mascot） */
export async function loadRiv(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('riv_http');
  return r.arrayBuffer();
}
