// 按环境变量建 R2 客户端（架构 0.32、8.6 R2_FN_*）：vault、vault-image、account-purge 共用这一份（11-14 独立评审：原来三处各写一份 makeR2）。
// 文件名以 objstore 开头：check_backend F3 只准 _shared/objstore*.ts 读 R2_*，引它的函数必须在 R2_FUNCS 里。
// 没配齐、地址不合格（createObjStore 抛错，比如不是 https）一律回 null，由调用方在用到时回 misconfigured / try_later，不让函数整个起不来。
// 引 _shared/gen/，所以不给 Vitest 测（逻辑在各函数的 core.ts，测试注入内存假 store）。
import { timedFetch } from './net.ts';
import { createObjStore } from './gen/objstore.ts';

export type EnvObjStore = ReturnType<typeof createObjStore>;

export function r2FromEnv(): EnvObjStore | null {
  const endpoint = Deno.env.get('R2_ENDPOINT');
  const accessKeyId = Deno.env.get('R2_FN_ACCESS_KEY_ID');
  const secretAccessKey = Deno.env.get('R2_FN_SECRET_ACCESS_KEY');
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  try {
    return createObjStore({
      endpoint, accessKeyId, secretAccessKey, bucketPrefix: Deno.env.get('R2_BUCKET_PREFIX') ?? '',
      fetch: (url, init) => timedFetch(fetch)(url, init as RequestInit), now: () => Date.now(),
    });
  } catch {
    return null;
  }
}
