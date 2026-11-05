-- 20261105130000_core_purge_backups_cursor.sql：account-purge 删 backups 桶时记“删到哪个日期”（接手清单 PURGE-date-cursor，11-05 后端）。
-- 问题：有几百个备份日期的账号要几十轮才删完（本机 400 个日期要 28 轮、约 3 天）——每轮都从头把已删空的日期再列一遍，
--   预算花在“列空日期”上（PURGE-cpu-budget 返工回报）。
-- 改法：pending_deletions 加 backups_done_through（text，可空）：account-purge 按名字升序删 backups 的日期目录，
--   停下（预算用完）之前把“从头起连续确认删空的最后一个日期”写进来（只许往后推，条件里带自己的认领时刻）；下一轮跳过不大于它的日期。
--   规则在 supabase/functions/account-purge/core.ts 的 backupDatesToScan：只认 YYYY-MM-DD 或 YYYYMMDD 这种按字符串排序就是时间顺序的名字，
--   别的名字每轮照列；列出来的最后一个日期永远不跳、也不记（当天的备份可能还在写）；最新的 8 个日期也永远照列（BACKUP_RECENT_KEEP，
--   守住“backup-daily 只往当天写”不成立时补写的最近几天，11-05 审查 M2），游标只省更老的那些。
-- 游标随这次注销申请走：requested_at 变了（account_request_deletion 的 on conflict 分支重写申请）就由触发器清空，
--   不改 account_request_deletion 本身（它的 lock_timeout、授权都挂在函数上）。restore 删掉整行，游标一起没了。
-- 授权不变：0001 给 service_role 的是表级 select、update（新列自动包括在内），别的角色对 private 没有权限。
set local lock_timeout = '5s';   -- alter table、create trigger 要拿 pending_deletions 的锁，长事务占着时 5 秒内失败回滚（写法同 20261104130000）

alter table private.pending_deletions add column backups_done_through text
  check (backups_done_through is null or backups_done_through ~ '^([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{8})$');   -- 和 core.ts 的 BACKUP_DAY 同一个正则（11-05 审查 S1）

create function private.pending_deletions_cursor_reset() returns trigger
  language plpgsql set search_path = '' as $$
begin
  if new.requested_at is distinct from old.requested_at then new.backups_done_through := null; end if;
  return new;
end $$;
-- 执行权：同 20261104100000 的 events_occ_reset，不 grant、不另写 revoke（只当触发器用；触发时不检查触发者的 EXECUTE 权限，private 别的角色本来就用不了）

create trigger pending_deletions_cursor_reset before update of requested_at on private.pending_deletions
  for each row execute function private.pending_deletions_cursor_reset();
