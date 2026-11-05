// 两连接脚本 tools/db/remind-queue-2conn.mjs 的“不等锁”判定（纯函数，单测 tests/build/remind-queue-2conn-guard.test.ts 直接 import）。
// 11-05 租约出队安全复审五 R5-2：纯函数单放这里，脚本本身不再用“import.meta.url 等于 argv[1]”判断是不是直接运行
//   （经符号链接、目录联接调用时两边对不上，main() 不跑、无输出、退出码 0，CI 会假绿），脚本里直接调 main()。

/** 拼进 SQL 的几句（毫秒）：这条语句在服务器上的耗时、开始时刻、此刻 */
export const STMT_MS = 'round(extract(epoch from clock_timestamp() - statement_timestamp()) * 1000)';
export const START_MS = 'round(extract(epoch from statement_timestamp()) * 1000)';
export const NOW_MS = 'round(extract(epoch from clock_timestamp()) * 1000)';

/**
 * 按服务器上的证据判“不等锁”（时刻都取自同一个库的时钟，毫秒）：
 *   holderCommitAt：持锁方在 commit 之前、同一事务里 sleep 之后取的时刻（R5-1 ①）——真正放锁只会比它晚。
 *   startAt：另一边这条语句的开始时刻（R5-1 ②）。晚于 holderCommitAt 说明它开始时锁已经放了，这一轮根本没测到，单独报“起晚了”。
 *   err：这条语句的 psql 报错（退出码 0 时传空；里面可能夹着 auto_explain 的 NOTICE，取 ERROR 那一行）。
 *     含 lock timeout 的（函数自己的 lock_timeout 5 秒，持锁 7 秒更长）判“等锁”（R6-1）。
 *   lockSeen：语句执行期间每 250 毫秒采样它自己的 pg_stat_activity（wait_event_type、pg_blocking_pids），
 *     看到过 Lock 等待或被别的连接拦着 = true，采了样一次都没有 = false，没采到样（语句不到 250 毫秒就完了）= undefined。
 * 11-05 CI（3516b93）复盘：连接 2 服务器上 9833 毫秒、在持锁方提交以后 3001 毫秒才结束，但 1.5 秒时它自己是 -/-、阻塞列表为空——
 *   在跑、不在等锁。原来只凭“提交以后才结束”就写“等了它的锁”是错的：结束时刻在后只是时间先后。现在分开记：
 *   kind = '等锁'（报错是 lock timeout，或采样看到在等锁）、'慢'（耗时 ≥ 1 秒或在持锁方提交后才结束，但采样没看到等锁）、
 *   '起晚了'、'报错'、'没时刻'、'通过'。除“通过”外都不算通过（慢也不放过：这一轮测不出“不等锁”，要查为什么慢）。
 * @param {{ startAt: number, serverMs: number, endAt: number, holderCommitAt: number, err?: string, lockSeen?: boolean | undefined }} p
 */
export function noWaitVerdict({ startAt, serverMs, endAt, holderCommitAt, err = '', lockSeen }) {
  const lines = String(err ?? '').split(/\r?\n/u).map((l) => l.trim()).filter((l) => l !== '');
  const first = lines.find((l) => /^(ERROR|FATAL|PANIC|psql:)/u.test(l)) ?? lines.find((l) => !/^(NOTICE|DETAIL|CONTEXT|HINT|LOG|Query Text|->|Buffers|Planning|Execution)/u.test(l)) ?? lines[0] ?? '';
  if (first !== '') {
    if (/lock[ _]timeout/iu.test(String(err))) return { ok: false, late: false, kind: '等锁', why: `等锁：撞到 lock_timeout（${first}）` };
    return { ok: false, late: false, kind: '报错', why: `语句报错：${first}` };
  }
  if (![startAt, serverMs, endAt, holderCommitAt].every(Number.isFinite)) return { ok: false, late: false, kind: '没时刻', why: '没拿到服务器时刻' };
  if (startAt >= holderCommitAt) {
    return { ok: false, late: true, kind: '起晚了', why: `起晚了：持锁方快提交时（${Math.round(startAt - holderCommitAt)} 毫秒前）这条语句还没开始，这一轮没测到（不算通过；持锁再拉长或查 CI 起 psql 为什么慢）` };
  }
  const afterCommit = endAt >= holderCommitAt;
  const slow = serverMs >= 1000;
  if (!afterCommit && !slow) return { ok: true, late: false, kind: '通过', why: '' };
  const ms = `服务器上 ${Math.round(serverMs)} 毫秒`;
  const after = afterCommit ? `，在持锁方提交以后才结束（晚 ${Math.round(endAt - holderCommitAt)} 毫秒）` : '';
  if (lockSeen === true) return { ok: false, late: false, kind: '等锁', why: `等锁：执行中采样看到它在等锁（Lock 等待或被别的连接拦着）；${ms}${after}` };
  if (lockSeen === false) {
    return { ok: false, late: false, kind: '慢', why: `慢：${ms}${after}；执行中每次采样都没在等锁（不是锁的问题；结束时刻在后只是时间先后），计划见上面 auto_explain 的输出` };
  }
  return { ok: false, late: false, kind: '慢', why: `慢：${ms}${after}；没采到它的等待状态，分不清是不是等锁` };
}
