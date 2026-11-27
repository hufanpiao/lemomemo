// ai-chat：AI 助手对话一轮（R-492 第 1 段；实施计划 3.2；第 2 段联网、看图见 3.3 和本文件头下半段）。纯逻辑，依赖由 index.ts 注入，
// Vitest 直接测（tests/edge/ai-chat.test.ts）；不 import _shared/gen（CI unit 不生成 gen）、不 import npm 包。
// 顺序（每一步不过就直接回，后面的都不做）：
//   ① 只收 POST → ② requireActiveUser（JWT）→ ③ 请求体 ≤ MAX_BODY（边读边计数，超了 413），过 shared/schema/chat.ts 的 chatReq、时区认得、
//      带的图每张都解得开（解不开不静默丢，整句 400），否则 400 bad_request；
//   ④ 共用的门（_shared/ai/gate.ts：同意、类型开关和 AI 助手自己的开关 chat（wire.ts 的 chatGateDeps）、按用途选的服务商、每分钟 6 次、
//      谷歌额度、每人每天 50 次和全项目预扣）：**一轮扣 1 次**；这一句带了图而对话服务商不收图 → 退回、{fallback, error}；
//   ⑤ 工具循环：最多 CHAT_MAX_ROUNDS 次模型往返；整轮预算 CHAT_TURN_BUDGET_MS 从请求进来那一刻算（handle 开头取 start），比前端 30 秒先收；
//      每次往返超时取 CHAT_CALL_TIMEOUT_MS 和预算剩下的里小的；最后一次 toolChoice none（不许再调工具，直接作答）；
//      第 2 次往返起、每次联网各多扣 1 个全项目次数（takeExtra，用户这边仍只算 1 次；发出去就不退）。多扣的上限是 global_daily 的 CHAT_EXTRA_SHARE（70%，
//      同 ai-media 的让路做法）：全项目用到七成以后对话不再多扣、这一轮按 quota 停下，剩下三成留给记账、录音、总结和每轮对话的第一次（独立评审第 2 条）；
//      工具只按一张表（tools.ts 的 TOOL_TABLE）：给模型哪些看门算出的类型和第 2 段两项（toolsFor），模型调来的经 parseCall 校验，
//      没给的（关掉的类型、这一轮没有的联网 / 看图）回 {error: 'unknown_tool'}，再按 tool 一处 switch 分派（runTool）；
//      每次往返最多处理 CALLS_MAX 个调用，多的回 {error: 'too_many'}；每次查库前看预算，剩下的不够 QUERY_MS 加一次往返就回 {error: 'budget'}、不查；
//      查库经 deps.query（store.ts，fn_ai，语句超时 QUERY_MS），出错交回 {error: 'store'}，不中断；
//   ⑥ 校验回答（answerOf）：去控制字符，[n] 改写成 refs 里的位置（cites.ts 的 relinkCites，模型编的号丢掉），截到 CHAT_ANSWER_MAX（cutCited 去半截角标），
//      截掉的那段里才有的角标，对应的 refs 一并去掉（只留正文里还剩的 [m]）；为空算 invalid；回包再过一遍 chatOk（deps.checkOk），没过算 invalid；
//   ⑦ 回 {answer, refs, searched, found, webs?, quota_left}（found 只数记录，webs 是联网查到的网页数，没联网不带）。
//   失败一律回 {fallback, reason}，原因是显式的 Stop.kind（一处 switch，finish）；结算经 settleFailure：
//   • 这一轮发给服务商的调用（模型往返加联网）不超过 1 次：按 R-356 退回个人那 1 次和第一次的全项目预扣；
//   • 已经多次往返或联网过（sent > 1）才失败：不退（前面的调用真用掉了，退了就能白用，独立评审第 1 条）；
//   • 服务商回 quota 的照样写 exhausted_until；全项目多扣扣不上（global_out）不是谷歌回的 429，不写。
// 时钟只用服务器的（deps.now），请求体里不带时间。
// 历史：前端每次带最近几轮纯文字；助手那几条里旧的 [n] 去掉（旧编号对不上这一轮的结果）。服务器不存对话（实施计划第二节“对话历史不落库”）。
// 日志只经 deps.log 记码和条数（往返次数、工具名、条数、图的张数、异常类型名），不记原话、记录内容、搜索词、网址、图、回答（A23）。
//
// 第 2 段（负责人 11-22：联网带来源；“发图问 + 看随手记里的图”；编辑、生成图片不做）：
// • 联网（请求带 web: true、deps.web() 有能单独联网的服务商才给模型 web_search 工具）：模型调 web_search(q) →
//   ① 全项目多扣 1 次（takeExtra；联网后模型还要多一次往返去读搜到的网页，发出去就不退；也顺带给整个项目每天联网的总量封顶）；扣不上回 {error: 'quota'}，
//      个人每天和这一轮的联网次数都不计（独立评审第 13 条：先扣能不能搜）；
//   ② 每人每天 WEB_DAILY 次（web:<uid>:<太平洋日期>，经 take_rate；管理员不设上限、照样计数），用完回 {error: 'web_quota'}、退回 ① 扣的那 1 次，模型照常用本地数据作答；
//      两步都过了才算这一轮联网一次（webCalls、sent）；
//   ③ WebSearcher.search 调一次（按管理员定的联网搜索方式：11-24 起默认 DeepSeek + Brave + Naver 同时搜、都挂退 Tavily，或单用一家、不行退备用，
//      _shared/ai/websearch-mix.ts 的 webFor；里面搜了几家都只算这一次），
//      搜到的网页（标题、网站）和摘要进 Registry（和记录共用 [n] 编号），由对话模型自己读、自己概括；失败回 {error: 'web_failed'}。
//      日志：每一家失败各一行“chat web try=<家> <码> st=<状态>”，通了记实际搜成的那家（by=，退到第二家时是第二家）。
//      撞了搜索接口的额度也只回 web_failed，**不写 exhausted_until**（那是 AI 服务商的停用，搜索接口不归它管）。
//   一轮最多联网 WEB_CALLS_MAX 次（3）、每人每天 WEB_DAILY 次（50）。用户这边仍只算 1 次。
// • 用户这一句带的图（请求 images，base64）：解码后随这一句交给模型（只在这一句，不进历史、不存、不记日志）。
// • 看随手记里的图（服务商 caps.imageIn、随手记这一类开着才给 look_note_images）：n 只认这一轮送出去的随手记编号（Registry.noteAt），
//   图只经视图 private.ai_chat_notes 连过去取（隐私记的图取不到），**只读缩略图**（store 只列有缩略图的），每张边读边计数、超过 NOTE_THUMB_MAX_BYTES 不送，
//   每张的超时按整轮预算剩下的给（留一次往返作答），超时就停、已读到的照送；一次最多 NOTE_IMAGES_MAX 张、一轮合计最多 TURN_IMAGES_MAX 张；
//   读图不扣次数（图是下一次往返一起送的，那次往返本来就算在全项目里）。
// 记日程待办（负责人 11-24“在 AI 里输入也可以记录日程跟待办”；请求带 draft: true、日程或待办开着才给 draft_records）：
// • 模型调 draft_records(items)：只排上要记的几段原话（同 remember：看过工具结果以后不收，防资料、网页里的内容变成要记的事；一轮最多 DRAFTS_MAX 段），
//   **服务器不写库**；答成了随回包交回 drafts，客户端用打字条同一套本机规则拆成日程、待办出确认卡片，用户点“记下来”才经 outbox 写（离线队列、提醒照旧）；
// • 第 1 回合只有成功的 remember、draft_records 时，紧接着那次往返不多扣全项目次数（freeNext）；日志只记段数（drafts=），不记原话。
import type { AuthResult } from '../_shared/auth-result.ts';
import { readJsonCapped } from '../_shared/body.ts';
import { json } from '../_shared/http.ts';
import { cutCited, relinkCites } from '../_shared/ai/cites.ts';
import { ADMIN_DAILY_CAP, aiGate, clientReason, pacificDate, settleFailure, type GateDeps, type GateGo } from '../_shared/ai/gate.ts';
import { CHAT_CALL_TIMEOUT_MS, CHAT_MAX_ROUNDS, CHAT_TURN_BUDGET_MS, TASK_PARAMS } from '../_shared/ai/params.ts';
import { cleanExamples, EXAMPLES_MAX, PROJECT_LEN, sanitize, wallOf } from '../_shared/ai/parse-core.ts';
import { checkMemory, MEMORY_STMT_MS, OVERLAP_MIN, overlapOf, MEMORY_TURN_MAX, memoryBlock, promptMemories, type MemoryRow, type MemorySaved, type MemoryWrite } from '../_shared/memories.ts';
import { CHAT_V6, CHAT_V6_DRAFT, CHAT_V6_HISTORY, CHAT_V6_IMAGES, CHAT_V6_MEMORY, CHAT_V6_MEMORY_TOOL, CHAT_V6_USER_IMAGES, CHAT_V6_WEB } from '../_shared/ai/prompts/chat.v6.ts';
import {
  aiFailCode, errNameOf, type ChatImage, type ChatMsg, type ChatProvider, type ChatResult, type ChatTurn, type ToolResult, type WebSearcher, type WebSearchResult,
} from '../_shared/ai/provider.ts';
import { QUOTA_WINDOW_S } from '../_shared/ai/store.ts';
import { VOICE_ASK_FREE, voiceIssuedKey, voiceUsedKey } from '../_shared/ai/voice-ask.ts';
import {
  CALLS_MAX, DRAFTS_MAX, kindOf, KINDS, NOTE_IMAGES_MAX, parseCall, projectKeyOf, QUERY_MS, Registry, toolsFor, TURN_IMAGES_MAX,
  type Call, type ChatKind, type ChatRow, type Extras, type Ref, type ToolQuery,
} from './tools.ts';

// 上限和 shared/schema/chat.ts 的同名常量相等（本文件不引 shared；tests/edge/ai-chat.test.ts 钉住）
export const ANSWER_MAX = 1200;
export const REFS_MAX = 30;
export const IMAGES_MAX = 3;
export const IMAGE_B64_MAX = 800_000;
/** 请求体上限：文字 64 KB（24 条 × 800 个 UTF-16 单元，汉字按 3 字节约 58 KB）加图 3 × 800 KB 的 base64，再留 4 KB */
export const MAX_BODY = 64 * 1024 + IMAGES_MAX * IMAGE_B64_MAX + 4 * 1024;
export const SRC = 'ai-chat';
/** 单次调用最少给几毫秒（预算快用完时不再发，直接按超时算） */
export const MIN_CALL_MS = 1_500;
/** 每人每天最多联网几次（负责人 11-23 弹窗定 50，原来实施计划代定 20；管理员不设上限） */
export const WEB_DAILY = 50;
/** 一轮里最多联网几次（负责人 11-23 弹窗定 3，原来 2） */
export const WEB_CALLS_MAX = 3;
/** 一次联网最多等多久（还要留一次往返作答） */
export const WEB_TIMEOUT_MS = 8_000;
/** 对话多扣的全项目次数最多用到 global_daily 的几成（到了就不再多扣，剩下的留给别的 AI 功能；同 ai-media 的 GLOBAL_SHARE） */
export const CHAT_EXTRA_SHARE = 0.7;
/** 随手记里的图只读缩略图（客户端压到长边 384、≤ 128 KB），超过这个字节数的不送 */
export const NOTE_THUMB_MAX_BYTES = 256 * 1024;
/** 缩略图是 webp（_shared/gen/logic/files/media-path.ts 的拼法） */
const NOTE_IMAGE_MIME = 'image/webp';

/** 请求体只写这里用到的形状，不引 _shared/gen 下的 schema；index.ts 接 chatReq 时 deno check 按这里核对 */
export type Req = {
  messages: ChatMsg[];
  tz: string;
  locale?: string | undefined;
  scope: 'main';
  web?: boolean | undefined;
  images?: { mime: string; data: string }[] | undefined;
  /** R-495：客户端画得出“AI 记住了”才带；不带的旧客户端不读记忆、不给 remember、回包没有 memories */
  memory?: boolean | undefined;
  /** 11-24 记日程待办：客户端画得出确认卡片才带；不带的旧客户端不给 draft_records、回包没有 drafts */
  draft?: boolean | undefined;
  /** R-497：以前分进自建项目的几条（带 draft 才用；deps.normExamples 规整） */
  examples?: unknown[] | undefined;
  /** R-495：这一句是语音转写来的，答成后消费一次 ai-voice 发的额度（转写那 1 次退回） */
  voice_ask?: true | undefined;
};

export interface Deps extends GateDeps<ChatProvider> {
  authenticate(req: Request): Promise<AuthResult>;
  /** shared/schema/chat.ts 的 chatReq（不合格为 null） */
  parse(v: unknown): Req | null;
  /** shared/schema/chat.ts 的 chatOk：成功回包发出去前再核一遍 */
  checkOk(v: unknown): boolean;
  isValidTz(tz: string): boolean;
  /** shared/schema/ai.ts 的 normLocale */
  normLocale(v: unknown): 'zh' | 'ko';
  /** shared/schema/ai.ts 的 stripCtlText */
  stripCtl(s: string): string;
  /** shared/schema/ai.ts 的 normExamples（R-497） */
  normExamples(v: unknown): { title: string; project: string }[];
  /** 跑一个已校验的查询（store.ts 的 runQuery，经 withAiUser）；读库出错抛 */
  query(userId: string, q: ToolQuery, tz: string): Promise<ChatRow[]>;
  /** 联网用哪家（wire.ts 的 chatWebSearcher：Brave / Tavily 按管理员选的先后）；两家都没密钥为 null（不给 web_search 工具） */
  web(): Promise<WebSearcher | null>;
  /** 某条随手记里有缩略图的图（store.ts 的 noteImages，只经视图连过去，隐私记的取不到）；读库出错抛 */
  noteImages(userId: string, noteId: string, limit: number): Promise<{ id: string; noteId: string }[]>;
  /** 从 images 桶读一张缩略图：边读边计数，超过 maxBytes 或不在为 null；超过 timeoutMs 中止、抛 TimeoutError；别的出错抛 */
  readThumb(userId: string, noteId: string, id: string, maxBytes: number, timeoutMs: number): Promise<Uint8Array | null>;
  /** 长期记忆（R-495，_shared/memories.ts，经 fn_ai）：最近的几条加版本；按这一问找相关的（两步分开，相关失败只用最近）；存这一轮记下的，版本变了不存。出错抛 */
  memories: {
    recent(userId: string, ms: number): Promise<{ rows: MemoryRow[]; ver: string }>;
    related(userId: string, said: string, ms: number): Promise<MemoryRow[]>;
    save(userId: string, items: readonly MemoryWrite[], now: number, ver: string): Promise<MemorySaved[]>;
  };
  /** 今天 ai-voice 发了几次语音提问额度（private.counters 该键合计）。出错抛 */
  voiceIssued(key: string): Promise<number>;
}

/** 填 chat.v6 的占位符（只放今天、现在、时区、语言和这一轮给了的第 2 段工具说明）；now 用服务器时钟 */
export function chatPrompt(
  now: number, tz: string, locale: 'zh' | 'ko', extras: Extras = { web: false, images: false }, userImages = false, memories: readonly MemoryRow[] = [],
  history: readonly { t: string; p: string }[] = [],
): string {
  const w = wallOf(now, tz);
  const extra = (extras.web ? CHAT_V6_WEB : '') + (extras.images ? CHAT_V6_IMAGES : '') + (extras.memory === true ? CHAT_V6_MEMORY_TOOL : '')
    + (extras.draft === true ? CHAT_V6_DRAFT : '') + (userImages ? CHAT_V6_USER_IMAGES : '');
  const map: Record<string, string> = { TODAY: w.today, WEEKDAY: w.weekday, NOW: w.time, TZ: tz, LANG: locale === 'ko' ? '韩文' : '中文', EXTRA: extra };
  const base = CHAT_V6.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (Object.hasOwn(map, k) ? map[k] : undefined) ?? m);
  // 记忆最后才拼上去：里面的文字不再过占位符替换（函数式 replace，$ 也不会被当替换语法）
  const withMem = memories.length === 0 ? base : base + CHAT_V6_MEMORY.replace('{{BLOCK}}', () => memoryBlock(memories));
  // R-497：给了 draft_records、又有以前分进自建项目的例子才拼（parse-core.ts 的 cleanExamples 已转义 </history>、</data>）；没有就和以前一字不差
  return extras.draft === true && history.length > 0 ? withMem + CHAT_V6_HISTORY.replace('{{BLOCK}}', () => `<history>${JSON.stringify(history)}</history>`) : withMem;
}

/** 历史：助手那几条去掉旧的 [n]（旧编号对不上这一轮）；都去掉首尾空白，空的丢掉 */
export function historyOf(messages: readonly ChatMsg[]): ChatMsg[] {
  return messages
    .map((m) => ({ role: m.role, text: (m.role === 'assistant' ? m.text.replace(/\[\d{1,3}\]/g, '') : m.text).trim() }))
    .filter((m) => m.text !== '');
}

/** 请求里的图（base64）→ 字节；有一张解不开就回 null（整句 400，不静默丢掉一张接着问） */
export function imagesOf(list: Req['images']): ChatImage[] | null {
  const out: ChatImage[] = [];
  for (const im of list ?? []) {
    try {
      const bin = atob(im.data);
      out.push({ mimeType: im.mime, data: Uint8Array.from(bin, (c) => c.charCodeAt(0)) });
    } catch {
      return null;
    }
  }
  return out;
}

/** 联网计数键（附录 A 三段写法；ai_quota_take 只收 ai: 开头的键，所以经 take_rate 计，同 ai-media 的 media:） */
export const webKey = (userId: string, ms: number): string => `web:${userId}:${pacificDate(ms)}`;

type Fail = Extract<ChatResult, { ok: false }>;

/** 这一轮为什么没答成（finish 一处 switch） */
export type Stop =
  /** 服务商回了失败（超时、出错、额度）或调用抛错 */
  | { kind: 'provider'; fail: Fail }
  /** 整轮预算不够再发一次 */
  | { kind: 'budget' }
  /** 多扣的全项目次数扣不上（到了 CHAT_EXTRA_SHARE） */
  | { kind: 'global_out' }
  /** 多扣时计数出错（err 是异常类型名） */
  | { kind: 'count_failed'; err: string }
  /** 到了往返上限还在要工具 */
  | { kind: 'tool_loop' }
  /** 回答去完控制字符、截完是空的 */
  | { kind: 'empty' }
  /** 回包没过 chatOk */
  | { kind: 'bad_output' }
  /** 这一句带了图而对话服务商不收图 */
  | { kind: 'image_unsupported' };

type Loop = { ok: true; text: string; rounds: number } | { ok: false; stop: Stop };

/** 一个工具调用的结果：成功交回 result（看图另带 images）和一段只含码和条数的日志；失败交回 {error} */
type Out = { result: Record<string, unknown>; images?: ChatImage[]; log: string } | { error: string };

const toolName = (n: string): string => (/^[a-z_]{1,30}$/.test(n) ? n : 'other');

interface Turn {
  deps: Deps;
  gate: GateGo<ChatProvider>;
  uid: string;
  body: Req;
  reg: Registry;
  start: number;
  web: WebSearcher | null;
  today: string;
  lang: 'zh' | 'ko';
  /** 这一轮真发给服务商的调用（模型往返加联网）有几次：> 1 的失败不退次数 */
  sent: number;
  /** 第一批工具调用已跑完：之后模型看过工具结果，不再收 remember、draft_records（防网页、资料里的内容写进记忆、变成要记的事） */
  sawTools: boolean;
  /** 这一轮要出确认卡片的几段原话（draft_records；答成了才随回包交回，服务器不写库） */
  drafts: string[];
  /** R-497：和 drafts 一一对应的项目名（不在 allowed 里的记成空串）；history 是给模型看的例子（cleanExamples 转义过）；
   *  allowed：例子里项目名的比对口径（tools.ts 的 projectKeyOf）→ 客户端发来的原名，空的就是这一轮没给例子、回包不带 draft_projects */
  draftProjects: string[];
  history: readonly { t: string; p: string }[];
  allowed: ReadonlyMap<string, string>;
  /** 这一轮已经联网几次、看了几张随手记的图 */
  webCalls: number;
  seenImages: number;
  /** 查了哪几类 */
  searched: Set<ChatKind>;
  /** 长期记忆（R-495）：本人一共几条（null：这一轮不用记忆，不给 remember）、给模型看的那几条（m 是下标 + 1，replaces 只认它们）、这一轮要记的（答完才存） */
  memVer: string | null;
  memShown: MemoryRow[];
  memPending: MemoryWrite[];
}

const left = (t: Turn): number => CHAT_TURN_BUDGET_MS - (t.deps.now() - t.start);

/** 全项目多扣 1 次（第 2 次往返起、每次联网）：上限是 global_daily 的 CHAT_EXTRA_SHARE */
async function takeExtra(t: Turn): Promise<'ok' | 'out' | { failed: string }> {
  try {
    const cap = Math.floor(((await t.deps.config()).global_daily ?? 0) * CHAT_EXTRA_SHARE);
    return (await t.deps.quota.take(t.gate.globalKey, cap)) !== null ? 'ok' : 'out';
  } catch (e) {
    return { failed: errNameOf(e) };
  }
}

/** web_search：见文件头第 2 段 ①～③ */
async function webSearch(t: Turn, query: string): Promise<Out> {
  if (!t.web) return { error: 'unknown_tool' };
  if (t.webCalls >= WEB_CALLS_MAX) return { error: 'too_many' };
  if (left(t) < MIN_CALL_MS * 3) return { error: 'budget' };   // 剩下的不够联网一次再答一次
  // 先扣全项目那 1 次（能不能搜），扣上了才计个人每天和这一轮的联网次数：扣不上不计（独立评审第 13 条）
  const take = await takeExtra(t);
  if (take !== 'ok') {
    if (take !== 'out') t.deps.log(`chat extra_take_failed err=${take.failed}`);
    return { error: take === 'out' ? 'quota' : 'store' };
  }
  let allowed: boolean | 'failed';
  try {
    // 管理员不设上限、照样计数（同门第 ⑥ 步的 dailyCap）
    allowed = await t.deps.rate(webKey(t.uid, t.deps.now()), t.gate.unlimited ? ADMIN_DAILY_CAP : WEB_DAILY, QUOTA_WINDOW_S);
  } catch (e) {
    t.deps.log(`chat web rate_failed err=${errNameOf(e)}`);
    allowed = 'failed';
  }
  if (allowed !== true) {
    // 个人今天联网用完（或计不上）：没搜，刚扣的全项目那 1 次退回
    await t.deps.quota.refund(t.gate.globalKey).catch((e: unknown) => t.deps.log(`chat web refund_failed err=${errNameOf(e)}`));
    return { error: allowed === 'failed' ? 'store' : 'web_quota' };
  }
  t.webCalls += 1;
  t.sent += 1;
  // 每一家失败各记一行（撞了额度也不写 exhausted_until，见文件头第 2 段 ③）
  const onFail = (by: string, f: Extract<WebSearchResult, { ok: false }>): void =>
    t.deps.log(`chat web try=${by} ${aiFailCode(f)} st=${f.status ?? '-'}${f.errName ? ` err=${f.errName}` : ''}`);
  let r: WebSearchResult;
  try {
    r = await t.web.search({ query, lang: t.lang, today: t.today, timeoutMs: Math.min(WEB_TIMEOUT_MS, left(t) - MIN_CALL_MS), onFail });
  } catch (e) {
    const f = { ok: false as const, reason: 'error' as const, errName: errNameOf(e) };
    onFail(t.web.name, f);
    r = f;
  }
  if (!r.ok) return { error: 'web_failed' };
  // 加工后的搜索词只记码（语言、换没换日期、要不要最近的、字数），不记搜索词本身（A23）
  const s = r.sent;
  const sent = s ? ` lang=${s.lang} dated=${s.dated ? 1 : 0} fresh=${s.fresh ? 1 : 0} chars=${s.chars}` : '';
  return { result: t.reg.takeWeb(r.sources), log: `by=${r.by} sources=${r.sources.length}${sent}` };
}

/** look_note_images：n 是这一轮送出去的随手记编号；只读缩略图，每张按剩余预算给超时 */
async function lookImages(t: Turn, n: number): Promise<Out> {
  const noteId = t.reg.noteAt(n);
  if (noteId === null) return { error: 'not_a_note' };
  const room = Math.min(NOTE_IMAGES_MAX, TURN_IMAGES_MAX - t.seenImages);
  if (room <= 0) return { error: 'too_many' };
  if (left(t) < QUERY_MS + MIN_CALL_MS) return { error: 'budget' };
  let list: { id: string; noteId: string }[];
  try {
    list = await t.deps.noteImages(t.uid, noteId, room);
  } catch (e) {
    t.deps.log(`chat images list_failed err=${errNameOf(e)}`);
    return { error: 'store' };
  }
  const images: ChatImage[] = [];
  for (const im of list) {
    const ms = left(t) - MIN_CALL_MS;   // 留一次往返作答
    if (ms <= 0) break;
    try {
      const bytes = await t.deps.readThumb(t.uid, im.noteId, im.id, NOTE_THUMB_MAX_BYTES, ms);
      if (bytes) images.push({ mimeType: NOTE_IMAGE_MIME, data: bytes });
    } catch (e) {
      // 超时、读失败：停下，已读到的照送
      t.deps.log(`chat images read_failed err=${errNameOf(e)}`);
      if (images.length === 0) return { error: 'store' };
      break;
    }
  }
  if (images.length === 0) return { error: 'no_images' };
  t.seenImages += images.length;
  return { result: { n, images: images.length, note: '图按顺序附在这些工具结果后面' }, images, log: `images=${images.length}` };
}

/** 查库的四个工具 */
async function runQuery(t: Turn, q: ToolQuery, kind: ChatKind): Promise<Out> {
  if (left(t) < QUERY_MS + MIN_CALL_MS) return { error: 'budget' };   // 剩下的不够查一次再答一次
  t.searched.add(kind);
  try {
    const rows = await t.deps.query(t.uid, q, t.body.tz);
    const out = t.reg.take(rows);
    return { result: out, log: `rows=${rows.length} sent=${out.records.length}` };
  } catch (e) {
    t.deps.log(`chat tool name=${q.tool} store_failed err=${errNameOf(e)}`);
    return { error: 'store' };
  }
}

/** remember（R-495）：校验只认用户这一句原话；这里只排上，整轮答成了才存（没答成的一轮不留记忆） */
function remember(t: Turn, c: Extract<Call, { tool: 'remember' }>): Out {
  if (t.memVer === null) return { error: 'unknown_tool' };
  if (t.sawTools) return { error: 'memory_late' };
  if (t.memPending.length >= MEMORY_TURN_MAX) return { error: 'too_many' };
  const said = t.body.messages.at(-1)?.text ?? '';
  const v = checkMemory(c.text, said);
  if ('error' in v) return { error: `memory_${v.error}` };
  let replaces: string | null = null;
  if (c.replaces !== null) {
    const at = c.replaces - 1;
    replaces = t.memShown.find((_, i) => i === at)?.id ?? null;
    if (replaces === null || t.memPending.some((p) => p.replaces === replaces)) return { error: 'bad_replaces' };
  }
  // 判重和上限只在 saveMemories 的锁里做一次
  t.memPending.push({ text: v.text, norm: v.norm, replaces });
  return { result: { ok: true }, log: `memory=queued replaces=${replaces === null ? 0 : 1}` };
}

/** R-497：例子里的项目名按给模型看的样子（sanitize）取比对口径，对回客户端发来的原名；同一口径只留第一个 */
function allowedOf(examples: readonly { project: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of examples.slice(0, EXAMPLES_MAX)) {
    const k = projectKeyOf(sanitize(e.project, PROJECT_LEN));
    if (k !== '' && !m.has(k)) m.set(k, e.project);
  }
  return m;
}

/**
 * draft_records（11-24）：只排上要出卡片的原话（看过工具结果以后不收，同 remember），整轮答成了才随回包交回；不写库、不扣次数。
 * 每段同 remember 核对是不是用户这一句说的（memories.ts 的 overlapOf：二元组覆盖不到 OVERLAP_MIN 的丢掉，前几轮、工具结果里的事过不了）
 */
function draftRecords(t: Turn, items: readonly string[], projects: readonly string[]): Out {
  if (t.sawTools) return { error: 'draft_late' };
  const room = DRAFTS_MAX - t.drafts.length;
  if (room <= 0) return { error: 'too_many' };
  const said = t.body.messages.at(-1)?.text ?? '';
  // R-497：项目名和原话成对走；只认给模型看的例子里出现过的名字（模型编的、<data> 里被注入的都不认），交回客户端发来的原名（不是转义过的）
  const mine: { x: string; p: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const x = items[i] ?? '';
    const p = projects[i] ?? '';
    if (overlapOf(x, said) >= OVERLAP_MIN) mine.push({ x, p: t.allowed.get(p) ?? '' });
  }
  const dropped = items.length - mine.length;
  if (mine.length === 0) return { error: 'draft_not_said' };
  const took = mine.slice(0, room);
  t.drafts.push(...took.map((d) => d.x));
  t.draftProjects.push(...took.map((d) => d.p));
  const proj = took.filter((d) => d.p !== '').length;
  return { result: { ok: true, cards: took.length, note: '界面会给每件事出确认卡片，用户点了才记下' }, log: `drafts=${took.length} dropped=${dropped}${t.allowed.size > 0 ? ` proj=${proj}` : ''}` };
}

/** 一个已校验、这一轮给了的调用 → 结果（按 tool 一处 switch） */
async function runTool(t: Turn, c: Call): Promise<Out> {
  switch (c.tool) {
    case 'remember':
      return remember(t, c);
    case 'draft_records':
      return draftRecords(t, c.items, c.projects);
    case 'web_search':
      return webSearch(t, c.query);
    case 'look_note_images':
      return lookImages(t, c.n);
    default: {
      const kind = kindOf(c.tool);
      return kind === undefined ? { error: 'unknown_tool' } : runQuery(t, c, kind);
    }
  }
}

/** 模型的一个工具调用：校验参数 → 这一轮给了没有 → 分派 */
async function dispatch(t: Turn, name: string, args: Readonly<Record<string, unknown>>, offered: ReadonlySet<string>): Promise<Out> {
  const c = parseCall(name, args, t.today);
  if ('error' in c) return c;
  // 这一轮没给这个工具（关掉的类型、没联网、不收图），模型硬调也不做
  if (!offered.has(c.tool)) return { error: 'unknown_tool' };
  return runTool(t, c);
}

/** 工具循环（见文件头 ⑤） */
async function loop(t: Turn, userImages: readonly ChatImage[]): Promise<Loop> {
  const { deps, gate, body } = t;
  const kinds = new Set<string>(gate.features);
  const tools = toolsFor(KINDS.filter((k) => kinds.has(k)), { web: t.web !== null, images: gate.provider.caps.imageIn, memory: t.memVer !== null, draft: body.draft === true });
  const offered = new Set(tools.map((x) => x.name));
  const system = chatPrompt(
    t.start, body.tz, t.lang,
    { web: offered.has('web_search'), images: offered.has('look_note_images'), memory: offered.has('remember'), draft: offered.has('draft_records') },
    userImages.length > 0, t.memShown, t.history,
  );
  const messages = historyOf(body.messages);
  let resume: { turn: ChatTurn; results: readonly ToolResult[] } | undefined;
  // 第 1 回合有且只有成功的 remember、draft_records（都不查资料、不出服务器）：紧接着那一次不多扣全项目次数（只免这一次）。
  // t.sent 每次真调服务商都加，发出去超过 1 次的失败不退，不受这个免扣影响
  let freeNext = false;
  for (let round = 1; round <= CHAT_MAX_ROUNDS; round += 1) {
    if (left(t) < MIN_CALL_MS) return { ok: false, stop: { kind: 'budget' } };
    if (round > 1 && !gate.own && !freeNext) {   // 自己的密钥（R-494）不占全项目次数
      const take = await takeExtra(t);
      if (take === 'out') return { ok: false, stop: { kind: 'global_out' } };
      if (take !== 'ok') return { ok: false, stop: { kind: 'count_failed', err: take.failed } };
    }
    t.sent += 1;
    freeNext = false;
    let r: ChatResult;
    try {
      r = await gate.provider.chat({
        system, messages, tools, toolChoice: round === CHAT_MAX_ROUNDS ? 'none' : 'auto', resume,
        ...(userImages.length > 0 ? { images: userImages } : {}),
        params: TASK_PARAMS.chat, timeoutMs: Math.min(CHAT_CALL_TIMEOUT_MS, left(t)),
      });
    } catch (e) {
      r = { ok: false, reason: 'error', errName: errNameOf(e) };
    }
    if (!r.ok) return { ok: false, stop: { kind: 'provider', fail: r } };
    if (r.toolCalls.length === 0) return { ok: true, text: r.text, rounds: round };
    if (round === CHAT_MAX_ROUNDS) break;   // 不许调了还在调：按输出不合格算
    const results: ToolResult[] = [];
    let allLocal = round === 1;
    for (const [i, c] of r.toolCalls.entries()) {
      const out: Out = i >= CALLS_MAX ? { error: 'too_many' } : await dispatch(t, c.name, c.args, offered);
      if ((c.name !== 'remember' && c.name !== 'draft_records') || 'error' in out) allLocal = false;
      if ('error' in out) {
        deps.log(`chat tool name=${toolName(c.name)} bad=${out.error}`);
        results.push({ id: c.id, name: c.name, result: { error: out.error } });
      } else {
        deps.log(`chat tool name=${toolName(c.name)} ${out.log}`);
        results.push({ id: c.id, name: c.name, result: out.result, ...(out.images ? { images: out.images } : {}) });
      }
    }
    t.sawTools = true;
    freeNext = allLocal;
    resume = { turn: r.turn, results };
  }
  return { ok: false, stop: { kind: 'tool_loop' } };
}

/** 回答：先把 [n] 改写成 refs 里的位置，再截到上限（cutCited 去半截角标，超过 REFS_MAX 的角标去掉）；
 *  keys 只留正文里还剩的角标对应的那几条（relinkCites 按第一次出现编号，截完留下的一定是 1..k） */
export function answerOf(text: string, order: readonly string[]): { answer: string; keys: string[] } {
  const linked = relinkCites(text, [], order);
  const answer = cutCited(linked.summary, ANSWER_MAX).replace(/\[(\d+)\]/g, (m, k: string) => (Number(k) <= REFS_MAX ? m : '')).trim();
  const kept = Math.max(0, ...[...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return { answer, keys: linked.cited.slice(0, kept) };
}

/** 没答成：记日志、结算（发出去超过 1 次的不退）、回 {fallback, reason}。各原因只在这一处 */
async function finish(t: Pick<Turn, 'deps' | 'gate' | 'uid' | 'sent'>, stop: Stop): Promise<Response> {
  const { deps } = t;
  const refund = t.sent <= 1;
  if (!refund) deps.log(`chat no_refund sent=${t.sent}`);
  const settle = (f: Parameters<typeof settleFailure>[4]): Promise<void> => settleFailure(deps, t.gate, t.uid, SRC, f, refund);
  const fallback = (reason: string): Response => json(200, { fallback: true, reason });
  switch (stop.kind) {
    case 'provider':
      deps.log(`${aiFailCode(stop.fail)}${stop.fail.errName ? ` err=${stop.fail.errName}` : ''}`);
      await settle(stop.fail);
      return fallback(clientReason(stop.fail));   // 每分钟限额回 error，客户端不记“今天用完”
    case 'budget':
      deps.log('ai_timeout budget');
      await settle({ reason: 'timeout' });
      return fallback('timeout');
    case 'global_out':
      // 不是谷歌回的 429：不写 exhausted_until，给客户端说 quota
      deps.log('global_quota_out');
      await settle({ reason: 'error' });
      return fallback('quota');
    case 'count_failed':
      deps.log(`chat extra_take_failed err=${stop.err}`);
      await settle({ reason: 'error' });
      return fallback('error');
    case 'tool_loop':
      // 不是输出格式不对（不写 schema 进 logs），只记码
      deps.log('ai_invalid tool_loop');
      await settle({ reason: 'invalid' });
      return fallback('invalid');
    case 'empty':
      deps.log('ai_invalid empty');
      await settle({ reason: 'invalid', invalid_reasons: ['empty'] });
      return fallback('invalid');
    case 'bad_output':
      deps.log('ai_invalid schema');
      await settle({ reason: 'invalid', invalid_reasons: ['schema'] });
      return fallback('invalid');
    case 'image_unsupported':
      deps.log('chat image_unsupported');
      await settle({ reason: 'error' });
      return fallback('error');
  }
}

/** 读记忆两步共用的总预算；剩下不够这么多毫秒就不找相关的 */
const MEMORY_READ_MS = MEMORY_STMT_MS;
const MEMORY_RELATED_MIN_MS = 200;

/** 开轮读记忆：最近的读不出来这一轮不用记忆（也不给 remember）；相关的失败或没时间了，只用最近的 */
async function readMemories(deps: Deps, uid: string, said: string): Promise<{ shown: MemoryRow[]; ver: string } | null> {
  const t0 = deps.now();
  let first: { rows: MemoryRow[]; ver: string };
  try {
    first = await deps.memories.recent(uid, MEMORY_READ_MS);
  } catch (e) {
    deps.log(`chat memory list_failed err=${errNameOf(e)}`);
    return null;
  }
  const rest = MEMORY_READ_MS - (deps.now() - t0);
  let related: MemoryRow[] = [];
  if (rest >= MEMORY_RELATED_MIN_MS) {
    try {
      related = await deps.memories.related(uid, said, rest);
    } catch (e) {
      deps.log(`chat memory related_failed err=${errNameOf(e)}`);
    }
  }
  return { shown: promptMemories(first.rows, related), ver: first.ver };
}

/** 语音提问答成了：消费一次 ai-voice 发的额度，转写那 1 次个人次数退回；回退了几次（0 或 1） */
async function settleVoiceAsk(t: Pick<Turn, 'deps' | 'gate' | 'uid'>): Promise<number> {
  const { deps, gate, uid } = t;
  if (gate.own) return 0;
  const now = deps.now();
  try {
    const issued = await deps.voiceIssued(voiceIssuedKey(uid, now));
    if (issued <= 0 || !(await deps.rate(voiceUsedKey(uid, now), Math.min(issued, VOICE_ASK_FREE), QUOTA_WINDOW_S))) return 0;
    await deps.quota.refund(gate.userKey);
    return gate.unlimited ? 0 : 1;
  } catch (e) {
    deps.log(`chat voice_ask_refund_failed err=${errNameOf(e)}`);
    return 0;
  }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const start = deps.now();   // 整轮预算从请求进来那一刻算（含验身份、读请求体、过门）
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = await deps.authenticate(req);
  if (!auth.ok) return auth.response;
  const uid = auth.user.userId;

  const raw = await readJsonCapped(req, MAX_BODY);
  if (raw === 'too_large') return json(413, { error: 'too_large' });
  const body = deps.parse(raw);
  if (!body || !deps.isValidTz(body.tz)) return json(400, { error: 'bad_request' });
  const userImages = imagesOf(body.images);
  if (userImages === null) return json(400, { error: 'bad_request' });

  const gate = await aiGate(deps, uid, req.headers.get('x-app-version') ?? '');
  if (gate.stop) return json(gate.status, gate.body);

  let web: WebSearcher | null = null;
  if (body.web === true) {
    try {
      web = await deps.web();
    } catch (e) {
      deps.log(`chat web_config_failed err=${errNameOf(e)}`);
    }
  }
  // 记忆读不出来不影响回答：这一轮不用记忆、也不给 remember（不然模型看不到旧的，会记重）
  const mem = body.memory === true ? await readMemories(deps, uid, body.messages.at(-1)?.text ?? '') : null;
  // R-497：带 draft 才看例子（不带的旧客户端、没有自建项目的：没有 <history>，回包不带 draft_projects）
  const examples = body.draft === true ? deps.normExamples(body.examples) : [];
  const history = cleanExamples(examples);
  const t: Turn = {
    deps, gate, uid, body, reg: new Registry(), start, web, today: wallOf(start, body.tz).today, lang: deps.normLocale(body.locale),
    sent: 0, sawTools: false, drafts: [], draftProjects: [], history, allowed: allowedOf(examples), webCalls: 0, seenImages: 0, searched: new Set(),
    memVer: mem?.ver ?? null, memShown: mem?.shown ?? [], memPending: [],
  };
  // 带图问而对话服务商不收图：不调，退回这一次
  if (userImages.length > 0 && !gate.provider.caps.imageIn) return finish(t, { kind: 'image_unsupported' });
  if (userImages.length > 0) deps.log(`chat images=${userImages.length}`);
  const out = await loop(t, userImages);
  if (!out.ok) return finish(t, out.stop);
  const { reg } = t;
  const { answer, keys } = answerOf(deps.stripCtl(out.text).trim(), reg.order);
  if (answer === '') return finish(t, { kind: 'empty' });
  const refs = keys.map((k) => reg.ref(k)).filter((r): r is Ref => r !== undefined);
  const res = {
    answer, refs, searched: [...t.searched], found: reg.records, ...(reg.webs > 0 ? { webs: reg.webs } : {}),
    ...(t.drafts.length > 0 ? { drafts: t.drafts } : {}), ...(t.drafts.length > 0 && t.allowed.size > 0 ? { draft_projects: t.draftProjects } : {}), quota_left: gate.quotaLeft,
  };
  if (!deps.checkOk(res)) return finish(t, { kind: 'bad_output' });
  const back = body.voice_ask === true ? await settleVoiceAsk(t) : 0;
  const done = back > 0 ? { ...res, quota_left: res.quota_left + back } : res;
  // 答成了才存这一轮要记的；请求已中止（用户关了抽屉）不存；存不上不影响回答（回包不带，界面就不说“记住了”）
  let memories: MemorySaved[] = [];
  if (t.memPending.length > 0 && t.memVer !== null && !req.signal.aborted) {
    try {
      memories = await deps.memories.save(uid, t.memPending, deps.now(), t.memVer);
    } catch (e) {
      deps.log(`chat memory save_failed err=${errNameOf(e)}`);
    }
  }
  deps.log(`chat ok rounds=${out.rounds} found=${reg.records} webs=${reg.webs} cited=${refs.length} remembered=${memories.length} drafts=${t.drafts.length} voice_back=${back}`);
  return json(200, memories.length > 0 ? { ...done, memories } : done);
}
