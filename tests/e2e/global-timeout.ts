// 两个 Playwright 配置的 globalTimeout（接手清单 E2E-webkit-hang，需求记录 R-267 D2）：整轮跑超过这么久，Playwright 自己收尾退出，
// 不会一直挂着（10-30 真后端组 webkit 卡住、8789、9198、9199 被残留进程占着就是这么来的）。
// • E2E_GLOBAL_TIMEOUT_MS 覆盖：纯十进制毫秒数，60 秒～60 分钟；没设或空字符串用各配置的默认值；不合格抛错
// • 默认：无后端组 20 分钟（CI 的 e2e 任务 timeout-minutes 是 30，要比它短，Playwright 先收尾、报告能留下来）；
//   真后端组只跑 chromium 15 分钟，E2E_REAL_WEBKIT=1 多跑 webkit 时 30 分钟
// 本机另有 tools/e2e/run-watchdog.mjs 管“连续很久没输出”（npm run e2e、npm run e2e:real 套着它）。
export const GLOBAL_TIMEOUT_ENV = 'E2E_GLOBAL_TIMEOUT_MS';
export const GLOBAL_TIMEOUT_MIN_MS = 60_000;
export const GLOBAL_TIMEOUT_MAX_MS = 60 * 60_000;

/** 无后端组（playwright.config.ts）的默认值 */
export const NO_BACKEND_GLOBAL_TIMEOUT_MS = 20 * 60_000;
/** 真后端组只跑 chromium 时的默认值 */
export const REAL_GLOBAL_TIMEOUT_MS = 15 * 60_000;
/** 真后端组 E2E_REAL_WEBKIT=1 时的默认值 */
export const REAL_WEBKIT_GLOBAL_TIMEOUT_MS = 30 * 60_000;

/** 读 E2E_GLOBAL_TIMEOUT_MS；没设或空字符串返回 fallback；非纯十进制、越界抛错（消息只带变量名和数值） */
export function globalTimeoutMs(env: Readonly<Record<string, string | undefined>>, fallback: number): number {
  const raw = env[GLOBAL_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${GLOBAL_TIMEOUT_ENV} 必须是纯十进制毫秒数`);
  const ms = Number(raw);
  if (ms < GLOBAL_TIMEOUT_MIN_MS || ms > GLOBAL_TIMEOUT_MAX_MS) {
    throw new Error(`${GLOBAL_TIMEOUT_ENV} 是 ${ms}，必须在 ${GLOBAL_TIMEOUT_MIN_MS}（1 分钟）～${GLOBAL_TIMEOUT_MAX_MS}（60 分钟）之间`);
  }
  return ms;
}

/** 真后端组的默认值：E2E_REAL_WEBKIT=1 时 30 分钟，否则 15 分钟 */
export function realGroupDefaultTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  return env['E2E_REAL_WEBKIT'] === '1' ? REAL_WEBKIT_GLOBAL_TIMEOUT_MS : REAL_GLOBAL_TIMEOUT_MS;
}
