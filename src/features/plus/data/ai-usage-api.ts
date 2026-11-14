// 设置 › 语音与 AI 的“今天 AI 用了 N 次 / 共 50 次”（B3 任务单 FA-4、S13）：读法在 platform/ai-usage.ts（结果层也用），
// 这里只是带上“读到已用完时记进本机额度”（quota.ts 的 rememberQuotaLeft，打字条就不再白发一次）
// 纯 TS：不准 import React（A1）
import { readAiUsage as read, usageRpc, USAGE_TIMEOUT_MS, type UsageDeps, type UsageResult } from '../../../platform/ai-usage.ts';
import { rememberQuotaLeft } from './quota.ts';

export { usageOf, USAGE_TIMEOUT_MS, type AiUsage, type UsageDeps, type UsageErr, type UsageResult } from '../../../platform/ai-usage.ts';

export const readAiUsage = (d: UsageDeps = { rpc: usageRpc, remember: rememberQuotaLeft }, timeoutMs = USAGE_TIMEOUT_MS): Promise<UsageResult> => read(d, timeoutMs);
