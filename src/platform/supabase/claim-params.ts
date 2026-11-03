// claim_endpoint（推送订阅认领到本会话）的入参：同步层（sync-transport.ts）和 platform/push-claim.ts 共用。
// 放在 supabase 层（代码审查建议 3）：sync-transport 从这里引，不再经 push-claim.ts 把 push.ts 拉进同步层的依赖图；push-claim 反过来引这里
/** claim_endpoint 的五个入参（“接口先定”第 1 条） */
export interface ClaimArgs {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly label: string;
  readonly platform: string;
}

/**
 * 发给 claim_endpoint 的参数：显式只挑这 5 个键（安全审查 S3：调用方以后换成整个 PushSubscription.toJSON()，
 * 多带的 expirationTime、keys 会让 PostgREST 找不到函数签名）
 */
export function claimParams(a: ClaimArgs): ClaimArgs {
  return { endpoint: a.endpoint, p256dh: a.p256dh, auth: a.auth, label: a.label, platform: a.platform };
}
