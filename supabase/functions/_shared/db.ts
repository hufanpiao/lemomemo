// 直连数据库（6.2）：只给 fn_vault、fn_ai 两个低权限角色用，禁止 SUPABASE_DB_URL
// 谁能 import 本文件、读哪个连接串由 CI 管（TC-B0-35，build/check_backend.py 的 F1、F2，名单写在那里）：vault、vault-file、account 用 fn_vault；
// ai-embed、ai-media、note-search、ai-summarize、file-check 以及只验 pin_epoch 的 ai-parse、ai-voice、vault-image 用 fn_ai
// 每次请求开一个连接、用完就关，不做连接池（Edge Function 是短进程）；走 Supavisor 事务模式，关掉预编译（prepare: false，待 B0 实测）
// 角色写死在导出名里（B1 接手清单 S3 复审必改，乙方案）：withVaultUser / withVaultScan 用 fn_vault，withAiUser / withAiScan 用 fn_ai，
//   不收角色参数——F2 按 import 了哪个导出名判断（改名导入看原名），角色名拼出来也没用；对本文件禁止 import * as、动态 import、export *（F7）。
//   改导出名要同时改 build/check_backend.py 的 DB_EXPORTS
// 部署时函数没有 import map，写全 npm: 版本（和 package.json 一致，tests/build/deno-config.test.ts 核对）
import postgres from 'npm:postgres@3.4.5';

type FnRole = 'fn_vault' | 'fn_ai';   // 只在本文件里用，不导出
export type Tx = postgres.TransactionSql;

const URL_ENV: Record<FnRole, string> = { fn_vault: 'FN_VAULT_DB_URL', fn_ai: 'FN_AI_DB_URL' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT = '4min';   // 0.29 续第 141 条：和 cron、service_role 同一个上限

function connect(role: FnRole) {
  const url = Deno.env.get(URL_ENV[role]);
  if (!url) throw new Error(`${URL_ENV[role]} 未设置`);
  // 强制 TLS（10-28 安全审查严重 1）：postgres.js 3.4.5 默认 ssl: false，连接串里没写 sslmode 就是明文，密码和数据都在公网上裸传。
  // 这里写死 'require'，不依赖连接串（连接串里的 sslmode 会被这个选项盖掉，连接串写成 disable 也没用）；服务器不肯加密时直接报错，不降级成明文。
  // 'require' 只加密、不校验证书（postgres.js 对它传 rejectUnauthorized: false）：Supavisor 连接池的证书是不是由 Supabase 自己的根证书
  // （控制台可下载的 prod-ca-2021.crt）签发，离线没法确认，改成 { ca, rejectUnauthorized: true } 之前要在预览项目上实测（后端-B0实测清单 P6）
  // 本机开发（10-28 安全复审低 C，这次只写注释、不改代码）：supabase functions serve 连本地库（54322）时，本地 Postgres 不一定开了 SSL，
  // 可能被这里的 'require' 挡住（是否挡住见实测清单 P6）。真要留口子，只能按主机名放行（127.0.0.1、host.docker.internal、supabase_db_*），
  // 绝不接受连接串里的 sslmode=disable——连接串来自 secrets，按连接串放行就等于谁能改 secrets 谁就能关掉加密
  return postgres(url, { ssl: 'require', prepare: false, max: 1, connect_timeout: 10, idle_timeout: 5 });
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
function withUser<T>(role: FnRole, uid: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(uid)) throw new Error('bad_user_id');
  return run(role, uid, fn);
}

/**
 * 跨用户扫描：不设 app.uid，基表上的策略一行都不放行，只能读 private.scan_* 四个视图（只有定位列）。
 * 扫出 user_id 以后，必须再按用户调 withUser 读内容。
 */
function withScan<T>(role: FnRole, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return run(role, null, fn);
}

/** fn_vault 按用户开事务（见 withUser）：只给 vault、vault-file、account */
export function withVaultUser<T>(uid: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withUser('fn_vault', uid, fn);
}

/** fn_vault 跨用户扫描（见 withScan）：只给 vault、vault-file、account */
export function withVaultScan<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withScan('fn_vault', fn);
}

/** fn_ai 按用户开事务（见 withUser）：只给 fn_ai 名单里的函数 */
export function withAiUser<T>(uid: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withUser('fn_ai', uid, fn);
}

/** fn_ai 跨用户扫描（见 withScan）：只给 fn_ai 名单里的函数 */
export function withAiScan<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withScan('fn_ai', fn);
}
