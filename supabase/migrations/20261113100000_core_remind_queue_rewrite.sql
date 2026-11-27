-- 20261113100000_core_remind_queue_rewrite.sql：提醒队列重写 M1（R-411，范围 A；方案 docs/10-架构/方案-提醒队列重写.md 第 3、4.2 节，负责人 11-13 定 6.3 五条照推荐）。
-- 一类事一个出口：
--   入队只经 private.remind_enqueue（全仓唯一一句 insert into private.remind_queue；scope：row / floating / allday / anniv / all）；
--   “哪些列算提醒输入”只有 table_meta.remind_cols 一份（清单 remindCols 随第三阶段接上 D1 比对）；
--   一行改了要清什么只在 private.remind_reset（touch() 里调一行，原来的 events_occ_reset 前置触发器和 touch() 提醒段都删掉，没有名字先后的依赖）；
--   要不要入队只在 private.enqueue_remind（三张表各一个不带列清单的 after 触发器）；设置改了只在 private.remind_on_settings（一个触发器，按键分派）。
-- 队列表加 user_id（外键级联）、prio（0 用户改的，1 批量里 24 小时内到点或还没算的，2 其余批量）、min_ver（规则版本，出队按 p_ver 放行）、
--   fresh（待办新建或改了截止，给第 0 步回落用，6.3 Q2）、enqueued_at（只给积压统计用，不进排序）。
-- 出队 remind_queue_pop 换签名：每人上限、有毒次数、规则版本改成参数（带默认值，旧 push-dispatch 按名字传三个参数照跑），多返回 fresh；
--   候选直接用 q.user_id，删孤儿那段整段删掉（孤儿带着 user_id 照常出队，第 0 步读不到行就不放回、finish 按租约删；注销的由外键级联删）；
--   排序：每人内按 (prio, table_name, id) 编号，跨用户按 (prio, 每人编号, table_name, id)，用户自己改的全站先算。
-- 批量入队收“这一次还没过完”的，不改现状（6.3 Q3 A）、只去掉重算了也推不出去的（修 P16）；口径写在 remind_enqueue 上面（11-13 整块评审必改 1 改过：
--   原来一律按 remind_at > 现在收，改默认时刻时把“稍后”、免打扰顺延还没响的那条也挡在外面，改了 P12 的现状）。纪念日按人入队补“为空”（修 P3）。
-- 不改提醒算法，不做全量重算（方案 3.3 ④：以后改算法时版本号加 1、加一句 remind_enqueue('all', …)）；不写一次性补算（4.2 第 10 步）。
-- 锁：开头按“四张业务表 → table_meta → 队列”拿（单句写入是先业务表、touch() 里再读 table_meta、最后写队列），lock_timeout 5 秒拿不到整个迁移回滚，重推即可；
--   用户的多表事务（先写随手记、再写日程）先拿了 table_meta 的共享锁，可能和这里互等成死锁，被选中中止的是迁移就整体回滚，重推即可；
--   第 9 步的外键最后才拿 auth.users，和正在跑的注销同样可能死锁回滚。推之前用 private.long_transactions() 看有没有长事务、看一眼队列行数（方案 4.2 末段）。
-- supabase CLI 推迁移是把一份文件的语句一次性管道发出（不是显式事务块，整份到最后才结束事务）：顶层的 lock table 会报 25P01，
--   所以放进 do 块（函数里的 lock table 不要求显式事务块，锁拿到这份迁移结束）；set local 在这种推法下照样管到最后，
--   do 块开头再核一次两个超时真的生效了，没生效就报错停下，不在没有超时保护的情况下硬推（lemo-e2e 起库时实测，11-13）。

set local lock_timeout = '5s';
set local statement_timeout = '4min';
do $$
begin
  if current_setting('lock_timeout') <> '5s' or current_setting('statement_timeout') <> '4min' then
    raise exception 'R-411 迁移：set local 没生效（等锁上限 %，语句上限 %），停下', current_setting('lock_timeout'), current_setting('statement_timeout');
  end if;
  lock table public.settings, public.events, public.todos, public.anniversaries in access exclusive mode;
  lock table private.table_meta in access exclusive mode;   -- 第 2 步 alter 要它；从这里起所有同步表的写入都等着（touch() 要读它）
  lock table private.remind_queue in access exclusive mode;
end $$;

-- ===== 1. 队列表加列；按三张表回填 user_id，回填不到的是孤儿（旧出队函数下一轮本来也要删），删掉 =====
alter table private.remind_queue
  add column user_id uuid,
  add column prio smallint not null default 0,
  add column min_ver smallint not null default 0,
  add column fresh boolean not null default false,
  add column enqueued_at timestamptz not null default now();
update private.remind_queue q set user_id = e.user_id from public.events e where q.table_name = 'events' and e.id = q.id;
update private.remind_queue q set user_id = t.user_id from public.todos t where q.table_name = 'todos' and t.id = q.id;
update private.remind_queue q set user_id = a.user_id from public.anniversaries a where q.table_name = 'anniversaries' and a.id = q.id;
delete from private.remind_queue q where q.user_id is null;
alter table private.remind_queue alter column user_id set not null;
create index remind_queue_user_id_idx on private.remind_queue (user_id);

-- ===== 2. table_meta.remind_cols：变了要重算、并清 pushed_for、defer_until 的列（逐列照 0001:67-71、0002:37、82、0005:31-32） =====
-- snooze_at 三张表都是“变了只重算、不清”，不进这一列，写在 enqueue_remind 里
alter table private.table_meta add column remind_cols text[] not null default '{}';
update private.table_meta set remind_cols = '{date,time,tz,remind_min,remind_days,deleted_at}' where tbl = 'events';
update private.table_meta set remind_cols = '{due,due_time,remind_before_min,remind_days,remind_time,done,deleted_at}' where tbl = 'todos';
update private.table_meta set remind_cols = '{remind_offsets,remind_time,month,day,calendar,lunar_variant,is_leap,year,after_due,kind,deleted_at}'
 where tbl = 'anniversaries';

-- ===== 3. 新函数 =====
-- 唯一入队。invoker、不授任何角色：只被下面几个 security definer 函数（属主 postgres）和迁移调；收任意 user_id，绝不能授给客户端。
-- row：就是这一行（p_tn、p_id、p_user 来自 after 触发器的 NEW），prio 0。批量（floating / allday / anniv / all）从三张表按行上的 user_id 选，
--   收“这一次还没过完”的，范围是原来各入口的子集、只去掉重算了也推不出去的（修 P16，不改现状：6.3 Q3 A；唯一多收的是 floating 里 remind_at 为空的纪念日，修 P3）：
--   floating（时区）照原 enqueue_floating：没到点（remind_at > 现在）或还没算（为空且设了提醒）；
--   allday（改默认时刻）、all 的日程和待办：日期（日程 date、待办 due）还没过两天以上，或“稍后”、免打扰顺延还在 1 小时以内——
--     第 1 步只回看 1 小时（round-types.ts BEHIND_MS），日期过了两天的（时区最多差 14 小时，再留一天）重算出来也推不出去；
--     当天推过的、按了“稍后”的、被免打扰顺延的照原来一样重算（P12 照现状挪到新默认时刻；这一天推过的由第 0 步 R-336 压住不重推）；
--   anniv（改纪念日默认）和 all 的纪念日：每年都会再来，不看时间，照原 enqueue_anniv_defaults。
--   all 现在没有调用方；第一次真用之前要核：有时刻的日程、待办当天推过、新规则又把时刻挪到将来的，没有 R-336 压着，会不会再推一次。
--   “设了提醒”是 shared/logic/remind.ts 各分支的粗判（宁多勿少，只用来少入队），以后加提醒字段要一起改。
-- 每个分支开头只看参数的条件（p_scope = …）在执行时一次判定，不在本 scope 的分支整支跳过；按人的分支和全站的分支分开写，按人的走 user_id 索引。
-- 冲突时：user_id 换成这一次的（行被硬删后同一个 id 被别人重用时跟着换主人）；清租约、attempts 清零（R-348：正在处理时又有改动，finish 删不到它）；
--   prio 取小、fresh 取或、min_ver 取大；什么都不用改时不写（where）。enqueued_at 只在 prio 变小时记成现在（批量项被用户改成 prio 0，
--   积压统计从这时算起，不带着几小时前的批量入队时间误报；评审建议 3），其余一直在等的就一直算着。
create function private.remind_enqueue(p_scope text, p_user uuid, p_tn text, p_id uuid, p_fresh boolean, p_min_ver smallint) returns void
  language plpgsql set search_path = '' as $$
declare
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  soon bigint := (extract(epoch from now()) * 1000)::bigint + 86400000;
  win bigint := (extract(epoch from now()) * 1000)::bigint - 3600000;
  cut date := (now() at time zone 'UTC')::date - 2;
begin
  if p_scope is null or p_scope not in ('row', 'floating', 'allday', 'anniv', 'all') then
    raise exception 'remind_enqueue_scope: %', p_scope;
  end if;
  insert into private.remind_queue as q (table_name, id, user_id, prio, fresh, min_ver)
  select c.tn, c.rid, c.uid, c.pr, coalesce(p_fresh, false), coalesce(p_min_ver, 0::smallint)
    from (
      select p_tn as tn, p_id as rid, p_user as uid, 0::smallint as pr where p_scope = 'row'
      union all
      -- 时区（floating）：这个人的全天日程
      select 'events', e.id, e.user_id, (case when e.remind_at is null or e.remind_at <= soon then 1 else 2 end)::smallint
        from public.events e
       where p_scope = 'floating' and e.user_id = p_user and e.deleted_at is null and e.time is null
         and (e.remind_at > now_ms or (e.remind_at is null and e.remind_days is not null))
      union all
      -- 改默认时刻（allday）：这个人设了提醒的全天日程
      select 'events', e.id, e.user_id, (case when e.remind_at is null or e.remind_at <= soon then 1 else 2 end)::smallint
        from public.events e
       where p_scope = 'allday' and e.user_id = p_user and e.deleted_at is null and e.time is null and e.remind_days is not null
         and (e.date >= cut or e.snooze_at > win or e.defer_until > win)
      union all
      -- 规则版本（all）：全站设了提醒的日程
      select 'events', e.id, e.user_id, (case when e.remind_at is null or e.remind_at <= soon then 1 else 2 end)::smallint
        from public.events e
       where p_scope = 'all' and e.deleted_at is null
         and ((e.time is null and e.remind_days is not null) or (e.time is not null and e.remind_min is not null))
         and (e.date >= cut or e.snooze_at > win or e.defer_until > win)
      union all
      -- 时区（floating）：这个人没完成的待办
      select 'todos', t.id, t.user_id, (case when t.remind_at is null or t.remind_at <= soon then 1 else 2 end)::smallint
        from public.todos t
       where p_scope = 'floating' and t.user_id = p_user and t.deleted_at is null and not t.done
         and (t.remind_at > now_ms or (t.remind_at is null and t.due is not null
              and ((t.due_time is null and t.remind_days is not null) or (t.due_time is not null and t.remind_before_min is not null))))
      union all
      -- 规则版本（all）：全站没完成、设了提醒的待办
      select 'todos', t.id, t.user_id, (case when t.remind_at is null or t.remind_at <= soon then 1 else 2 end)::smallint
        from public.todos t
       where p_scope = 'all' and t.deleted_at is null and not t.done and t.due is not null
         and ((t.due_time is null and t.remind_days is not null) or (t.due_time is not null and t.remind_before_min is not null))
         and (t.due >= cut or t.snooze_at > win or t.defer_until > win)
      union all
      -- 纪念日按人：时区（floating）收没到点或还没算的；改默认（anniv）收用默认的，不看时间。
      -- 提醒偏移不会为空数组（0005 的 check：1～4 个；为空表示用默认），所以“设了提醒”就是没删
      select 'anniversaries', a.id, a.user_id, (case when a.remind_at is null or a.remind_at <= soon then 1 else 2 end)::smallint
        from public.anniversaries a
       where p_scope in ('floating', 'anniv') and a.user_id = p_user and a.deleted_at is null
         and (p_scope = 'anniv' or a.remind_at > now_ms or a.remind_at is null)
         and (p_scope = 'floating' or a.remind_offsets is null or a.remind_time is null)
      union all
      -- 规则版本（all）：全站没删的纪念日
      select 'anniversaries', a.id, a.user_id, (case when a.remind_at is null or a.remind_at <= soon then 1 else 2 end)::smallint
        from public.anniversaries a
       where p_scope = 'all' and a.deleted_at is null
    ) c
  on conflict (table_name, id) do update set user_id = excluded.user_id, claim = null, claimed_at = null, attempts = 0,
      prio = least(q.prio, excluded.prio), fresh = q.fresh or excluded.fresh, min_ver = greatest(q.min_ver, excluded.min_ver),
      enqueued_at = case when excluded.prio < q.prio then now() else q.enqueued_at end
   where q.user_id is distinct from excluded.user_id or q.claim is not null or q.attempts > 0
      or excluded.prio < q.prio or (excluded.fresh and not q.fresh) or excluded.min_ver > q.min_ver;
end $$;

-- 一行改了要清什么。只被 touch() 调（在“截止日期清空连带清截止时刻”之后、比较 fv 之前，所以清掉的 notified_for、snooze_at 照常记进 fv）；
-- 入参是旧行、新行的 jsonb，返回清好列的新行。invoker、不授任何角色。
--   日程换了哪一次（日期、remind_days 变了，或 time 在空和非空之间变；照 20261104110000）：客户端没跟着改的“知道了”（或改成的正是旧那次的
--   remind_at）、没跟着改的“稍后”都是旧那次的，清掉；pushed_for 清掉。
--   remind_cols 有一列变了：清 pushed_for、defer_until（原 touch() 提醒段）。
create function private.remind_reset(p_tn text, o jsonb, n jsonb) returns jsonb
  language plpgsql stable set search_path = '' as $$
declare cols text[];
begin
  select m.remind_cols into cols from private.table_meta m where m.tbl = p_tn;
  if coalesce(cardinality(cols), 0) = 0 then return n; end if;
  if p_tn = 'events' and (o->'date' is distinct from n->'date' or o->'remind_days' is distinct from n->'remind_days'
       or (o->'time' = 'null'::jsonb) <> (n->'time' = 'null'::jsonb)) then
    if n->'notified_for' is not distinct from o->'notified_for'
       or (o->'remind_at' <> 'null'::jsonb and n->'notified_for' = o->'remind_at') then
      n := n || '{"notified_for": null}'::jsonb;
    end if;
    if n->'snooze_at' is not distinct from o->'snooze_at' then n := n || '{"snooze_at": null}'::jsonb; end if;
    n := n || '{"pushed_for": null}'::jsonb;
  end if;
  if exists (select 1 from unnest(cols) c where n->c is distinct from o->c) then
    n := n || '{"pushed_for": null, "defer_until": null}'::jsonb;
  end if;
  return n;
end $$;

-- 三张提醒表的 after 触发器函数（沿用名字，换函数体；属主、security definer、0001 给 authenticated 的执行权照旧）。
-- insert 一律入队；update 时 remind_cols 或 snooze_at 有一列变了入队；全天日程的“知道了”写成了不等于 remind_at 的值也入队
--   （条件照 20261105120000：服务器才能收回改了默认时刻以前推的那条）。push-dispatch 写 remind_at、next_date、pushed_for、defer_until 不在名单里：不入队。
-- 待办新建、或截止日期、截止时刻、提前量变了：fresh（第 0 步不传 prevRemindAt，提前量已过时回落到截止时刻，6.3 Q2）。
-- 新旧值一律按 jsonb 取：触发器挂在三张列不同的表上，plpgsql 里写 new.time 在待办上会报“没有这一列”。
create or replace function private.enqueue_remind() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare cols text[]; o jsonb; n jsonb;
begin
  n := to_jsonb(new);
  if tg_op = 'INSERT' then
    perform private.remind_enqueue('row', new.user_id, tg_table_name, new.id, tg_table_name = 'todos', 0::smallint);
    return null;
  end if;
  o := to_jsonb(old);
  select m.remind_cols into cols from private.table_meta m where m.tbl = tg_table_name;
  if exists (select 1 from unnest(coalesce(cols, '{}') || '{snooze_at}'::text[]) c where n->c is distinct from o->c)
     or (tg_table_name = 'events' and n->'time' = 'null'::jsonb and n->'deleted_at' = 'null'::jsonb and n->'remind_days' <> 'null'::jsonb
         and n->'notified_for' <> 'null'::jsonb and n->'notified_for' is distinct from o->'notified_for'
         and n->'notified_for' is distinct from n->'remind_at') then
    perform private.remind_enqueue('row', new.user_id, tg_table_name, new.id,
      tg_table_name = 'todos' and (n->'due' is distinct from o->'due' or n->'due_time' is distinct from o->'due_time'
                                   or n->'remind_before_min' is distinct from o->'remind_before_min'),
      0::smallint);
  end if;
  return null;
end $$;

-- 设置触发器函数：只认三个影响重算的键（第 0 步读哪些设置是另一份名单 round-types.ts 的 SETTING_KEYS，新增影响重算的键两处都要加）。
-- update 时值、软删、撤销都没变就不入队（原样再写不重算，修 P11）；纪念日默认的软删、撤销也重算（修 P3）。
-- security definer：客户端改设置时要写 private.remind_queue；不授执行权（触发时不查 EXECUTE，先例 20261104100000）。
create function private.remind_on_settings() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.key not in ('remind.default_time', 'anniv.default_offsets', 'anniv.default_time') then return null; end if;
  if tg_op = 'UPDATE' and old.value is not distinct from new.value and old.deleted_at is not distinct from new.deleted_at
     and old.undone is not distinct from new.undone then
    return null;
  end if;
  perform private.remind_enqueue(case when new.key = 'remind.default_time' then 'allday' else 'anniv' end, new.user_id, null, null, false, 0::smallint);
  return null;
end $$;

-- 时区采纳（report_tz_impl）、切固定时区（tz_fixed_reset）调的入口：名字和签名不变，函数体改成转发，这两处不用动
create or replace function private.enqueue_floating(p_user uuid) returns void
  language plpgsql set search_path = '' as $$
begin
  perform private.remind_enqueue('floating', p_user, null, null, false, 0::smallint);
end $$;

-- 积压统计（只读，usage-report / 心跳用）：可用账号的 prio 0 项数、批量项数、prio 0 里最老一项从 enqueued_at 起等了几秒。
-- 停用、冷静期账号的项不算，告警不会被它们一直点亮。只授 service_role。
create function private.remind_queue_stats() returns table (user_items bigint, batch_items bigint, oldest_user_wait_s int)
  language sql stable security definer set search_path = '' set lock_timeout = '5s' as $$
  with ok as (select u.user_id from (select distinct q.user_id from private.remind_queue q) u where private.account_usable(u.user_id))
  select count(*) filter (where q.prio = 0), count(*) filter (where q.prio > 0),
         coalesce(floor(extract(epoch from now() - min(q.enqueued_at) filter (where q.prio = 0)))::int, 0)
    from private.remind_queue q join ok on ok.user_id = q.user_id
$$;
grant execute on function private.remind_queue_stats() to service_role;   -- B2 新迁移（R-411）  usage-report、心跳：可用账号的提醒队列积压（用户改的项数、批量项数、用户改的最老一项等了几秒）

-- ===== 4. 换触发器（同一事务里先删后建，没有空窗）：删 8 个，建 4 个；profiles_tz_fixed_reset 不动 =====
drop trigger events_remind on public.events;
drop trigger todos_remind on public.todos;
drop trigger anniversaries_remind on public.anniversaries;
drop trigger events_occ_reset on public.events;
drop trigger events_allday_ack_enqueue on public.events;
drop trigger settings_anniv_defaults on public.settings;
drop trigger settings_allday_defaults_ins on public.settings;
drop trigger settings_allday_defaults_upd on public.settings;
create trigger events_remind after insert or update on public.events for each row execute function private.enqueue_remind();
create trigger todos_remind after insert or update on public.todos for each row execute function private.enqueue_remind();
create trigger anniversaries_remind after insert or update on public.anniversaries for each row execute function private.enqueue_remind();
create trigger settings_remind after insert or update of value, deleted_at, undone on public.settings
  for each row execute function private.remind_on_settings();

-- ===== 5. touch() 整份替换一次：0001 的提醒段（8 行）换成一行调 remind_reset，其余逐字照 0001 =====
create or replace function private.touch() returns trigger language plpgsql security definer set search_path = '' as $$
declare k text; sys text[] := array['rev','fv','synced_at','updated_at']
    || (select m.system_cols from private.table_meta_of(tg_table_name) m);
  o jsonb; n jsonb; r jsonb; bump boolean := false;
begin
  if tg_op = 'INSERT' then new.rev := 1; new.fv := '{}'; new.synced_at := now(); return new; end if;
  new.id := old.id; new.user_id := old.user_id; new.rev := old.rev; new.fv := old.fv;
  if tg_table_name = 'todos' and to_jsonb(new)->>'due' is null then   -- 0.29 续第 136 条：截止日期清空时连带清截止时刻
    new := jsonb_populate_record(new, jsonb_build_object('due_time', null, 'remind_before_min', null));
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  -- 提醒：换了哪一次、提醒输入变了要清的列，判定和清列都在 remind_reset（R-411；非提醒表 remind_cols 为空，原样返回）
  r := private.remind_reset(tg_table_name, o, n);
  if r is distinct from n then n := r; new := jsonb_populate_record(new, n); end if;
  for k in select jsonb_object_keys(n) loop
    if k = any(sys) then continue; end if;
    if n->k is distinct from o->k then
      bump := true; new.fv := jsonb_set(new.fv, array[k], to_jsonb(old.rev + 1));
    end if;
  end loop;
  if bump then new.rev := old.rev + 1; end if;
  new.synced_at := now(); return new;
end $$;

-- ===== 6. 出队换签名 =====
-- 只交出 min_ver <= p_ver 的项（规则版本：旧版 push-dispatch 拿不到新规则的项）；多返回 fresh（6.3 Q2 回落）和 prio（3.7：logs 只记 prio 0 的重算）；每人上限、有毒次数由 push-dispatch 的 LIMITS 传，
-- 默认值只给按名字传三个参数的旧版兜底。其余（两种出队、租约、锁住后再看一次租约、skip locked、有毒项删掉以 claim 为空返回）照 20261105110000。
-- 读行的时间点不变：行不在这里取，第 0 步照旧在出队返回（租约已提交）之后另发请求读行。
drop function private.remind_queue_pop(int, int, boolean);
create function private.remind_queue_pop(p_limit int, p_lease_s int, p_retry boolean, p_per_user int default 50, p_poison int default 5, p_ver smallint default 0) returns table (table_name text, id uuid, user_id uuid, claim uuid, fresh boolean, prio smallint)
  language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s' as $$
declare
  retry boolean := coalesce(p_retry, false);
  n int := greatest(0, least(coalesce(p_limit, 0), case when coalesce(p_retry, false) then 1 else 500 end));
  lease interval := pg_catalog.make_interval(secs => greatest(30, least(coalesce(p_lease_s, 180), 3600)));
  per int := greatest(1, coalesce(p_per_user, 50));
  poison int := greatest(1, coalesce(p_poison, 5));
  ver smallint := coalesce(p_ver, 0::smallint);
  k uuid := pg_catalog.gen_random_uuid();
begin
  if n = 0 then return; end if;
  -- 返回列 table_name、id、user_id、claim、fresh、prio 也是 plpgsql 变量，下面的列一律带表别名
  return query
  with cand as (
    select q.table_name as tn, q.id as qid, q.user_id as uid, q.prio as pr, q.attempts as att, q.claimed_at as cat
      from private.remind_queue q
     where (q.claim is null or q.claimed_at < now() - lease)
       and (case when retry then q.attempts >= 1 else q.attempts = 0 end)
       and q.min_ver <= ver
  ), ok as (
    select u.uid from (select distinct cand.uid from cand) u where private.account_usable(u.uid)
  ), ranked as (
    select cand.tn, cand.qid, cand.uid, cand.pr, cand.att, cand.cat,
           row_number() over (partition by cand.uid order by cand.pr, cand.tn, cand.qid) as rn
      from cand join ok on ok.uid = cand.uid
  ), lim as (
    -- 重试（n = 1）：次数最少的先，同样次数的按 claimed_at 先来先到；新项：先全站 prio 0（按人公平），再 1、再 2
    select ranked.tn, ranked.qid, ranked.uid, ranked.pr from ranked
     where ranked.rn <= per
     order by case when retry then ranked.att else 0 end, case when retry then ranked.cat end nulls first,
              ranked.pr, ranked.rn, ranked.tn, ranked.qid limit n
  ), locked as (
    -- 锁住以后再看一次租约（候选和加锁之间别的轮可能刚打上租约并提交；理由同 20261105110000）
    select q.table_name as tn, q.id as qid, q.attempts as att from private.remind_queue q
      join lim on q.table_name = lim.tn and q.id = lim.qid
     where q.claim is null or q.claimed_at < now() - lease
       for update of q skip locked
  ), dropped as (
    -- 有毒项：已被取走 p_poison 次都没处理完，丢掉（push-dispatch 记 queue_poison）
    delete from private.remind_queue q using locked l
     where q.table_name = l.tn and q.id = l.qid and l.att >= poison
    returning q.table_name as tn, q.id as qid
  ), taken as (
    update private.remind_queue q set claim = k, claimed_at = now(), attempts = q.attempts + 1
      from locked l
     where q.table_name = l.tn and q.id = l.qid and l.att < poison
    returning q.table_name as tn, q.id as qid, q.fresh as fr
  )
  select x.tn, x.qid, lim.uid, x.k, x.fr, lim.pr from (
    select p.tn, p.qid, null::uuid as k, false as fr from dropped p
    union all
    select t.tn, t.qid, k, t.fr from taken t
  ) x join lim on lim.tn = x.tn and lim.qid = x.qid;
end $$;
grant execute on function private.remind_queue_pop(int, int, boolean, int, int, smallint) to service_role;   -- B2 新迁移（R-411）  push-dispatch 第 0 步：可用账号的打租约出队（先全站用户改的、再批量；每人上限、有毒次数、规则版本由参数传），租约过期的重取，取满有毒次数的丢弃；孤儿照常出队；停用和冷静期的不出队

-- ===== 7. 删掉被取代的函数 =====
drop function private.enqueue_anniv_defaults();
drop function private.enqueue_allday_defaults();
drop function private.events_occ_reset();

-- ===== 8. 收回 service_role 对队列的表权限（只经上面这些 security definer 函数碰队列；旧 push-dispatch 也只走 RPC） =====
revoke select, insert, delete on private.remind_queue from service_role;

-- ===== 9. 最后加外键（要拿 auth.users 的 ShareRowExclusive，放最后，持锁时间最短）：注销时队列项跟着删 =====
alter table private.remind_queue add constraint remind_queue_user_id_fkey foreign key (user_id) references auth.users on delete cascade;
