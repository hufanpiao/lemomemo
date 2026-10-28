// /files 上传的请求体处理（架构 14.2 第 11 点、3.3 G“R2 起”；15.4 S-B0 ③）：
// 先读前 12 字节查 webp 文件头（不对就不碰存储），再边读边计数：多于 Content-Length 立即中断（too_large），少了也算失败。
// Cloudflare 上用 FixedLengthStream 把计过数的流直接交给 R2（不整个读进内存；R2 的 PutObject 要知道长度）；
// 测试环境没有 FixedLengthStream 时读进内存再交（同样计数，超了在读的时候就断）。

export interface UploadState {
  /** 实际字节多于声明的 Content-Length */
  overflow: boolean;
  /** 实际字节少于声明的 Content-Length */
  short: boolean;
}

export type Prepared =
  | { ok: true; body: ReadableStream<Uint8Array> | Uint8Array; state: UploadState }
  | { ok: false; status: number; code: string };

export type FixedLength = (n: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

/** RIFF????WEBP */
export function isWebpHeader(b: Uint8Array): boolean {
  return (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  );
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function prepareUpload(
  src: ReadableStream<Uint8Array>,
  declared: number,
  opts: { webp: boolean; fixedLength?: FixedLength | undefined },
): Promise<Prepared> {
  const reader = src.getReader();
  const head: Uint8Array[] = [];
  let count = 0;
  const state: UploadState = { overflow: false, short: false };

  // 1. 先读够 12 字节（webp 才需要）
  if (opts.webp) {
    while (count < 12) {
      const { done, value } = await reader.read();
      if (done) break;
      head.push(value);
      count += value.length;
      if (count > declared) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413, code: 'too_large' };
      }
    }
    if (!isWebpHeader(concat(head, count))) {
      await reader.cancel().catch(() => {});
      return { ok: false, status: 415, code: 'bad_type' };
    }
  }

  // 2. 其余部分边读边计数
  const counted = new ReadableStream<Uint8Array>({
    start(c) {
      for (const h of head) c.enqueue(h);
    },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) {
        if (count !== declared) {
          state.short = true;
          c.error(new Error('upload_short'));
        } else {
          c.close();
        }
        return;
      }
      count += value.length;
      if (count > declared) {
        state.overflow = true;
        await reader.cancel().catch(() => {});
        c.error(new Error('upload_too_large'));
        return;
      }
      c.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  if (opts.fixedLength) {
    const fixed = opts.fixedLength(declared);
    void counted.pipeTo(fixed.writable).catch(() => {});
    return { ok: true, body: fixed.readable, state };
  }

  // 没有 FixedLengthStream：读进内存（超了在读的时候就断）
  const chunks: Uint8Array[] = [];
  const r2 = counted.getReader();
  try {
    for (;;) {
      const { done, value } = await r2.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    if (state.overflow) return { ok: false, status: 413, code: 'too_large' };
    return { ok: false, status: 400, code: 'bad_request' };
  }
  return { ok: true, body: concat(chunks, count), state };
}
