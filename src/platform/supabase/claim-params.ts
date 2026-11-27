// claim_endpoint（推送订阅认领到本会话）的入参：sync-transport.ts 和 push-claim.ts 共用。
// 放在 supabase 层：sync-transport 从这里引，免得经 push-claim.ts 把 push.ts 拉进同步层的依赖图
/** claim_endpoint 的五个入参 */
export interface ClaimArgs {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly label: string;
  readonly platform: string;
}

/**
 * 显式只挑这 5 个键：多带的键（如 PushSubscription.toJSON() 的 expirationTime、keys）会让 PostgREST 找不到函数签名
 */
export function claimParams(a: ClaimArgs): ClaimArgs {
  return { endpoint: a.endpoint, p256dh: a.p256dh, auth: a.auth, label: a.label, platform: a.platform };
}
