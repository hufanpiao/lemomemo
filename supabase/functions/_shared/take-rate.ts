// private.take_rate 的调用（service role 经 PostgREST），服务器函数只留这一份（11-14 独立评审先收了 vault、vault-image；
// 11-15 后端安全审查第 7 条把 account、invite-admin、invite-signup、push-test、token-admin、claude-intake 也收进来，
// 原来 token-admin、push-test、claude-intake 回的不是布尔时当成“拒绝”，account 等几处抛错，口径统一成一律抛）。
// _shared/ai/store.ts 那份由另一条线在改，这次不动。
// 鉴权（requireActiveUser）不收进来：tests/build/fn-account-disabled-coverage.test.ts 按“函数自己目录的源码引用了 requireActiveUser”核对 TC-B1-10，
//   收到 _shared 里那条核对就看不见了。
// 不 import npm 包：只要求客户端有用到的这一点（supabase-js 的 SupabaseClient 照样能传），Vitest 直接测（tests/edge/take-rate.test.ts）。

type RpcResult = { data: unknown; error: unknown };
type RpcCall = PromiseLike<RpcResult> & { abortSignal(signal: AbortSignal): PromiseLike<RpcResult> };
/** rpcTakeRate 用到的客户端（supabase-js 的 service role 客户端） */
export interface TakeRateClient {
  schema(name: 'private'): { rpc(fn: 'take_rate', args: { p_key: string; p_limit: number; p_window_s: number }): RpcCall };
}

/**
 * private.take_rate(p_key, p_limit, p_window_s)：true = 放行；出错、回的不是布尔一律抛（不当成放行，也不当成拒绝）。
 * signal：store-timeout 每次调用新建的那个（超时就中止这一次请求）；不给就不挂。
 */
export function rpcTakeRate(admin: TakeRateClient, signal?: AbortSignal): (key: string, limit: number, windowS: number) => Promise<boolean> {
  const priv = admin.schema('private');
  return async (key, limit, windowS) => {
    const call = priv.rpc('take_rate', { p_key: key, p_limit: limit, p_window_s: windowS });
    const { data, error } = await (signal ? call.abortSignal(signal) : call);
    if (error || typeof data !== 'boolean') throw new Error('db');
    return data;
  };
}
