// ai-memory 的请求和响应（R-495 AI 助手第 3 段“记住的事”）。前后端共用这一份。A20：字符串里不放汉字。
// • list：本人没删的记忆，新的在前，一次一页（MEMORY_PAGE），带 cursor 接着往后读；delete：单条删（留 1 天等撤销）；undo：撤销这一条；clear：全部真删（方案页“找不回来”）
// • 只有文字，和 AI 服务商无关：换服务商记忆照样在
import { z } from 'zod';

export const AI_MEMORY_FN = 'ai-memory';
/** 一条最多几个字（迁移 20261123130000 的 check 同一个数） */
export const MEMORY_TEXT_MAX = 200;
/** 每人最多几条 */
export const MEMORIES_MAX = 5_000;
/** 一轮对话最多记几条 */
export const MEMORY_TURN_MAX = 2;
/** “记住的事”页一次拉几条 */
export const MEMORY_PAGE = 50;
/** 翻页游标：updated_at.id */
export const memoryCursor = z.string().regex(/^\d{1,16}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const memoryReq = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), cursor: memoryCursor.optional() }),
  z.strictObject({ action: z.literal('delete'), id: z.uuid() }),
  /** replaced：撤销一次改写时带被替换的旧行，服务器把新行换回旧行 */
  z.strictObject({ action: z.literal('undo'), id: z.uuid(), replaced: z.uuid().optional() }),
  z.strictObject({ action: z.literal('clear') }),
]);
export type MemoryReq = z.infer<typeof memoryReq>;

export const memoryItem = z.strictObject({
  id: z.uuid(),
  text: z.string().min(1).max(MEMORY_TEXT_MAX),
  /** 记下的时刻（毫秒） */
  at: z.number().int().min(0),
});
export type MemoryItem = z.infer<typeof memoryItem>;

export const memoryListRes = z.strictObject({
  items: z.array(memoryItem).max(MEMORY_PAGE),
  next: memoryCursor.nullable(),
  /** 本人没删的一共几条（“全部清空”要写清楚） */
  total: z.number().int().min(0),
});
export type MemoryListRes = z.infer<typeof memoryListRes>;
export const memoryDoneRes = z.strictObject({ ok: z.boolean() });

/** ai-chat 回包里这一轮新记下的；replaced：这条改写了哪一条（提示条写“已改写：旧 → 新”，撤销换回去） */
export const chatMemory = z.strictObject({
  id: z.uuid(),
  text: z.string().min(1).max(MEMORY_TEXT_MAX),
  replaced: z.strictObject({ id: z.uuid(), text: z.string().min(1).max(MEMORY_TEXT_MAX) }).optional(),
});
export type ChatMemory = z.infer<typeof chatMemory>;
