// TC-B0-117 真链路（purge-runner.ts 的 startLivePurge）和 store-it（supabase/tests/store-it/harness.ts）共用的会话级锁：
// 两边都调 account-purge，它处理库里所有到期的 pending_deletions，同时跑会互相把对方的到期行当成“别人的”，或删掉对方的用户，所以串行。
// 等锁有上限：锁连接上设 lock_timeout（Postgres 对 pg_advisory_lock 的等待同样生效），到点语句被取消、锁没拿到，
// 不会在后台继续等、事后再拿到；报“等锁超时”，之后把 lock_timeout 复原。纯 TS，Node（vitest）和 Deno 都能用

/** pg_advisory_lock 的键 */
export const LIVE_LOCK = 117_117;
/** 最多等多久（秒）：vitest 那边 beforeAll 的超时是 60 秒，要比它短，才能报出“等锁超时”而不是笼统的钩子超时 */
export const LIVE_LOCK_WAIT_S = 45;

/** postgres.js 的 sql / reserve() 连接都满足（只用模板调用；写成方法签名取参数双变，返回值只 await） */
type Tag = { q(s: TemplateStringsArray, ...v: (string | number)[]): unknown }['q'];

/** 在这条连接上拿锁；等满 waitS 秒拿不到就抛“等锁超时”（锁没拿到）。会话级锁，调用方用同一条连接 unlock 或断开 */
export async function takeLiveLock(conn: Tag, waitS = LIVE_LOCK_WAIT_S): Promise<void> {
  await conn`select set_config('lock_timeout', ${`${waitS}s`}, false)`;
  try {
    await conn`select pg_advisory_lock(${LIVE_LOCK})`;
  } catch (e) {
    if ((e as { code?: string }).code === '55P03') {
      throw new Error(`等锁超时（${waitS} 秒，advisory lock ${LIVE_LOCK}）：可能有别的测试在跑（TC-B0-117 真链路或 store-it），等它跑完再试`);
    }
    throw e;
  } finally {
    // 连接已断时复原也会抛错：吞掉，免得盖掉原来的报错（LocalStack 批复查建议 ②）
    try {
      await conn`select set_config('lock_timeout', '0', false)`;
    } catch {
      // 不抛：保留 try 里原来的报错
    }
  }
}
