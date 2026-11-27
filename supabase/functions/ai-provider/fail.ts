// ai-provider 的试调失败归类（试调 core.ts 和对比 compare.ts 共用一份，独立评审第 10 条；从 core.ts 挪出来，免得 compare.ts 反过来引 core.ts）。
// 纯逻辑，不 import npm 包、不引 shared；Vitest 经 core.ts 的 tryKey、tryWebKey 和 compare.ts 测。

/** 试调的超时（界面写“连不上（10 秒没回）”）；对比时每家每条也用它 */
export const TEST_TIMEOUT_MS = 10_000;

export type TestFail = 'auth' | 'model' | 'quota' | 'timeout' | 'net' | 'error';
export type TestRes = { ok: true; ms: number } | { ok: false; code: TestFail; status?: number };
export type TestFailRes = Extract<TestRes, { ok: false }>;

/** 算“密钥不对”的状态码：AI 服务商 401 / 403；搜索接口另加 422（Brave 认不出密钥回 422 SUBSCRIPTION_TOKEN_INVALID） */
export const AI_AUTH_STATUS: readonly number[] = [401, 403];
export const WEB_AUTH_STATUS: readonly number[] = [401, 403, 422];

/**
 * 试调失败归成固定词：quota、timeout 照结果；authStatus 里的状态码、
 * 或 400 带 errName API_KEY_INVALID（Gemini 的密钥不对，ErrorInfo.reason 由 gemini.ts 的 geminiFail 记成 errName；别的 400 不算）当密钥不对；
 * 有模型名的（AI 服务商）404 当模型名不对；没状态码的 TypeError 是连不上；其余 error
 */
export function testFailOf(r: { reason: string; status?: number | undefined; errName?: string | undefined }, authStatus: readonly number[], withModel: boolean): TestFailRes {
  const st = r.status;
  const withSt = (code: TestFail): TestFailRes => (st === undefined ? { ok: false, code } : { ok: false, code, status: st });
  if (r.reason === 'quota') return withSt('quota');
  if (r.reason === 'timeout') return withSt('timeout');
  if ((st !== undefined && authStatus.includes(st)) || (st === 400 && r.errName === 'API_KEY_INVALID')) return withSt('auth');
  if (withModel && st === 404) return withSt('model');
  if (st === undefined && r.errName === 'TypeError') return { ok: false, code: 'net' };
  return withSt('error');
}
