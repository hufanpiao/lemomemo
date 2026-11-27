// ai-parse、ai-voice、claude-intake 的 index.ts 共用的接线（B4b-2 起 note-search、ai-embed 经 embedderFor 拿嵌入函数）（B3 任务单 BE-4、BE-5）：把 gate.ts 要的依赖接到 service role 的 supabase-js 上。
// 只给 index.ts 用（core.ts 要在 Vitest 里跑，不准 import _shared/gen/）。
// 密钥（R-494）：先读 Vault 里管理员存的 ai_key_<服务商>（private.ai_secret_get），没有再退到环境变量 GEMINI_API_KEY（预览、正式各一把，8.4；过渡用）；
//   每个人自己的密钥 ai_ukey_<user_id> 和 private.ai_user_keys 只在 ownProvider 里读。密钥只放各家适配器的请求头。
//   联网搜索：Brave、Tavily、Naver 的密钥也在 Vault（ai_key_brave、ai_key_tavily、ai_key_naver），DeepSeek 搜索用对话那家的 ai_key_deepseek，
//   都经同一个 projectKey 取，chatWebSearcher 按管理员勾的几家（websearch-mix.ts 的 webFor）建。
// 读 app_config.ai、features，profiles.beta_features，private.counters、ai_state、take_rate、admins（管理员不设个人每天上限）、ai_user_keys，public.logs。
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { isValidTz } from '../gen/core/tz.ts';
import { featureOn, type FeaturesConfig } from '../gen/logic/flags.ts';
import { AI_PROVIDERS, ownCovers } from '../gen/schema/ai-provider.ts';
import { AI_KINDS, KIND_FLAG, type AiKind } from '../gen/schema/kinds.ts';
import { isObj } from '../obj.ts';
import { isAdmin } from '../user-reads.ts';
import type { Fetch } from './compat.ts';
import type { GateDeps, OwnDead } from './gate.ts';
import { geminiEmbed, type EmbedResult } from './embed.ts';
import type { AiTask, ChatProvider, ProviderName, WebSearcher } from './provider.ts';
import { providerOf, readAiConfig, routeFor, type AiConfig, type AnyProvider, type KeyOwner } from './router.ts';
import { makeSearcher } from './websearch.ts';
import { webFor, webNeeds } from './websearch-mix.ts';
import { exhaustedUntil, logInvalid, markExhausted, quotaStore, takeRate, type StoreAdmin } from './store.ts';


/** app_config 一行（ai、features）；60 秒缓存，读失败抛错 */
let cfgMemo: { at: number; ai: unknown; features: unknown } | null = null;
async function appConfig(admin: SupabaseClient, now: number): Promise<{ ai: unknown; features: unknown }> {
  if (cfgMemo && now - cfgMemo.at < 60_000) return cfgMemo;
  const { data, error } = await admin.from('app_config').select('ai, features').eq('id', 1).maybeSingle();
  if (error || !data) throw new Error('db:app_config');
  cfgMemo = { at: now, ai: (data as { ai: unknown }).ai, features: (data as { features: unknown }).features };
  return cfgMemo;
}

/** app_config.ai（note-search、ai-embed 读 embed_model 等；同一份 60 秒缓存，读失败抛错） */
export const appAiConfig = async (admin: SupabaseClient, now: number): Promise<unknown> => (await appConfig(admin, now)).ai;

/**
 * 这个人能用的 AI 类型（0.27 第 4 点 featureOn）：app_config.features 读不出 → 一种都没有；
 * profiles.beta_features 读不出 → 按空算（TC-B3-26：读 profiles 失败当作关闭，只剩全局打开的）。
 * need：这个函数自己的开关（ai-chat 是 CHAT_FLAG）；给了而对这个人没开 → 一种都没有（门第 ② 步回 feature_off）。
 */
export async function aiFeatures(admin: SupabaseClient, userId: string, appVersion: string, now: number, need?: string): Promise<AiKind[]> {
  let cfg: FeaturesConfig;
  try {
    const f = (await appConfig(admin, now)).features;
    cfg = (isObj(f) ? f : {}) as FeaturesConfig;
  } catch {
    return [];
  }
  let beta: string[] = [];
  try {
    const { data, error } = await admin.from('profiles').select('beta_features').eq('user_id', userId).maybeSingle();
    const b = (data as { beta_features?: unknown } | null)?.beta_features;
    if (!error && Array.isArray(b)) beta = b.filter((x): x is string => typeof x === 'string');
  } catch {
    beta = [];
  }
  // 用 Map 查、不用方括号，并在本文件里写明 KIND_FLAG 的类型：发布脚本第 1 步在还没生成 _shared/gen 的干净检出里跑 check_backend，
  // 那时 ../gen 的类型解析不出来（any），方括号里的 k、Object.entries 的参数都推断不出类型，F7 会报（tests/build/publish-run*.test.ts）
  if (need !== undefined && !featureOn(cfg, need, { beta, appVersion })) return [];
  const kindFlag: Readonly<Record<string, string>> = KIND_FLAG;
  const flags: ReadonlyMap<string, string> = new Map(Object.entries(kindFlag));
  return AI_KINDS.filter((k) => {
    const flag = flags.get(k);
    return flag !== undefined && featureOn(cfg, flag, { beta, appVersion });
  });
}

/**
 * consent 由各函数的 index.ts 传进来（从 _shared/consent.ts 具名 import aiAllowed 再调用），
 * 好让 tests/build/ai-consent-gate.test.ts 在函数目录里就看得到“先过同意”（TC-B1-15）。
 */
export function gateDeps(admin: SupabaseClient, log: (code: string) => void, consent: GateDeps['consent'], task?: AiTask): GateDeps {
  const sa = admin as unknown as StoreAdmin;
  const now = () => Date.now();
  return {
    consent,
    isAdmin: (userId) => isAdmin(admin, userId),
    features: (userId, v) => aiFeatures(admin, userId, v, now()),
    config: async (): Promise<AiConfig> => readAiConfig((await appConfig(admin, now())).ai),
    provider: (cfg) => projectProvider(admin, cfg, task),
    // 自己的密钥只管 OWN_KEY_TASKS 里的用途（对话和整理、录音转文字）；没给用途的（识图）不查
    ...(task ? { own: (userId: string) => ownProvider(admin, userId, task), ownMark: (userId: string, code: OwnDead) => ownMark(admin, userId, code, now()) } : {}),
    rate: (key, limit, windowS) => takeRate(sa, key, limit, windowS),
    quota: quotaStore(sa),
    exhaustedUntil: (p) => exhaustedUntil(sa, p),
    markExhausted: (until, p) => markExhausted(sa, until, p),
    logInvalid: (userId, src, reasons) => logInvalid(sa, userId, src, reasons, now()),
    now,
    log,
  };
}

/** AI 助手自己的功能开关（app_config.features.chat；20261122090000 打开）。关了门第 ② 步回 feature_off，各类型开关照旧各管各的工具 */
export const CHAT_FLAG = 'chat';

/**
 * ai-chat（R-492）用的门依赖：和 gateDeps 同一份（按用途 chat 选服务商、自己的密钥），第 ② 步多看 CHAT_FLAG。
 * 四家适配器都同时能 generate 和 chat（router.ts 的 AnyProvider），所以不再另写一套取服务商的路子
 */
export function chatGateDeps(admin: SupabaseClient, log: (code: string) => void, consent: GateDeps['consent']): GateDeps<ChatProvider> {
  return {
    ...(gateDeps(admin, log, consent, 'chat') as GateDeps<AnyProvider>),
    features: chatFeatures(admin),
  };
}

/** 门第 ② 步多看 CHAT_FLAG 的 features：ai-chat 和语音提问（ai-voice 只转写那一支，R-495）共用 */
export function chatFeatures(admin: SupabaseClient): GateDeps['features'] {
  return (userId, v) => aiFeatures(admin, userId, v, Date.now(), CHAT_FLAG);
}

export { isValidTz };

// ===== 密钥（R-494）：先读 Vault（管理员在“AI 服务商”页存的 ai_key_<服务商>），没有再退到环境变量（只有 gemini 有 GEMINI_API_KEY，过渡用）=====
// 项目密钥按 60 秒缓存（和 app_config 同一节奏：管理员换了密钥，最长 1 分钟全部函数换过去，不用发版）；读 Vault 出错当没有，退到环境变量。
// 每个人自己的密钥不缓存（关掉、删掉要马上生效），每次请求现读一次。密钥只放各家适配器的请求头，不打印、不进日志。

/** 出站一律经它（各家适配器、联网搜索、ai-provider 的试调） */
export const fetchOut: Fetch = (u, init) => fetch(u, init);
const keyMemo = new Map<string, { at: number; v: string | null }>();

/** 管理员刚存了这家的新密钥（ai-provider 的 admin_key）：这个函数实例里不再用 60 秒缓存里的旧的；别的实例最长 1 分钟换过去 */
export const forgetProjectKey = (p: KeyOwner): void => {
  keyMemo.delete(`ai_key_${p}`);
};

/** private.ai_secret_get（只有 service_role 能执行）；没有这一条回 null，出错抛 */
export async function vaultSecret(admin: SupabaseClient, name: string): Promise<string | null> {
  const { data, error } = await admin.schema('private').rpc('ai_secret_get', { p_name: name });
  if (error) throw new Error('db:ai_secret_get');
  return typeof data === 'string' && data !== '' ? data : null;
}

/** 管理员给全体配的这家的密钥：Vault → 环境变量（gemini） */
export async function projectKey(admin: SupabaseClient, p: KeyOwner, now: number = Date.now()): Promise<string | undefined> {
  const name = `ai_key_${p}`;
  const hit = keyMemo.get(name);
  let v: string | null;
  if (hit && now - hit.at < 60_000) v = hit.v;
  else {
    try {
      v = await vaultSecret(admin, name);
      keyMemo.set(name, { at: now, v });
    } catch {
      v = null;
    }
  }
  return v ?? (p === 'gemini' ? Deno.env.get('GEMINI_API_KEY') : undefined) ?? undefined;
}

/**
 * ai-chat 联网：按管理员勾的几家（app_config.ai.web，没写当 DeepSeek + Brave + Naver；见 websearch-mix.ts 的 webFor）建；
 * 取勾的几家和备用候选的密钥，没存密钥的那家不放进来，一家都没有回 null（不给模型 web_search 工具）。app_config 读不出抛错
 */
export async function chatWebSearcher(admin: SupabaseClient): Promise<WebSearcher | null> {
  const picks = readAiConfig((await appConfig(admin, Date.now())).ai).web;
  const keys = new Map(await Promise.all(webNeeds(picks).map(async (p) => [p, await projectKey(admin, p)] as const)));
  return webFor(picks, (p) => makeSearcher(p, keys.get(p), fetchOut), Date.now);
}

/** 柠檬记提供的服务商：routeFor 选哪家（没给用途的识图只认 Gemini），取那家的项目密钥，providerOf 建并核对能力 */
async function projectProvider(admin: SupabaseClient, cfg: AiConfig, task: AiTask | undefined): Promise<AnyProvider | null> {
  const r = routeFor(cfg, task);
  return r ? providerOf(r, task, await projectKey(admin, r.provider), fetchOut) : null;
}

/**
 * 这个人自己的密钥（“我的 AI”）：private.ai_user_keys 里正在用（active）、这项归它做（ownCovers）时，按他填的那家、那个模型建；否则 null。
 * 他那家用不了（欠费、额度满、密钥失效）时改用柠檬记的、额度失败不当柠檬记的额度，都在门里（gate.ts 的 ownFirst）
 */
export async function ownProvider(admin: SupabaseClient, userId: string, task: AiTask): Promise<AnyProvider | null> {
  const { data, error } = await admin.schema('private').from('ai_user_keys').select('provider, model, active').eq('user_id', userId).maybeSingle();
  if (error) throw new Error('db:ai_user_keys');
  const row = data as { provider?: unknown; model?: unknown; active?: unknown } | null;
  if (!row || row.active !== true || typeof row.provider !== 'string' || typeof row.model !== 'string') return null;
  if (!(AI_PROVIDERS as readonly string[]).includes(row.provider)) return null;
  const p = row.provider as ProviderName;
  if (!ownCovers(p).includes(task)) return null;
  return providerOf({ provider: p, model: row.model }, task, await vaultSecret(admin, `ai_ukey_${userId}`), fetchOut);
}

/** 自己的密钥用不了、这次改用了柠檬记的：记在 ai_user_keys 那一行（“我的 AI”页据此提示；出错抛，门只记日志） */
async function ownMark(admin: SupabaseClient, userId: string, code: OwnDead, now: number): Promise<void> {
  const { error } = await admin.schema('private').from('ai_user_keys').update({ fell_back_at: new Date(now).toISOString(), fell_back_why: code }).eq('user_id', userId);
  if (error) throw new Error('db:ai_user_keys');
}

/** 带密钥的嵌入函数（note-search、ai-embed；_shared/ai/embed.ts）：模型名不合法、密钥没配回 null。向量现在只有 Gemini（换向量要整库重算，还没做） */
// 形状不变（note-search、ai-embed 的 core 同步拿到函数）：模型名不合法当场回 null；密钥在真要算的时候才读（Vault → 环境变量），读不到这一次回 error
export const embedderFor = (admin: SupabaseClient) => (model: string | null): ((texts: readonly string[], timeoutMs: number) => Promise<EmbedResult>) | null => {
  if (geminiEmbed(model, 'probe', fetchOut) === null) return null;
  return async (texts, timeoutMs) => {
    const run = geminiEmbed(model, await projectKey(admin, 'gemini'), fetchOut);
    return run ? run(texts, timeoutMs) : { ok: false, reason: 'error', errName: 'no_key' };
  };
};
