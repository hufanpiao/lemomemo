// ai-parse、ai-voice、claude-intake 的 index.ts 共用的接线（B4b-2 起 note-search、ai-embed 经 embedderFor 拿嵌入函数）（B3 任务单 BE-4、BE-5）：把 gate.ts 要的依赖接到 service role 的 supabase-js 上。
// 只给 index.ts 用（core.ts 要在 Vitest 里跑，不准 import _shared/gen/）。
// 环境变量：GEMINI_API_KEY（预览、正式各一把，8.4；只放 x-goog-api-key 请求头）。读 app_config.ai、features，profiles.beta_features，
// private.counters、ai_state、take_rate，public.logs。
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { isValidTz } from '../gen/core/tz.ts';
import { featureOn, type FeaturesConfig } from '../gen/logic/flags.ts';
import { AI_KINDS, KIND_FLAG, type AiKind } from '../gen/schema/kinds.ts';
import { isObj } from '../obj.ts';
import type { GateDeps } from './gate.ts';
import { geminiEmbed } from './embed.ts';
import { pickProvider, readAiConfig, type AiConfig } from './router.ts';
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

/**
 * 这个人能用的 AI 类型（0.27 第 4 点 featureOn）：app_config.features 读不出 → 一种都没有；
 * profiles.beta_features 读不出 → 按空算（TC-B3-26：读 profiles 失败当作关闭，只剩全局打开的）。
 */
export async function aiFeatures(admin: SupabaseClient, userId: string, appVersion: string, now: number): Promise<AiKind[]> {
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
export function gateDeps(admin: SupabaseClient, log: (code: string) => void, consent: GateDeps['consent']): GateDeps {
  const sa = admin as unknown as StoreAdmin;
  const now = () => Date.now();
  return {
    consent,
    features: (userId, v) => aiFeatures(admin, userId, v, now()),
    config: async (): Promise<AiConfig> => readAiConfig((await appConfig(admin, now())).ai),
    provider: (cfg) => pickProvider(cfg, Deno.env.get('GEMINI_API_KEY'), (u, init) => fetch(u, init)),
    rate: (key, limit, windowS) => takeRate(sa, key, limit, windowS),
    quota: quotaStore(sa),
    exhaustedUntil: () => exhaustedUntil(sa),
    markExhausted: (until) => markExhausted(sa, until),
    logInvalid: (userId, src, reasons) => logInvalid(sa, userId, src, reasons, now()),
    now,
    log,
  };
}

export { isValidTz };

/** 带密钥的嵌入函数（note-search、ai-embed；_shared/ai/embed.ts）：模型名不合法、密钥没配回 null */
export const embedderFor = (model: string | null) => geminiEmbed(model, Deno.env.get('GEMINI_API_KEY'), (u, init) => fetch(u, init));
