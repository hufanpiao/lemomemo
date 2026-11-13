-- B2 迁移 20261103130000_core_remind_queue_pop.sql 建的出队函数，20261104130000_core_remind_queue_lease.sql 改成租约式出队
-- （REMIND-queue-crash-loss 方案丙，R-348）：private.remind_queue_pop(int, int, boolean)、private.remind_queue_finish(uuid, jsonb)，
-- 4 个入队入口重新入队时清租约、attempts 清零；取过的项按重试一项一项出队，新项另外按批出队、互不挡（11-04 审查返工 H1、L2、S2；11-05 安全复审 N1）。B2 任务单 BE-2 第 0 步、K3-remind-orphan、TC-DEL-remind_queue；架构 5.3 第 0 步、0.42 第 1 条、0.49 第 3 条。
-- R-411 迁移 20261113100000（方案 docs/10-架构/方案-提醒队列重写.md 5.2 T12～T17、T22）：出队换成 (int, int, boolean, int, int, smallint)、多返回 fresh；
-- 队列带 user_id（外键级联）、prio、min_ver、fresh、enqueued_at；入队只经 remind_enqueue；孤儿不再在出队里删，带着 user_id 照常出队；跨用户先取 prio 0。
-- 迁移 20261113120000：finish 的 p_release 元素带 hold: true 的不放回也不删（第 0 步写回出错的项，计入有毒次数）；
-- 迁移 20261113160000 换成 finish(uuid, jsonb, jsonb)：传处理完的名单 p_done 时只删名单里的，都没列的留着租约（hold 作废）；放回保留 claimed_at；
-- 出队、积压统计对 account_usable 都是每人判一次，见文件末尾；批量入队不再清 attempts（只有 row 一支清），见 ⑪。
-- 线上的 push-dispatch 一律传 p_done，下面的 finish 都按三参数写；旧两参数口径（publish.ps1 -Only functions 回滚到 R-411 之前时走的）
-- 只在“处理完的名单”一段末尾留两条兼容断言。
-- 函数一侧的重算、写回、放回、finish 在 tests/edge/push-dispatch-step0.test.ts。
-- 用户：seed 的 A、B 可用，C 是管理员停用；这里另加一个冷静期的 D（disabled_reason = deletion）。
-- 同一个事务里 now() 不变：租约过期用“把 claimed_at 往前改”来造。
begin;
select plan(107);
\ir _helpers.psql
select tests.seed();

-- ① 执行权：两个函数都只给 service_role；旧签名 (int) 已删
select ok(to_regprocedure('private.remind_queue_pop(int)') is null and to_regprocedure('private.remind_queue_pop(int, int)') is null
   and to_regprocedure('private.remind_queue_pop(int, int, boolean)') is null,
  '旧签名 remind_queue_pop(int)、(int, int, boolean) 都已删（20261104130000、20261113100000）');
select ok(tests.try_as('anon', null, $$select * from private.remind_queue_pop(10, 180, false)$$) like '42501%', 'remind_queue_pop：anon 没有执行权');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select * from private.remind_queue_pop(10, 180, false)$$, null,
  'aaaaaaaa-5555-4000-8000-000000000001') like '42501%', 'remind_queue_pop：authenticated 没有执行权');
select ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
   where p.oid = 'private.remind_queue_pop(int, int, boolean, int, int, smallint)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'remind_queue_pop：PUBLIC 没有执行权');
select ok(has_function_privilege('service_role', 'private.remind_queue_pop(int, int, boolean, int, int, smallint)', 'EXECUTE'), 'remind_queue_pop：service_role 能执行');
select ok(tests.try_as('anon', null, $$select private.remind_queue_finish(null, null)$$) like '42501%', 'remind_queue_finish：anon 没有执行权');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select private.remind_queue_finish(null, null)$$, null,
  'aaaaaaaa-5555-4000-8000-000000000001') like '42501%', 'remind_queue_finish：authenticated 没有执行权');
select ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
   where p.oid = 'private.remind_queue_finish(uuid, jsonb, jsonb)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'remind_queue_finish：PUBLIC 没有执行权');
select ok(has_function_privilege('service_role', 'private.remind_queue_finish(uuid, jsonb, jsonb)', 'EXECUTE'), 'remind_queue_finish：service_role 能执行');

-- ② 定义者、search_path 置空、lock_timeout 5s、属主 postgres；返回值多了 claim
select is((select string_agg(p.oid::regprocedure::text, ',' order by p.proname) from pg_proc p
   where p.pronamespace = 'private'::regnamespace and p.proname in ('remind_queue_pop', 'remind_queue_finish')
     and p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig @> array['search_path=""', 'lock_timeout=5s'] and cardinality(p.proconfig) = 2),
  'private.remind_queue_finish(uuid,jsonb,jsonb),private.remind_queue_pop(integer,integer,boolean,integer,integer,smallint)',
  '两个函数各只有一个签名：security definer、search_path 置空、lock_timeout=5s、属主 postgres');
select is(pg_get_function_result('private.remind_queue_pop(int, int, boolean, int, int, smallint)'::regprocedure), 'TABLE(table_name text, id uuid, user_id uuid, claim uuid, fresh boolean, prio smallint)',
  '返回 table(table_name text, id uuid, user_id uuid, claim uuid, fresh boolean, prio smallint)（R-411 多返回 fresh、prio；旧版 push-dispatch 按名字取前四列）');
select is(pg_get_function_arguments('private.remind_queue_pop(int, int, boolean, int, int, smallint)'::regprocedure),
  'p_limit integer, p_lease_s integer, p_retry boolean, p_per_user integer DEFAULT 50, p_poison integer DEFAULT 5, p_ver smallint DEFAULT 0',
  '新加的三个参数都带默认值（旧版按名字传三个参数照跑）');
select is(pg_get_function_arguments('private.remind_queue_finish(uuid, jsonb, jsonb)'::regprocedure),
  'p_claim uuid, p_release jsonb, p_done jsonb DEFAULT NULL::jsonb',
  'finish 换签名（20261113160000）：p_done 带默认值 null，旧版按名字只传 p_claim、p_release 照跑；旧签名 (uuid, jsonb) 已删（上一条只剩这一个）');
select is((select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' order by ordinal_position)
   from information_schema.columns where table_schema = 'private' and table_name = 'remind_queue'),
  'table_name:text:NO:,id:uuid:NO:,claim:uuid:YES:,claimed_at:timestamp with time zone:YES:,attempts:smallint:NO:0,'
  || 'user_id:uuid:NO:,prio:smallint:NO:0,min_ver:smallint:NO:0,fresh:boolean:NO:false,enqueued_at:timestamp with time zone:NO:now()',
  'remind_queue：claim、claimed_at（可空）、attempts（默认 0），R-411 加 user_id（不可空）、prio、min_ver（默认 0）、fresh（默认 false）、enqueued_at（默认 now()）');
select is((select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'private.remind_queue'::regclass and c.contype = 'f'),
  'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE', 'remind_queue.user_id 外键 auth.users、级联删（R-411）');

-- 造数据：A 有日程、待办、纪念日各一条；B 一条待办；C（停用）、D（冷静期）各一条待办（孤儿另在 ⑰ 造）
insert into auth.users (id, email) values ('dddddddd-0000-4000-8000-000000000004', 'd@test.local');
insert into public.profiles (user_id, disabled_at, disabled_reason) values ('dddddddd-0000-4000-8000-000000000004', now(), 'deletion');
insert into public.events (id, user_id, title, date, created_at, updated_at) values
  ('e0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'e', '2026-11-03', 1, 1);
insert into public.todos (id, user_id, title, created_at, updated_at) values
  ('70000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1),
  ('70000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002', 't', 1, 1),
  ('70000000-0000-4000-8000-00000000000c', 'cccccccc-0000-4000-8000-000000000003', 't', 1, 1),
  ('70000000-0000-4000-8000-00000000000d', 'dddddddd-0000-4000-8000-000000000004', 't', 1, 1);
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at) values
  ('a0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 1, 1, 1, 1);
-- 触发器已经把上面几行入队了；清掉重来，只留下面明写的这些
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id) values
  ('events', 'e0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('todos', '70000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('anniversaries', 'a0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('todos', '70000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002'),
  ('todos', '70000000-0000-4000-8000-00000000000c', 'cccccccc-0000-4000-8000-000000000003'),
  ('todos', '70000000-0000-4000-8000-00000000000d', 'dddddddd-0000-4000-8000-000000000004');

-- ③ p_limit = 0：一条都不取，也不动队列（R-411 起出队不删孤儿）
select is((select count(*)::int from private.remind_queue_pop(0, 180, false)), 0, 'p_limit = 0：不取');
select is((select count(*)::int from private.remind_queue), 6, 'p_limit = 0：队列 6 条都还在');

-- ④ 上限：p_limit = 2 只取 2 条；按人公平（安全审查必改 2）：A 的第 1 条和 B 的第 1 条。取到的打上租约、还在队列里
create temp table got1 as select * from private.remind_queue_pop(2, 180, false);
select is((select string_agg(table_name || ':' || id::text, ',' order by table_name, id) from got1),
  'anniversaries:a0000000-0000-4000-8000-00000000000a,todos:70000000-0000-4000-8000-00000000000b', '上限 2：先取每人第 1 条（A 的纪念日、B 的待办），不是 A 的前两条');
select is((select count(distinct claim)::int || '|' || count(claim)::int from got1), '1|2', '同一批是同一个租约号，不为空');
select is((select string_agg(q.attempts::text || ':' || (q.claimed_at = now())::text, ',') from private.remind_queue q join got1 g
   on g.table_name = q.table_name and g.id = q.id and g.claim = q.claim), '1:true,1:true', '取走不删：队列里打上这个租约、claimed_at = now()、attempts = 1');

-- ⑤ 余下：租约没过期的不再取；只取可用账号（A）的；停用的 C、冷静期的 D 跳过、不打租约（0.42 第 1 条）
create temp table got2 as select * from private.remind_queue_pop(500, 180, false);
select is((select string_agg(id::text || '@' || user_id::text, ',' order by id) from got2),
  '70000000-0000-4000-8000-00000000000a@aaaaaaaa-0000-4000-8000-000000000001,e0000000-0000-4000-8000-00000000000a@aaaaaaaa-0000-4000-8000-000000000001',
  '余下只取可用账号 A 的两条（上一批租着的不重取），返回 user_id');
select ok((select g2.claim <> g1.claim from got2 g2, got1 g1 limit 1), '每一轮的租约号不同');
select is((select string_agg(id::text, ',' order by id) from private.remind_queue where claim is null),
  '70000000-0000-4000-8000-00000000000c,70000000-0000-4000-8000-00000000000d', '停用（C）和冷静期（D）的没被租');

-- ⑥ 恢复以后下一轮照常取到
update public.profiles set disabled_at = null, disabled_reason = null where user_id = 'dddddddd-0000-4000-8000-000000000004';
create temp table got3 as select * from private.remind_queue_pop(500, 180, false);
select is((select string_agg(id::text, ',') from got3), '70000000-0000-4000-8000-00000000000d', '冷静期恢复后下一轮取到');

-- ⑦ 上限封顶 500、负数按 0；null 按 0
select is((select count(*)::int from private.remind_queue_pop(-5, 180, false)), 0, '负数按 0');
select is((select count(*)::int from private.remind_queue_pop(null, 180, false)), 0, 'null 按 0');

-- ⑧ finish：放回的清租约、attempts 减 1；处理完的（p_done）删掉；别的租约、没被租的不动
select private.remind_queue_finish((select claim from got1 limit 1),
  '[{"table_name": "todos", "id": "70000000-0000-4000-8000-00000000000b"}, {"table_name": "todos", "id": "70000000-0000-4000-8000-00000000000a"}]',
  '[{"table_name": "anniversaries", "id": "a0000000-0000-4000-8000-00000000000a"}]');
select is((select string_agg(q.table_name || ':' || right(q.id::text, 2) || ':' || coalesce(q.claim = g.claim, false)::text || ':' || q.attempts, ',' order by q.table_name, q.id)
   from private.remind_queue q left join (select distinct claim from got2) g on true),
  'events:0a:true:1,todos:0a:true:1,todos:0b:false:0,todos:0c:false:0,todos:0d:false:1',
  'finish(got1)：A 的纪念日删了；B 的待办放回（租约清空、attempts 1 → 0）；release 里别人租约的 A 待办不动；got2 的、C 的、D 的不动');
select is((select string_agg(id::text, ',') from private.remind_queue_pop(500, 180, false)), '70000000-0000-4000-8000-00000000000b', '放回的下一轮马上能取到');
select private.remind_queue_finish((select claim from got2 limit 1), '[]', (select jsonb_agg(jsonb_build_object('table_name', table_name, 'id', id)) from got2));
select is((select string_agg(right(id::text, 2), ',' order by id) from private.remind_queue), '0b,0c,0d', 'finish(got2, [], 这一批)：两条都删了');
select is(tests.try_as('postgres', null, $$select private.remind_queue_finish(gen_random_uuid(), '{"table_name": "todos"}')$$), 'P0001 bad_release',
  'p_release 不是数组：报 bad_release');
select private.remind_queue_finish(null, null);
select is((select count(*)::int from private.remind_queue), 3, 'p_claim 为空：什么都不做（没被租的项不会被当成“这个租约的”删掉）');

-- ⑨ 租约过期（取走的那一轮崩了、没调 finish）：没过期的不重取，过期的重取、换新租约、attempts + 1；旧租约的 finish 不再碰它
delete from private.remind_queue where id = '70000000-0000-4000-8000-00000000000b';   -- 上面⑧取走的那条：留着它的租约没意义，清掉
update private.remind_queue set claim = gen_random_uuid(), claimed_at = now() - interval '179 seconds', attempts = 1
 where id = '70000000-0000-4000-8000-00000000000d';
select is((select count(*)::int from private.remind_queue_pop(500, 180, true) where id = '70000000-0000-4000-8000-00000000000d'), 0, '租约 179 秒前打的（180 秒租约）：不重取');
create temp table old_claim as select claim from private.remind_queue where id = '70000000-0000-4000-8000-00000000000d';
update private.remind_queue set claimed_at = now() - interval '181 seconds' where id = '70000000-0000-4000-8000-00000000000d';
create temp table got4 as select * from private.remind_queue_pop(500, 180, true);
select is((select string_agg(right(g.id::text, 2) || ':' || (g.claim <> o.claim)::text, ',') from got4 g, old_claim o), '0d:true', '过期 181 秒：重取，换了新租约');
select is((select attempts::int from private.remind_queue where id = '70000000-0000-4000-8000-00000000000d'), 2, '重取 attempts 1 → 2');
select private.remind_queue_finish((select claim from old_claim), '[]', '[{"table_name": "todos", "id": "70000000-0000-4000-8000-00000000000d"}]');
select is((select count(*)::int from private.remind_queue where id = '70000000-0000-4000-8000-00000000000d'), 1, '崩掉那一轮迟到的 finish（旧租约）不删新租约的项');
-- 租约下限 30 秒：传 1 也按 30 算
update private.remind_queue set claimed_at = now() - interval '20 seconds' where id = '70000000-0000-4000-8000-00000000000d';
select is((select count(*)::int from private.remind_queue_pop(500, 1, true) where id = '70000000-0000-4000-8000-00000000000d'), 0, 'p_lease_s = 1 按 30 秒：20 秒前打的不重取');
update private.remind_queue set claimed_at = now() - interval '100 seconds' where id = '70000000-0000-4000-8000-00000000000d';
select is((select count(*)::int from private.remind_queue_pop(500, null, true) where id = '70000000-0000-4000-8000-00000000000d'), 0, 'p_lease_s 为空按 180 秒：100 秒前打的不重取（按 30 秒就会重取）');
-- 租约上限 3600 秒（安全审查 S2）：传 100000 也按 3600 算——3599 秒前打的不重取，3601 秒前打的重取
update private.remind_queue set claimed_at = now() - interval '3599 seconds' where id = '70000000-0000-4000-8000-00000000000d';
select is((select count(*)::int from private.remind_queue_pop(500, 100000, true) where id = '70000000-0000-4000-8000-00000000000d'), 0, 'p_lease_s = 100000 按 3600 秒：3599 秒前打的不重取');
update private.remind_queue set claimed_at = now() - interval '3601 seconds' where id = '70000000-0000-4000-8000-00000000000d';
select is((select count(*)::int from private.remind_queue_pop(500, 100000, true) where id = '70000000-0000-4000-8000-00000000000d'), 1, 'p_lease_s = 100000 按 3600 秒：3601 秒前打的重取（不按 100000 秒）');

-- ⑩ 有毒项：被取走 5 次都没处理完的，第 6 次不再交出去，删掉、以 claim 为空的一行返回（push-dispatch 记 queue_poison）
update private.remind_queue set claimed_at = now() - interval '1 hour', attempts = 4 where id = '70000000-0000-4000-8000-00000000000d';
select is((select string_agg(right(id::text, 2) || ':' || (claim is not null)::text, ',') from private.remind_queue_pop(500, 180, true)), '0d:true', 'attempts = 4：第 5 次照样取（带租约）');
select is((select attempts::int from private.remind_queue where id = '70000000-0000-4000-8000-00000000000d'), 5, 'attempts 4 → 5');
update private.remind_queue set claimed_at = now() - interval '1 hour' where id = '70000000-0000-4000-8000-00000000000d';
select is((select string_agg(right(id::text, 2) || ':' || coalesce(claim::text, 'null') || ':' || user_id::text, ',') from private.remind_queue_pop(500, 180, true)),
  '0d:null:dddddddd-0000-4000-8000-000000000004', '取过 5 次又过期：第 6 次返回 claim 为空（有毒，带 user_id）');
select is((select count(*)::int from private.remind_queue where id = '70000000-0000-4000-8000-00000000000d'), 0, '有毒项已从队列删掉');
-- 放回不算次数：attempts = 5 的项被放回，下一轮照样交出去（不当成有毒）
update private.remind_queue set claim = gen_random_uuid(), claimed_at = now(), attempts = 5 where id = '70000000-0000-4000-8000-00000000000c';
update public.profiles set disabled_at = null, disabled_reason = null where user_id = 'cccccccc-0000-4000-8000-000000000003';
select private.remind_queue_finish((select claim from private.remind_queue where id = '70000000-0000-4000-8000-00000000000c'),
  '[{"table_name": "todos", "id": "70000000-0000-4000-8000-00000000000c"}]', '[]');
select is((select string_agg(right(id::text, 2) || ':' || (claim is not null)::text, ',') from private.remind_queue_pop(500, 180, true)), '0c:true',
  '放回的（attempts 5 → 4）下一轮照样带租约取走，不算有毒');
update public.profiles set disabled_at = now(), disabled_reason = 'admin' where user_id = 'cccccccc-0000-4000-8000-000000000003';

-- ⑪ 入队（R-411 起只经 remind_enqueue，下面按调它的 4 条路走）：处理期间（项正被租着）又入队，就清掉租约，finish 不删、下一轮按新值再算。
--    attempts：用户自己改了这一行（row 一支，enqueue_remind）清零（11-04 审查返工 L2，主持人定：改了就是新的一次重算，不背上一版的次数）；
--    批量范围（anniv、allday、floating）保留（20261113160000，R-411 整块评审建议 5：改一次时区、默认时刻不该把有毒项的次数清掉）。
--    没被租着、也没取过的项照旧什么都不写。
delete from private.remind_queue;
create temp table k as select gen_random_uuid() as claim;
-- enqueue_remind（events_remind、todos_remind、anniversaries_remind 三个触发器）。T12：这一项原来是批量入队的（prio 2）、规则版本 3、不是 fresh
insert into private.remind_queue (table_name, id, user_id, claim, claimed_at, attempts, prio, min_ver)
  select 'todos', '70000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', k.claim, now(), 2, 2, 3 from k;
update public.todos set due = '2026-11-20' where id = '70000000-0000-4000-8000-00000000000a';
select is((select coalesce(claim::text, 'null') || ':' || coalesce(claimed_at::text, 'null') || ':' || attempts from private.remind_queue
   where id = '70000000-0000-4000-8000-00000000000a'), 'null:null:0', 'enqueue_remind：租着的项被改，租约清空，attempts 2 → 0');
select is((select prio || ':' || min_ver || ':' || fresh from private.remind_queue where id = '70000000-0000-4000-8000-00000000000a'), '0:3:true',
  'T12：再入队时 prio 取小（2 → 0）、min_ver 取大（留 3）、fresh 取或（改了截止日期 → true）');
select private.remind_queue_finish((select claim from k), '[]', '[{"table_name": "todos", "id": "70000000-0000-4000-8000-00000000000a"}]');
select is((select count(*)::int from private.remind_queue where id = '70000000-0000-4000-8000-00000000000a'), 1, 'enqueue_remind：finish 不删处理期间重新入队的项（列在 p_done 里也不删）');
update public.todos set due = '2026-11-21' where id = '70000000-0000-4000-8000-00000000000a';
select is((select coalesce(claim::text, 'null') || ':' || attempts from private.remind_queue where id = '70000000-0000-4000-8000-00000000000a'), 'null:0',
  'enqueue_remind：没被租着、没取过的再改一次，什么都不变（不重复、不报错）');
-- 放回过、还没再取的（claim 为空、attempts > 0）被改：attempts 也清零
update private.remind_queue set attempts = 3 where id = '70000000-0000-4000-8000-00000000000a';
update public.todos set due = '2026-11-22' where id = '70000000-0000-4000-8000-00000000000a';
select is((select coalesce(claim::text, 'null') || ':' || attempts from private.remind_queue where id = '70000000-0000-4000-8000-00000000000a'), 'null:0',
  'enqueue_remind：没被租着但取过（attempts 3）的被改，attempts 清零');
-- remind_on_settings → remind_enqueue('anniv')（改纪念日默认提醒，A 的纪念日 remind_offsets 为空）
insert into private.remind_queue (table_name, id, user_id, claim, claimed_at, attempts)
  select 'anniversaries', 'a0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', k.claim, now(), 1 from k;
insert into public.settings (id, user_id, key, value) values ('5f300000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'anniv.default_time', '"08:00"');
select is((select coalesce(claim::text, 'null') || ':' || attempts from private.remind_queue where id = 'a0000000-0000-4000-8000-00000000000a'), 'null:1',
  'remind_on_settings（anniv.default_time）：租着的项租约清空，attempts 留着（1）');
-- remind_on_settings → remind_enqueue('allday')（改 remind.default_time，全天日程设了提醒、还没算、日期没过）
update public.events set remind_days = 0, date = current_date + 1 where id = 'e0000000-0000-4000-8000-00000000000a';
update private.remind_queue set claim = (select claim from k), claimed_at = now(), attempts = 3 where id = 'e0000000-0000-4000-8000-00000000000a';
insert into public.settings (id, user_id, key, value) values ('5f300000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'remind.default_time', '"08:00"');
select is((select coalesce(claim::text, 'null') || ':' || attempts from private.remind_queue where id = 'e0000000-0000-4000-8000-00000000000a'), 'null:3',
  'remind_on_settings（remind.default_time）：租着的项租约清空，attempts 留着（3）');
-- enqueue_floating → remind_enqueue('floating')（时区变了；events、todos、anniversaries 三支各一项）
update public.events set remind_at = 9999999999999 where id = 'e0000000-0000-4000-8000-00000000000a';
update public.todos set remind_at = 9999999999999 where id = '70000000-0000-4000-8000-00000000000a';
update public.anniversaries set remind_at = 9999999999999 where id = 'a0000000-0000-4000-8000-00000000000a';
update private.remind_queue set claim = (select claim from k), claimed_at = now(), attempts = 2;
select private.enqueue_floating('aaaaaaaa-0000-4000-8000-000000000001');
select is((select string_agg(table_name || ':' || coalesce(claim::text, 'null') || ':' || attempts, ',' order by table_name) from private.remind_queue
   where id in ('e0000000-0000-4000-8000-00000000000a', '70000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a')),
  'anniversaries:null:2,events:null:2,todos:null:2', 'enqueue_floating：三支都把租着的项租约清空，attempts 留着（2）');
select private.remind_queue_finish((select claim from k), '[]', (select jsonb_agg(jsonb_build_object('table_name', table_name, 'id', id)) from private.remind_queue));
select is((select count(*)::int from private.remind_queue where id in ('e0000000-0000-4000-8000-00000000000a', '70000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a')), 3, '4 条路清过租约的项，finish 都不删');
-- 批量入队碰上没被租、取过的项（attempts > 0、prio 不变小）：什么都不写，attempts 照旧（有毒项照样攒次数、取满被丢）；用户一改照旧清零
select private.enqueue_floating('aaaaaaaa-0000-4000-8000-000000000001');
select is((select string_agg(table_name || ':' || coalesce(claim::text, 'null') || ':' || attempts, ',' order by table_name) from private.remind_queue
   where id in ('e0000000-0000-4000-8000-00000000000a', '70000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a')),
  'anniversaries:null:2,events:null:2,todos:null:2', '批量再入队一次：没被租的项 attempts 照旧 2，不清零');
update public.todos set due = '2026-11-23' where id = '70000000-0000-4000-8000-00000000000a';
select is((select attempts::int from private.remind_queue where id = '70000000-0000-4000-8000-00000000000a'), 0, '同一项用户自己改了（row 一支）：attempts 2 → 0');

-- ⑫ TC-DEL-remind_queue、T17：注销满 7 天、account-purge 删掉 auth 用户，队列项随 user_id 外键级联立刻删掉（R-411 起不用等下一轮出队删孤儿）；
--    没被租的、正被租的孤儿都删，别人的不动
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id, claim, claimed_at) values
  ('todos', '70000000-0000-4000-8000-00000000000c', 'cccccccc-0000-4000-8000-000000000003', null, null),
  ('todos', '70000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002', null, null);
insert into private.remind_queue (table_name, id, user_id, claim, claimed_at)
  select 'events', 'e0000000-0000-4000-8000-0000000000fe', 'cccccccc-0000-4000-8000-000000000003', gen_random_uuid(), now();   -- 正被租着的孤儿（那一轮处理期间行被删了）
delete from auth.users where id = 'cccccccc-0000-4000-8000-000000000003';
select is((select string_agg(right(id::text, 2), ',') from private.remind_queue), '0b',
  'T17：账号删掉后，它的队列项（没被租的、正被租的孤儿）随外键立刻删掉，B 的不动');
select is((select count(*)::int from private.remind_queue_pop(0, 180, false)), 0, '下一轮出队什么都不用删');

-- ⑬ 按人公平（安全审查必改 2）：A2 有 60 条、id 全从 00000000… 开始，A 一条 ffffffff…；一轮里 A2 最多出 50 条，A 的照样取到
insert into auth.users (id, email) values ('abababab-0000-4000-8000-000000000002', 'ab@test.local');
insert into public.profiles (user_id) values ('abababab-0000-4000-8000-000000000002') on conflict do nothing;
insert into public.todos (id, user_id, title, created_at, updated_at)
  select format('00000000-0000-4000-8000-%s', lpad(to_hex(i), 12, '0'))::uuid, 'abababab-0000-4000-8000-000000000002', 't', 1, 1 from generate_series(1, 60) i;
insert into public.todos (id, user_id, title, created_at, updated_at) values ('ffffffff-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1);
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id)
  select 'todos', t.id, t.user_id from public.todos t where t.id::text like '00000000-%' or t.id = 'ffffffff-0000-4000-8000-000000000001';
create temp table got5 as select * from private.remind_queue_pop(500, 180, false);
select is((select count(*)::int from got5 where user_id = 'abababab-0000-4000-8000-000000000002'), 50, '一个人一轮最多取 50 条');
select ok(exists (select 1 from got5 where id = 'ffffffff-0000-4000-8000-000000000001'), '别人 id 排在最后的照样取到（插不了队）');
select is((select count(*)::int from private.remind_queue where claim is null), 10, 'A2 余下 10 条没被租，留到下一轮');

-- ⑭ 总数封顶 500（代码审查建议 ⑨）：另造 11 个可用账号各 50 条，加上 A2 余下的 10 条共 560 条没被租的，一轮只回 500
insert into auth.users (id, email)
  select format('f%s-0000-4000-8000-000000000000', lpad(i::text, 7, '0'))::uuid, format('f%s@test.local', i) from generate_series(1, 11) i;
insert into public.profiles (user_id)
  select format('f%s-0000-4000-8000-000000000000', lpad(i::text, 7, '0'))::uuid from generate_series(1, 11) i
  on conflict do nothing;
insert into public.todos (id, user_id, title, created_at, updated_at)
  select format('%s-0000-4000-8000-%s', lpad(to_hex(i), 8, '0'), lpad(to_hex(j), 12, '0'))::uuid,
         format('f%s-0000-4000-8000-000000000000', lpad(i::text, 7, '0'))::uuid, 't', 1, 1
    from generate_series(1, 11) i, generate_series(1, 50) j;
delete from private.remind_queue where claim is not null or id::text not like '00000000-%';   -- 建行时触发器入的队也清掉
insert into private.remind_queue (table_name, id, user_id)
  select 'todos', t.id, t.user_id from public.todos t where t.user_id::text like 'f00000%';
select is((select count(*)::int from private.remind_queue_pop(500, 180, false)), 500, '队列 560 条：一轮只回 500');

-- ⑮ 重试（11-04 审查返工：代码审查 H1 / 安全审查必改 1；11-05 安全复审 N1 改成两段）：一批里有一项一算就崩（bad，A 的待办），
--    同批的 innocent（B 的待办）、ev（A 的日程）不能被连坐。模拟 8 轮（push-dispatch 的 step0）：每轮先单项重试（p_retry = true）
--    反复取到取空，再做一次新项按批出队（p_retry = false）；取到 bad 就“进程死了”（这一批不 finish、这一轮结束），
--    取到别的就当处理完、列进 p_done 调 finish（线上口径）；每轮结束把还租着的项租约改成过期。
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id) values
  ('todos', '70000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001'),   -- bad
  ('todos', '70000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002'),   -- innocent
  ('events', 'e0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001');  -- ev
create temp table sim (r int, n int, tn text, id uuid, claimed boolean, retry boolean);
do $$
declare rr int; i int; x record; got int; cl uuid; crashed boolean; seq int := 0; m boolean; dn jsonb;
begin
  for rr in 1..8 loop
    crashed := false;
    for i in 1..11 loop                                         -- 前 10 次单项重试（取空就停），第 11 次是新项按批
      m := i <= 10;
      got := 0; cl := null; dn := '[]';
      for x in select * from private.remind_queue_pop(500, 180, m) loop
        seq := seq + 1; got := got + 1;
        insert into sim values (rr, seq, x.table_name, x.id, x.claim is not null, m);
        if x.claim is not null then cl := x.claim; dn := dn || jsonb_build_object('table_name', x.table_name, 'id', x.id); end if;
        if x.claim is not null and x.id = '70000000-0000-4000-8000-00000000000a' then crashed := true; end if;
      end loop;
      exit when crashed;                                        -- 进程死了：这一批不 finish、这一轮结束
      if cl is not null then perform private.remind_queue_finish(cl, '[]', dn); end if;   -- 和线上一样：处理完的列进 p_done
      if m and got = 0 then i := 10; end if;                    -- 重试取空了：跳到新项按批
      exit when not m;
    end loop;
    update private.remind_queue set claimed_at = now() - interval '1 hour' where claim is not null;   -- 租约过期
  end loop;
end $$;
select is((select string_agg(tn || ':' || right(id::text, 2) || ':' || claimed::text || ':' || retry::text, ',' order by tn, id) from sim where r = 1),
  'events:0a:true:false,todos:0a:true:false,todos:0b:true:false', '第 1 轮：没有重试项，三项按批一起出队（同一个租约），取到 bad 就崩');
select is((select string_agg(r || ':' || tn || ':' || right(id::text, 2), ',' order by n) from sim where r in (2, 3)),
  '2:events:0a,2:todos:0a,3:todos:0b,3:todos:0a', '第 2、3 轮单项重试：一项一项出队，attempts 少的先；ev、innocent 单独处理完，bad 每次单独崩');
select is((select count(*)::int from sim where id = '70000000-0000-4000-8000-00000000000b' and claimed), 2,
  'innocent 只出队两次（第 1 批、第 3 轮单独一次），处理完了，没有被连坐到 5 次');
select is((select string_agg(r || ':' || tn || ':' || right(id::text, 2), ',') from sim where not claimed), '6:todos:0a',
  '只有 bad 被当成有毒项丢掉（第 6 轮：第 1 批加 4 次单独，取过 5 次都没处理完）');
select is((select count(*)::int from private.remind_queue), 0, '8 轮以后队列清空：ev、innocent 处理完删掉，bad 被丢掉');

-- ⑯ 重试项挡不住新项（11-05 安全复审 N1）：A2 有 30 项取过、租约过期的重试项，B 新改了一项。新项按批出队只取 B 的新项、
--    不管有没有重试项；单项重试只取重试项、一次 1 项。同样次数的重试项按 claimed_at 先来先到，不按 id（20261113160000 起放回保留 claimed_at，不再插到最前）
insert into private.remind_queue (table_name, id, user_id, claim, claimed_at, attempts)
  select 'todos', t.id, t.user_id, gen_random_uuid(), now() - interval '1 hour', 1 from public.todos t
   where t.user_id = 'abababab-0000-4000-8000-000000000002' order by t.id limit 30;
insert into private.remind_queue (table_name, id, user_id) values ('todos', '70000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002');
select is((select string_agg(right(id::text, 2) || ':' || (claim is not null)::text, ',') from private.remind_queue_pop(500, 180, false)), '0b:true',
  '有 30 项重试项时，新项按批出队照样取到 B 的新项（只取 attempts = 0 的，不取重试项）');
select is((select count(*)::int || ':' || count(distinct user_id)::int from private.remind_queue_pop(500, 180, true)), '1:1',
  '单项重试：p_limit 500 也只交出 1 项');
select is((select count(*)::int from private.remind_queue_pop(500, 180, null) where id::text like '00000000-%'), 0, 'p_retry 为空按新项：不取重试项');
insert into private.remind_queue (table_name, id, user_id, claim, claimed_at, attempts) values
  ('todos', 'ffffffff-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid(), now() - interval '2 hours', 1);
select is((select string_agg(right(id::text, 2), ',') from private.remind_queue_pop(500, 180, true)), '01',
  '同样 attempts 1：A 两小时前取走的那项排在 A2 一小时前取走的 29 项前面（先来先到，不按 id）');
create temp table rel as select id from private.remind_queue
 where id::text like '00000000-%' and claimed_at < now() - interval '30 minutes' order by id desc limit 1;
create temp table rel_next as select id from private.remind_queue
 where id::text like '00000000-%' and claimed_at < now() - interval '30 minutes' and id <> (select id from rel) order by id limit 1;
update private.remind_queue set attempts = 2 where id = (select id from rel);
select private.remind_queue_finish((select claim from private.remind_queue where id = (select id from rel)),
  jsonb_build_array(jsonb_build_object('table_name', 'todos', 'id', (select id from rel))), '[]');
select is((select (claim is null)::text || ':' || (claimed_at = now() - interval '1 hour')::text || ':' || attempts from private.remind_queue where id = (select id from rel)),
  'true:true:1', '放回清租约、attempts 2 → 1，claimed_at 留着（最近一次被取走的时刻）');
select is((select string_agg(p.id::text, ',') from private.remind_queue_pop(500, 180, true) p), (select id::text from rel_next),
  '放回过的（id 最大）不插队：和其余同一时刻取走、同样 attempts 的一起按 id 排，取到的是 id 最小的那项');

-- 账号不可用的重试项不交出去：D 停用（冷静期），它的项 attempts = 2、租约过期
delete from private.remind_queue;
update public.profiles set disabled_at = now(), disabled_reason = 'deletion' where user_id = 'dddddddd-0000-4000-8000-000000000004';
insert into private.remind_queue (table_name, id, user_id, claim, claimed_at, attempts) values
  ('todos', '70000000-0000-4000-8000-00000000000d', 'dddddddd-0000-4000-8000-000000000004', gen_random_uuid(), now() - interval '1 hour', 2);
insert into private.remind_queue (table_name, id, user_id) values ('todos', '70000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002');
select is((select count(*)::int from private.remind_queue_pop(500, 180, true)), 0, '账号不可用的重试项不交出去');
select is((select string_agg(right(id::text, 2), ',') from private.remind_queue_pop(500, 180, false)), '0b', '可用账号的新项照常按批出队');

-- ⑰ R-411（方案 5.2 T13～T16、T22）。出队不读三张表，队列项只要 user_id 是可用账号就行，下面多用不存在的行 id（同时就是孤儿）
-- T13 跨用户先算用户改动：600 个可用账号各 1 条批量项（prio 1），B 另有 1 条自己改的（prio 0）；一轮 500 条里有 B 的
delete from private.remind_queue;
insert into auth.users (id, email)
  select format('e%s-0000-4000-8000-000000000000', lpad(i::text, 7, '0'))::uuid, format('e%s@test.local', i) from generate_series(1, 600) i;
insert into public.profiles (user_id)
  select format('e%s-0000-4000-8000-000000000000', lpad(i::text, 7, '0'))::uuid from generate_series(1, 600) i on conflict do nothing;
insert into private.remind_queue (table_name, id, user_id, prio)
  select 'todos', gen_random_uuid(), format('e%s-0000-4000-8000-000000000000', lpad(i::text, 7, '0'))::uuid, 1 from generate_series(1, 600) i;
insert into private.remind_queue (table_name, id, user_id, prio) values ('todos', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'bbbbbbbb-0000-4000-8000-000000000002', 0);
create temp table got6 as select * from private.remind_queue_pop(500, 180, false);
select is((select count(*)::int || ':' || count(*) filter (where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff')::int from got6), '500:1',
  'T13：600 个人各 1 条批量项（prio 1）排在前面也挡不住：B 自己改的那条（prio 0，id 最大）在这一轮 500 条里');

-- T14 同一个人的批量项里快到点的先算：A 三条 prio 2（id 小），一条 prio 1（id 最大）；只取 1 条时先取 prio 1
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id, prio) values
  ('events', '00000000-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-000000000001', 2),
  ('events', '00000000-0000-4000-8000-0000000000e2', 'aaaaaaaa-0000-4000-8000-000000000001', 2),
  ('todos', '00000000-0000-4000-8000-0000000000e3', 'aaaaaaaa-0000-4000-8000-000000000001', 2),
  ('todos', 'ffffffff-0000-4000-8000-0000000000e4', 'aaaaaaaa-0000-4000-8000-000000000001', 1);
select is((select string_agg(right(id::text, 2), ',') from private.remind_queue_pop(1, 180, false)), 'e4', 'T14：prio 1 先于 prio 2（不看表名和 id）');
select is((select string_agg(right(id::text, 2), ',' order by id) from private.remind_queue_pop(500, 180, false)), 'e1,e2,e3', '余下的 prio 2 下一轮照常取');

-- T15 每人上限、有毒次数改成参数（push-dispatch 从 LIMITS 传）：p_per_user = 2 一个人一轮只出 2 条；p_poison = 2 取过 2 次就丢
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id)
  select 'todos', format('00000000-0000-4000-8000-%s', lpad(to_hex(i), 12, '0'))::uuid, 'aaaaaaaa-0000-4000-8000-000000000001' from generate_series(1, 5) i;
select is((select count(*)::int from private.remind_queue_pop(500, 180, false, 2)), 2, 'T15：p_per_user = 2：A 五条一轮只出 2 条');
select is((select count(*)::int from private.remind_queue_pop(500, 180, false, null)), 3, 'p_per_user 为空按 50：余下 3 条都出');
update private.remind_queue set claimed_at = now() - interval '1 hour', attempts = 2;
select is((select string_agg(coalesce(claim::text, 'null'), ',') from private.remind_queue_pop(500, 180, true, 50, 2)), 'null',
  'p_poison = 2：取过 2 次又过期的直接丢掉（claim 为空）');
select is((select string_agg((claim is not null)::text, ',') from private.remind_queue_pop(500, 180, true)), 'true',
  'p_poison 不传按 5：attempts 2 的照常带租约重取');

-- T16 孤儿（行被硬删）带着 user_id 照常出队，第 0 步读不到行不放回，finish 按租约删掉；停用账号的孤儿不出队、不进积压统计
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id) values
  ('events', 'e0000000-0000-4000-8000-0000000000ff', 'aaaaaaaa-0000-4000-8000-000000000001'),   -- 没有这一行
  ('todos', 'e0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001'),    -- id 在 events 里、todos 里没有
  ('todos', 'e0000000-0000-4000-8000-0000000000dd', 'dddddddd-0000-4000-8000-000000000004');    -- D 冷静期
create temp table got7 as select * from private.remind_queue_pop(500, 180, false);
select is((select string_agg(table_name || ':' || right(id::text, 2) || ':' || (claim is not null)::text || ':' || left(user_id::text, 8), ',' order by table_name, id) from got7),
  'events:ff:true:aaaaaaaa,todos:0a:true:aaaaaaaa', 'T16：A 的两条孤儿照常带租约出队、带 user_id；D（冷静期）的不出队');
select private.remind_queue_finish((select claim from got7 limit 1), '[]', (select jsonb_agg(jsonb_build_object('table_name', table_name, 'id', id)) from got7));
select is((select string_agg(right(id::text, 2), ',') from private.remind_queue), 'dd', 'finish 按 p_done 删掉 A 的孤儿（第 0 步读不到行记 gone、列进 p_done）；D 的留到恢复或注销');
select is((select user_items || ':' || batch_items || ':' || oldest_user_wait_s from private.remind_queue_stats()), '0:0:0',
  '积压统计不算停用、冷静期账号的项');

-- T22 规则版本：min_ver = 2 的项，p_ver 不传（0）、1 都拿不到，2 拿得到；fresh 原样交出
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id, min_ver, fresh, prio) values
  ('todos', '00000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-000000000001', 2, true, 1);
select is((select count(*)::int from private.remind_queue_pop(500, 180, false)), 0, 'T22：p_ver 不传（旧版 push-dispatch）拿不到 min_ver = 2 的项');
select is((select count(*)::int from private.remind_queue_pop(500, 180, false, 50, 5, 1::smallint)), 0, 'p_ver = 1 也拿不到');
select is((select string_agg(right(id::text, 2) || ':' || fresh || ':' || prio, ',') from private.remind_queue_pop(500, 180, false, 50, 5, 2::smallint)), 'f1:true:1',
  'p_ver = 2 拿得到，fresh、prio 原样交出（6.3 Q2：第 0 步按“新建或改了截止”算；3.7：logs 只记 prio 0 的）');

-- 积压统计：可用账号 prio 0 的项数、批量项数、prio 0 最老一项从 enqueued_at 起等了几秒（同一事务 now() 不变，往前改 enqueued_at 来造）
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id, prio, enqueued_at) values
  ('todos', '00000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 0, now() - interval '100 seconds'),
  ('todos', '00000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 0, now() - interval '5 seconds'),
  ('todos', '00000000-0000-4000-8000-0000000000a3', 'aaaaaaaa-0000-4000-8000-000000000001', 1, now() - interval '9000 seconds'),
  ('todos', '00000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 2, now()),
  ('todos', '00000000-0000-4000-8000-0000000000d1', 'dddddddd-0000-4000-8000-000000000004', 0, now() - interval '1000 seconds');
select is((select user_items || ':' || batch_items || ':' || oldest_user_wait_s from private.remind_queue_stats()), '2:2:100',
  '积压统计：A 两条用户改的、A 和 B 各一条批量；最老等了 100 秒（批量的 9000 秒、冷静期 D 的 1000 秒都不算）');
select is((select p.prosecdef::text || ':' || array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'private.remind_queue_stats()'::regprocedure),
  'true:search_path="",lock_timeout=5s', 'remind_queue_stats：security definer、search_path 置空、lock_timeout=5s');
select ok(has_function_privilege('service_role', 'private.remind_queue_stats()', 'EXECUTE'), 'remind_queue_stats：service_role 能执行');

-- 处理完的名单（迁移 20261113160000，R-411 后续）：传了 p_done 只删名单里的；p_release 里的放回（claimed_at 留着）；两份都没列的
-- （第 0 步写回遇到数据类错误的项）租约、claimed_at、attempts 原样，和“中途崩了”一样：没过期谁都不取，过期后按重试取、attempts 加 1，取满有毒次数被丢掉
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id) values
  ('todos', '00000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('todos', '00000000-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('todos', '00000000-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('todos', '00000000-0000-4000-8000-0000000000c6', 'aaaaaaaa-0000-4000-8000-000000000001');
create temp table got8 as select * from private.remind_queue_pop(500, 180, false);
select private.remind_queue_finish((select claim from got8 limit 1),
  '[{"table_name": "todos", "id": "00000000-0000-4000-8000-0000000000c2"}, {"table_name": "todos", "id": "00000000-0000-4000-8000-0000000000c6"}]',
  '[{"table_name": "todos", "id": "00000000-0000-4000-8000-0000000000c3"}, {"table_name": "todos", "id": "00000000-0000-4000-8000-0000000000c6"}]');
select is((select string_agg(right(q.id::text, 2) || ':' || coalesce(q.claim = g.claim, false)::text || ':' || q.attempts || ':' || (q.claimed_at = now())::text, ',' order by q.id)
   from private.remind_queue q left join (select distinct claim from got8) g on true),
  'c1:true:1:true,c2:false:0:true,c6:false:0:true',
  'finish 传 p_done：都没列的 c1 租约、attempts 原样留着；c2 放回（attempts 1 → 0、claimed_at 留着）；c3 删了；两份都列的 c6 按放回、不删');
select is(tests.try_as('postgres', null, $$select private.remind_queue_finish(gen_random_uuid(), '[]', '{"table_name": "todos"}')$$), 'P0001 bad_done',
  'p_done 不是数组：报 bad_done');
-- p_done 里列了别人租约的项、没被租的项：不删
update private.remind_queue set claim = gen_random_uuid() where id = '00000000-0000-4000-8000-0000000000c6';
select private.remind_queue_finish((select claim from got8 limit 1), '[]',
  '[{"table_name": "todos", "id": "00000000-0000-4000-8000-0000000000c2"}, {"table_name": "todos", "id": "00000000-0000-4000-8000-0000000000c6"}]');
select is((select string_agg(right(id::text, 2), ',' order by id) from private.remind_queue), 'c1,c2,c6', 'p_done 只删还是这个租约的：放回了的 c2、别人租约的 c6 都不删');
delete from private.remind_queue where id = '00000000-0000-4000-8000-0000000000c6';
select is((select count(*)::int from private.remind_queue_pop(500, 180, true) where id = '00000000-0000-4000-8000-0000000000c1'), 0,
  '留着租约的项没过期：重试出队也不取');
update private.remind_queue set claimed_at = now() - interval '181 seconds' where id = '00000000-0000-4000-8000-0000000000c1';
create temp table got9 as select * from private.remind_queue_pop(500, 180, true, 50, 2);
select is((select string_agg(right(g.id::text, 2) || ':' || (g.claim is not null)::text || ':' || q.attempts, ',') from got9 g join private.remind_queue q on q.id = g.id),
  'c1:true:2', '过期后按重试取到、换新租约，attempts 1 → 2（计入有毒次数）');
select private.remind_queue_finish((select claim from got9), '[]', '[]');
update private.remind_queue set claimed_at = now() - interval '181 seconds' where id = '00000000-0000-4000-8000-0000000000c1';
select is((select string_agg(right(id::text, 2) || ':' || (claim is null)::text, ',') from private.remind_queue_pop(500, 180, true, 50, 2)), 'c1:true',
  '又写回出错、两份都没列；再过期时已取满 p_poison（2）次：出队丢掉、以 claim 为空返回');
select is((select string_agg(right(id::text, 2), ',' order by id) from private.remind_queue), 'c2', '有毒的 c1 已删，放回的 c2 还在');
-- 兼容断言（旧两参数口径，只留这两条）：p_done 为空那条分支是给 publish.ps1 -Only functions 把函数回滚到 R-411 之前版本用的，不能删。
-- 旧版 push-dispatch（不传 p_done）：这个租约里不在 p_release 的照旧删；20261113120000 的 hold: true 不再认，按放回处理
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id) values
  ('todos', '00000000-0000-4000-8000-0000000000c7', 'aaaaaaaa-0000-4000-8000-000000000001'), ('todos', '00000000-0000-4000-8000-0000000000c8', 'aaaaaaaa-0000-4000-8000-000000000001');
create temp table got11 as select * from private.remind_queue_pop(500, 180, false);
select private.remind_queue_finish((select claim from got11 limit 1), '[{"table_name": "todos", "id": "00000000-0000-4000-8000-0000000000c7", "hold": true}]');
select is((select string_agg(right(id::text, 2) || ':' || (claim is null)::text || ':' || attempts, ',' order by id) from private.remind_queue), 'c7:true:0',
  '旧版两参数调用：带 hold 的 c7 放回（attempts 1 → 0），没列出的 c8 删了');
-- 放回那句没放回成（真实场景是行被用户事务锁着、skip locked 跳过，删除那句时锁已放开；单会话造不出，用一个只挡这一行 update 的触发器代替）：
-- 列在 p_release 里的一律不删，留着租约走重试（独立评审建议 1；原来会被当成处理完删掉）
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id) values
  ('todos', '00000000-0000-4000-8000-0000000000c4', 'aaaaaaaa-0000-4000-8000-000000000001'), ('todos', '00000000-0000-4000-8000-0000000000c5', 'aaaaaaaa-0000-4000-8000-000000000001');
create temp table got10 as select * from private.remind_queue_pop(500, 180, false);
create function tests.skip_c4() returns trigger language plpgsql as $$
begin
  if old.id = '00000000-0000-4000-8000-0000000000c4' then return null; end if;
  return new;
end $$;
create trigger t_skip_c4 before update on private.remind_queue for each row execute function tests.skip_c4();
select private.remind_queue_finish((select claim from got10 limit 1), '[{"table_name": "todos", "id": "00000000-0000-4000-8000-0000000000c4"}]');
drop trigger t_skip_c4 on private.remind_queue;
select is((select string_agg(right(q.id::text, 2) || ':' || coalesce(q.claim = g.claim, false)::text || ':' || q.attempts, ',' order by q.id)
   from private.remind_queue q left join (select distinct claim from got10) g on true),
  'c4:true:1', '放回没成的 c4 不删、租约和 attempts 留着（过期后重试）；没列出的 c5 照旧删');


-- 判可用账号的次数（迁移 20261113160000，R-411 后续，独立评审建议 11、方案 3.7 第 ② 条；整块评审建议 2 起出队和统计同一种写法）：
-- pg_stat_xact_user_functions 记本事务里的调用次数。原写法 (select distinct uid …) where account_usable(uid) 的条件被推进 distinct 子查询，
-- 对每一项各调一次；remind_enqueue('all', …) 以后每轮上万次。现在候选里不同的 user_id 先物化、每人判一次。
-- 300 个可用账号（⑰ T13 建的 e 开头那批）各 4 条批量项，共 1200 条
delete from private.remind_queue;
set local track_functions = 'all';
insert into private.remind_queue (table_name, id, user_id, prio)
  select 'todos', gen_random_uuid(), format('e%s-0000-4000-8000-000000000000', lpad((i % 300 + 1)::text, 7, '0'))::uuid, 1 from generate_series(1, 1200) i;
create temp table au_calls (k text primary key, n bigint);
create function tests.au_mark(p_k text) returns void language sql as $$
  insert into au_calls values (p_k, coalesce((select calls from pg_stat_xact_user_functions where schemaname = 'private' and funcname = 'account_usable'), 0))
$$;
create function tests.au_diff(p_a text, p_b text) returns int language sql as $$
  select (b.n - a.n)::int from au_calls a, au_calls b where a.k = p_a and b.k = p_b
$$;
select tests.au_mark('s0');
select is((select user_items || ':' || batch_items from private.remind_queue_stats()), '0:1200', '积压统计：1200 条批量项都算上');
select tests.au_mark('s1');
select is(tests.au_diff('s0', 's1'), 300, '积压统计：300 个人各判一次（不是每一项判一次的 1200）');
select tests.au_mark('p0');
select is((select count(*)::int || ':' || count(distinct user_id)::int from private.remind_queue_pop(100, 180, false)), '100:100', '出队 100 条：先取每人第 1 条');
select tests.au_mark('p1');
select is(tests.au_diff('p0', 'p1'), 300, '出队：候选里 300 个人各判一次（不是每一项判一次的 1200）');
update private.remind_queue set claim = gen_random_uuid(), claimed_at = now() - interval '1 hour', attempts = 1 where claim is null;
select tests.au_mark('r0');
select is((select count(*)::int from private.remind_queue_pop(1, 180, true)), 1, '单项重试取 1 项');
select tests.au_mark('r1');
select is(tests.au_diff('r0', 'r1'), 300, '单项重试：候选 1100 项、300 个人，各判一次（不是 1100 次）');
-- 排在最前的不可用账号：它们的项一条不交出去，照样取满可用账号的
delete from private.remind_queue;
insert into auth.users (id, email)
  select format('cd%s-0000-4000-8000-000000000000', lpad(i::text, 6, '0'))::uuid, format('cd%s@test.local', i) from generate_series(1, 5) i;
insert into public.profiles (user_id, disabled_at, disabled_reason)
  select format('cd%s-0000-4000-8000-000000000000', lpad(i::text, 6, '0'))::uuid, now(), 'deletion' from generate_series(1, 5) i;
insert into private.remind_queue (table_name, id, user_id, prio)
  select 'todos', gen_random_uuid(), format('cd%s-0000-4000-8000-000000000000', lpad((i % 5 + 1)::text, 6, '0'))::uuid, 0 from generate_series(1, 20) i;
insert into private.remind_queue (table_name, id, user_id, prio)
  select 'todos', gen_random_uuid(), format('e%s-0000-4000-8000-000000000000', lpad((i % 300 + 1)::text, 7, '0'))::uuid, 1 from generate_series(1, 1200) i;
select tests.au_mark('d0');
select is((select count(*)::int || ':' || count(*) filter (where user_id::text like 'cd%')::int from private.remind_queue_pop(10, 180, false)), '10:0',
  '冷静期账号的 20 条 prio 0 排在最前：一条不交出去，照样取满 10 条可用账号的');
select tests.au_mark('d1');
select is(tests.au_diff('d0', 'd1'), 305, '判 305 次：5 个冷静期账号加 300 个可用账号，每人一次（不是 1220 次）');
select * from finish();
rollback;
