// raw deflate 解压（file-sniff.ts 的 InflateRaw）：客户端（判类型、查压缩包）和服务器 file-check 共用这一份（架构 5.13 第 2 点）。
// 只用 WHATWG 标准的 DecompressionStream('deflate-raw')（浏览器、Deno、Node 24 都有），不引第三方库；
// 边解边计数，超过 maxBytes 立刻取消、回 null（InflateRaw 的约定）；数据坏了抛错，由调用方当 inflate_failed。
// shared 的 lib 里没有 DOM 类型：照 link.ts 只声明用到的部分（不经 globalThis 取，F7）
import type { InflateRaw } from './file-sniff.ts';

interface Chunks {
  read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>;
  cancel(): Promise<void>;
}
declare const DecompressionStream: new (format: 'deflate-raw') => {
  readonly readable: { getReader(): Chunks };
  readonly writable: { getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> } };
};

export const inflateRaw: InflateRaw = async (deflated, maxBytes) => {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  // 写端的错误（数据坏了、读端取消）都会在 read() 上再抛一次，这里吞掉免得成为未处理的 rejection
  w.write(deflated).catch(() => undefined);
  w.close().catch(() => undefined);
  const reader = ds.readable.getReader();
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
