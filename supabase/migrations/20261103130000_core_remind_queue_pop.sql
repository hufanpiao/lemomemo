-- 20261103130000_core_remind_queue_pop.sql：push-dispatch 第 0 步的出队函数 private.remind_queue_pop(int)
-- （B2 任务单 BE-2 第 0 步、K3-remind-orphan；架构 5.3 第 0 步、0.42 第 1 条、0.49 第 5 条；架构审 D3 第 5 点、D6）。
-- 为什么要一个函数：PostgREST 做不了“带上限的 delete … returning”，也做不了“只出队可用账号的、孤儿直接删”这种跨三张表的判断。
-- 做法（一次调用，一个事务）：
--   ① 孤儿：目标行（events / todos / anniversaries 里同 id 的行）已经不在的队列项直接删（永久删除、30 天清理、注销后 account-purge
--      删用户时外键级联删掉了行）。不设上限：按主键的反连接，一轮就清为 0（TC-DEL-remind_queue“注销满 7 天、account-purge 跑完后下一轮清为 0”）；
--   ② 出队即删：目标行在、并且 private.account_usable(行的 user_id) 为真的，按人公平取（每人按 (table_name, id) 编号，先比编号；
--      每人每轮最多 50 条）最多 p_limit 条（上限 500，小于 1 按 0 处理），for update skip locked（两轮万一重叠，同一项只有一轮拿得到），
--      delete … returning 交给调用方重算；
--   ③ 账号不可用（停用、冷静期）的跳过、不出队，恢复后下一轮照常取到（0.42 第 1 条，M5）。
--   重算写回失败、或这一轮时间预算到了没来得及处理的，由 push-dispatch 再插回去（service_role 本来就有 remind_queue 的 insert）。
-- 返回 (table_name, id, user_id)：user_id 给调用方按人读时区和设置，不必再查一遍。
-- security definer（service_role 对 events、todos、anniversaries 的读取不经这里也有，但 account_usable 和三表反连接放在一个语句里更稳），
-- set search_path = ''、lock_timeout = 5s（和别的服务器函数一样，锁等不到就报错，push-dispatch 这一轮跳过第 0 步、下一轮再来）。
-- 执行权：0001 的默认权限已收回 PUBLIC，这里只 grant 给 service_role（下面一句和 3.3 C、附录 A 标“B2 新迁移（BE-2）”的行一字不差）。

create function private.remind_queue_pop(p_limit int) returns table (table_name text, id uuid, user_id uuid)
  language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s' as $$
declare n int := greatest(0, least(coalesce(p_limit, 0), 500));
begin
  delete from private.remind_queue q
   where (q.table_name = 'events' and not exists (select 1 from public.events e where e.id = q.id))
      or (q.table_name = 'todos' and not exists (select 1 from public.todos t where t.id = q.id))
      or (q.table_name = 'anniversaries' and not exists (select 1 from public.anniversaries a where a.id = q.id));
  if n = 0 then return; end if;
  -- 按人公平取（B2 BE-2 安全审查必改 2）：id 是客户端给的 UUID，按 (table_name, id) 排序时一个人全取 0000… 就能插到最前面，
  -- 每分钟改 ≥ 500 行就让全站新提醒算不出 remind_at。改成每人按 (table_name, id) 编号，先比编号再比 (table_name, id)：
  -- 轮流从每个人那里取，每人每轮最多 50 条；account_usable 按人判一次（先去重），停用、冷静期的人不逐行判。
  -- 窗口函数和 for update 不能在同一层：先在 ranked、lim 里排好，再到 locked 里按主键锁队列行（skip locked）。
  return query
  with cand as (
    select q.table_name as tn, q.id as qid, coalesce(e.user_id, t.user_id, a.user_id) as uid
      from private.remind_queue q
      left join public.events e on q.table_name = 'events' and e.id = q.id
      left join public.todos t on q.table_name = 'todos' and t.id = q.id
      left join public.anniversaries a on q.table_name = 'anniversaries' and a.id = q.id
  ), ok as (
    select u.uid from (select distinct cand.uid from cand where cand.uid is not null) u where private.account_usable(u.uid)
  ), ranked as (
    select cand.tn, cand.qid, cand.uid, row_number() over (partition by cand.uid order by cand.tn, cand.qid) as rn
      from cand join ok on ok.uid = cand.uid
  ), lim as (
    select ranked.tn, ranked.qid, ranked.uid from ranked where ranked.rn <= 50 order by ranked.rn, ranked.tn, ranked.qid limit n
  ), locked as (
    select q.table_name as tn, q.id as qid from private.remind_queue q
      join lim on q.table_name = lim.tn and q.id = lim.qid
       for update of q skip locked
  )
  delete from private.remind_queue q using locked l join lim on lim.tn = l.tn and lim.qid = l.qid
   where q.table_name = l.tn and q.id = l.qid
  returning q.table_name, q.id, lim.uid;
end $$;
grant execute on function private.remind_queue_pop(int) to service_role;   -- B2 新迁移（BE-2）  push-dispatch 第 0 步：删孤儿，可用账号的出队即删（≤ 500），停用和冷静期的不出队
