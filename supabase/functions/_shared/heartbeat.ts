// cron 函数写心跳 private.heartbeat（架构 6.1；lemo-ops 经 usage-report 读“距今多少秒”和 detail 白名单里的个数）。
// 原来 account-purge、anniv-roll、backup-daily、storage-sweep、vault-file 各写一份同样的 upsert，收到这里一份（B7a 评审第 15 条）。
// 出错、没写进去一律抛（调用方决定记什么错误码）。不 import npm 包：只要求客户端有用到的这一点（supabase-js 的 service role 客户端照样能传）。

type Upserted = PromiseLike<{ error: unknown }>;
/** writeHeartbeat 用到的客户端（supabase-js 的 service role 客户端） */
export interface HeartbeatClient {
  schema(name: 'private'): { from(table: 'heartbeat'): { upsert(row: { name: string; at: string; detail: unknown }, opts: { onConflict: 'name' }): Upserted } };
}

export async function writeHeartbeat(admin: HeartbeatClient, name: string, detail: unknown, now: number = Date.now()): Promise<void> {
  const { error } = await admin.schema('private').from('heartbeat').upsert({ name, at: new Date(now).toISOString(), detail }, { onConflict: 'name' });
  if (error) throw new Error('heartbeat');
}
