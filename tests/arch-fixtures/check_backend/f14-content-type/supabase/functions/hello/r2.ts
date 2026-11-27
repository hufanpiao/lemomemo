// F14 样例一：objstore 的 put 没带 contentType（Uint8Array 往 vault-preview 传；注释里的 r2.put(b, k, x) 不算）
interface Obj { put(bucket: string, key: string, body: Uint8Array, opts?: { contentType?: string }): Promise<unknown> }
export async function save(r2: Obj, bytes: Uint8Array): Promise<void> {
  await r2.put('vault-preview', 'a/b.pptx', bytes);
}
