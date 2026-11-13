// 请求体边读边计数（5.11 第 2 点；安全审建议 1）：按字节数，超过上限立刻中断，不只看 Content-Length，也不整段读进内存再比长度。
// ai-voice（音频 600 KB）、ai-parse（16 KB）、claude-intake（32 KB，网关不验 JWT）共用。纯函数，只用 Web 标准接口。

/** 读请求体：超过 max 字节回 'too_large'（已中断读取），没有内容回 'empty' */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | 'too_large' | 'empty'> {
  const declared = Number(req.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > max) {
    await req.body?.cancel().catch(() => {});
    return 'too_large';
  }
  if (!req.body) return 'empty';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return 'too_large';
    }
    chunks.push(value);
  }
  if (total === 0) return 'empty';
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
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
