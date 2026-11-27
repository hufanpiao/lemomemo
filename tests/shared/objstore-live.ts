// 打真的 S3 替身（LocalStack，运维 O-1）或 R2 的测试共用：读 OBJSTORE_* 变量、建真客户端（架构 0.33 第 13 条、代码审查中 2 ②）。
// 变量名和 build/objstore.mjs、ci.yml 的 db 任务一致：OBJSTORE_ENDPOINT、OBJSTORE_ACCESS_KEY_ID、OBJSTORE_SECRET_ACCESS_KEY、OBJSTORE_REGION、R2_BUCKET_PREFIX。
// 各组一律写成 describe.skipIf(!OBJSTORE_LIVE)：没设 OBJSTORE_ENDPOINT 时报告里是“跳过”；设了就真跑（CI 设了却还有跳过的，由 ci.yml 判失败）。
// Node（vitest）和 Deno（deno task test，要 --allow-env 这几个变量）都能用；纯 TS，不用 Node、Deno 专有的 API。
import { createObjStore, type ObjStore } from '../../shared/objstore.ts';

/** 读环境变量；Deno 没给 --allow-env 时当没设 */
export function env(name: string): string | undefined {
  try {
    const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return p?.env?.[name];
  } catch {
    return undefined;
  }
}

/** 设了 OBJSTORE_ENDPOINT 才打真替身；值就是替身地址（本机 http://127.0.0.1:4566） */
export const OBJSTORE_LIVE: string | undefined = env('OBJSTORE_ENDPOINT') || undefined;

/** 按变量建真客户端（经 shared/objstore.ts，和服务器函数同一份代码） */
export function liveObjStore(): ObjStore {
  if (!OBJSTORE_LIVE) throw new Error('没设 OBJSTORE_ENDPOINT：这一组应当已被 describe.skipIf 跳过');
  return createObjStore({
    endpoint: OBJSTORE_LIVE,
    accessKeyId: env('OBJSTORE_ACCESS_KEY_ID') ?? 'test',
    secretAccessKey: env('OBJSTORE_SECRET_ACCESS_KEY') ?? 'test',
    bucketPrefix: env('R2_BUCKET_PREFIX') ?? '',
    region: env('OBJSTORE_REGION') ?? 'us-east-1',
    fetch: (url, init) => fetch(url, init as RequestInit),
    now: () => Date.now(),
  });
}
