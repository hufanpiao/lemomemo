// F14 样例二：supabase-js storage 的 upload 没带 contentType（Uint8Array 往 backups 传）
// deno-lint-ignore no-explicit-any
export async function backup(admin: any, bytes: Uint8Array): Promise<void> {
  await admin.storage.from('backups').upload('2026-11-13/u/notes.json.gz', bytes, { upsert: false });
}
