// e2e 要不要复用已经在跑的 wrangler、假后端（FA-6 执行说明“四之一、已知坑”，主持人 11-04 定）：
// • 默认不复用：Playwright 自己起服务，端口被占着就失败（看门狗起跑前也先查一遍端口，见 run-watchdog.mjs 的 busyPorts）；
// • 本机设了 LEMO_E2E_REUSE=1 才复用（改 src 后要自己先 npm run build -- --mode e2e，globalSetup 的产物指纹核对照旧）；
// • CI（CI=true）一律不复用，设了也不算。
// 起因：11-04 8788 上叠着一个跑了 7 小时的旧 wrangler，reuseExistingServer 连上它，整套 66 条失败。
// 两个无后端配置（playwright.config.ts、playwright.fastread.config.ts）都读这里；真后端配置一律不复用，不读。

export const REUSE_ENV = 'LEMO_E2E_REUSE';

/**
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {boolean}
 */
export function reuseServers(env) {
  return env['CI'] !== 'true' && env[REUSE_ENV] === '1';
}
