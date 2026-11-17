// 令牌提前刷新的余量（TC-B1-82 ①）：同步层先刷新再发（sync-errors.ts 转出、sync-transport.ts 用）和告知页关口的快读（onboarding 的 useConsentWiring.ts）同一口径。
// 单独一个文件：关口在首屏，只要这一个常量，不带进 sync-errors.ts 的错误码映射（首屏瘦身 C，11-17）
/** 令牌还剩这么多就先刷新再发 */
export const REFRESH_MARGIN_MS = 60_000;
