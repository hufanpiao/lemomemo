// 令牌提前刷新的余量：同步层（sync-transport.ts）和告知页关口（useConsentWiring.ts）同一口径。
// 单独一个文件：关口在首屏，只要这一个常量，不带进 sync-errors.ts 的错误码映射
/** 令牌还剩这么多就先刷新再发 */
export const REFRESH_MARGIN_MS = 60_000;
