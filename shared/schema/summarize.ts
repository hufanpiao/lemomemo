// ai-summarize 的请求和响应（架构 5.14 第 4 点、第 6 节 ai-summarize 行；B4b-3）。前后端共用这一份。A20：字符串里不放汉字。
// • 请求 {ids: [{kind, id}]（1～50 条、不重复）, ask（原话，≤ 200 字，给模型当“要总结什么”，可空）, now, tz, locale, scope: 'main'}：
//   主页面只送普通记录的 id、不带令牌；隐私记页面的总结（scope=vault）这一批不做，函数回 400 bad_request。
//   服务器按 id 读本人的日程、待办、随手记（没删、没撤销）；随手记是隐私记的整次拒绝 mixed_scope（不扣次数）；查不到的放进 missing。
//   每条只送标题、时间、正文前 SUMMARY_BODY_MAX 字，总共不超过 SUMMARY_TOTAL_MAX 字，放进 <data>（第 7 节防提示注入）。
// • 成功 {summary（≤ 800 字，纯文本）, cited（送进去的 id，不在里面的丢掉）, missing（查不到的 id）, quota_left}
// • 退路照 ai-parse 的几种（aiResponse 的非成功分支）：{consent_required} / {quota_out, quota_left: 0} / {fallback, reason}；
//   另加 {error: 'mixed_scope'}（HTTP 400）
import { z } from 'zod';
import { FALLBACK_REASONS } from './ai.ts';

export const AI_SUMMARIZE_FN = 'ai-summarize';
export const SUMMARY_KINDS = ['event', 'todo', 'note'] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];
/** 一次最多总结几条 */
export const SUMMARY_MAX_ITEMS = 50;
/** 每条正文最多送几个字 */
export const SUMMARY_BODY_MAX = 500;
/** 一次总共最多送几个字（标题、时间、正文合计） */
export const SUMMARY_TOTAL_MAX = 20_000;
/** 总结最长几个字 */
export const SUMMARY_TEXT_MAX = 800;
/** 原话最长几个字 */
export const SUMMARY_ASK_MAX = 200;

const ref = z.strictObject({ kind: z.enum(SUMMARY_KINDS), id: z.uuid() });
export type SummaryRef = z.infer<typeof ref>;

export const summarizeReq = z
  .strictObject({
    ids: z.array(ref).min(1).max(SUMMARY_MAX_ITEMS),
    ask: z.string().max(SUMMARY_ASK_MAX * 4).optional(),
    now: z.number().int().positive(),
    tz: z.string().min(1).max(64),
    locale: z.string().max(16).optional(),
    scope: z.literal('main'),
  })
  .refine((r) => new Set(r.ids.map((x) => x.id)).size === r.ids.length, { message: 'duplicate_ids' });
export type SummarizeReq = z.infer<typeof summarizeReq>;

/** 模型的输出：{summary, cited}（cited 由服务器过滤成送进去的 id） */
export const summarizeRaw = z.strictObject({ summary: z.string(), cited: z.array(z.string()).max(SUMMARY_MAX_ITEMS * 2) });

export const summarizeOk = z.strictObject({
  summary: z.string().min(1).max(SUMMARY_TEXT_MAX),
  cited: z.array(z.uuid()).max(SUMMARY_MAX_ITEMS),
  missing: z.array(z.uuid()).max(SUMMARY_MAX_ITEMS),
  quota_left: z.number().int().min(0),
});
export type SummarizeOk = z.infer<typeof summarizeOk>;

export const summarizeRes = z.union([
  summarizeOk,
  z.strictObject({ fallback: z.literal(true), reason: z.enum(FALLBACK_REASONS) }),
  z.strictObject({ consent_required: z.literal(true) }),
  z.strictObject({ quota_out: z.literal(true), quota_left: z.literal(0) }),
]);
export type SummarizeRes = z.infer<typeof summarizeRes>;
