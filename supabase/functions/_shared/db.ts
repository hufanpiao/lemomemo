// 直连数据库（6.2）：只给 fn_vault、fn_ai 两个低权限角色用，禁止 SUPABASE_DB_URL
// 谁能 import 本文件、读哪个连接串由 CI 管（TC-B0-35）：vault、vault-file、account 用 fn_vault；
// ai-embed、ai-media、note-search、ai-summarize、file-check 以及只验 pin_epoch 的 ai-parse、ai-voice、vault-image 用 fn_ai
// 每次请求开一个连接、用完就关，不做连接池（Edge Function 是短进程）；走 Supavisor 事务模式，关掉预编译（prepare: false，待 B0 实测）
import postgres from 'npm:postgres@3.4.5';

export type FnRole = 'fn_vault' | 'fn_ai';
export type Tx = postgres.TransactionSql;

const URL_ENV: Record<FnRole, string> = { fn_vault: 'FN_VAULT_DB_URL', fn_ai: 'FN_AI_DB_URL' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT = '4min';   // 0.29 续第 141 条：和 cron、service_role 同一个上限

function connect(role: FnRole) {
  const url = Deno.env.get(URL_ENV[role]);
  if (!url) throw new Error(`${URL_ENV[role]} 未设置`);
  return postgres(url, { prepare: false, max: 1, connect_timeout: 10, idle_timeout: 5 });
}

async function run<T>(role: FnRole, uid: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const sql = connect(role);
  try {
    // begin … commit，出错自动 rollback；两句设置都只在本事务内有效，事务模式的 Supavisor 下不会串到别的请求
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local statement_timeout = '${TIMEOUT}'`);
      if (uid) await tx`select set_config('app.uid', ${uid}, true)`;
      return fn(tx);
    })) as T;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * 按用户开事务：第一句 set local statement_timeout，第二句 set_config('app.uid', uid, true)，会话变量版 RLS 只放行这一个用户的行。
 * uid 只能来自 requireActiveUser 验过的 JWT，或 cron 从扫描视图拿到、已经 isUsable 过的 user_id。
 * SQL 一律用 tx`…${参数}` 的写法，不拼字符串。
 */
export function withUser<T>(role: FnRole, uid: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(uid)) throw new Error('bad_user_id');
  return run(role, uid, fn);
}

/**
 * 跨用户扫描：不设 app.uid，基表上的策略一行都不放行，只能读 private.scan_* 四个视图（只有定位列）。
 * 扫出 user_id 以后，必须再按用户调 withUser 读内容。
 */
export function withScan<T>(role: FnRole, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return run(role, null, fn);
}
