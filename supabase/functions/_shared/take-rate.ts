// private.take_rate 的调用（service role 经 PostgREST）：vault、vault-image 共用（11-14 独立评审：两处 index.ts 原来逐字各写一份）。
// 别的函数的写法各有差别（带 abortSignal、must 包装、回 data === true），这次只收隐私记这两处，其余以后改到再并（不为合并去动已验收的函数）。
// 鉴权（requireActiveUser）不收进来：tests/build/fn-account-disabled-coverage.test.ts 按“函数自己目录的源码引用了 requireActiveUser”核对 TC-B1-10，
//   收到 _shared 里那条核对就看不见了。引 npm 包，不给 Vitest 测（各函数的 core.ts 注入假的）。
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';

/** private.take_rate(p_key, p_limit, p_window_s)：true = 放行；出错、回的不是布尔一律抛（不当成放行） */
export function rpcTakeRate(admin: SupabaseClient): (key: string, limit: number, windowS: number) => Promise<boolean> {
  const priv = admin.schema('private');
  return async (key, limit, windowS) => {
    const { data, error } = await priv.rpc('take_rate', { p_key: key, p_limit: limit, p_window_s: windowS });
    if (error || typeof data !== 'boolean') throw new Error('db');
    return data;
  };
}
