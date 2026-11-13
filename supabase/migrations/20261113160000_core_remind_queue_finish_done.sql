-- 20261113160000_core_remind_queue_finish_done.sql：提醒队列重写的四项后续（R-411，11-13；方案 docs/10-架构/方案-提醒队列重写.md 3.7“11-13 后续二”）。
-- ① 收尾 remind_queue_finish 换签名，加 p_done（处理完的名单）：新版 push-dispatch 传 p_done 时只删名单里列出的，两份名单都没列的项不动
--    （租约、attempts 原样，和“中途崩了、没调 finish”同一条路：租约过期后按重试重取，取满有毒次数被丢掉）。漏分类的项不会再被当成处理完悄悄删掉；
--    第 0 步写回遇到数据类错误的项（原来带 hold: true）直接不列，hold 标记作废。
--    p_done 带默认值 null：旧版 push-dispatch 按名字只传 p_claim、p_release，照旧“这个租约里不在 p_release 的都删”，迁移和函数谁先部署都行
--    （先例：20261113100000 的出队）。旧版在 p_release 里带 hold: true 的项，在旧口径下改成放回（不再留租约）：只影响两边部署之间那一两分钟。
--    一项同时在两份名单里按放回处理（先放回，删除那句只删还是这个租约的）。
-- ② 放回不再清 claimed_at（保留最近一次被取走的时刻）：重试出队按 claimed_at 先来先到，原来放回的 claimed_at 为空、排在最前（nulls first），
--    同一轮单项重试里一项被放回后会被马上再取到、一直占着重试名额；现在放回的排在这一刻，不插队。出队的排序跟着去掉 nulls first。
-- ③ 出队对候选账号逐个调 account_usable 改成“排好序以后按顺序判、够数就停”：原写法 (select distinct uid from cand) where account_usable(uid)
--    的条件会被规划器推进 distinct 子查询里、对每一项候选各调一次；remind_enqueue('all', …) 把全站入队后每轮要判上万次。
--    现在 offset 0 挡住下推，按出队顺序逐项判，取满 n 项就停：调用次数 ≤ n 加上排在前面的不可用账号的项数（每人最多 p_per_user 项）。
--    可用的判断仍只有 account_usable 一处（0.29 续第 138 条），不另抄 profiles 的条件。
-- ④ 积压统计 remind_queue_stats 先按人汇总（一次扫队列），再对每个人判一次 account_usable（materialized 挡住下推）：
--    原写法扫两遍队列，条件同样被推进 distinct 里、对每一项各调一次。统计要的是全部可用账号，按人判一次是下限。
-- 出队、统计签名不变（create or replace 保留属主和执行权）；finish 换签名：drop 后 create，grant 紧跟；3.3 C、附录 A 加新签名一行，旧签名那行加注。
-- 只换函数，不动表，不拿业务表的锁。

drop function private.remind_queue_finish(uuid, jsonb);
create function private.remind_queue_finish(p_claim uuid, p_release jsonb, p_done jsonb default null) returns void
  language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s' as $$
begin
  if p_claim is null then return; end if;
  if p_release is not null and pg_catalog.jsonb_typeof(p_release) <> 'array' then raise exception 'bad_release'; end if;
  if p_done is not null and pg_catalog.jsonb_typeof(p_done) <> 'array' then raise exception 'bad_done'; end if;
  -- 放回：p_release 里还是这个租约的项（处理期间被重新入队的 claim 已清空，本来就会被下一轮取到）。claimed_at 留着（见文件头 ②）。
  -- 放回和删除都先 for update skip locked：被用户事务锁着的行不等锁、跳过，租约留着，过期后走重试（安全审查必改 2）
  update private.remind_queue q set claim = null, attempts = greatest(q.attempts - 1, 0)
    from (select q2.table_name as tn, q2.id as qid from private.remind_queue q2
            join pg_catalog.jsonb_to_recordset(coalesce(p_release, '[]'::jsonb)) as r(table_name text, id uuid)
              on q2.table_name = r.table_name and q2.id = r.id
           where q2.claim = p_claim
             for update of q2 skip locked) l
   where q.table_name = l.tn and q.id = l.qid and q.claim = p_claim;
  -- 删除（同样跳过锁着的）：传了 p_done 只删其中列出的；没传（旧版）删这个租约里不在 p_release 的
  delete from private.remind_queue q
   using (select q2.table_name as tn, q2.id as qid from private.remind_queue q2
           where q2.claim = p_claim
             and case when p_done is null
                   then not exists (select 1 from pg_catalog.jsonb_to_recordset(coalesce(p_release, '[]'::jsonb)) as h(table_name text, id uuid)
                                     where h.table_name = q2.table_name and h.id = q2.id)
                   else exists (select 1 from pg_catalog.jsonb_to_recordset(p_done) as d(table_name text, id uuid)
                                 where d.table_name = q2.table_name and d.id = q2.id) end
             for update of q2 skip locked) l
   where q.table_name = l.tn and q.id = l.qid and q.claim = p_claim;
end $$;
grant execute on function private.remind_queue_finish(uuid, jsonb, jsonb) to service_role;   -- B2 新迁移（R-411 后续）  push-dispatch 第 0 步结尾：放回的清租约，处理完的按名单删，都没列的留着租约等过期重取（没传名单的旧版：其余按租约删）

-- 出队：只改两处（文件头 ②③），其余逐字照 20261113100000
create or replace function private.remind_queue_pop(p_limit int, p_lease_s int, p_retry boolean, p_per_user int default 50, p_poison int default 5, p_ver smallint default 0) returns table (table_name text, id uuid, user_id uuid, claim uuid, fresh boolean, prio smallint)
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
  ), ranked as (
    -- 每人编号不看账号可不可用：可用账号的编号和只在可用账号里编一样（按人分区）
    select cand.tn, cand.qid, cand.uid, cand.pr, cand.att, cand.cat,
           row_number() over (partition by cand.uid order by cand.pr, cand.tn, cand.qid) as rn
      from cand
  ), lim as (
    -- 重试（n = 1）：次数最少的先，同样次数的按 claimed_at 先来先到；新项：先全站 prio 0（按人公平），再 1、再 2。
    -- 排好序以后逐项判 account_usable，取满 n 项就停（offset 0 挡住规划器把条件推到排序下面去、对每一项候选都判）
    select s.tn, s.qid, s.uid, s.pr from (
      select ranked.tn, ranked.qid, ranked.uid, ranked.pr from ranked
       where ranked.rn <= per
       order by case when retry then ranked.att else 0 end, case when retry then ranked.cat end,
                ranked.pr, ranked.rn, ranked.tn, ranked.qid
      offset 0
    ) s
     where private.account_usable(s.uid)
     limit n
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

-- 积压统计：先按人汇总、每人判一次（文件头 ④）；返回的三个数和口径照 20261113100000
create or replace function private.remind_queue_stats() returns table (user_items bigint, batch_items bigint, oldest_user_wait_s int)
  language sql stable security definer set search_path = '' set lock_timeout = '5s' as $$
  with per_user as materialized (
    select q.user_id, count(*) filter (where q.prio = 0) as c0, count(*) filter (where q.prio > 0) as c1,
           min(q.enqueued_at) filter (where q.prio = 0) as m0
      from private.remind_queue q group by q.user_id
  )
  select coalesce(sum(s.c0), 0)::bigint, coalesce(sum(s.c1), 0)::bigint,
         coalesce(floor(extract(epoch from now() - min(s.m0)))::int, 0)
    from per_user s where private.account_usable(s.user_id)
$$;
