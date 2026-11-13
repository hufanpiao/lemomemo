// 响应之后还要做完的事（推送、邮件、写日志、删对象）：Supabase Edge Runtime 上交给 EdgeRuntime.waitUntil，本机 deno 里没有这个全局就让它自己跑完。
// 11-14 隐私记整块评审第 17 条：原来 vault/index.ts、account/index.ts 各写一份。调用方的 Promise 自己先 .catch 记错误码；这里只兜底不让它变成未处理的拒绝。
// 只给各函数的 index.ts 用（core.ts 经 Deps.background 注入，测试注入收集器）。

/** Supabase Edge Runtime 自带的全局（本机 deno 里没有，用 typeof 判断） */
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

export function background(p: Promise<unknown>): void {
  const settled = p.catch(() => {});
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime) EdgeRuntime.waitUntil(settled);
}
