// 两连接脚本 tools/db/remind-queue-2conn.mjs 的“不等锁”判定（纯函数，单测 tests/build/remind-queue-2conn-guard.test.ts 直接 import）。
// 11-05 租约出队安全复审五 R5-2：纯函数单放这里，脚本本身不再用“import.meta.url 等于 argv[1]”判断是不是直接运行
//   （经符号链接、目录联接调用时两边对不上，main() 不跑、无输出、退出码 0，CI 会假绿），脚本里直接调 main()。

/** 拼进 SQL 的几句（毫秒）：这条语句在服务器上的耗时、开始时刻、此刻 */
export const STMT_MS = 'round(extract(epoch from clock_timestamp() - statement_timestamp()) * 1000)';
export const START_MS = 'round(extract(epoch from statement_timestamp()) * 1000)';
export const NOW_MS = 'round(extract(epoch from clock_timestamp()) * 1000)';

/**
 * 按服务器上的证据判“不等锁”（时刻都取自同一个库的时钟，毫秒）：
 *   holderCommitAt：持锁方在 commit 之前、同一事务里 sleep 之后取的时刻（R5-1 ①）——真正放锁只会比它晚，
 *     所以等了锁的语句一定在它之后结束；原来在 commit 之后另取一条，比放锁晚一个来回，竞态下会把等锁误判成通过。
 *   startAt：另一边这条语句的开始时刻（R5-1 ②）。晚于 holderCommitAt 说明它开始时锁已经放了（CI 上起 psql 要 5～6 秒），
 *     这一轮根本没测到，单独报“起晚了”，不当成“等了锁”，也不算通过。
 */
export function noWaitVerdict({ startAt, serverMs, endAt, holderCommitAt }) {
  if (![startAt, serverMs, endAt, holderCommitAt].every(Number.isFinite)) return { ok: false, late: false, why: '没拿到服务器时刻' };
  if (startAt >= holderCommitAt) {
    return { ok: false, late: true, why: `起晚了：持锁方快提交时（${Math.round(startAt - holderCommitAt)} 毫秒前）这条语句还没开始，这一轮没测到（不算通过；持锁再拉长或查 CI 起 psql 为什么慢）` };
  }
  if (endAt >= holderCommitAt) return { ok: false, late: false, why: `持锁方提交以后才结束（晚 ${Math.round(endAt - holderCommitAt)} 毫秒），等了它的锁` };
  if (serverMs >= 1000) return { ok: false, late: false, why: `服务器上耗时 ${Math.round(serverMs)} 毫秒` };
  return { ok: true, late: false, why: '' };
}
