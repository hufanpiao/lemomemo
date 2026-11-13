// F14 对照：写明 contentType 的都不报；表的 update 不是上传
// deno-lint-ignore no-explicit-any
export async function ok(r2: any, admin: any, bytes: Uint8Array): Promise<void> {
  await r2.put('images', 'a/b.webp', bytes, { contentType: 'image/webp', ifNoneMatch: true });
  await admin.storage.from('backups').upload('a.json.gz', bytes, { contentType: 'application/gzip' });
  const contentType = 'image/webp';
  await admin.storage.from('backups').update('b.webp', bytes, { contentType });
  await admin.from('notes').update({ title: 'x' }).eq('id', '1');
}
