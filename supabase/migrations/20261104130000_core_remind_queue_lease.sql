-- 20261104130000_core_remind_queue_lease.sql：push-dispatch 第 0 步改成租约式出队（REMIND-queue-crash-loss 方案丙，R-348，11-04 负责人定）。
-- 方案说明：docs/03-评审/B2/B2-方案说明-REMIND-queue-crash-loss.md；架构 5.3 第 0 步、0.49 第 3 条。
-- 为什么：原来的 private.remind_queue_pop(int)（20261103130000）出队即删，push-dispatch 在重算、写回之前被掐断（CPU 硬上限、
--   墙钟超时、部署替换实例）时，这一批最多 500 项的重算就丢了，要等这些行下次被改才会再入队。
-- 做法：
--   ① remind_queue 加三列：claim（这一批的租约号，空 = 没人在处理）、claimed_at（取走的时间）、attempts（被取走过几次）。
--   ② remind_queue_pop(p_limit int, p_lease_s int, p_retry boolean)：孤儿照旧直接删；只取“没人在处理的或租约过期的”项，按人公平、每人每轮最多 50 条、
--      总上限 500、account_usable、for update skip locked 全部照旧；最后一步从 delete 改成打租约（claim = 这一轮新生成的 uuid、
--      claimed_at = now()、attempts + 1）。租约 p_lease_s 秒（push-dispatch 传 180；小于 30 按 30，大于 3600 按 3600，空按 180）。
--      有毒项：已经被取走过 5 次还没处理完（attempts ≥ 5，每次都把进程弄死）的不再交出去，直接删掉，以 claim 为空的一行返回，
--      push-dispatch 记 queue_poison。
--      **两种出队**（11-04 审查返工，代码审查 H1 / 安全审查必改 1；11-05 安全复审 N1 改成两种分开取，主持人定）：
--      · p_retry = true（重试）：只取 attempts ≥ 1 的项（取过、没收尾：上一批崩了、finish 失败，或放回过又被重取），一次只交出 1 项，
--        单独一个租约——attempts 最小的先，同样次数的按上一次被取走的时间先来先到（claimed_at 早的先；放回过、claimed_at 为空的最先），
--        再按 table_name、id。反复让自己的项收尾失败的人，他的项每被取一次就排到后面，占不住别人的重试次数。push-dispatch 处理完马上单独 finish，再取下一项
--        （round-step0.ts，每轮至多 QUEUE_RETRY_POPS 次）。一批崩了以后同批的项一项一项单独重算，只有真正一算就崩的那一项次数会一直涨，
--        满 5 次被丢掉；同批无辜的项不会被连坐（原来整批每项都 + 1，5 轮后一起被当成有毒项删掉）。
--      · p_retry = false 或空（新项）：只取 attempts = 0 的项，按批出队（每人 50、总数 500）。push-dispatch 每轮做完重试以后
--        **不管还有没有重试项都再做一次**：重试项再多也挡不住别人新改的项（11-04 版有重试项时不按批出队，一批 500 项崩一次，
--        全站新改的项要等约 25 分钟；普通用户还能用持锁后回滚的批量修改维持这个状态，安全复审 N1）。
--   ③ 新函数 remind_queue_finish(p_claim uuid, p_release jsonb)：p_release（[{table_name, id}]）里、还是这个租约的项放回
--      （claim、claimed_at 置空，attempts 减 1：放回的是“这一轮没来得及处理”或“写回时行又被改了”，不是崩溃，不该算进有毒次数）；
--      其余 claim = p_claim 的项删掉。放回和删除都先 for update skip locked（安全审查必改 2）：被用户事务锁着的行
--      （用户正在改这一行、入队触发器锁住了队列行）跳过、不等锁，留给下一轮按租约处理——用户提交了，租约和 attempts 已被清空、
--      下一轮按新值重算；用户回滚了，租约过期后按重试模式单独重取，只影响这个用户自己的项。原来等锁超过 5 秒整批报错，
--      一条持锁的批量修改就能让同批别人的项一起被重取、累计次数。处理期间被触发器重新入队的项 claim 已被清空（见 ④），不会被删，下一轮按新值再算——
--      这就是 0.49 第 3 条拒绝“先读后删”的那个问题（吞掉处理期间的新改动）的解法。
--   ④ 写队列的 4 个入口（enqueue_remind、enqueue_anniv_defaults、enqueue_floating、enqueue_allday_defaults）的 on conflict do nothing
--      改成 on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0 where 这一项正被租着或取过。
--      attempts 清零（11-04 审查返工 L2，主持人定）：用户改了这一项就是新的一次重算，不该背着上一版的次数；有了重试模式，
--      用户反复改来绕过上限也只影响他自己的项。没被租着、也没取过的项照旧什么都不写。
--      函数体除 on conflict 那一句外逐字照原来的最新版（0001、0005、20261104100000）；create or replace 保留属主和执行权
--      （enqueue_remind、enqueue_anniv_defaults 仍授 authenticated，enqueue_floating、enqueue_allday_defaults 仍不授任何角色）。
--      20261104100000 里那句一次性补算的 insert 已经跑过，不用改。
-- 至少处理一次：崩溃后同一项可能被重算两次。重算是幂等的（结果一样就不写回；行改过了乐观条件不成立、放回），
--   不涉及推送（推送“最多一次”由第 3 步认领 pushed_for 保证，和这里无关）。
-- 执行权：0001 的默认权限已收回 PUBLIC；两个函数都只 grant 给 service_role（下面两句和 3.3 C、附录 A 标“B2 新迁移（REMIND-queue-crash-loss）”
--   的行一字不差）。service_role 对 remind_queue 的表权限不变（select、insert、delete，0001）：打租约、放回、按租约删都在 security definer 函数里做。
-- 两个函数都 security definer、set search_path = ''、lock_timeout = 5s（和原来的出队函数一样：锁等不到就报错，这一轮跳过第 0 步或 finish，
--   租约过期后下一轮再来；队列行一律 skip locked，函数级 lock_timeout 只兜住意外的锁等待）。
-- 迁移本身也 set local lock_timeout = '5s'（安全审查 S1，写法同 20261029190000）：alter table 要拿 remind_queue 的 AccessExclusive 锁，
--   万一有长事务占着表，5 秒内失败、整个迁移回滚，不让排队的 alter 把所有走入队触发器的用户写入一起堵住；失败了等长事务结束再推一次。
-- 【发布顺序】先推这个迁移、再部署新的 push-dispatch：旧函数调的 remind_queue_pop(int) 在这里被删掉，迁移和部署之间那几分钟旧函数
--   第 0 步每轮记 queue_pop_failed、跳过，队列不丢（不出队），第 1～8 步照常；新函数先上线则调不到 (int, int, boolean)，同样只是跳过第 0 步。
--   见 docs/08-发布/上线与回滚手册-v4.md。

set local lock_timeout = '5s';

alter table private.remind_queue
  add column claim uuid,
  add column claimed_at timestamptz,
  add column attempts smallint not null default 0;

drop function private.remind_queue_pop(int);

create function private.remind_queue_pop(p_limit int, p_lease_s int, p_retry boolean) returns table (table_name text, id uuid, user_id uuid, claim uuid)
  language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s' as $$
declare
  retry boolean := coalesce(p_retry, false);
  n int := greatest(0, least(coalesce(p_limit, 0), case when coalesce(p_retry, false) then 1 else 500 end));
  lease interval := pg_catalog.make_interval(secs => greatest(30, least(coalesce(p_lease_s, 180), 3600)));
  k uuid := pg_catalog.gen_random_uuid();
begin
  -- 孤儿（行已经没了）：照旧直接删；同样 skip locked——另一轮出队还没提交、正删着同一批孤儿时不等它（lemo-b2push 两连接实测：
  -- 不加的话后一轮要等前一轮提交，tools/db/remind-queue-2conn.mjs 场景 B）
  delete from private.remind_queue q
   using (select q2.table_name as tn, q2.id as qid from private.remind_queue q2
           where (q2.table_name = 'events' and not exists (select 1 from public.events e where e.id = q2.id))
              or (q2.table_name = 'todos' and not exists (select 1 from public.todos t where t.id = q2.id))
              or (q2.table_name = 'anniversaries' and not exists (select 1 from public.anniversaries a where a.id = q2.id))
             for update of q2 skip locked) o
   where q.table_name = o.tn and q.id = o.qid;
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
grant execute on function private.remind_queue_pop(int, int, boolean) to service_role;   -- B2 新迁移（REMIND-queue-crash-loss）  push-dispatch 第 0 步：删孤儿，可用账号的打租约出队（新项 ≤ 500 按批，重试项一次 1 项），租约过期的重取，取过 5 次的丢弃；停用和冷静期的不出队

create function private.remind_queue_finish(p_claim uuid, p_release jsonb) returns void
  language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s' as $$
begin
  if p_claim is null then return; end if;
  if p_release is not null and pg_catalog.jsonb_typeof(p_release) <> 'array' then raise exception 'bad_release'; end if;
  -- 放回：只认还是这个租约的项（处理期间被重新入队的 claim 已清空，本来就会被下一轮取到）。
  -- 放回和删除都先 for update skip locked：被用户事务锁着的行不等锁、跳过，租约留着，下一轮按租约处理（安全审查必改 2）
  update private.remind_queue q set claim = null, claimed_at = null, attempts = greatest(q.attempts - 1, 0)
    from (select q2.table_name as tn, q2.id as qid from private.remind_queue q2
            join pg_catalog.jsonb_to_recordset(coalesce(p_release, '[]'::jsonb)) as r(table_name text, id uuid)
              on q2.table_name = r.table_name and q2.id = r.id
           where q2.claim = p_claim
             for update of q2 skip locked) l
   where q.table_name = l.tn and q.id = l.qid and q.claim = p_claim;
  -- 其余这个租约的项处理完了：删掉（同样跳过锁着的）
  delete from private.remind_queue q
   using (select q2.table_name as tn, q2.id as qid from private.remind_queue q2 where q2.claim = p_claim for update of q2 skip locked) l
   where q.table_name = l.tn and q.id = l.qid and q.claim = p_claim;
end $$;
grant execute on function private.remind_queue_finish(uuid, jsonb) to service_role;   -- B2 新迁移（REMIND-queue-crash-loss）  push-dispatch 第 0 步结尾：放回的清租约，其余按租约删

-- ④ 4 个入队入口：正被租着或取过的项清租约、attempts 清零（逐字照原来的最新版，只改 on conflict 那一句）
create or replace function private.enqueue_remind() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into private.remind_queue as q (table_name, id) values (tg_table_name, new.id)
    on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0 where q.claim is not null or q.attempts > 0;
  return new;
end $$;

create or replace function private.enqueue_anniv_defaults() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into private.remind_queue as q (table_name, id)
    select 'anniversaries', a.id from public.anniversaries a
     where a.user_id = new.user_id and a.deleted_at is null and (a.remind_offsets is null or a.remind_time is null)
  on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0 where q.claim is not null or q.attempts > 0;
  return null;
end $$;

create or replace function private.enqueue_allday_defaults() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into private.remind_queue as q (table_name, id)
    select 'events', e.id from public.events e
     where e.user_id = new.user_id and e.deleted_at is null and e.time is null and e.remind_days is not null
  on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0 where q.claim is not null or q.attempts > 0;
  return null;
end $$;

create or replace function private.enqueue_floating(p_user uuid) returns void
  language plpgsql set search_path = '' as $$
declare now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  insert into private.remind_queue as q (table_name, id)
    select 'events', e.id from public.events e
     where e.user_id = p_user and e.deleted_at is null and e.time is null
       and (e.remind_at > now_ms or (e.remind_at is null and e.remind_days is not null))
  on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0 where q.claim is not null or q.attempts > 0;
  insert into private.remind_queue as q (table_name, id)
    select 'todos', t.id from public.todos t
     where t.user_id = p_user and t.deleted_at is null and not t.done
       and (t.remind_at > now_ms or (t.remind_at is null and t.due is not null
            and ((t.due_time is null and t.remind_days is not null) or (t.due_time is not null and t.remind_before_min is not null))))
  on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0 where q.claim is not null or q.attempts > 0;
  insert into private.remind_queue as q (table_name, id)
    select 'anniversaries', a.id from public.anniversaries a
     where a.user_id = p_user and a.deleted_at is null and a.remind_at > now_ms
  on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0 where q.claim is not null or q.attempts > 0;
end $$;
