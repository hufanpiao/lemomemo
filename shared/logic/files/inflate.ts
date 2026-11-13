// raw deflate 解压（file-sniff.ts 的 InflateRaw）：客户端（判类型、查压缩包）和服务器 file-check 共用这一份（架构 5.13 第 2 点）。
// 只用 WHATWG 标准的 DecompressionStream('deflate-raw')（浏览器、Deno、Node 24 都有），不引第三方库；
// 边解边计数，超过 maxBytes 立刻取消、回 null（InflateRaw 的约定）；数据坏了抛错，由调用方当 inflate_failed。
import type { InflateRaw } from './file-sniff.ts';

export const inflateRaw: InflateRaw = async (deflated, maxBytes) => {
  const ds = new DecompressionStream('deflate-raw');
  const reader = new Blob([deflated as BlobPart]).stream().pipeThrough(ds).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
