-- 20261105120000_core_allday_ack_enqueue.sql：全天日程改了默认时刻以后按的“知道了”，让服务器能收回已推的那条（REMIND-shown-persist S1，
-- 11-05 主持人定修；方案 docs/03-评审/B2/B2-方案-提醒响过持久化.md 第 7 节）。
-- 问题：全天日程 07:00 推过（pushed_for = 07:00），用户把 remind.default_time 改成 07:20，第 0 步 R-336 判“这一天推过”、remind_at 保持 07:00；
--   客户端“知道了”写的是本机现算的 07:20（ackPatch：notified_for = 本机 remindAt）。于是 notified_for ≠ remind_at、due_at 仍等于 pushed_for，
--   private.remind_pushed 的 resolve 条件一条都不成立，安卓、Edge 上 07:00 那条推送收不回来（iPhone 本来不发 resolve）；
--   而且这次写入只改 notified_for，不在 events_remind 的触发列里，这一行不进 remind_queue，第 0 步也不会再看它。
-- 改法（两半一起上）：
--   ① 本迁移：触发器 events_allday_ack_enqueue——全天日程（time 为空、没删）的 notified_for 改成了一个不等于 remind_at 的值时入 remind_queue，
--      复用 private.enqueue_remind（同 events_remind 的入口：已在队列里且正被租着或取过的清租约、attempts 清零，迁移 20261104130000 ④）。
--   ② push-dispatch 第 0 步（round-step0.ts）：R-336 压住之前先看 notified_for 是不是正好等于新算出的 remind_at，是就照写回。
--      写回后 notified_for = remind_at：第 1 步不算到点（不会在 07:20 再推一次），remind_pushed 的“按了知道了”成立，同一轮发 resolve。
--   不在 SQL 里按时区换算日期（例如 resolve 改成“notified_for 和 remind_at 按 current_tz 同一天”）：current_tz 坏了会让 at time zone 报错、
--   整个 remind_pushed 失败、全站 resolve 停掉（20261103140000 ④ 不在 SQL 里认时区名的理由同此）；时区只在 TS 里认（R-316）。
-- 触发条件里比的是 new 的值（before 触发器 events_occ_reset 处理过以后）：挪日期时合并进来的旧时刻被它清空，这里就不再入队（挪日期本身由 events_remind 入队）。
-- 只多了一次入队，不改任何列、不授任何权限：enqueue_remind 的属主、security definer、search_path、执行权都不变（触发时不检查触发者的 EXECUTE 权限）。
-- 不提醒的全天日程（remind_days 为空）不入队：第 0 步算出来是空、和原值相同、不写，入队只是多一次空算（11-05 安全审查 A1）。
-- 有时刻的日程、待办不加：它们的 remind_at 不会被 R-336 压住，客户端算的和服务器一致，notified_for = remind_at 照常成立。
set local lock_timeout = '5s';   -- create trigger 要拿 events 的 ShareRowExclusive 锁，长事务占着时 5 秒内失败回滚（写法同 20261104130000）

create trigger events_allday_ack_enqueue after update of notified_for on public.events
  for each row when (new.time is null and new.deleted_at is null and new.remind_days is not null and new.notified_for is not null
    and new.notified_for is distinct from old.notified_for and new.notified_for is distinct from new.remind_at)
  execute function private.enqueue_remind();
