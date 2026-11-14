// note-search 函数的请求和响应（架构 5.13 第 6 点“查询流程”、第 6 节 note-search 行；B4b-2）。前后端共用这一份。
// • 请求 {q（≤ 100 字）, scope: 'main'}：主页面按意思找。scope=vault（隐私记页面，D-16）这一批不做，函数回 400 bad_request
// • 成功 {hits: [{kind, id, score}]}：只回 id 和分数，不回内容；kind 是 note_vectors 的五种
// • 只按关键词（客户端顶上写“现在只按关键词找”）：{fallback: 原因}；原因四种和线框 sFind 第二张对上：
//   consent 没同意 AI（或 ai.enabled 关着）；quota 今天按意思找的次数用完、谷歌额度用完、每分钟太快；timeout 嵌入超时（3 秒）或谷歌出错。
//   offline（没网）只在客户端判，服务器不回
import { z } from 'zod';

export const NOTE_SEARCH_FN = 'note-search';
/** 查询最多几个字（架构第 6 节 note-search 行） */
export const SEARCH_Q_MAX = 100;
/** 最多回几条（架构 5.13 第 6 点） */
export const SEARCH_HITS_MAX = 30;
export const SEM_KINDS = ['note', 'image', 'file', 'event', 'todo'] as const;
export const FALLBACK_REASONS = ['offline', 'consent', 'quota', 'timeout'] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export const noteSearchReq = z.object({ q: z.string().trim().min(1).max(SEARCH_Q_MAX), scope: z.literal('main') }).strict();
export type NoteSearchReq = z.infer<typeof noteSearchReq>;

export const noteSearchRes = z.union([
  z.object({ hits: z.array(z.object({ kind: z.enum(SEM_KINDS), id: z.uuid(), score: z.number() })).max(SEARCH_HITS_MAX) }),
  z.object({ fallback: z.enum(['consent', 'quota', 'timeout']) }),
]);
export type NoteSearchRes = z.infer<typeof noteSearchRes>;
