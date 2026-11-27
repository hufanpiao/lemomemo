-- 20261103140000_core_remind_due.sql：push-dispatch 第 1 步“到点的”和 resolve 候选改在 SQL 里精确判断（B2 BE-2 安全审查必改 1、代码审查 M2）
-- 原来的写法：PostgREST 粗筛（remind_at ≤ hi 且三列之一 > lo）、每表按 remind_at 升序取 500 条，精确条件留到 TS 的 isDue。
-- 问题：snooze_at 客户端可写，一个人建 500 条 remind_at 很早、snooze_at 很远的条目，就永远占满前 500、又全被 isDue 丢掉，
--   全站别人的提醒每轮都取不到（跨用户拒绝服务）；不攻击时，推过的行（60 分钟窗口内）也算进 500，一小时超 500 条就挤掉新到点的。
-- 改：
--   ① private.remind_due(p_lo, p_hi, p_per_user, p_limit)：三张表合起来，条件和 push-dispatch/round.ts 的 isDue 逐条一致——
--      未删、未撤销、待办未完成、remind_at 不空；due_at = greatest(remind_at, snooze_at, defer_until)（greatest 不看 null），
--      p_lo < due_at ≤ p_hi；coalesce(pushed_for, 0) <> due_at（这个 due_at 还没推过）；coalesce(notified_for, 0) <> remind_at（没按过“知道了”）；
--      只留可用账号（private.account_usable，按人判一次）；每人按 due_at 先后最多 p_per_user 条，再按 (due_at, table_name, id) 取最多 p_limit 条（≤ 500）。
--   ② private.remind_pushed(p_lo, p_hi, p_per_user, p_limit)：resolve 候选，条件和 isHandledAfterPush 一致——
--      p_lo < pushed_for ≤ p_hi，并且下面任一条：条目删除（deleted_at 不空）、撤销（undone）、待办完成（done）（R-317）；
--      remind_at 不空且 notified_for = remind_at（按了“知道了”）；due_at 为空（提醒关了）或 due_at <> pushed_for（改了时间、按了“稍后”）；
--      同样每人最多 p_per_user 条、总数 ≤ 500，按 (pushed_for, table_name, id)。
--   ③ 三张表的 snooze_at 加约束：为空，或 0 ～ 4102444800000（2100-01-01 00:00 UTC）。精确判断已经挡住了上面的攻击，这一条是第二道：
--      怪值进不了库（客户端写的是“几分钟后”，正常值远小于上限）。先 not valid 加、再 validate（同 20261103100000 的写法）。
--   ④ 复审（11-03）：
--      · 代码审查 M4：remind_due 的 ok 只留至少有一台可推设备（devices 未删、push_endpoint 不空）的人。没设备的人到点条目第 2 步不认领、
--        pushed_for 不变，原来每轮都会被返回、占 500 名额，把有设备的人的新提醒挤出 60 分钟窗口。
--        current_tz 坏了的人（TS 一侧跳过、记 tz_invalid）这里不过滤：每人最多 p_per_user（20）条，挤不满 500，可以接受；
--        要过滤得在 SQL 里认时区名（pg_timezone_names 是视图、每轮全读一遍），不值得。
--      · 安全审查必改：三张表 pushed_for 加部分索引（where pushed_for is not null），remind_pushed 不再每分钟全表扫。
--        pushed_for > p_lo 用的是严格运算符，规划器能推出 pushed_for is not null，参数化的通用计划也用得上这条部分索引。
--      · 代码审查建议：remind_due 的 c 层三支加下界（remind_at、snooze_at、defer_until 三者之一 > p_lo），和 greatest(…) > p_lo 等价、语义不变，
--        让规划器能用索引只取窗口里的行；纪念日补 remind_at 部分索引（events、todos 在 0002 已有），三张表的 snooze_at、defer_until 各配
--        一条 where … is not null 的部分索引（大多数行为空，索引很小），下界里的 or 能走 BitmapOr。
--      · 这些索引名固定，登记在 build/d1/whitelist.ts 的 REQUIRED_INDEXES（D1 第 7 节，定义逐字比对）。
-- 两个函数只返回 (table_name, id, user_id, due_at / pushed_for)，整行由调用方按 id 读（store.ts 的 rows）。
-- security definer、set search_path = ''、lock_timeout = 5s；只 grant 给 service_role（下面两句和 3.3 C、附录 A 标“B2 新迁移（BE-2）”的行一字不差）。

alter table public.events add constraint events_snooze_at_range
  check (snooze_at is null or (snooze_at >= 0 and snooze_at <= 4102444800000)) not valid;
alter table public.todos add constraint todos_snooze_at_range
  check (snooze_at is null or (snooze_at >= 0 and snooze_at <= 4102444800000)) not valid;
alter table public.anniversaries add constraint anniversaries_snooze_at_range
  check (snooze_at is null or (snooze_at >= 0 and snooze_at <= 4102444800000)) not valid;
alter table public.events validate constraint events_snooze_at_range;
alter table public.todos validate constraint todos_snooze_at_range;
alter table public.anniversaries validate constraint anniversaries_snooze_at_range;

-- ④ 索引（复审）：pushed_for（remind_pushed）、remind_at（纪念日；events、todos 在 0002 已有）、snooze_at、defer_until（remind_due 的下界）
create index events_pushed_for_idx on public.events (pushed_for) where pushed_for is not null;
create index todos_pushed_for_idx on public.todos (pushed_for) where pushed_for is not null;
create index anniversaries_pushed_for_idx on public.anniversaries (pushed_for) where pushed_for is not null;
create index anniversaries_remind_at_idx on public.anniversaries (remind_at) where deleted_at is null and remind_at is not null;
create index events_snooze_at_idx on public.events (snooze_at) where snooze_at is not null;
create index todos_snooze_at_idx on public.todos (snooze_at) where snooze_at is not null;
create index anniversaries_snooze_at_idx on public.anniversaries (snooze_at) where snooze_at is not null;
create index events_defer_until_idx on public.events (defer_until) where defer_until is not null;
create index todos_defer_until_idx on public.todos (defer_until) where defer_until is not null;
create index anniversaries_defer_until_idx on public.anniversaries (defer_until) where defer_until is not null;

create function private.remind_due(p_lo bigint, p_hi bigint, p_per_user int, p_limit int) returns table (table_name text, id uuid, user_id uuid, due_at bigint)
  language sql stable security definer set search_path = '' set lock_timeout = '5s' as $$
  with c as (
    select 'events'::text as tn, e.id, e.user_id as uid, e.pushed_for as pf, greatest(e.remind_at, e.snooze_at, e.defer_until) as d
      from public.events e
     where e.deleted_at is null and not e.undone and e.remind_at is not null and e.remind_at <= p_hi
       and (e.remind_at > p_lo or e.snooze_at > p_lo or e.defer_until > p_lo)
       and coalesce(e.notified_for, 0) <> e.remind_at
    union all
    select 'todos', t.id, t.user_id, t.pushed_for, greatest(t.remind_at, t.snooze_at, t.defer_until)
      from public.todos t
     where t.deleted_at is null and not t.undone and not t.done and t.remind_at is not null and t.remind_at <= p_hi
       and (t.remind_at > p_lo or t.snooze_at > p_lo or t.defer_until > p_lo)
       and coalesce(t.notified_for, 0) <> t.remind_at
    union all
    select 'anniversaries', a.id, a.user_id, a.pushed_for, greatest(a.remind_at, a.snooze_at, a.defer_until)
      from public.anniversaries a
     where a.deleted_at is null and not a.undone and a.remind_at is not null and a.remind_at <= p_hi
       and (a.remind_at > p_lo or a.snooze_at > p_lo or a.defer_until > p_lo)
       and coalesce(a.notified_for, 0) <> a.remind_at
  ), due as (
    select c.tn, c.id, c.uid, c.d from c
     where c.d > p_lo and c.d <= p_hi
       and coalesce(c.pf, 0) <> c.d
  ), ok as (
    -- M4：只留可用账号里至少有一台可推设备的人（没设备的人不认领、pushed_for 不变，不过滤就每轮占名额）
    select u.uid from (select distinct due.uid from due) u
     where private.account_usable(u.uid)
       and exists (select 1 from public.devices d where d.user_id = u.uid and d.deleted_at is null and d.push_endpoint is not null)
  ), ranked as (
    select due.tn, due.id, due.uid, due.d, row_number() over (partition by due.uid order by due.d, due.tn, due.id) as rn
      from due join ok on ok.uid = due.uid
  )
  select r.tn, r.id, r.uid, r.d from ranked r
   where r.rn <= greatest(0, coalesce(p_per_user, 0))
   order by r.d, r.tn, r.id
   limit greatest(0, least(coalesce(p_limit, 0), 500))
$$;
grant execute on function private.remind_due(bigint, bigint, int, int) to service_role;   -- B2 新迁移（BE-2）  push-dispatch 第 1 步：精确判到点（三表合起来、每人有上限、≤ 500），只回可用账号的

create function private.remind_pushed(p_lo bigint, p_hi bigint, p_per_user int, p_limit int) returns table (table_name text, id uuid, user_id uuid, pushed_for bigint)
  language sql stable security definer set search_path = '' set lock_timeout = '5s' as $$
  with c as (
    select 'events'::text as tn, e.id, e.user_id as uid, e.pushed_for as pf, e.remind_at as ra, e.notified_for as nf,
           greatest(e.remind_at, e.snooze_at, e.defer_until) as d, (e.deleted_at is not null or e.undone) as gone
      from public.events e where e.pushed_for > p_lo and e.pushed_for <= p_hi
    union all
    select 'todos', t.id, t.user_id, t.pushed_for, t.remind_at, t.notified_for, greatest(t.remind_at, t.snooze_at, t.defer_until),
           (t.deleted_at is not null or t.undone or t.done)
      from public.todos t where t.pushed_for > p_lo and t.pushed_for <= p_hi
    union all
    select 'anniversaries', a.id, a.user_id, a.pushed_for, a.remind_at, a.notified_for, greatest(a.remind_at, a.snooze_at, a.defer_until),
           (a.deleted_at is not null or a.undone)
      from public.anniversaries a where a.pushed_for > p_lo and a.pushed_for <= p_hi
  ), h as (
    select c.tn, c.id, c.uid, c.pf from c
     where c.gone or (c.ra is not null and c.nf = c.ra) or c.d is null or c.d <> c.pf
  ), ok as (
    select u.uid from (select distinct h.uid from h) u where private.account_usable(u.uid)
  ), ranked as (
    select h.tn, h.id, h.uid, h.pf, row_number() over (partition by h.uid order by h.pf, h.tn, h.id) as rn
      from h join ok on ok.uid = h.uid
  )
  select r.tn, r.id, r.uid, r.pf from ranked r
   where r.rn <= greatest(0, coalesce(p_per_user, 0))
   order by r.pf, r.tn, r.id
   limit greatest(0, least(coalesce(p_limit, 0), 500))
$$;
grant execute on function private.remind_pushed(bigint, bigint, int, int) to service_role;   -- B2 新迁移（BE-2）  push-dispatch 的 resolve：精确判推过后已在别处处理的（每人有上限、≤ 500），只回可用账号的
