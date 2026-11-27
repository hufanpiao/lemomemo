-- 20261104110000_core_occ_reset_ack.sql：离线合并出的旧“知道了”也清掉（11-04 B2 后端；接手清单 REMIND-offline-ack-merge，主持人定做法 ②）。
-- 现象：离线时先把日程挪到别的日期（或改当天 / 前一天、time 在空和非空之间变），再对挪之前那条旧通知按“知道了”，
--   outbox 把两次写合并成一个补丁 {date: 新日期, notified_for: 旧时刻}。20261104100000 ④ 的 events_occ_reset 见补丁显式写了 notified_for，
--   就照客户端的值保留；第 0 步 R-336 再用这个旧时刻判断“当天已提醒过”，新日期那一次可能被压住、不推。
-- 改法（服务器兜底，旧客户端也覆盖到）：换了“哪一次提醒”时，写进来的 notified_for 等于 old.remind_at（旧那一次的提醒时刻），
--   说明这次“知道了”针对的是旧的一次，照样清空；写的是别的值（例如本机按新那一次算出的时刻）照客户端的保留。
--   触发器本身（events_occ_reset，条件：date、remind_days 变了，或 time 在空和非空之间变了）不变，只 create or replace 函数，
--   保留属主和执行权（不授任何角色）；函数体除 notified_for 那一句的条件外逐字照 20261104100000 ④。
-- 只有一种情况会多清：新那一次的 remind_at 恰好和旧那一次相等（例如 11-05 当天 20:00 改成 11-06 前一天提醒，同是 11-05 20:00），
--   这时客户端按新那一次写的“知道了”也被清空，代价是同一时刻再推一次；比漏推安全。
-- 不依赖新函数，迁移和 push-dispatch 部署先后都可以。
create or replace function private.events_occ_reset() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.notified_for is not distinct from old.notified_for
     or (old.remind_at is not null and new.notified_for = old.remind_at) then new.notified_for := null; end if;
  if new.snooze_at is not distinct from old.snooze_at then new.snooze_at := null; end if;   -- 三轮审查 R3-L2：“稍后”也是旧那次的，和前端 B 一致
  new.pushed_for := null;
  return new;
end $$;
