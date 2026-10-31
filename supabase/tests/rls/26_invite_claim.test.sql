-- 迁移 20261031150000_core_invite_claim.sql（接手清单 INVITE-late-commit）：private.invite_claim、private.invite_release 和 pending_signups.claimed_code。
-- 定义：security invoker、search_path = ''、lock_timeout = 5s，只有 service_role 能执行；claimed_code 只收 64 位小写十六进制。
-- 行为：第一次占回 ok、之后回 reused；占码幂等（同一邮箱同一个码只加一次）、换码先退旧码、退码只退占着的那一次、upsert pending 不带这一列时原值保留。
begin;
select plan(20);

create temp view f as
  select p.oid, p.proname, p.prosecdef, p.proconfig from pg_catalog.pg_proc p
   where p.pronamespace = 'private'::regnamespace and p.proname in ('invite_claim', 'invite_release');

-- ① 定义
select is((select string_agg(proname || ':' || pg_catalog.array_to_string(proconfig, ';'), ',' order by proname) from f),
  'invite_claim:search_path="";lock_timeout=5s,invite_release:search_path="";lock_timeout=5s', '两个函数：search_path 置空、lock_timeout 5s，各只有一个签名');
select is((select string_agg(proname, ',' order by proname) from f where prosecdef), null, '两个都是 security invoker');
select is((select string_agg(proname, ',' order by proname) from f where pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE')),
  'invite_claim,invite_release', 'service_role 能执行');
select is((select string_agg(proname, ',' order by proname) from f
            where pg_catalog.has_function_privilege('anon', oid, 'EXECUTE') or pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE')),
  null, 'anon、authenticated 都不能执行');
-- 执行一句，回 ok 或 sqlstate（离线 PGlite 的 pgTAP 没有 throws_ok）
create function pg_temp.try_sql(q text) returns text language plpgsql as $f$
begin
  execute q;
  return 'ok';
exception when others then
  return sqlstate;
end $f$;
select is(pg_temp.try_sql($$insert into private.pending_signups (email_hash, otp_hash, expires_at, claimed_code) values ('e-bad', 'o', now() + interval '10 minutes', 'XYZ')$$),
  '23514', 'claimed_code 不是 64 位小写十六进制被 check 拒绝');

-- 造数据：码 A（一次）、码 B（一次）、码 C（已用完）；邮箱 e1 的 pending（验证码 o1）
insert into private.invites (code_hash, max_uses, used_count, expires_at) values
  (repeat('a', 64), 1, 0, now() + interval '7 days'),
  (repeat('b', 64), 1, 0, now() + interval '7 days'),
  (repeat('c', 64), 1, 1, now() + interval '7 days');
insert into private.pending_signups (email_hash, otp_hash, expires_at) values ('e1', 'o1', now() + interval '10 minutes');

-- ② 占码
select is(private.invite_claim('e1', 'o-other', repeat('a', 64), now()), 'no_pending', '验证码版本对不上：no_pending，什么都不改');
select is(private.invite_claim('e1', 'o1', repeat('c', 64), now()), 'invalid', '码已用完：invalid');
select is((select claimed_code from private.pending_signups where email_hash = 'e1'), null, 'invalid 时不记 claimed_code');
select is(private.invite_claim('e1', 'o1', repeat('a', 64), now()), 'ok', '第一次占：ok');
select is((select used_count from private.invites where code_hash = repeat('a', 64)), 1, '码 A used_count 0 → 1');
select is(private.invite_claim('e1', 'o1', repeat('a', 64), now()), 'reused', '同一版验证码重试（晚到提交后再验）：reused');
select is((select used_count from private.invites where code_hash = repeat('a', 64)), 1, '重试不再加：码 A 仍是 1');

-- ③ 重新发码（PostgREST upsert 不带 claimed_code）：原值保留，新验证码 verify 沿用
insert into private.pending_signups as d (email_hash, otp_hash, tries, expires_at) values ('e1', 'o2', 0, now() + interval '10 minutes')
  on conflict (email_hash) do update set otp_hash = excluded.otp_hash, tries = excluded.tries, expires_at = excluded.expires_at;
select is((select claimed_code from private.pending_signups where email_hash = 'e1'), repeat('a', 64), '重新发码后 claimed_code 原样保留');
select is(private.invite_claim('e1', 'o2', repeat('a', 64), now()), 'reused', '新验证码 verify：reused（之前占过）');
select is((select used_count from private.invites where code_hash = repeat('a', 64)), 1, '新验证码沿用占用：码 A 仍是 1（只 +1）');

-- ④ 换了码重新发码再验：旧码退回、新码占上
select is(private.invite_claim('e1', 'o2', repeat('b', 64), now()), 'reused', '换码 B：reused（之前占过别的码）');
select is((select string_agg(left(code_hash, 1) || '=' || used_count, ',' order by code_hash) from private.invites where code_hash in (repeat('a', 64), repeat('b', 64))),
  'a=0,b=1', '码 A 退回 0、码 B 占上 1');

-- ⑤ 退码：只退占着的那一次；重复退、退别的码都不动
select is(private.invite_release('e1', repeat('a', 64)), false, '退没占着的码 A：false，不动');
select is(private.invite_release('e1', repeat('b', 64)), true, '退占着的码 B：true');
select is((select used_count::text || '/' || coalesce((select claimed_code from private.pending_signups where email_hash = 'e1'), 'null')
             from private.invites where code_hash = repeat('b', 64)) || '/' || private.invite_release('e1', repeat('b', 64))::text,
  '0/null/false', '码 B 回到 0、claimed_code 清空；再退一次 false、不会减成负数');

select * from finish();
rollback;
