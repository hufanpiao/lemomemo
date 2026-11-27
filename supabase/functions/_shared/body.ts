// 请求体边读边计数（5.11 第 2 点；安全审建议 1）：按字节数，超过上限立刻中断，不只看 Content-Length，也不整段读进内存再比长度。
// ai-voice（音频 600 KB）、ai-parse（16 KB）、claude-intake（32 KB，网关不验 JWT）、invite-signup、invite-admin、account、token-admin 共用。纯函数，只用 Web 标准接口。
// readAll：对象存储取回的正文整段读成字节（不限长，对象写入时已限过；file-check、vault-file、vault 搬家共用）。
// readStreamCapped：对象正文带上限、带中止地读（ai-chat 看随手记的缩略图）；和 readCapped 共用同一个计数循环 collect。

/** 读请求体：超过 max 字节回 'too_large'（已中断读取），没有内容回 'empty' */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | 'too_large' | 'empty'> {
  const declared = Number(req.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > max) {
    await req.body?.cancel().catch(() => {});
    return 'too_large';
  }
  if (!req.body) return 'empty';
  const b = await collect(req.body, max);
  return b !== 'too_large' && b.byteLength === 0 ? 'empty' : b;
}

/**
 * 边读边计数（readCapped、readStreamCapped 共用这一个循环）：超过 max 字节取消读取、回 'too_large'；
 * 带 signal 的，中止时取消读取、抛 signal.reason
 */
async function collect(stream: ReadableStream<Uint8Array>, max: number, signal?: AbortSignal): Promise<Uint8Array | 'too_large'> {
  const reader = stream.getReader();
  const stop = (): void => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', stop, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        stop();
        return 'too_large';
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * 读对象存储取回的正文，带上限和中止（ai-chat 看随手记的图，独立评审第 4 条）：超过 max 字节回 'too_large'（已取消读取）；
 * signal 中止时取消读取、抛 signal.reason（调用方按剩余预算给超时）
 */
export async function readStreamCapped(body: unknown, max: number, signal: AbortSignal): Promise<Uint8Array | 'too_large'> {
  const stream = body instanceof ReadableStream ? (body as ReadableStream<Uint8Array>) : new Response(body as BodyInit).body;
  return stream ? collect(stream, max, signal) : new Uint8Array(0);
}

/** 读 JSON 请求体：超过 max 字节回 'too_large'；空、不是 UTF-8、不是 JSON 回 undefined */
export async function readJsonCapped(req: Request, max: number): Promise<unknown> {
  const b = await readCapped(req, max);
  if (b === 'too_large') return 'too_large';
  if (b === 'empty') return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b));
  } catch {
    return undefined;
  }
}

/** 读 JSON 对象请求体（invite-signup、invite-admin、account、token-admin、claude-intake 共用，安全审查第 2 条）：
 *  超过 max 字节回 'too_large'（已中断读取）；空、不是 UTF-8、不是 JSON、不是对象（数组也不算）回 null */
export async function readJsonObjectCapped(req: Request, max: number): Promise<Record<string, unknown> | 'too_large' | null> {
  const v = await readJsonCapped(req, max);
  if (v === 'too_large') return v;
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 字节的 sha256 十六进制（file-check、vault-file、vault 搬家共用；_shared/vault-files.ts 原样转出） */
export async function sha256Hex(b: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** 读对象存储取回的正文（R2 的 body）整段成字节（file-check、vault-file、vault 搬家共用，评审 9）；不限长度：对象写入时已经限过 */
export async function readAll(body: unknown): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
}
