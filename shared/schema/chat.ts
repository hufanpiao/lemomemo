// ai-chat 的请求和响应（R-492 AI 助手第 1 段；实施计划 3.2；第 2 段联网、看图见下）。前后端共用这一份。A20：字符串里不放汉字。
// • 请求 {messages: [{role, text}]（最后一条是这次的提问，user；连同历史最多 CHAT_MAX_MESSAGES 条、每条 ≤ CHAT_TEXT_MAX 字）, tz, locale, scope: 'main'}（不带时间：服务器只用自己的时钟）：
//   历史只在前端内存里（本次打开 App 期间），每次带最近几轮纯文字；服务器不存对话。主页面不查隐私记、不带令牌。
// • 一轮扣 1 次（同一个门：同意、类型开关、每分钟 6 次、每人每天 50 次）；服务器用只读工具查本人的日程、待办、随手记（不含隐私记）、纪念日。
// • 成功 {answer（纯文本，正文里的 [n] 是 refs 里第 n 条）, refs（引用的条目，按正文里第一次出现的顺序）, searched（查了哪几类）, found（工具一共找到几条）, quota_left}
// • 退路照 ai-summarize 的几种：{consent_required} / {quota_out, quota_left: 0} / {fallback, reason}
// 第 2 段（联网、看图）：
// • 请求加 web: true（客户端画得出网页来源才带；不带的旧客户端，服务器不给模型联网工具，回包也不会有网页来源和 webs 键）；
//   images：这一句带的图（最多 CHAT_IMAGES_MAX 张，客户端先压成 JPEG / PNG / WebP，每张 base64 ≤ CHAT_IMAGE_B64_MAX）。图只在这一句里，不进历史
// 第 3 段（长期记忆，R-495）：请求带 memory: true 才用记忆、才可能回 memories（这一轮新记下的）；不带的旧客户端回包没有这个键
// • refs 里多一种网页来源 {kind: 'web', title, url, site}（和记录一起按正文里第一次出现的顺序编号）；webs：联网一共查到几个网页（没联网不带）
// 记日程待办（负责人 11-24“在 AI 里输入也可以记录日程跟待办”）：请求带 draft: true（客户端画得出确认卡片）才给模型 draft_records，
// 回包才可能有 drafts（要记的几段原话，每段一件事）。服务器不写库：客户端用打字条同一套本机规则把每段拆成日程、待办，出卡片，用户点“记下来”才经 outbox 写
// 新网页带 draft 打到旧函数会被 strictObject 回 400：靠部署顺序保证（publish.ps1 第 6 步、deploy-preview 都先 functions deploy、后 pages deploy，
// 函数失败就停）；ai-chat 不能单独回滚到这之前，网页要一起回（上线与回滚手册第 2 层，memory、voice_ask 同一约定）
// 分类记忆（R-497，11-28）：带 draft 时客户端另带 examples（以前分进自建项目的几条 {title, project}，同 ai-parse，shared/logic/project-examples.ts 挑）；
// 服务器给模型看、模型给每段配一个项目名（只认例子里出现过的名字），回包多一个 draft_projects（和 drafts 一一对应，空串是没配）。
// 不带 examples 的旧客户端回包没有这个键；新网页带 examples 打到旧函数同样靠部署顺序
import { z } from 'zod';
import { AI_PROJECT_LEN, FALLBACK_REASONS } from './ai.ts';
import { chatMemory, MEMORY_TURN_MAX } from './ai-memory.ts';

export const AI_CHAT_FN = 'ai-chat';
/** 一次最多带几条（这一句加历史，约 12 轮） */
export const CHAT_MAX_MESSAGES = 24;
/** 每条最多几个字（UTF-16 单元，和 zod 的 max 同一口径） */
export const CHAT_TEXT_MAX = 800;
/** 回答最长几个字 */
export const CHAT_ANSWER_MAX = 1200;
/** 一次回答最多引用几条 */
export const CHAT_REFS_MAX = 30;
/** 引用条目标题最长几个字 */
export const CHAT_TITLE_MAX = 160;
/** 能查的几类（对话里的引用也只会是这几类） */
export const CHAT_KINDS = ['event', 'todo', 'note', 'anniv'] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];
/** 一句最多带几张图 */
export const CHAT_IMAGES_MAX = 3;
/** 一张图 base64 最长几个字符（约 600 KB 的原始字节；客户端压到长边 1280 以内基本不会超） */
export const CHAT_IMAGE_B64_MAX = 800_000;
/** 图的类型（客户端压缩后只出这三种） */
export const CHAT_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** 联网来源的网址最长几个字符 */
export const CHAT_URL_MAX = 2048;
/** 一轮最多出几段要记的原话（draft_records） */
export const CHAT_DRAFTS_MAX = 5;
/** 每段要记的原话最长几个字（UTF-16 单元） */
export const CHAT_DRAFT_TEXT_MAX = 200;

const msg = z.strictObject({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(CHAT_TEXT_MAX) });
export type ChatMessage = z.infer<typeof msg>;

const chatImage = z.strictObject({
  mime: z.enum(CHAT_IMAGE_MIMES),
  data: z.string().min(1).max(CHAT_IMAGE_B64_MAX).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type ChatImageIn = z.infer<typeof chatImage>;

export const chatReq = z
  .strictObject({
    messages: z.array(msg).min(1).max(CHAT_MAX_MESSAGES),
    tz: z.string().min(1).max(64),
    locale: z.string().max(16).optional(),
    scope: z.literal('main'),
    web: z.boolean().optional(),
    images: z.array(chatImage).min(1).max(CHAT_IMAGES_MAX).optional(),
    memory: z.boolean().optional(),
    /** 客户端画得出“要记成这样吗”的确认卡片（不带的旧客户端：不给 draft_records，回包没有 drafts） */
    draft: z.boolean().optional(),
    /** R-497：以前分进自建项目的几条（只在带 draft 时有用；服务器 normExamples 规整，形状不对的条目丢掉） */
    examples: z.array(z.unknown()).max(200).optional(),
    /** 这一句是语音转写来的（R-495）：答成后退回转写扣的那 1 次 */
    voice_ask: z.literal(true).optional(),
  })
  .refine((r) => r.messages.at(-1)?.role === 'user', { message: 'last_not_user' });
export type ChatReq = z.infer<typeof chatReq>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** 一条引用：前端照这几样画依据列表，点了按 kind、id 打开原条目（日程的项目色前端按 id 从本机库查，服务器不读 events.project） */
export const chatRef = z.strictObject({
  kind: z.enum(CHAT_KINDS),
  id: z.uuid(),
  title: z.string().max(CHAT_TITLE_MAX),
  /** 日程的日子、待办的截止日子、随手记写下那天、纪念日下一次的日子；没有为 null */
  date: day.nullable(),
  /** 日程、待办的时刻 HH:MM；没有为 null */
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  /** 待办做完没有（别的类不带） */
  done: z.boolean().optional(),
});
export type ChatRef = z.infer<typeof chatRef>;

/** 一个网页来源（联网）：url 是服务商给的原样地址（条款：不改链接、不加中间页、不记点了哪个）；site 网站名（认不出为空串） */
export const chatWebRef = z.strictObject({
  kind: z.literal('web'),
  title: z.string().min(1).max(CHAT_TITLE_MAX),
  url: z.string().max(CHAT_URL_MAX).regex(/^https:\/\/\S+$/),
  site: z.string().max(253),
});
export type ChatWebRef = z.infer<typeof chatWebRef>;
export type ChatAnyRef = ChatRef | ChatWebRef;

export const chatOk = z.strictObject({
  answer: z.string().min(1).max(CHAT_ANSWER_MAX),
  refs: z.array(z.union([chatRef, chatWebRef])).max(CHAT_REFS_MAX),
  searched: z.array(z.enum(CHAT_KINDS)).max(CHAT_KINDS.length),
  found: z.number().int().min(0),
  webs: z.number().int().min(1).optional(),
  memories: z.array(chatMemory).min(1).max(MEMORY_TURN_MAX).optional(),
  /** 要记的几段原话（每段一件事，日子时刻照原话的说法）；请求没带 draft 或这一轮没有要记的不带 */
  drafts: z.array(z.string().min(1).max(CHAT_DRAFT_TEXT_MAX)).min(1).max(CHAT_DRAFTS_MAX).optional(),
  /** R-497：和 drafts 一一对应的项目名（照以前怎么分的，空串是没配）；请求没带 examples 或这一轮没有要记的不带。项目名按码点截到 AI_PROJECT_LEN，UTF-16 最多两倍 */
  draft_projects: z.array(z.string().max(AI_PROJECT_LEN * 2)).min(1).max(CHAT_DRAFTS_MAX).optional(),
  // 管理员（private.admins）个人每天不设上限：quota_left 按满额 per_user_daily 回，客户端不会把本机额度记成 0（_shared/ai/gate.ts 第 ⑥ 步）；
  // 是不是管理员前端读 my_ai_usage 的 ai_unlimited（src/platform/ai-usage.ts），回包里不另加键（各 AI 回包都是 strictObject，旧版客户端认不出新键）
  quota_left: z.number().int().min(0),
});
export type ChatOk = z.infer<typeof chatOk>;

export const chatRes = z.union([
  chatOk,
  z.strictObject({ fallback: z.literal(true), reason: z.enum(FALLBACK_REASONS) }),
  z.strictObject({ consent_required: z.literal(true) }),
  z.strictObject({ quota_out: z.literal(true), quota_left: z.literal(0) }),
]);
export type ChatRes = z.infer<typeof chatRes>;

/** 语音提问（R-495）：ai-voice 带请求头 x-want: transcript 时只转文字。成功回这个；别的（没同意、用完、退路、失败）和普通录音同形 */
export const VOICE_WANT_TRANSCRIPT = 'transcript';
export const voiceAskOk = z.strictObject({ transcript: z.string().max(CHAT_TEXT_MAX), quota_left: z.number().int().min(0) });
