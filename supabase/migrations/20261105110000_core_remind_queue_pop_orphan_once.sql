-- 20261105110000_core_remind_queue_pop_orphan_once.sql：push-dispatch 第 0 步删孤儿那句只算一次（两连接 B 段偶尔慢 6～10 秒的根因）。
-- 现象：CI（ebc39c0，job 127063774335 第 28 步）的 auto_explain 计划：删孤儿那句是 Nested Loop，外层 Index Scan remind_queue_pkey
--   估 1 行、实际 2506 行，内层带 LockRows 的孤儿子查询 loops=2506、每次 2.9 毫秒，Buffers shared hit=18880090；连接 1、2 出队
--   分别 5771、7346 毫秒，24 次采样都没在等锁。前面的步骤留下 2500 条孤儿后统计信息没更新（表在几乎空的时候 analyze 过），
--   规划器以为两边都只有 1 行，把孤儿子查询放进了嵌套循环内层。lemo-e2e 上照这个条件（空表 analyze 后插 2500 条孤儿）自然复现过一次：
--   同样的计划，3592 毫秒。两种连接顺序代价几乎一样（49.58 对 49.57），选哪个看页数等细节，所以是“偶尔慢”。
-- 改法：孤儿集合写成 with o as materialized (… for update skip locked)：materialized 的 CTE 只执行一次、结果存起来，
--   查孤儿、加锁都只做一次。删的时候不和 o 做连接，按表名分三组写 q.table_name = '…' and q.id = any (array(select o.qid from o where o.tn = '…'))：
--   三个 array 子查询各只算一次（InitPlan），主键 (table_name, id) 直接按两列找，耗时和孤儿条数成正比，不看统计信息、不靠 analyze。
--   没用 delete … where (table_name, id) in (select … from o)：同样的统计状态下它被排成 Nested Loop Semi Join、CTE Scan 在内层
--   每一行重读一遍（loops = 行数），按平方涨，lemo-e2e 实测 2500 条 0.47 秒、1 万条 6.4 秒；any(array) 写法 2500 条 3.7 毫秒、1 万条 17 毫秒。
--   三个表名和孤儿判定那三行一一对应；remind_queue.table_name 只会是这三个值（0001 的 remind_queue_table_name_check）。
-- 只替换这一个函数：签名不变，create or replace 保留属主和执行权（仍只授 service_role，不重复 grant），函数属性
--   （security definer、search_path = ''、lock_timeout = 5s）照旧；函数体除删孤儿那句外逐字照 20261104130000。
-- 只替换函数，不改表结构，不需要 set local lock_timeout（tests/build/migration-lock-timeout.test.ts 只管 alter 热表）。
-- 本机两连接核对：tools/db/remind-queue-2conn.mjs（上线与回滚手册：改过出队里的 skip locked 要跑一次）。

create or replace function private.remind_queue_pop(p_limit int, p_lease_s int, p_retry boolean) returns table (table_name text, id uuid, user_id uuid, claim uuid)
  language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s' as $$
declare
  retry boolean := coalesce(p_retry, false);
  n int := greatest(0, least(coalesce(p_limit, 0), case when coalesce(p_retry, false) then 1 else 500 end));
  lease interval := pg_catalog.make_interval(secs => greatest(30, least(coalesce(p_lease_s, 180), 3600)));
  k uuid := pg_catalog.gen_random_uuid();
begin
  -- 孤儿（行已经没了）：照旧直接删；同样 skip locked——另一轮出队还没提交、正删着同一批孤儿时不等它（lemo-b2push 两连接实测：
  -- 不加的话后一轮要等前一轮提交，tools/db/remind-queue-2conn.mjs 场景 B）。
  -- 20261105110000：孤儿集合放进 materialized 的 o，只查一次、只加一次锁；删的时候按表名分三组、id = any(array(…))，
  -- 三个 array 子查询各算一次（InitPlan），按主键直接找，不和 o 做连接——不管统计信息准不准，都不会嵌套循环重算
  -- （原来写在 using 子查询里，统计过期时被放进嵌套循环内层每圈重算加锁，CI 实测 2506 条孤儿 5～7 秒；
  -- 写成 in (select … from o) 也会被排成“每一行重读一遍 o”，1 万条孤儿要 6 秒多）
  with o as materialized (
    select q2.table_name as tn, q2.id as qid from private.remind_queue q2
     where (q2.table_name = 'events' and not exists (select 1 from public.events e where e.id = q2.id))
        or (q2.table_name = 'todos' and not exists (select 1 from public.todos t where t.id = q2.id))
        or (q2.table_name = 'anniversaries' and not exists (select 1 from public.anniversaries a where a.id = q2.id))
       for update of q2 skip locked
  )
  delete from private.remind_queue q
   where (q.table_name = 'events' and q.id = any (array(select o.qid from o where o.tn = 'events')))
      or (q.table_name = 'todos' and q.id = any (array(select o.qid from o where o.tn = 'todos')))
      or (q.table_name = 'anniversaries' and q.id = any (array(select o.qid from o where o.tn = 'anniversaries')));
  if n = 0 then return; end if;
  -- 候选：没人在处理（claim 为空），或租约已过期（取走的那一轮崩了、没调 finish）。其余和 20261103130000 相同：
  -- 按人公平（每人按 (table_name, id) 编号，先比编号；每人每轮最多 50 条），account_usable 按人判一次，
  -- 窗口函数和 for update 不能在同一层，先在 ranked、lim 里排好，再到 locked 里按主键锁队列行（skip locked）。
  -- 返回列 table_name、id、user_id、claim 也是 plpgsql 变量，下面的列一律带表别名。
  return query
  with cand as (
    select q.table_name as tn, q.id as qid, q.attempts as att, q.claimed_at as cat, coalesce(e.user_id, t.user_id, a.user_id) as uid
      from private.remind_queue q
      left join public.events e on q.table_name = 'events' and e.id = q.id
      left join public.todos t on q.table_name = 'todos' and t.id = q.id
      left join public.anniversaries a on q.table_name = 'anniversaries' and a.id = q.id
     where (q.claim is null or q.claimed_at < now() - lease)
       and (case when retry then q.attempts >= 1 else q.attempts = 0 end)
  ), ok as (
    select u.uid from (select distinct cand.uid from cand where cand.uid is not null) u where private.account_usable(u.uid)
  ), ranked as (
    select cand.tn, cand.qid, cand.uid, cand.att, cand.cat, row_number() over (partition by cand.uid order by cand.tn, cand.qid) as rn
      from cand join ok on ok.uid = cand.uid
  ), lim as (
    -- 重试（n = 1）：次数最少的先（同批无辜的项先单独算完，一算就崩的那项排在后面、单独累计），同样次数的按 claimed_at 先来先到。
    -- 新项：每人最多 50 条，先比每人的编号（按人公平）。候选在 cand 里已按 p_retry 分开，两种互不挡
    select ranked.tn, ranked.qid, ranked.uid from ranked
     where ranked.rn <= 50
     order by case when retry then ranked.att else 0 end, case when retry then ranked.cat end nulls first, ranked.rn, ranked.tn, ranked.qid limit n
  ), locked as (
    -- 锁住以后再看一次租约（候选和加锁之间别的轮可能刚打上租约并提交：skip locked 只跳过还锁着的；锁上的是最新版本，
    -- READ COMMITTED 按最新版本重算这个 where）。去掉这一句只会让这一项被两轮同时处理：重算幂等、写回有乐观条件，结果照样对，
    -- 多算一次、attempts 多加 1。PGlite、pgTAP 单会话造不出“快照之后、加锁之前另一个事务提交”的窗口，自动化测试钉不住
    -- （代码审查 S_noLockedRecheck 存活、判为接受，接手清单登记）；两连接的并发证据见 tools/db/remind-queue-2conn.mjs 和方案说明第六节。
    select q.table_name as tn, q.id as qid, q.attempts as att from private.remind_queue q
      join lim on q.table_name = lim.tn and q.id = lim.qid
     where q.claim is null or q.claimed_at < now() - lease
       for update of q skip locked
  ), poison as (
    -- 有毒项：已被取走 5 次都没处理完，丢掉（push-dispatch 记 queue_poison）
    delete from private.remind_queue q using locked l
     where q.table_name = l.tn and q.id = l.qid and l.att >= 5
    returning q.table_name as tn, q.id as qid
  ), taken as (
    update private.remind_queue q set claim = k, claimed_at = now(), attempts = q.attempts + 1
      from locked l
     where q.table_name = l.tn and q.id = l.qid and l.att < 5
    returning q.table_name as tn, q.id as qid
  )
  select x.tn, x.qid, lim.uid, x.k from (
    select p.tn, p.qid, null::uuid as k from poison p
    union all
    select t.tn, t.qid, k from taken t
  ) x join lim on lim.tn = x.tn and lim.qid = x.qid;
end $$;
