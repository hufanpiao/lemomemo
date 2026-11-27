-- 迁移 20261115060000_core_api_tokens_revoke.sql（后端安全审查第 1 条）：连接码随会话一起失效。
--   revoke_my_sessions(true)（“退出全部设备”，连本机一起）、改密码（on_password_change）、管理员停用（admin_set_disabled(…, true)）
--   三处都把这个人还没吊销的 api_tokens 写上 revoked_at；revoke_my_sessions(false)（“退出其他设备”）不动连接码。
-- 用户：A、B（tests.seed，各一个会话 5555）；E 用来测改密码（同 47 号：auth.users 的改密码被 0001 的 guard 挡住，用临时表挂同一函数、同一 when）。
begin;
select plan(9);
\ir _helpers.psql
select tests.seed();

insert into auth.users (id, email) values ('eeeeeeee-6000-4000-8000-000000000005', 'e60@test.local');
insert into public.profiles (user_id) values ('eeeeeeee-6000-4000-8000-000000000005');
insert into public.api_tokens (id, user_id, token_hash, revoked_at) values
  ('a0600000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'h60-a1', null),
  ('a0600000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'h60-a2', '2026-01-01T00:00:00Z'),
  ('a0600000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'h60-b1', null),
  ('a0600000-0000-4000-8000-0000000000e1', 'eeeeeeee-6000-4000-8000-000000000005', 'h60-e1', null);

create function tests.tok(p_id text) returns text language sql as $$
  select case when revoked_at is null then 'live' when revoked_at = '2026-01-01T00:00:00Z' then 'old' else 'revoked' end
    from public.api_tokens where id = ('a0600000-0000-4000-8000-0000000000' || p_id)::uuid $$;

-- ===== 一、revoke_my_sessions =====
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', 'select public.revoke_my_sessions(false) as n', null, 'aaaaaaaa-5555-4000-8000-000000000001'),
  '[{"n": 0}]'::jsonb, 'revoke_my_sessions(false)：A 只有本机一个会话，吊掉 0 个');
select is(tests.tok('a1'), 'live', 'false（退出其他设备）：连接码不动（本机还登录着，连接码是本机设置里建的）');
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', 'select public.revoke_my_sessions(true) as n', null, 'aaaaaaaa-5555-4000-8000-000000000001'),
  '[{"n": 1}]'::jsonb, 'revoke_my_sessions(true)：连本机一起吊，回个数不变（不把连接码算进去）');
select is(tests.tok('a1') || '|' || tests.tok('a2') || '|' || tests.tok('b1'), 'revoked|old|live',
  'true：A 还有效的连接码吊销；已吊销的不改 revoked_at；B 的不动');

-- ===== 二、改密码 =====
create table tests.pw_users (id uuid primary key, email text, encrypted_password character varying(255));
create trigger users_password_change_revoke after update of encrypted_password on tests.pw_users
  for each row when (coalesce(old.encrypted_password, '') is distinct from coalesce(new.encrypted_password, ''))
  execute function private.on_password_change();
insert into tests.pw_users values ('eeeeeeee-6000-4000-8000-000000000005', 'e60@test.local', '');
update tests.pw_users set email = 'e60b@test.local';
select is(tests.tok('e1'), 'live', '没改密码（只改别的列）：连接码不动');
update tests.pw_users set encrypted_password = '$2a$10$hash60';
select is(tests.tok('e1') || '|' || tests.tok('b1'), 'revoked|live', '真改了密码：这个人的连接码吊销，别人的不动');

-- ===== 三、管理员停用 =====
insert into public.api_tokens (id, user_id, token_hash) values
  ('a0600000-0000-4000-8000-0000000000b2', 'bbbbbbbb-0000-4000-8000-000000000002', 'h60-b2');
select private.admin_set_disabled('bbbbbbbb-0000-4000-8000-000000000002', true);
select is(tests.tok('b1') || '|' || tests.tok('b2'), 'revoked|revoked', '管理员停用：这个人全部还有效的连接码吊销');
select private.admin_set_disabled('bbbbbbbb-0000-4000-8000-000000000002', false);
select is(tests.tok('b1') || '|' || (select coalesce(disabled_at::text, 'null') from public.profiles where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'),
  'revoked|null', '解除停用：账号恢复，连接码不复活（要在设置里重新生成）');

-- ===== 四、三个函数的属性没变 =====
select is((select string_agg(p.proname || ':' || p.prosecdef::text || ':' || array_to_string(p.proconfig, ','), ' ' order by p.proname)
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.proname in ('revoke_my_sessions_impl', 'on_password_change', 'admin_set_disabled')),
  'admin_set_disabled:true:search_path="" on_password_change:true:search_path="" revoke_my_sessions_impl:true:search_path=""',
  '三个函数照旧 security definer、search_path 空');

select * from finish();
rollback;
