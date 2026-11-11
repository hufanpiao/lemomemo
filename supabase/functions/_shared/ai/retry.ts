// Gemini 回 503 时在服务器端重试一次（B3 iPhone 实测 11-11：40 次里 4 次 gemini_http 503，同一段换一次就成功）。
// 只给录音用：voice-probe（预览探测）和正式 ai-voice（parse-core.ts 的 voiceWithAI）。ai-parse 照旧不重试（5 秒超时，重试一次就超了）。
// 规则：
//   • 只认 { ok: false, reason: 'error', status: 503 }；429（含额度用完）、超时、别的 4xx / 5xx、返回不是 JSON 都不重试；
//   • 两次合计不超过 req.timeoutMs（ai-voice 15 秒）：第一次照原超时发；回 503 时离截止还剩不到 RETRY_MIN_LEFT_MS + RETRY_BACKOFF_MS（4.3 秒，即第一次用掉 10.7 秒以上）就不重试，
//     够的话等 RETRY_BACKOFF_MS 再发第二次，第二次的超时是“剩下的时间”（不会把总时长拉过原来的 15 秒）；
//   • 最多重试一次。
// 纯函数：时钟、等待由调用方注入（单测用假的），默认 performance.now、setTimeout。
import type { AIProvider, AiRequest, AiResult } from './provider.ts';

/** 回 503 后先等这么久再发第二次（毫秒） */
export const RETRY_BACKOFF_MS = 300;
/** 离截止还剩不到这么多（毫秒）就不重试：音频转写正常要 1～11 秒（实测），剩太少重试也多半超时 */
export const RETRY_MIN_LEFT_MS = 4_000;

export interface RetryDeps {
  /** 单调时钟（毫秒） */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryOutcome {
  result: AiResult;
  /** 第一次回 503、重试过了（不管第二次成没成） */
  retried: boolean;
}

export const is503 = (r: AiResult): boolean => !r.ok && r.reason === 'error' && r.status === 503;

const defaultSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

export async function generateRetry503(provider: AIProvider, req: AiRequest, deps: RetryDeps = {}): Promise<RetryOutcome> {
  const clock = deps.clock ?? (() => performance.now());
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = clock() + req.timeoutMs;
  const first = await provider.generate(req);
  if (!is503(first)) return { result: first, retried: false };
  if (deadline - clock() < RETRY_MIN_LEFT_MS + RETRY_BACKOFF_MS) return { result: first, retried: false };
  await sleep(RETRY_BACKOFF_MS);
  const left = Math.floor(deadline - clock());
  if (left < RETRY_MIN_LEFT_MS) return { result: first, retried: false };
  const second = await provider.generate({ ...req, timeoutMs: left });
  return { result: second, retried: true };
}
