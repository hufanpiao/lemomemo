// 字节的 SHA-256（小写十六进制）：crypto.subtle 只能写在 src/platform/（A13）。附件判型准备、预览前核对字节用
export async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}
