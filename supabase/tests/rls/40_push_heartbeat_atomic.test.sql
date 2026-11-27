-- 迁移 20261105140000_core_push_heartbeat_atomic.sql：private.push_heartbeat_write（接手清单 REMIND-poison-atomic，B2 租约出队代码审查复审 N3）
-- 钉住：① 首次写、同一个首尔日累加、换日（按首尔 0 点，不是 UTC）从这一轮重新算、旧行 at 比 now() 晚时 at 不倒退（审查 L1）；② 旧值不合格从这一轮重新算；
-- ③ p_detail 不是对象当空对象、p_detail 里自带的 queue_poison 不算数；p_poison 为空、负数、超大截到 0～100000；
-- ④ 心跳名写死 push-dispatch；⑤ 授权：security definer、search_path 空、lock_timeout 5s，只授 service_role。
-- 两轮并发写的不丢靠 insert … on conflict do update 的行锁（PostgreSQL 既有语义），这里只测两次先后写的累加；函数里调它的那一半在 tests/edge 和 store-it。
-- 同一个事务里 now() 不变：换日靠把旧行的 at 往前改。
begin;
select plan(26);
\ir _helpers.psql
select tests.seed();

delete from private.heartbeat where name = 'push-dispatch';
create temp table hb_names on commit drop as select name from private.heartbeat;

-- ① 首次写、同日累加
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{"claimed": 3, "sent": 2, "failed": 1, "budget_hit": false, "queue_ok": 1}', 2) as n$$),
  '[{"n": 2}]'::jsonb, '首次写：返回这一轮的 2');
select is((select detail from private.heartbeat where name = 'push-dispatch'),
  '{"claimed": 3, "sent": 2, "failed": 1, "budget_hit": false, "queue_ok": 1, "queue_poison": 2}'::jsonb, '首次写：detail 是 p_detail 加 queue_poison');
select is((select at from private.heartbeat where name = 'push-dispatch'), now(), '首次写：at = now()');
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{"sent": 5}', 3) as n$$), '[{"n": 5}]'::jsonb, '同一个首尔日：2 + 3 = 5');
select is((select detail from private.heartbeat where name = 'push-dispatch'), '{"sent": 5, "queue_poison": 5}'::jsonb, '同日再写：别的字段整份换成这一次的');

-- ① 换日：按首尔 0 点
update private.heartbeat set at = (((now() at time zone 'Asia/Seoul')::date)::timestamp at time zone 'Asia/Seoul') where name = 'push-dispatch';
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', 1) as n$$), '[{"n": 6}]'::jsonb, '旧行在首尔今天 0 点整：同一天，5 + 1 = 6');
update private.heartbeat set at = (((now() at time zone 'Asia/Seoul')::date)::timestamp at time zone 'Asia/Seoul') - interval '1 second' where name = 'push-dispatch';
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', 1) as n$$), '[{"n": 1}]'::jsonb, '旧行在首尔昨天 23:59:59：换日，从这一轮的 1 重新算');
update private.heartbeat set at = now() - interval '1 day' where name = 'push-dispatch';
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', 0) as n$$), '[{"n": 0}]'::jsonb, '旧行是 24 小时前：换日，这一轮 0 就是 0');
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', 4) as n$$), '[{"n": 4}]'::jsonb, '换日以后同一天再累加：0 + 4 = 4');
-- 审查 L1：0 点前后两轮重叠、开始得早的那句后拿到锁（旧行 at 比这一句的 now() 晚、已是新的一天）：按 greatest 判同日、at 不倒退
update private.heartbeat set at = (((now() at time zone 'Asia/Seoul')::date + 1)::timestamp at time zone 'Asia/Seoul') + interval '1 second', detail = '{"queue_poison": 7}' where name = 'push-dispatch';
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', 1) as n$$), '[{"n": 8}]'::jsonb, '旧行 at 已是首尔明天（比 now() 晚）：算进那一天，7 + 1 = 8');
select is((select at from private.heartbeat where name = 'push-dispatch'), (((now() at time zone 'Asia/Seoul')::date + 1)::timestamp at time zone 'Asia/Seoul') + interval '1 second', 'at 不倒退回 now()');
update private.heartbeat set at = now(), detail = '{"queue_poison": 4}' where name = 'push-dispatch';

-- ② 旧值不合格：从这一轮重新算
update private.heartbeat set detail = '{"queue_poison": -1}' where name = 'push-dispatch';
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', 2) as n$$), '[{"n": 2}]'::jsonb, '旧值负数：重新算');
update private.heartbeat set detail = '{"queue_poison": 1.5}' where name = 'push-dispatch';
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', 2) as n$$), '[{"n": 2}]'::jsonb, '旧值小数：重新算');
update private.heartbeat set detail = '{"queue_poison": "3"}' where name = 'push-dispatch';
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', 2) as n$$), '[{"n": 2}]'::jsonb, '旧值是字符串 "3"：重新算');
update private.heartbeat set detail = '{"queue_poison": 1000000000}' where name = 'push-dispatch';
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', 2) as n$$), '[{"n": 2}]'::jsonb, '旧值超过 9 位（累加会溢出 int）：重新算');
update private.heartbeat set detail = '{"sent": 1}' where name = 'push-dispatch';
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', 2) as n$$), '[{"n": 2}]'::jsonb, '旧行没有 queue_poison：重新算');
update private.heartbeat set detail = '{"queue_poison": 999999999}' where name = 'push-dispatch';
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', 1) as n$$), '[{"n": 1000000000}]'::jsonb, '旧值 9 位上限 999999999：照样累加，不溢出');

-- ③ p_detail、p_poison 的兜底
update private.heartbeat set detail = '{"queue_poison": 10}' where name = 'push-dispatch';
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{"queue_poison": 999, "sent": 1}', 1) as n$$), '[{"n": 11}]'::jsonb, 'p_detail 自带的 queue_poison 不算数：10 + 1 = 11');
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('[1, 2]', 1) as n$$), '[{"n": 12}]'::jsonb, 'p_detail 是数组：当空对象，照样累加');
select is((select detail from private.heartbeat where name = 'push-dispatch'), '{"queue_poison": 12}'::jsonb, 'p_detail 是数组：detail 只剩 queue_poison');
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write(null, null) as n$$), '[{"n": 12}]'::jsonb, 'p_detail、p_poison 都为空：加 0');
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', -5) as n$$), '[{"n": 12}]'::jsonb, 'p_poison 负数：截到 0');
select is(tests.rows_as('service_role', null, $$select private.push_heartbeat_write('{}', 2000000000) as n$$), '[{"n": 100012}]'::jsonb, 'p_poison 超大：截到 100000');

-- ④ 心跳名写死：只动 push-dispatch 这一行，别的服务的心跳行一行没多一行没少
select is((select count(*)::int from private.heartbeat where name not in (select name from hb_names)), 1, '只多了 push-dispatch 一行');

-- ⑤ 授权
select is((select p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'push_heartbeat_write'), 'true search_path="",lock_timeout=5s', 'security definer、search_path 空、lock_timeout 5s');
select ok(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$select private.push_heartbeat_write('{}', 1)$$, null, 'bbbbbbbb-5555-4000-8000-000000000002') like '42501%',
  'authenticated 不能执行');

select * from finish();
rollback;
