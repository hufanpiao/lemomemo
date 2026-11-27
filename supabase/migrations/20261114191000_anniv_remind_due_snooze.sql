-- 20261114191000_anniv_remind_due_snooze.sql：纪念日推过以后的“明天再提醒”被吞、刚推的通知被 resolve 收回（B5 整块评审第 1 条）。
-- 起因：push-dispatch 第 6 步（round-send.ts 的 writeAnnivNext）推完纪念日马上把 remind_at 挪到下一次（例：{7,1} 推完 D-7 写 D-1）。
--   ① 到点：greatest(remind_at, snooze_at, defer_until) 里挪过的 remind_at（D-1）比推过以后按的稍后（D-6）晚，稍后被吞，D-6 不推；
--      选行的 remind_at <= p_hi 也把这行挡在外面。
--   ② resolve：due_at（D-1）≠ pushed_for（D-7），下一分钟就当“已在别处处理”，把刚推出去的通知收回（非苹果设备）。
-- 改法（只动 anniversaries 一支，日程、待办两支的条件不变；签名、属性、授权不变，create or replace 保留原授权）：
--   ① remind_due：snooze_at > coalesce(pushed_for, 0)（推过以后才按的稍后）且 greatest(snooze_at, defer_until) 落在 (p_lo, p_hi] 里，
--      按它判到点；否则照旧 greatest(...)。选行条件放宽为 remind_at <= p_hi 或 snooze_at <= p_hi。
--   ② remind_pushed：纪念日“已处理”改成 删除、撤销，或 remind_at 为空（提醒关了），或 notified_for >= pushed_for（界面按“知道了”写这一次的时刻），
--      或 snooze_at > pushed_for（推过以后又按了稍后）；不再看 due_at ≠ pushed_for。
-- 和 push-dispatch/round-util.ts 的 dueOf、isDue、isHandledAfterPush 逐条一致；内存替身 tests/edge/push-dispatch-mem.ts 照这里写；
-- pgTAP 在 supabase/tests/rls/51_anniv_remind_due_snooze.test.sql，edge 在 tests/edge/push-dispatch-anniv.test.ts。

create or replace function private.remind_due(p_lo bigint, p_hi bigint, p_per_user int, p_limit int) returns table (table_name text, id uuid, user_id uuid, due_at bigint)
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
    select 'anniversaries', a.id, a.user_id, a.pushed_for,
           case when a.snooze_at > coalesce(a.pushed_for, 0)
                 and greatest(a.snooze_at, a.defer_until) > p_lo and greatest(a.snooze_at, a.defer_until) <= p_hi
                then greatest(a.snooze_at, a.defer_until)
                else greatest(a.remind_at, a.snooze_at, a.defer_until) end
      from public.anniversaries a
     where a.deleted_at is null and not a.undone and a.remind_at is not null and (a.remind_at <= p_hi or a.snooze_at <= p_hi)
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

create or replace function private.remind_pushed(p_lo bigint, p_hi bigint, p_per_user int, p_limit int) returns table (table_name text, id uuid, user_id uuid, pushed_for bigint)
  language sql stable security definer set search_path = '' set lock_timeout = '5s' as $$
  with c as (
    select 'events'::text as tn, e.id, e.user_id as uid, e.pushed_for as pf, e.remind_at as ra, e.notified_for as nf,
           greatest(e.remind_at, e.snooze_at, e.defer_until) as d, (e.deleted_at is not null or e.undone) as gone, null::boolean as ah
      from public.events e where e.pushed_for > p_lo and e.pushed_for <= p_hi
    union all
    select 'todos', t.id, t.user_id, t.pushed_for, t.remind_at, t.notified_for, greatest(t.remind_at, t.snooze_at, t.defer_until),
           (t.deleted_at is not null or t.undone or t.done), null::boolean
      from public.todos t where t.pushed_for > p_lo and t.pushed_for <= p_hi
    union all
    -- 纪念日：推完 remind_at 已挪到下一次，不看 d <> pf；ah = 提醒关了、按了“知道了”（notified_for = 这一次 ≥ pushed_for）、推过以后又按了稍后
    select 'anniversaries', a.id, a.user_id, a.pushed_for, a.remind_at, a.notified_for, greatest(a.remind_at, a.snooze_at, a.defer_until),
           (a.deleted_at is not null or a.undone),
           (a.remind_at is null or coalesce(a.notified_for, 0) >= a.pushed_for or coalesce(a.snooze_at, 0) > a.pushed_for)
      from public.anniversaries a where a.pushed_for > p_lo and a.pushed_for <= p_hi
  ), h as (
    select c.tn, c.id, c.uid, c.pf from c
     where c.gone or (c.ah is null and ((c.ra is not null and c.nf = c.ra) or c.d is null or c.d <> c.pf)) or c.ah
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
