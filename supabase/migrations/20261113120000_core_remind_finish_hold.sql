-- 20261113120000_core_remind_finish_hold.sql：第 0 步写回出错的项计入有毒次数（R-411 整块评审后续，11-13 主持人定；方案 docs/10-架构/方案-提醒队列重写.md 3.7）。
-- 原来写回报错（recalc_write_failed）和“预算到了”“乐观条件不成立”一样放回：finish 清租约、attempts 减 1，有毒次数不涨，
--   一直写不进去的那一项每分钟重算一次、永远不会被丢掉。
-- 改成：p_release 的元素可以带 "hold": true，这样的项 finish 既不放回、也不删，租约和 attempts 原样留着——
--   和“中途崩了、没调 finish”走同一条路：租约过期后按重试模式单独重取，取满有毒次数由出队函数丢掉（push-dispatch 记 queue_poison）。
--   不另记次数、不改表结构，复用出队时已经加上的 attempts。处理期间用户又改了这一行：入队冲突时清租约、attempts 清零（R-348），照旧按新值当新项算。
--   push-dispatch 只对数据类错误（SQLSTATE 22、23 类：这一行本身写不进去）传 hold；超时、连不上这类暂时的错误照旧放回（独立评审 M1）。
-- 不带 hold（或 hold 不为真）的元素照旧放回；放回和删除照旧 for update skip locked（锁着的跳过、租约留着）。
-- 删除改成只删“这个租约的、而且不在 p_release 里”的项（不管带不带 hold；独立评审建议 1）：原来放回那句因为行锁跳过的项，
--   到删除那句时锁可能已经放开（用户事务回滚了），就会被当成处理完删掉、这一次重算丢了；现在它留着租约，过期后走重试。
--   旧版 push-dispatch 不传 hold，行为和 20261104130000 一字不差，所以这条迁移和函数部署谁先谁后都行。
-- 签名 (uuid, jsonb)、security definer、search_path = ''、lock_timeout = 5s、只授 service_role 都不变：create or replace 保留属主和执行权，
--   3.3 C、附录 A、build/d1/whitelist.ts、fn-lock-timeout.ts 的登记不用动。只换函数体，不动表，不需要 set local lock_timeout。

create or replace function private.remind_queue_finish(p_claim uuid, p_release jsonb) returns void
  language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s' as $$
begin
  if p_claim is null then return; end if;
  if p_release is not null and pg_catalog.jsonb_typeof(p_release) <> 'array' then raise exception 'bad_release'; end if;
  -- 放回：p_release 里不带 hold、还是这个租约的项（处理期间被重新入队的 claim 已清空，本来就会被下一轮取到）。
  -- 放回和删除都先 for update skip locked：被用户事务锁着的行不等锁、跳过，租约留着，下一轮按租约处理（安全审查必改 2）
  update private.remind_queue q set claim = null, claimed_at = null, attempts = greatest(q.attempts - 1, 0)
    from (select q2.table_name as tn, q2.id as qid from private.remind_queue q2
            join pg_catalog.jsonb_to_recordset(coalesce(p_release, '[]'::jsonb)) as r(table_name text, id uuid, hold boolean)
              on q2.table_name = r.table_name and q2.id = r.id
           where q2.claim = p_claim and r.hold is not true
             for update of q2 skip locked) l
   where q.table_name = l.tn and q.id = l.qid and q.claim = p_claim;
  -- 其余这个租约的项处理完了：删掉（同样跳过锁着的）。p_release 里列出的一律不删：带 hold 的等租约过期重取；
  -- 不带 hold、上一句因为锁着没放回的，留着租约走重试（不当成处理完）
  delete from private.remind_queue q
   using (select q2.table_name as tn, q2.id as qid from private.remind_queue q2
           where q2.claim = p_claim
             and not exists (select 1 from pg_catalog.jsonb_to_recordset(coalesce(p_release, '[]'::jsonb)) as h(table_name text, id uuid)
                              where h.table_name = q2.table_name and h.id = q2.id)
             for update of q2 skip locked) l
   where q.table_name = l.tn and q.id = l.qid and q.claim = p_claim;
end $$;
