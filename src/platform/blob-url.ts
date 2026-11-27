// 图片的 blob: 地址在这里造、在这里撤：造的时候记下“地址 → 原 Blob”，撤的时候一起删
// • 看图页存图要原图字节和真实类型，可 CSP 的 connect-src 不放行 blob:，不能 fetch 自己的地址
// • 地址表（core/blob-urls.ts、vault 的 session）撤地址时默认走 revokeBlobUrl
// • Blob 和地址同生同灭：地址撤了（行删了、退出换账号、上锁）这里也不留，旧账号、上了锁的图不留在内存里
// • 不是这里造的地址，blobOfUrl 回 null；revokeBlobUrl 照样撤
const made = new Map<string, Blob>();

export function makeBlobUrl(b: Blob): string {
  const u = URL.createObjectURL(b);
  made.set(u, b);
  return u;
}

export function revokeBlobUrl(u: string): void {
  made.delete(u);
  URL.revokeObjectURL(u);
}

/** 这个地址背后的原 Blob（地址已撤或不是这里造的回 null） */
export function blobOfUrl(u: string): Blob | null {
  return made.get(u) ?? null;
}
