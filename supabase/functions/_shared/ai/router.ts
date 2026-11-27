// 选服务商（架构第 7 节；R-492 按用途选、R-494 补齐四家适配器）。只有一条路：routeFor（这项该哪家、哪个模型）→ makeProvider（建适配器）→ canDo（能力够不够）。
// • app_config.ai.tasks.<用途> = {provider, model}（用途见 provider.ts 的 AI_TASKS）；某个用途没配就沿用顶层的 provider / model（顶层 provider 为 null 当 gemini）。
// • 没有用途的调用（识图 ai-media）：只认 Gemini 和顶层模型名（顶层 provider 写的是别家时为 null：那时顶层模型名不是 Gemini 的）。
// • 密钥由调用方按 routeFor 选出的那家去取（wire.ts 的 projectKey：Vault → 环境变量；自己的密钥 ai_ukey_<user_id>），再交给 providerOf。
// • 没配、没适配器、模型名不合法、没密钥、能力不够一律回 null（调用方当“AI 没配好”，不扣次数、退回本机规则）。
// • 联网搜索（不归 AI 服务商；11-24 起 DeepSeek / Brave / Naver / Tavily）：app_config.ai.web 是勾了哪几家（readAiConfig 经 websearch.ts 的 webPicksOf 读成 cfg.web 数组，
//   旧的 'multi'、单家字符串照认，没写当 DeepSeek + Brave + Naver），wire.ts 按 websearch-mix.ts 的 webNeeds 取这几家的密钥、webFor 建。
import { ClaudeProvider } from './claude.ts';
import type { Fetch } from './compat.ts';
import { GeminiProvider } from './gemini.ts';
import { OpenAiCompatProvider } from './openai.ts';
import { AI_TASKS, PROVIDER_NAMES, type AIProvider, type AiTask, type ChatProvider, type ProviderName } from './provider.ts';
import { webPicksOf, type WebProviderName } from './websearch.ts';

export interface TaskRoute {
  provider: ProviderName;
  model: string;
}

export interface AiConfig {
  provider: string | null;
  model: string | null;
  /** 每人每天（默认 50） */
  per_user_daily: number;
  /** 全项目每天；null = 没配（当 0，AI 一律不调，只走本机规则） */
  global_daily: number | null;
  /** 按用途单独配的服务商和模型（格式不对的那一项当没配；一项都没配时不带这个键，原来的读法和单测不变） */
  tasks?: Partial<Record<AiTask, TaskRoute>>;
  /** 联网搜索勾了哪几家（app_config.ai.web，负责人 11-25；新旧格式见 websearch.ts 的 webPicksOf），至少一家 */
  web: WebProviderName[];
}

/** 每人每天默认几次（app_config.ai.per_user_daily 没配或读不出时） */
export const PER_USER_DAILY_DEFAULT = 50;

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
export const isProvider = (v: unknown): v is ProviderName => typeof v === 'string' && (PROVIDER_NAMES as readonly string[]).includes(v);
const asObj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function readTasks(v: unknown): Partial<Record<AiTask, TaskRoute>> {
  const o = asObj(v);
  const out: Partial<Record<AiTask, TaskRoute>> = {};
  for (const t of AI_TASKS) {
    const r = asObj(o[t]);
    if (isProvider(r['provider']) && typeof r['model'] === 'string' && r['model'] !== '') out[t] = { provider: r['provider'], model: r['model'] };
  }
  return out;
}

/** 从 app_config.ai 读出用得到的几项；格式不对的按默认（失败就关上：global_daily 读不出当 null） */
export function readAiConfig(ai: unknown): AiConfig {
  const o = asObj(ai);
  const tasks = readTasks(o['tasks']);
  return {
    provider: typeof o['provider'] === 'string' ? o['provider'] : null,
    model: typeof o['model'] === 'string' && o['model'] !== '' ? o['model'] : null,
    per_user_daily: posInt(o['per_user_daily']) ?? PER_USER_DAILY_DEFAULT,
    global_daily: posInt(o['global_daily']),
    ...(Object.keys(tasks).length > 0 ? { tasks } : {}),
    web: webPicksOf(o['web']),
  };
}

/** 这项实际用哪家、哪个模型（见文件头）；没配好为 null */
export function routeFor(cfg: AiConfig, task?: AiTask): TaskRoute | null {
  const own = task === undefined ? undefined : new Map(Object.entries(cfg.tasks ?? {})).get(task);
  if (own) return own;
  const p = cfg.provider ?? 'gemini';
  if (task === undefined && p !== 'gemini') return null;
  return isProvider(p) && cfg.model ? { provider: p, model: cfg.model } : null;
}

/** 四家都同时实现 generate（回 JSON）和 chat（对话、工具调用） */
export type AnyProvider = AIProvider & ChatProvider;

/** 各家的适配器；构造失败（模型名不合法、没密钥）抛错 */
const ADAPTERS: ReadonlyMap<ProviderName, (model: string, key: string, fetchFn: Fetch) => AnyProvider> = new Map<ProviderName, (model: string, key: string, fetchFn: Fetch) => AnyProvider>([
  ['gemini', (model, key, fetchFn) => new GeminiProvider(model, key, fetchFn)],
  ['openai', (model, key, fetchFn) => new OpenAiCompatProvider('openai', model, key, fetchFn)],
  ['deepseek', (model, key, fetchFn) => new OpenAiCompatProvider('deepseek', model, key, fetchFn)],
  ['claude', (model, key, fetchFn) => new ClaudeProvider(model, key, fetchFn)],
]);

/** 建一家的适配器：没适配器、模型名不合法、没密钥回 null（ai-provider 的试调也用它） */
export function makeProvider(p: ProviderName, model: string, key: string | null | undefined, fetchFn: Fetch): AnyProvider | null {
  const make = ADAPTERS.get(p);
  if (!make || !key) return null;
  try {
    return make(model, key, fetchFn);
  } catch {
    return null;
  }
}

/** 这家的适配器能不能做这项（chat 要能调工具、stt 要收音频、embed 要有向量） */
export const canDo = (p: AnyProvider, task: AiTask): boolean =>
  task === 'chat' ? p.caps.tools : task === 'stt' ? p.caps.audioIn : p.caps.embed;

/**
 * 项目密钥归谁（Vault 名 ai_key_<它>）：四家 AI 服务商，加联网搜索的 Brave、Tavily（迁移 20261123110000）、Naver（20261124130000）；
 * DeepSeek 搜索和对话共用 ai_key_deepseek。wire.ts、ai-provider 都用这一份
 */
export type KeyOwner = ProviderName | WebProviderName;

/** 按选好的路建适配器并核对能力（没给用途的不核对）：柠檬记提供的、自己的密钥都经这里 */
export function providerOf(r: TaskRoute, task: AiTask | undefined, key: string | null | undefined, fetchFn: Fetch): AnyProvider | null {
  const p = makeProvider(r.provider, r.model, key, fetchFn);
  return p && (task === undefined || canDo(p, task)) ? p : null;
}
