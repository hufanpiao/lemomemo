-- 迁移 20261115061000_core_api_token_create.sql（后端安全审查第 12 条）：token-admin 建连接码改成一个函数里原子做完。
-- 原来 token-admin 先数有效码个数、再 take_rate、再插入，三步各一次请求：同一个人并发请求都先数到 4 个，能冲破 5 个上限。
-- private.api_token_create：按人拿事务级咨询锁 → 数有效码（没吊销、p_since 之后建的）够 p_max 回 too_many（不计次数）
--   → take_rate 不过回 rate_limited → 插入（token_hash 撞了回 duplicate，什么都不插）→ 回 ok、id、created_at。
-- 两个连接同时调的互斥 pgTAP 测不出（单会话），这里钉住函数体先拿锁；并发实测见交付说明。
begin;
select plan(9);
\ir _helpers.psql
select tests.seed();

create function tests.mk(p_hash text, p_rate_key text default 'token-admin:aaaaaaaa-0000-4000-8000-000000000001:20261115', p_limit int default 10)
  returns text language sql as $$
  select coalesce(tests.rows_as('service_role', null, format(
    'select private.api_token_create(%L, %L, %L, now() - interval ''180 days'', 5, %L, %s, 86400) ->> ''result'' as r',
    'aaaaaaaa-0000-4000-8000-000000000001', 'L', p_hash, p_rate_key, p_limit)) -> 0 ->> 'r',
    tests.rows_as('service_role', null, 'select 1')::text) $$;

select is(tests.mk('h61-1') || tests.mk('h61-2') || tests.mk('h61-3') || tests.mk('h61-4') || tests.mk('h61-5'), 'okokokokok', '前 5 个：ok');
select is(tests.mk('h61-6'), 'too_many', '第 6 个：too_many');
select is((select count(*)::int from public.api_tokens where user_id = 'aaaaaaaa-0000-4000-8000-000000000001') || '|'
       || (select count from private.counters where key = 'token-admin:aaaaaaaa-0000-4000-8000-000000000001:20261115'),
  '5|5', 'too_many 不插、不计次数（计数还是 5）');

update public.api_tokens set revoked_at = now() where token_hash = 'h61-1';
update public.api_tokens set created_at = now() - interval '181 days' where token_hash = 'h61-2';
select is(tests.mk('h61-7') || tests.mk('h61-8') || tests.mk('h61-9'), 'okoktoo_many', '吊销的、180 天前建的不算有效：又能建 2 个');

select is(tests.mk('h61-3'), 'too_many', '先数个数：已满时撞哈希也回 too_many');
update public.api_tokens set revoked_at = now() where token_hash in ('h61-3', 'h61-4');
select is(tests.mk('h61-5') || '|' || (select count(*)::int from public.api_tokens where token_hash = 'h61-5'), 'duplicate|1', 'token_hash 撞了：duplicate，不插第二行');
select is(tests.mk('h61-x', 'token-admin:aaaaaaaa-0000-4000-8000-000000000001:20261116', 1) || tests.mk('h61-y', 'token-admin:aaaaaaaa-0000-4000-8000-000000000001:20261116', 1),
  'okrate_limited', '次数用完：rate_limited，不插');

select ok((select p.prosrc from pg_proc p where p.oid = 'private.api_token_create(uuid, text, text, timestamptz, int, text, int, int)'::regprocedure)
            ~* '\ybegin\s+perform\s+pg_advisory_xact_lock\(',
  '函数体第一句就拿按人的事务级咨询锁（数、计次数、插入都在锁里）');
select ok(has_function_privilege('service_role', 'private.api_token_create(uuid, text, text, timestamptz, int, text, int, int)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.api_token_create(uuid, text, text, timestamptz, int, text, int, int)', 'EXECUTE')
          and not has_function_privilege('anon', 'private.api_token_create(uuid, text, text, timestamptz, int, text, int, int)', 'EXECUTE'),
  '只有 service_role 能调（token-admin）');

select * from finish();
rollback;
