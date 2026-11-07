// 选服务商（架构第 7 节：保留 router.ts，结构上可以换；R-55 只有 gemini）。
// app_config.ai.provider 为 null 或 'gemini' 都用 Gemini；模型名为空、密钥没配时返回 null（调用方当“AI 没配好”，不扣次数、退回本机规则）。
import { GeminiProvider, type Fetch } from './gemini.ts';
import type { AIProvider } from './provider.ts';

export interface AiConfig {
  provider: string | null;
  model: string | null;
  /** 每人每天（默认 50） */
  per_user_daily: number;
  /** 全项目每天；null = 没配（当 0，AI 一律不调，只走本机规则） */
  global_daily: number | null;
}

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** 从 app_config.ai 读出用得到的几项；格式不对的按默认（失败就关上：global_daily 读不出当 null） */
export function readAiConfig(ai: unknown): AiConfig {
  const o = typeof ai === 'object' && ai !== null && !Array.isArray(ai) ? (ai as Record<string, unknown>) : {};
  return {
    provider: typeof o['provider'] === 'string' ? o['provider'] : null,
    model: typeof o['model'] === 'string' && o['model'] !== '' ? o['model'] : null,
    per_user_daily: posInt(o['per_user_daily']) ?? 50,
    global_daily: posInt(o['global_daily']),
  };
}

export function pickProvider(cfg: AiConfig, apiKey: string | undefined, fetchFn: Fetch): AIProvider | null {
  if (cfg.provider !== null && cfg.provider !== 'gemini') return null;
  if (!cfg.model || !apiKey) return null;
  try {
    return new GeminiProvider(cfg.model, apiKey, fetchFn);
  } catch {
    return null;
  }
}
