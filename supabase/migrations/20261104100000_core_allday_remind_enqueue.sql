-- 20261104100000_core_allday_remind_enqueue.sql：全天日程提醒的入队缺口（11-04 B2 后端：全天日程提醒的服务器一侧）。
-- 【发布顺序：必须先部署 push-dispatch 函数（B2 全天日程版，会算全天日程），再推这个迁移】（11-04 定做法 1，
--   见 docs/08-发布/上线与回滚手册-v4.md 第三节“全天日程补算迁移”和第四节第 2 层）。反过来的话，旧函数算不了全天日程：
--   下面 ② 补算放进队列的行被旧函数出队即删、白白消耗掉，新函数上线后队列里已经没有这些行可以重算；
--   ① 的触发器在旧函数下也一样，改 default_time 入队的行被旧函数重算成空（原来有值的会被写成空）。
-- 背景：全天日程（events.time 为空）是浮动时刻，按 profiles.current_tz 算（架构 4.6）；remind_days = 0 是当天的设置 remind.default_time
--   （出厂 09:00；架构 0.29 续第 47、57 条），1 是前一天 20:00（shared/logic/remind.ts 的 allDayRemindAt）。remind_at 是派生列，
--   服务器只在 push-dispatch 第 0 步给队列里的行重算；events_remind 触发器（0002）只在这一行自己的列变了才入队。
-- 两个缺口：
--   ① 改了 remind.default_time，这个人的全天日程 remind_at 该变，但行没动、不入队。照 0005 的 private.enqueue_anniv_defaults()
--      （改纪念日默认提醒时入队，R-94）写一个同类触发器：settings 的 remind.default_time 新建、改值、软删或恢复、撤销或取消撤销时
--      （value、deleted_at、undone 三列；默认值“活着”的判断和本机一致：没软删、没撤销），把这个人没删的全天日程
--      （time 为空、remind_days 不为空）放进 remind_queue，重算结果和原来一样的第 0 步不写回。
--      remind_days = 1（前一天 20:00）其实不随 default_time 变，也一并入队：和下面的补算用同一个条件，多出的只是一次不写回的重算。
--   ② 一次性补算：B2 之前服务器算不了全天日程（remind.ts 没有全天分支），已有的全天日程 remind_at 可能是空的或客户端算的旧值；
--      time 为空、remind_days 不为空、deleted_at 为空的行全部入队，第 0 步按新逻辑重算（账号不可用的留在队列里，恢复后再算）。
-- 执行权（11-04 主持人定：选最小权限，不 grant）：和 0005 的 enqueue_anniv_defaults 不同，这里**不** grant execute 给任何角色。
--   理由：触发器函数在触发时不检查触发者的 EXECUTE 权限，只在 create trigger 时检查建触发器的人（迁移里是 postgres），
--   所以 authenticated 改 settings 照样会触发；多给的执行权只会让客户端能直接调这个函数，没有用处。
--   rls/32 用 authenticated 身份新建、改值、软删、恢复、撤销、取消撤销 settings，实测都会入队；值没变的更新不入队。也因此不用改 3.3 C、附录 A 和 D1 的 FUNCTION_EXEC。
-- 触发器函数一律 plpgsql、security definer、search_path 置空（0.23 L1、3.5）。

create function private.enqueue_allday_defaults() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into private.remind_queue (table_name, id)
    select 'events', e.id from public.events e
     where e.user_id = new.user_id and e.deleted_at is null and e.time is null and e.remind_days is not null
  on conflict do nothing;
  return null;
end $$;
-- 新建一个触发器、更新一个触发器（代码审查 L3）：更新时三列都没变（同步时原样再写一次）不入队
create trigger settings_allday_defaults_ins after insert on public.settings
  for each row when (new.key = 'remind.default_time')
  execute function private.enqueue_allday_defaults();
create trigger settings_allday_defaults_upd after update of value, deleted_at, undone on public.settings
  for each row when (new.key = 'remind.default_time' and (old.value is distinct from new.value
    or old.deleted_at is distinct from new.deleted_at or old.undone is distinct from new.undone))
  execute function private.enqueue_allday_defaults();

-- ② 一次性补算
insert into private.remind_queue (table_name, id)
  select 'events', e.id from public.events e
   where e.time is null and e.remind_days is not null and e.deleted_at is null
on conflict do nothing;

-- ③ 时区恢复以后补算（代码审查 L2）：current_tz 认不出时，第 0 步跳过全天日程、不写回，补算出来的那批 remind_at 一直是空的；
--   之后时区恢复（report_tz 采纳、tz_fixed_reset）调 enqueue_floating，原来只收 remind_at > now 的行，空的永远不会被重算。
--   events 一句加上“remind_at 为空、remind_days 不为空”（全天日程设了提醒但还没算出来）；待办原来就有同样的缺口（审查注明），
--   一并加上“remind_at 为空、设了提醒”：没有时刻的看 remind_days，有时刻的看 remind_before_min（和 shared todoRemindAt 的
--   两个分支一致）。多收的只是已过、算出来仍为空的行，第 0 步重算结果相同不写回。纪念日不改：第 0 步现在不重算纪念日（annivNext 留给 B5）。
--   create or replace 保留属主和执行权（仍然不授任何角色，rls/07 的断言不变）；函数体除 events、todos 两句的条件外逐字照
--   20261029192000_core_devices_sessions.sql。
create or replace function private.enqueue_floating(p_user uuid) returns void
  language plpgsql set search_path = '' as $$
declare now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  insert into private.remind_queue (table_name, id)
    select 'events', e.id from public.events e
     where e.user_id = p_user and e.deleted_at is null and e.time is null
       and (e.remind_at > now_ms or (e.remind_at is null and e.remind_days is not null))
  on conflict do nothing;
  insert into private.remind_queue (table_name, id)
    select 'todos', t.id from public.todos t
     where t.user_id = p_user and t.deleted_at is null and not t.done
       and (t.remind_at > now_ms or (t.remind_at is null and t.due is not null
            and ((t.due_time is null and t.remind_days is not null) or (t.due_time is not null and t.remind_before_min is not null))))
  on conflict do nothing;
  insert into private.remind_queue (table_name, id)
    select 'anniversaries', a.id from public.anniversaries a
     where a.user_id = p_user and a.deleted_at is null and a.remind_at > now_ms
  on conflict do nothing;
end $$;

-- ④ 换了“哪一次提醒”时清空提醒记录（二轮审查 N-M1，11-04 主持人定做法 ①）：R-336 在第 0 步按“pushed_for / notified_for 和新 remind_at
--   落在同一天”认“当天已经提醒过”，只该压住“同一次提醒、只是 default_time 变了”的情况。日程挪了日期、改了当天 / 前一天（remind_days）、
--   time 从空变有或从有变空时，就是另一次提醒（和本机 occurrenceKey = event:<id>:allday:<日期>:<remind_days> 一致），旧的记录不能再算数：
--   这里把 notified_for、snooze_at、pushed_for 置空，第 0 步就照常写新的 remind_at、到点照推（P1、P1b、P2）。本机编辑时前端 B 同样清空，两边一致。
--   · notified_for、snooze_at（三轮审查 R3-L2，和前端 B 一致）：这次更新自己没改它才清（客户端同一个补丁里显式写了新值就照它的）；
--   · pushed_for：系统列，客户端写不了，一律清（touch() 对这几列的变化本来也清 pushed_for、defer_until，这里写明、不依赖它）；
--     代价是挪日期前那条旧通知不再由 resolve 收回（主持人已知）。
--   触发器名 events_occ_reset 按字母排在 events_touch 之前：touch() 再看到 notified_for、snooze_at 变了，照常记 fv、加 rev，同步能把“已清空”带回各端。
--   函数只改 NEW、不读写任何表；照本文件头的写法 plpgsql、security definer、search_path 置空，不授执行权（理由同上）。
create function private.events_occ_reset() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.notified_for is not distinct from old.notified_for then new.notified_for := null; end if;
  if new.snooze_at is not distinct from old.snooze_at then new.snooze_at := null; end if;   -- 三轮审查 R3-L2：“稍后”也是旧那次的，和前端 B 一致
  new.pushed_for := null;
  return new;
end $$;
create trigger events_occ_reset before update of date, time, remind_days on public.events
  for each row when (old.date is distinct from new.date or old.remind_days is distinct from new.remind_days
    or (old.time is null) <> (new.time is null))
  execute function private.events_occ_reset();
