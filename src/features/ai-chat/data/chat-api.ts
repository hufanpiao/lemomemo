// 调 ai-chat（契约 shared/schema/chat.ts）：主页面只送纯文字的对话（这一句加最近几轮），scope 'main'，不带隐私记令牌
// • 历史：只带用户的话和 AI 的回答正文（出错的那几条不带），从后往前取到 CHAT_MAX_MESSAGES 条，每条按字截到 CHAT_TEXT_MAX 个 UTF-16 单元
//   （shared/logic/short.ts 的 cutGraphemes：不把 emoji、代理对截成半个）；最前面不是用户的话就丢掉
// • 不带时间：服务器只用自己的时钟
// • 客户端整轮等 CHAT_CLIENT_TIMEOUT_MS（服务器一轮最多 25 秒，多留 5 秒）；
//   服务器单次调模型的是 _shared/ai/params.ts 的 CHAT_CALL_TIMEOUT_MS，两个名字别混
// • 一律带 web: true（这一版画得出网页来源；服务器才给模型联网工具）；images：这一句带的图（已经压好、base64，只在这一句，不进历史）
// • chatTakesImages：输入条画不画“＋”——问 ai-provider 的 mine，对话那家收不收图（OpenAI、Claude 不收）
// • 记日程待办：draft（画得出确认卡片才带）→ 回包可能有 drafts（要记的几段原话），交给 hooks/useChat.ts 拆成卡片
// • 回：成功 {answer, refs（记录和网页来源）, searched, found, webs（联网查到几个网页，没联网为 0）, drafts, quotaLeft}；不成：consent（没同意 / 没开 AI）/ quota（今天用完）/ failed（超时、断网、读不懂、服务器退路）
// 纯 TS：不准 import React
import { AI_CHAT_FN, CHAT_MAX_MESSAGES, CHAT_TEXT_MAX, chatRes, type ChatAnyRef, type ChatImageIn, type ChatKind, type ChatMessage } from '../../../../shared/schema/chat.ts';
import type { ChatMemory } from '../../../../shared/schema/ai-memory.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { AI_PROVIDER_FN, mineRes } from '../../../../shared/schema/ai-provider.ts';
import { cutGraphemes } from '../../../../shared/logic/short.ts';
import { callFn, defaultFnDeps, type FnDeps } from '../../../platform/fn-call.ts';

export const CHAT_CLIENT_TIMEOUT_MS = 30_000;

export type ChatFail = 'consent' | 'quota' | 'failed';
export interface ChatAnswer {
  answer: string;
  refs: ChatAnyRef[];
  searched: ChatKind[];
  found: number;
  webs: number;
  /** 这一轮新记下的（回答下面的“AI 记住了”） */
  memories: ChatMemory[];
  /** 要出确认卡片的几段原话（请求带了 draft 才可能有） */
  drafts: string[];
  quotaLeft: number;
}
export type ChatResult = ({ ok: true } & ChatAnswer) | { ok: false; reason: ChatFail; code: string };

export interface ChatCall {
  messages: readonly ChatMessage[];
  tz: Tz;
  locale: string;
  images?: readonly ChatImageIn[] | undefined;
  /** 这一句是语音转写来的：答成后退回转写扣的那 1 次 */
  voiceAsk?: boolean | undefined;
  /** 画得出确认卡片（plus 登记了 ChatRecorder）：带 draft: true，服务器才给模型 draft_records */
  draft?: boolean | undefined;
}

/** 送出去的对话：从后往前取，最多 CHAT_MAX_MESSAGES 条，每条截字；开头必须是用户的话 */
export function trimHistory(msgs: readonly ChatMessage[]): ChatMessage[] {
  const out = msgs.slice(-CHAT_MAX_MESSAGES).map((m) => ({ role: m.role, text: cutGraphemes(m.text, CHAT_TEXT_MAX) }));
  while (out.length > 0 && out[0]?.role !== 'user') out.shift();
  return out;
}

/** 读“能不能收图”等多久（只是决定画不画“＋”，等不到就不画） */
export const IMAGES_CHECK_TIMEOUT_MS = 10_000;

/**
 * 对话现在用的那家收不收图：问 ai-provider 的 mine（契约 shared/schema/ai-provider.ts，回包带 images）。
 * 读不到、读不懂一律当不收（宁可不画“＋”，也不让人选了图发出去才被退回）
 */
export async function chatTakesImages(signal: AbortSignal, d: FnDeps = defaultFnDeps()): Promise<boolean> {
  const r = await callFn(AI_PROVIDER_FN, { action: 'mine' }, signal, IMAGES_CHECK_TIMEOUT_MS, d);
  if (!r.ok || r.status < 200 || r.status >= 300) return false;
  const p = mineRes.safeParse(r.body);
  return p.success && p.data.images;
}

export async function askChat(req: ChatCall, signal: AbortSignal, d: FnDeps = defaultFnDeps()): Promise<ChatResult> {
  const imgs = req.images && req.images.length > 0 ? { images: [...req.images] } : {};
  const body = { messages: trimHistory(req.messages), tz: req.tz, locale: req.locale, scope: 'main' as const, web: true, memory: true, ...(req.draft === true ? { draft: true } : {}), ...imgs, ...(req.voiceAsk === true ? { voice_ask: true as const } : {}) };
  const r = await callFn(AI_CHAT_FN, body, signal, CHAT_CLIENT_TIMEOUT_MS, d);
  if (!r.ok) return { ok: false, reason: 'failed', code: r.code };
  if (r.status < 200 || r.status >= 300) return { ok: false, reason: 'failed', code: String((r.body as { error?: unknown } | null)?.error ?? r.status) };
  const p = chatRes.safeParse(r.body);
  if (!p.success) return { ok: false, reason: 'failed', code: 'bad_response' };
  const v = p.data;
  if ('answer' in v) return { ok: true, answer: v.answer, refs: v.refs, searched: v.searched, found: v.found, webs: v.webs ?? 0, memories: v.memories ?? [], drafts: v.drafts ?? [], quotaLeft: v.quota_left };
  if ('consent_required' in v) return { ok: false, reason: 'consent', code: 'consent_required' };
  if ('quota_out' in v) return { ok: false, reason: 'quota', code: 'quota_out' };
  return { ok: false, reason: v.reason === 'quota' ? 'quota' : 'failed', code: v.reason };
}
