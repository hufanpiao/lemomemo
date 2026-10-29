-- B1 迁移 20261029130000_core_take_rate.sql：限流计数 private.take_rate（3.3 C、15.3 第 8 条；invite-signup 用，TC-B1-64 的数据库一半）
-- 函数那一半（三种键、伪造 IP、不发信）在 tests/functions/invite-signup.test.ts
begin;
select plan(12);
\ir _helpers.psql
select tests.seed();

-- ① 只给 service_role：anon、authenticated 调不了
select ok(tests.try_as('anon', null, $$select private.take_rate('signup:global:20261029', 50, 86400)$$) like '42501%',
  'take_rate：anon 没有执行权');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select private.take_rate('signup:global:20261029', 50, 86400)$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%',
  'take_rate：authenticated 没有执行权');

-- ② service_role：上限 2，第 1、2 次放行，第 3 次拒；拒的这次也计数
select is(tests.rows_as('service_role', null, $$select private.take_rate('signup-ip:ip:abc123', 2, 3600) as ok$$), '[{"ok": true}]'::jsonb, '第 1 次放行');
select is(tests.rows_as('service_role', null, $$select private.take_rate('signup-ip:ip:abc123', 2, 3600) as ok$$), '[{"ok": true}]'::jsonb, '第 2 次放行');
select is(tests.rows_as('service_role', null, $$select private.take_rate('signup-ip:ip:abc123', 2, 3600) as ok$$), '[{"ok": false}]'::jsonb, '第 3 次超过上限');
select is((select count from private.counters where key = 'signup-ip:ip:abc123'), 3, '被拒的那次也算进计数（TC-B1-64：计数里看得到）');

-- ③ 窗口起点按 UTC 对齐：3600 是整点，86400 是 UTC 日期 0 点
select is((select window_start from private.counters where key = 'signup-ip:ip:abc123'),
  date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC', '一小时窗口的 window_start 是 UTC 整点');
select tests.rows_as('service_role', null, $$select private.take_rate('signup:global:20261029', 50, 86400) as ok$$);
select is((select window_start from private.counters where key = 'signup:global:20261029'),
  date_trunc('day', now() at time zone 'UTC') at time zone 'UTC', '一天窗口的 window_start 是 UTC 日期 0 点');

-- ④ 不同的键互不影响
select is(tests.rows_as('service_role', null, $$select private.take_rate('signup-mail:mail:def456', 2, 3600) as ok$$), '[{"ok": true}]'::jsonb, '另一个键从 1 计起');

-- ⑤ 键过不了 counters 的约束、参数不对都报错（不悄悄放行）
select ok(tests.try_as('service_role', null, $$select private.take_rate('Bad:Key', 5, 3600)$$) like '23514%', '键格式不对：check 约束报错');
select ok(tests.try_as('service_role', null, $$select private.take_rate('signup-ip:ip:x', 5, 0)$$) like '22023%', '窗口 0 秒：bad_rate_args');
select ok(tests.try_as('service_role', null, $$select private.take_rate('signup-ip:ip:x', -1, 3600)$$) like '22023%', '上限为负：bad_rate_args');

select * from finish();
rollback;
