// AI 服务商接口（架构第 7 节；R-494 起四家都有适配器：gemini.ts、openai.ts（OpenAI、DeepSeek）、claude.ts，选哪家见 router.ts）。
// 纯类型和几个小常量，不 import 任何东西，单测、评测（tests/ai/run.ts）和函数共用。

/** 送给模型的一段内容：文字，或内联的音频（mimeType 取请求的 Content-Type，去掉参数以后，5.11 第 2 点） */
export type AiPart = { text: string } | { inlineData: { mimeType: string; data: Uint8Array } };

export interface AiRequest {
  /** 系统提示（提示词全文，已填好今天、时区等） */
  system: string;
  /** 用户内容：<data> 包起来的原话，或音频 */
  parts: AiPart[];
  /** Gemini responseSchema（OpenAPI 子集） */
  schema: Record<string, unknown>;
  /** 生成参数（只准传 _shared/ai/params.ts 里的）；thinkingLevel 现在只有探测页写（11-11，Gemini 3 的思考档位；正式 ai-voice 等实测后再加） */
  params: Readonly<{ temperature: number; candidateCount: number; thinkingLevel?: 'minimal' }>;
  /** 超时（毫秒），到点中止、不重试 */
  timeoutMs: number;
}

/**
 * 撞的是哪种额度（11-13 ai-eval #2：每 5 秒一句撞了每分钟限额，被当成“当天用完”整遍停下）：
 * day：每天的（太平洋午夜重置）；minute：每分钟的（等 retryDelay 就好）；unknown：回复体里认不出，调用方按 day 保守处理。
 */
export type QuotaKind = 'day' | 'minute' | 'unknown';

/**
 * ok：拿到了 JSON（json 是解析后的值，raw 是模型原样返回的文字，评测两份都存）；
 * quota：服务商说额度用完（Gemini 429 RESOURCE_EXHAUSTED），调用方写 ai_state.exhausted_until；
 *   quotaKind、retryMs（服务商建议的重试等待，毫秒，没有或不合法为 null）只在 quota 时带，只是固定词和数字；
 * timeout：到点中止；error：其他一切（HTTP 错、返回不是 JSON、被安全过滤拦下等）。
 * 失败时只带 HTTP 状态码（不带服务商返回的正文，15.3 第 6 条）；errName 是异常类型名，或 HTTP 失败时谷歌 error.status 的固定名字（gemini.ts 的 rpcCodeOf，如 UNAVAILABLE）。
 */
export type AiResult =
  | { ok: true; json: unknown; raw: string }
  | { ok: false; reason: 'quota' | 'timeout' | 'error'; status?: number; errName?: string; quotaKind?: QuotaKind; retryMs?: number | null };

/** 额度类型的日志片段 kind=day|minute|unknown（固定词，不带服务商原文）；没带类型记 unknown */
export const quotaKindField = (k: QuotaKind | undefined): string => `kind=${k ?? 'unknown'}`;

/**
 * 失败的日志码：ai_<原因>；额度用完另带一段 quotaKindField（空格隔开）。ai-parse、ai-voice、ai-classify、claude-intake 共用；
 * ai-voice 写 logs 表时按空格拆成 code（ai_quota）和 fields 里的 kind=…
 */
export const aiFailCode = (r: { reason: string; quotaKind?: QuotaKind | undefined }): string =>
  r.reason === 'quota' ? `ai_quota ${quotaKindField(r.quotaKind)}` : `ai_${r.reason}`;

/** 异常的类型名（TypeError、AbortError…）：只认 1～40 个英文字母，别的一律 'unknown'（不带 message，免得把正文带进日志） */
export const errNameOf = (e: unknown): string => {
  const n = e instanceof Error ? e.name : '';
  return /^[A-Za-z]{1,40}$/.test(n) ? n : 'unknown';
};

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generate(req: AiRequest): Promise<AiResult>;
}

// ===== 多轮对话和工具调用（R-492 AI 助手第 1 段；实施计划第三节 3.1）=====
// 和服务商无关的中立结构：历史只存纯文字，不存任何服务商专有的字段，换服务商时历史照样能用。
// 同一轮里的工具往返由适配器自己处理：服务商要原样回传的东西（Gemini 的 thoughtSignature、functionCall 的 id）
// 放在不透明的 ChatTurn.state 里，只在这一轮内交回给同一个适配器，调用方不读、不存、不跨轮。
// generate() 照旧不动（parse、voice、classify、media、summarize 一行不改）。

/** 服务商名字（app_config.ai 的 provider、tasks.<用途>.provider 只认这几个；和 shared/schema/ai-provider.ts 的 AI_PROVIDERS、迁移的 private.ai_provider_ok 一致，测试钉住） */
export const PROVIDER_NAMES = ['gemini', 'openai', 'claude', 'deepseek'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * 交给 AI 服务商的用途（负责人 11-22：按用途各选一家服务商）：chat 对话整理（含“＋”整理、总结、分类、Claude 记事）、stt 录音转文字、embed 向量。
 * 某个用途没在 app_config.ai.tasks 里配，就沿用顶层的 provider / model（router.ts 的 routeFor）。
 * 联网搜索（11-23 起）不归 AI 服务商：用的是搜索接口 Brave / Tavily，配在 app_config.ai.web（websearch.ts、router.ts 的 readAiConfig）
 */
export const AI_TASKS = ['chat', 'stt', 'embed'] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** 能力声明：router 按用途挑服务商时查它（例如 Claude 不收音频、没有向量，录音和向量就不能给它） */
export interface ProviderCaps {
  /** 支持工具调用（函数调用） */
  tools: boolean;
  /** 收图片（对话里发的图、随手记里存的图；第 2 段） */
  imageIn: boolean;
  /** 收音频 */
  audioIn: boolean;
  /** 算向量 */
  embed: boolean;
}

/**
 * 各家能力（一张表，各适配器的 caps 就取这里的；ai-provider 的 mine 按它告诉前端对话能不能发图）。
 * Gemini 收图、收音频、算向量；DeepSeek 收图（负责人 11-27 选“接上”，openai.ts 按官方 image_url 格式发图）；OpenAI、Claude 只接了文字
 */
export const PROVIDER_CAPS: Readonly<Record<ProviderName, ProviderCaps>> = Object.freeze({
  gemini: Object.freeze({ tools: true, imageIn: true, audioIn: true, embed: true }),
  openai: Object.freeze({ tools: true, imageIn: false, audioIn: false, embed: false }),
  claude: Object.freeze({ tools: true, imageIn: false, audioIn: false, embed: false }),
  deepseek: Object.freeze({ tools: true, imageIn: true, audioIn: false, embed: false }),
});

/** 按名字取这家的能力（写成 switch：check_backend F7 不许用变量当方括号里的键） */
export function capsOf(p: ProviderName): ProviderCaps {
  switch (p) {
    case 'gemini':
      return PROVIDER_CAPS.gemini;
    case 'openai':
      return PROVIDER_CAPS.openai;
    case 'claude':
      return PROVIDER_CAPS.claude;
    case 'deepseek':
      return PROVIDER_CAPS.deepseek;
  }
}

/** 历史里的一条：只有纯文字 */
export interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
}

/** 送给模型看的一张图（对话里用户发的、随手记里存的；第 2 段）。字节只在这一次请求里，不存、不进日志 */
export interface ChatImage {
  mimeType: string;
  data: Uint8Array;
}

/** 工具说明：parameters 是 JSON Schema 子集（type 用小写 object / string / integer / boolean / array，只用 properties、required、enum、items、description） */
export interface ToolDecl {
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}

/** 模型要调的一个工具（id 由适配器给，交回结果时原样带上；服务商没给 id 的由适配器自己编） */
export interface ToolCall {
  id: string;
  name: string;
  args: Readonly<Record<string, unknown>>;
}

/** 交回给模型的一个工具结果（result 是可以 JSON 序列化的值）；images：随这个结果一起给模型看的图（看随手记的图，第 2 段） */
export interface ToolResult {
  id: string;
  name: string;
  result: unknown;
  images?: readonly ChatImage[] | undefined;
}

/** 同一轮里上一次调用留下的不透明状态（只有产生它的适配器认得） */
export interface ChatTurn {
  readonly provider: string;
  readonly state: unknown;
}

export interface ChatRequest {
  system: string;
  /** 历史加这一句（最后一条是 user） */
  messages: readonly ChatMsg[];
  tools: readonly ToolDecl[];
  /** auto：模型自己决定调不调工具；none：这次不许再调、直接作答（一轮的往返到了上限时用；工具说明照旧带上，前面的往返才对得上） */
  toolChoice: 'auto' | 'none';
  /** 用户这一句带的图（接在最后一条 user 后面；只在这一句里，不进历史；第 2 段） */
  images?: readonly ChatImage[] | undefined;
  /** 这一轮里接着上一次：上一次的 turn 加这次交回的工具结果；第一次不带 */
  resume?: { turn: ChatTurn; results: readonly ToolResult[] } | undefined;
  params: Readonly<{ temperature: number; candidateCount: number }>;
  timeoutMs: number;
}

/**
 * ok：text 是模型这次给的文字（要调工具时可能为空），toolCalls 非空表示还要调工具，turn 下一次原样交回；
 * 失败沿用 AiResult 的 quota / timeout / error（含 quotaKind、retryMs、status、errName）
 */
export type ChatResult =
  | { ok: true; text: string; toolCalls: ToolCall[]; turn: ChatTurn }
  | Extract<AiResult, { ok: false }>;

/** 能对话的服务商（GeminiProvider 同时实现 AIProvider 和它） */
export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  readonly caps: ProviderCaps;
  chat(req: ChatRequest): Promise<ChatResult>;
}

// ===== 联网搜索（R-492 第 2 段；负责人 11-23 弹窗：不用谷歌搜索接地，改接 Brave Search API 和 Tavily 两家，见 websearch.ts）=====
// 对话模型拿到自定义工具 web_search(query)，要查时服务器调一次搜索接口（search），把搜到的网页（标题、网址、摘要）当工具结果交回，
// 由“对话和整理”那家模型自己读、自己概括，回答里用 [n] 标出依据的网页（前端画成来源链接）。
// 不用谷歌搜索接地：条款要求同时原样展示谷歌的 Search Suggestions、不许改写结果（负责人 11-23 选了换别家）。

/**
 * 对话里引用条目（记录、网页来源）的标题、网页来源网址的上限：后端唯一出处（适配器截来源、ai-chat/tools.ts 送模型和给前端都用这几个）。
 * TITLE_MAX、URL_MAX 和 shared/schema/chat.ts 的 CHAT_TITLE_MAX、CHAT_URL_MAX 相等（本目录不引 shared；tests/edge/ai-chat.test.ts 钉住）
 */
export const TITLE_MAX = 160;
export const URL_MAX = 2048;

/**
 * 联网查到的一个网页：url 原样（搜索接口给的）；title 网页标题；site 网站名（主机名）；
 * text 这一页的摘要（去了标记的纯文字，没截字，没有就是空串；只在 ai-chat/tools.ts 的 takeWeb 按 FINDING_MAX 截一次）
 */
export interface WebSource {
  title: string;
  url: string;
  site: string;
  text: string;
  /** 搜索接口给的网页日期（原样字符串，没有就不带）；只给 ai-provider 的对比看，对话不读 */
  date?: string;
}

export interface WebSearchRequest {
  query: string;
  /** 用户的界面语言（中文 / 韩文）。搜索接口的语言、国家跟搜索词的文字走（websearch.ts 的 webQueryOf），不看它 */
  lang: 'zh' | 'ko';
  /** 用户时区的今天（YYYY-MM-DD）：搜索词里“明天、今天”这类相对日子按它换成具体日期；不给就不换 */
  today?: string;
  timeoutMs: number;
  /** 某一家失败了（webChain 每试一家失败就调一次；调用方据此每家记一行日志） */
  onFail?: (by: string, r: Extract<AiResult, { ok: false }>) => void;
}

/** 实际发出去的搜索词加工成了什么（只给日志：语言、换没换日期、要不要最近的、字数；不带搜索词本身，A23） */
export interface WebSent {
  lang: string;
  dated: boolean;
  fresh: boolean;
  chars: number;
}

/** by：实际搜成的是哪一家（webChain 退到第二家时是第二家的名字）；sent 见 WebSent（测试桩可以不给） */
export type WebSearchResult =
  | { ok: true; by: string; sources: WebSource[]; sent?: WebSent }
  | Extract<AiResult, { ok: false }>;

/** 联网搜索的一家（websearch.ts 的 Brave、Tavily；name 是 WEB_PROVIDERS 里的名字） */
export interface WebSearcher {
  readonly name: string;
  search(req: WebSearchRequest): Promise<WebSearchResult>;
}
