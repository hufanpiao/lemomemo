-- 迁移 20261113170000_todos_items_create.sql：待办子任务 todo_items（R-350；方案 docs/10-架构/方案-R350-待办子任务.md 2.4～2.6、6.1）
-- 覆盖测试用例草案的服务器部分：
--   TC-R350-01 结构：table_meta 行、(user_id, synced_at) 索引、Realtime publication、tombstones 的 tbl check、列级授权、触发器、复合外键；
--   TC-R350-02 RLS：本人挂自己的待办、挂别人的待办报 not_found、别人读改不到、anon 被拒、没有 REST 硬删、冒名写不进、停用账号写不进、todo_id 改不了；
--   TC-R350-03、04 冲突口径：不同项互不冲突；同一项 done 后写胜出不报冲突；title 照常报 conflict；白名单外的 todo_id 被丢掉；
--   TC-R350-12：主待办被永久删除后再插它的子任务回 not_found（todo_items_cap 先锁主待办；R-350 主持人 11-13 代定）；
--   TC-R350-13：软删恢复主待办时子任务原样；永久删除、30 天清理时子任务级联硬删、各留墓碑；“全部清空”多清本人已软删的子任务；逐条永久删除不收 todo_items；
--   TC-R350-14：每条待办看得见的子任务 ≥ 30 再加、恢复删除、恢复撤销都报 items_quota；删掉或撤销的不占名额；标题 1～100 字、不能全是空格；
--     加子任务时主待办行被本事务锁上（并发两连接的场景在 store-it 的 todo-items-cap.it.ts，pgTAP 只能单连接）。
-- 用户：A、B、停用的 C（tests.seed）
begin;
select plan(62);
\ir _helpers.psql
select tests.seed();   -- A、B 正常，C 停用

-- 以 authenticated 身份调 apply_patch：成功回结果 jsonb，失败回 {"error": "<sqlstate> <信息>"}（同 14 号）
create function tests.ap(p_uid uuid, p_table text, p_id uuid, p_patch jsonb, p_base int, p_op uuid)
  returns jsonb language sql as $$
  with x as (select tests.rows_as('authenticated', p_uid,
    format('select public.apply_patch(%L, %L::uuid, %L::jsonb, %s, %L::uuid) as r', p_table, p_id, p_patch, p_base, p_op)) j)
  select coalesce(j -> 0 -> 'r', j) from x
$$;
create function tests.ms(p_days_ago int default 0) returns bigint language sql as $$
  select ((extract(epoch from now()) - p_days_ago * 86400) * 1000)::bigint $$;

-- 待办：A 的 T（常用）、T2（测永久删除）、T3（测 30 天清理）、T4（测上限）；B 的 TB
insert into public.todos (id, user_id, title, created_at, updated_at) values
  ('7a000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'T', 1, 1),
  ('7a000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'T2', 1, 1),
  ('7a000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'T3', 1, 1),
  ('7a000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 'T4', 1, 1),
  ('7a000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'TB', 1, 1);

-- ===== TC-R350-01：结构 =====
select is((select system_cols::text || '|' || no_conflict::text from private.table_meta where tbl = 'todo_items'),
  '{}|{done,sort,updated_at}', 'table_meta：没有系统列，no_conflict = done、sort、updated_at（方案 2.5）');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'todo_items' and indexdef like '%(user_id, synced_at)%'),
  '有 (user_id, synced_at) 索引（3.1 每张同步表都建）');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'todo_items'
  and indexdef like '%(todo_id)' and indexdef not like '%WHERE%'), '有完整的 (todo_id) 索引（级联删、计数都用得上；R-350 评审第 4 条）');
select ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'todo_items'),
  '进了 Realtime publication');
select ok((select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'tombstones_tbl_check'
  and c.conrelid = 'public.tombstones'::regclass) like '%''todo_items''%', 'tombstones 的 tbl check 含 todo_items');
select is((select string_agg(column_name::text, ',' order by column_name::text) from information_schema.column_privileges
  where table_schema = 'public' and table_name = 'todo_items' and grantee = 'authenticated' and privilege_type = 'INSERT'),
  'created_at,done,id,sort,title,todo_id,updated_at', 'insert 只授 id、todo_id、title、done、sort、created_at、updated_at（user_id 走默认值）');
select is((select string_agg(column_name::text, ',' order by column_name::text) from information_schema.column_privileges
  where table_schema = 'public' and table_name = 'todo_items' and grantee = 'authenticated' and privilege_type = 'UPDATE'),
  'deleted_at,done,sort,title,undone,updated_at', 'update 只授六列（todo_id 只能 insert）');
select is((select string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'todo_items' and grantee in ('anon', 'authenticated')),
  'authenticated:SELECT', '表级授权只有 authenticated 的 SELECT（没有 DELETE，anon 什么都没有）');
select is((select string_agg(tgname::text, ',' order by tgname::text) from pg_trigger where tgrelid = 'public.todo_items'::regclass and not tgisinternal),
  'todo_items_cap,todo_items_quota,todo_items_tombstone,todo_items_touch', '四个触发器都在');
select is((select p.prosecdef::text || '|' || array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'private.todo_items_cap()'::regprocedure)
  || '|' || has_function_privilege('authenticated', 'private.todo_items_cap()', 'EXECUTE')::text
  || '|' || has_function_privilege('anon', 'private.todo_items_cap()', 'EXECUTE')::text,
  'false|search_path=""|false|false', 'todo_items_cap：security invoker、search_path 空、客户端角色没有执行权（仅触发器调用）');
select is((select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.todo_items'::regclass and c.contype = 'f'
  and pg_get_constraintdef(c.oid) like '%todos%'), 'FOREIGN KEY (todo_id, user_id) REFERENCES todos(id, user_id) ON DELETE CASCADE',
  '复合外键 (todo_id, user_id) → todos(id, user_id)，级联删除');

-- ===== TC-R350-02：RLS =====
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7b000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000001', '买牛奶', 1, 1, 1)$$),
  'ok', '① A 给自己的待办 T 加子任务');
select is((select user_id::text || '|' || rev || '|' || done::text from public.todo_items where id = '7b000000-0000-4000-8000-000000000001'),
  'aaaaaaaa-0000-4000-8000-000000000001|1|false', '① user_id 由默认值填成 A，rev 从 1 起，done 默认 false');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7b000000-0000-4000-8000-0000000000f1', '7a000000-0000-4000-8000-0000000000b1', '挂到 B 的', 1, 1, 1)$$) = 'P0001 not_found',
  '② A 挂到 B 的待办 TB：锁不到本人的这条待办，not_found（复合外键兜底）');
select is((select count(*)::int from public.todo_items where id = '7b000000-0000-4000-8000-0000000000f1'), 0, '② 没有留下行');
select is(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', 'select count(*)::int as n from public.todo_items'),
  '[{"n": 0}]'::jsonb, '③ B 读不到 A 的子任务');
select is(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$update public.todo_items set title = 'B 改的'$$)
  || '|' || (select title from public.todo_items where id = '7b000000-0000-4000-8000-000000000001'), 'ok|买牛奶', '③ B 改 A 的：一行都没改到');
select ok(tests.try_as('anon', null, $$select 1 from public.todo_items$$) like '42501%', '④ anon 读不了');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$delete from public.todo_items where id = '7b000000-0000-4000-8000-000000000001'$$) like '42501%', '⑤ A 经 REST 硬删自己的子任务：没有 DELETE 权限');
select is((select count(*)::int from public.todo_items where id = '7b000000-0000-4000-8000-000000000001'), 1, '⑤ 行还在');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todo_items (id, user_id, todo_id, title, sort, created_at, updated_at)
  values ('7b000000-0000-4000-8000-0000000000f2', 'bbbbbbbb-0000-4000-8000-000000000002', '7a000000-0000-4000-8000-0000000000b1', '冒名', 1, 1, 1)$$) like '42501%',
  '⑥ A 带 user_id = B 插入：user_id 列没授 insert（42501）');
select ok(tests.try_as('authenticated', 'cccccccc-0000-4000-8000-000000000003', $$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7b000000-0000-4000-8000-0000000000f3', '7a000000-0000-4000-8000-000000000001', 'C', 1, 1, 1)$$) like '42501%', '停用的 C 写不进（RLS）');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.todo_items set todo_id = '7a000000-0000-4000-8000-000000000002' where id = '7b000000-0000-4000-8000-000000000001'$$) like '42501%',
  'todo_id 改不了：子任务不能改挂到别的待办（Q9）');

-- ===== TC-R350-03、04：冲突口径（经 apply_patch；两个子任务 I1、I2 都在 rev 1，两台设备都拿着 base_rev 1） =====
insert into public.todo_items (id, user_id, todo_id, title, sort, created_at, updated_at) values
  ('7b000000-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000001', 'I1', 2, 1, 1),
  ('7b000000-0000-4000-8000-000000000012', 'aaaaaaaa-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000001', 'I2', 3, 1, 1);
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todo_items', '7b000000-0000-4000-8000-000000000011', '{"done": true, "updated_at": 2}', 1,
  '7c000000-0000-4000-8000-000000000001') ->> 'status', 'ok', 'X 勾第 1 项：ok');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todo_items', '7b000000-0000-4000-8000-000000000012', '{"done": true, "updated_at": 3}', 1,
  '7c000000-0000-4000-8000-000000000002') ->> 'status', 'ok', 'TC-R350-03：Y 同时勾第 2 项（base_rev 也是 1）：不同行互不冲突，ok');
select is((select string_agg(done::text, ',' order by sort) from public.todo_items
  where id in ('7b000000-0000-4000-8000-000000000011', '7b000000-0000-4000-8000-000000000012')), 'true,true', 'TC-R350-03：两个勾都留下');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todo_items', '7b000000-0000-4000-8000-000000000011', '{"done": false, "updated_at": 4}', 1,
  '7c000000-0000-4000-8000-000000000003') ->> 'status', 'ok', 'TC-R350-04：Y 拿旧 base_rev 取消勾第 1 项：done 在 no_conflict 里，不报冲突');
select is((select done from public.todo_items where id = '7b000000-0000-4000-8000-000000000011'), false, 'TC-R350-04：第 1 项后写胜出（未勾）');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todo_items', '7b000000-0000-4000-8000-000000000012', '{"title": "X 改的"}', 1,
  '7c000000-0000-4000-8000-000000000004') ->> 'status', 'ok', 'X 改第 2 项标题：fv 里没有 title，ok');
select is((select r ->> 'status' || ':' || (r -> 'conflicts')::text || ':' || (r -> 'old' ->> 'title') from (select tests.ap('aaaaaaaa-0000-4000-8000-000000000001',
  'todo_items', '7b000000-0000-4000-8000-000000000012', '{"title": "Y 改的"}', 1, '7c000000-0000-4000-8000-000000000005') r) x),
  'conflict:["title"]:X 改的', 'TC-R350-04：Y 同时改第 2 项标题：title 照常报 conflict，old 带对方的字');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todo_items', '7b000000-0000-4000-8000-000000000011',
  '{"todo_id": "7a000000-0000-4000-8000-000000000002", "sort": 9}', 99, '7c000000-0000-4000-8000-000000000006') ->> 'status', 'ok',
  'patch 里带 todo_id 和 sort：ok');
select is((select todo_id::text || '|' || sort from public.todo_items where id = '7b000000-0000-4000-8000-000000000011'),
  '7a000000-0000-4000-8000-000000000001|9', '白名单外的 todo_id 被丢掉（行还挂在 T 下），sort 照改');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todo_items', '7b000000-0000-4000-8000-000000000011',
  jsonb_build_object('title', repeat('长', 101)), 99, '7c000000-0000-4000-8000-000000000007') ->> 'error', 'P0001 patch_bad_args',
  'TC-R350-14 ④：apply_patch 改成 101 字：check 拒，回 patch_bad_args');
select is(tests.ap('bbbbbbbb-0000-4000-8000-000000000002', 'todo_items', '7b000000-0000-4000-8000-000000000011', '{"done": true}', 1,
  '7c000000-0000-4000-8000-000000000008') ->> 'status', 'not_found', 'B 改 A 的子任务：not_found');

-- ===== TC-R350-13、12：删除、恢复、清理、墓碑（T2 下 J1～J3，T3 下 K1） =====
insert into public.todo_items (id, user_id, todo_id, title, sort, created_at, updated_at) values
  ('7b000000-0000-4000-8000-000000000021', 'aaaaaaaa-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000002', 'J1', 1, 1, 1),
  ('7b000000-0000-4000-8000-000000000022', 'aaaaaaaa-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000002', 'J2', 2, 1, 1),
  ('7b000000-0000-4000-8000-000000000023', 'aaaaaaaa-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000002', 'J3', 3, 1, 1),
  ('7b000000-0000-4000-8000-000000000031', 'aaaaaaaa-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000003', 'K1', 1, 1, 1);
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todos', '7a000000-0000-4000-8000-000000000002', jsonb_build_object('deleted_at', tests.ms()), 1,
  '7c000000-0000-4000-8000-000000000011') ->> 'status', 'ok', '① 删除主待办 T2（软删）');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todos', '7a000000-0000-4000-8000-000000000002', '{"deleted_at": null}', 2,
  '7c000000-0000-4000-8000-000000000012') ->> 'status', 'ok', '① 恢复 T2');
select is((select count(*)::int from public.todo_items where todo_id = '7a000000-0000-4000-8000-000000000002' and deleted_at is null), 3,
  '① 子任务一直没动，三项原样都在');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todos', '7a000000-0000-4000-8000-000000000002', jsonb_build_object('deleted_at', tests.ms()), 3,
  '7c000000-0000-4000-8000-000000000013') ->> 'status', 'ok', '③ 前置：T2 进“最近删除”');
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select public.purge_deleted('[{"tbl":"todos","id":"7a000000-0000-4000-8000-000000000002"}]') as n$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'),
  '[{"n": 1}]'::jsonb, '③ 永久删除 T2：删掉 1 条主待办（子任务由外键级联，不计数）');
select is((select count(*)::int from public.todo_items where todo_id = '7a000000-0000-4000-8000-000000000002'), 0, '③ T2 的三个子任务随外键级联删掉');
select is((select string_agg(tbl || ':' || right(id::text, 2), ',' order by tbl, id) from public.tombstones
  where id in ('7a000000-0000-4000-8000-000000000002', '7b000000-0000-4000-8000-000000000021', '7b000000-0000-4000-8000-000000000022', '7b000000-0000-4000-8000-000000000023')),
  'todo_items:21,todo_items:22,todo_items:23,todos:02', '③ 主待办和三个子任务各留一条墓碑（别的设备据此删本机行）');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7b000000-0000-4000-8000-000000000024', '7a000000-0000-4000-8000-000000000002', '离线时加的', 4, 1, 1)$$) = 'P0001 not_found',
  'TC-R350-12：主待办已被永久删除，离线时加的子任务再插：not_found（outbox 的 DROP_CODES 本来就丢掉它）');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select public.purge_deleted('[{"tbl":"todo_items","id":"7b000000-0000-4000-8000-000000000011"}]')$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '%bad_table%',
  '逐条永久删除不收 todo_items（子任务不进“最近删除”）：bad_table');
-- ② 30 天清理：T3 软删在 31 天前；T 下另有一个 31 天前软删的子任务 L1、一个 29 天前软删的 L2
update public.todos set deleted_at = tests.ms(31) where id = '7a000000-0000-4000-8000-000000000003';
insert into public.todo_items (id, user_id, todo_id, title, sort, deleted_at, created_at, updated_at) values
  ('7b000000-0000-4000-8000-000000000041', 'aaaaaaaa-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000001', 'L1', 4, tests.ms(31), 1, 1),
  ('7b000000-0000-4000-8000-000000000042', 'aaaaaaaa-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000001', 'L2', 5, tests.ms(29), 1, 1);
do $$ begin while private.cleanup_batch() > 0 loop end loop; end $$;
select is((select count(*)::int from public.todo_items where id = '7b000000-0000-4000-8000-000000000031')
  || '|' || (select count(*)::int from public.tombstones where tbl = 'todo_items' and id = '7b000000-0000-4000-8000-000000000031'),
  '0|1', '② 30 天清理硬删 T3，它的子任务 K1 随外键级联删掉、留墓碑');
select is((select string_agg(title, ',' order by sort) from public.todo_items where id in ('7b000000-0000-4000-8000-000000000041', '7b000000-0000-4000-8000-000000000042')),
  'L2', '② 主待办还在时，30 天前软删的子任务也被清理（cleanup_batch 补的那句），没满 30 天的留着');
-- ④ 全部清空：T 下 L2（已软删）、I1、I2（没删）；B 也有一个已软删的子任务
insert into public.todo_items (id, user_id, todo_id, title, sort, deleted_at, created_at, updated_at) values
  ('7b000000-0000-4000-8000-0000000000b2', 'bbbbbbbb-0000-4000-8000-000000000002', '7a000000-0000-4000-8000-0000000000b1', 'B 的', 1, 1, 1, 1);
select ok((tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select public.purge_deleted() as n$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') -> 0 ->> 'n')::int >= 1, '④ A 全部清空');
select is((select string_agg(title, ',' order by id) from public.todo_items where todo_id in ('7a000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-0000000000b1')),
  '买牛奶,I1,Y 改的,B 的', '④ A 已软删的子任务 L2 清掉；没删的不动；B 的不动');

-- ===== TC-R350-14：上限（T4） =====
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  select ('7d000000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid, '7a000000-0000-4000-8000-000000000004', '项' || g, g, 1, 1
    from generate_series(1, 30) g$$), 'ok', '一次加满 30 项');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7d000000-0000-4000-8000-000000000031', '7a000000-0000-4000-8000-000000000004', '第 31 项', 31, 1, 1)$$),
  'P0001 items_quota', '③ 第 31 项：items_quota');
select isnt((select xmax::text from public.todos where id = '7a000000-0000-4000-8000-000000000004'), '0',
  '加子任务时 todo_items_cap 给主待办行上了锁（T4 建好后没被改过，xmax 非 0 只能是这把行锁）：同一条待办的并发插入排队再数');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7d000000-0000-4000-8000-000000000032', '7a000000-0000-4000-8000-000000000001', '别的待办', 9, 1, 1)$$),
  'ok', '上限按每条待办算：T 下照常能加');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todo_items', '7d000000-0000-4000-8000-000000000001', jsonb_build_object('deleted_at', tests.ms()), 1,
  '7c000000-0000-4000-8000-000000000021') ->> 'status', 'ok', '满 30 项时删掉一项（软删）');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7d000000-0000-4000-8000-000000000033', '7a000000-0000-4000-8000-000000000004', '补一项', 33, 1, 1)$$),
  'ok', '删掉的不占名额：再加一项 ok');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todo_items', '7d000000-0000-4000-8000-000000000001', '{"deleted_at": null}', 2,
  '7c000000-0000-4000-8000-000000000022') ->> 'error', 'P0001 items_quota', '又满 30 项时恢复那一项（apply_patch 写 deleted_at = null）：items_quota');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todo_items', '7d000000-0000-4000-8000-000000000002', '{"undone": true}', 1,
  '7c000000-0000-4000-8000-000000000023') ->> 'status', 'ok', '把一项标成撤销（undone）');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7d000000-0000-4000-8000-000000000034', '7a000000-0000-4000-8000-000000000004', '再补一项', 34, 1, 1)$$),
  'ok', '撤销的那项界面不显示，也不占名额：再加一项 ok');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'todo_items', '7d000000-0000-4000-8000-000000000002', '{"undone": false}', 2,
  '7c000000-0000-4000-8000-000000000024') ->> 'error', 'P0001 items_quota', '满 30 项时把撤销的改回来：items_quota');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', format($$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7d000000-0000-4000-8000-000000000041', '7a000000-0000-4000-8000-000000000001', %L, 41, 1, 1)$$, repeat('长', 101))) like '23514%',
  '④ 标题 101 字：check 拒（23514）');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7d000000-0000-4000-8000-000000000042', '7a000000-0000-4000-8000-000000000001', '', 42, 1, 1)$$) like '23514%',
  '标题为空：check 拒（23514）');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', format($$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7d000000-0000-4000-8000-000000000043', '7a000000-0000-4000-8000-000000000001', %L, 43, 1, 1)$$, repeat('长', 100))),
  'ok', '标题正好 100 字：ok');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7d000000-0000-4000-8000-000000000044', '7a000000-0000-4000-8000-000000000001', '   ', 44, 1, 1)$$) like '23514%',
  '标题全是空格：check 拒（23514，btrim 后为空；R-350 评审第 6 条）');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todo_items (id, todo_id, title, sort, created_at, updated_at)
  values ('7d000000-0000-4000-8000-000000000045', '7a000000-0000-4000-8000-000000000001', ' 买菜 ', 45, 1, 1)$$),
  'ok', '前后带空格但有字：ok');

select * from finish();
rollback;
