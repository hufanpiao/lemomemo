// “先写行再传字节”的共用小件（B4 插图 S3 起；B4b-1 附件同一套）：时间有序的 id、行在 outbox 里的情况。
// 插图（features/notes/data/note-images.ts）和附件（features/attachments/data/attach-uploader.ts）都等这一行上了服务器再 PUT 对象
//   （files_authorize 只许已有这一行的路径上传，架构 5.13 第 2 点 ⑥、第四轮架构 L3）。
// 纯 TS：不准 import React（A1）

/** 时间有序的 UUID v7（同一条随手记里的图、附件按 id 排就是插入的先后） */
export function uuidv7(now: number, rnd: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = rnd(16);
  let t = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = 0x70 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 这一行在 outbox 里的情况：pending 还在排、failed 进了发送失败区（带码）、confirmed 上了服务器、gone 行没了 */
export type RowSync = { s: 'pending' } | { s: 'failed'; code: string | null } | { s: 'confirmed' } | { s: 'gone' };

export interface QueueItem {
  rec: string;
  state: 'pending' | 'inflight' | 'failed';
  error: string | null;
}

/** table 这一行（id）在 outbox 里的情况；rowExists：本机集合里还有没有这一行 */
export function rowSyncOf(items: readonly QueueItem[], table: string, id: string, rowExists: boolean): RowSync {
  const mine = items.filter((x) => x.rec === `${table}:${id}`);
  const failed = mine.find((x) => x.state === 'failed');
  if (failed) return { s: 'failed', code: failed.error };
  if (mine.length) return { s: 'pending' };
  return rowExists ? { s: 'confirmed' } : { s: 'gone' };
}
