-- R-382（架构 4.1a 第 4、5、6 点，0.60～0.62）：迁移 20261111120000_core_session_fate.sql
--   pair_hash 结构和固定样例、session_fate 只回 revoked / unknown、各条吊销路径都走 revoke_session、revoke_my_sessions、
--   注销后只留哈希、管理员停用只退出不吊销（0.62）、库内每分钟总闸、改密码触发器（0.61：4.0.0 里实际不触发，用临时表挂同一函数和 when 验）。
-- 用户：A、B（tests.seed，各一个会话 5555）；D 用来注销；E 用来测改密码。
begin;
select plan(46);
\ir _helpers.psql
select tests.seed();

-- 照 07 的写法：带完整 claims（含 amr）以 authenticated 执行
create function tests.try_claims(p_claims jsonb, p_sql text) returns text language plpgsql as $$
declare r text := 'ok';
begin
  begin
    perform set_config('request.jwt.claims', p_claims::text, true);
    set local role authenticated;
    execute p_sql;
    reset role;
  exception when others then
    r := sqlstate || ' ' || sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
-- 以 anon（不登录）问 session_fate；p_pair 原样传（格式不对的也传）
create function tests.fate_raw(p_pair text) returns text language sql as $$
  select coalesce(tests.rows_as('anon', null, format('select public.session_fate(%L) as f', p_pair)) -> 0 ->> 'f',
                  tests.rows_as('anon', null, format('select public.session_fate(%L) as f', p_pair))::text)
$$;
create function tests.fate(p_session uuid, p_user uuid) returns text language sql as $$
  select tests.fate_raw(private.session_pair_hash(p_session, p_user))
$$;

-- ================= 一、pair_hash 和表结构 =================
select is(private.session_pair_hash('aaaaaaaa-5555-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  'a194e9909f8473c20ddb222ebcc2d8386aaae24a1c20db306e59bfc196ff540e',
  'pair_hash 固定样例：sha256(session_id || '':'' || user_id) 的 64 位小写十六进制（客户端按同一算法算，见 4.1a 第 4 点）');
select is((select provolatile::text from pg_proc where oid = 'private.session_pair_hash(uuid, uuid)'::regprocedure), 'i', 'session_pair_hash 是 immutable');
select is((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.revoked_sessions'::regclass and contype = 'p'), 'PRIMARY KEY (pair_hash)',
  'revoked_sessions 的主键是 pair_hash');
select is((select indexdef from pg_indexes where schemaname = 'private' and indexname = 'revoked_sessions_session_id_idx'),
  'CREATE INDEX revoked_sessions_session_id_idx ON private.revoked_sessions USING btree (session_id) WHERE (session_id IS NOT NULL)',
  'session_id 有部分索引（复审 N2：session_alive 等仍按 session_id 查）');
-- 离线 PGlite 的 pgTAP 没有 throws_ok，照 26 的写法用 try_as 回 sqlstate
select is(tests.try_as('postgres', null, $$insert into private.revoked_sessions (pair_hash, session_id, user_id) values (repeat('0', 64), 'aaaaaaaa-5555-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001')$$),
  '22023 pair_hash_mismatch', '写进去的 pair_hash 和两个 id 算出来的不一致：报 pair_hash_mismatch');
select is(tests.try_as('postgres', null, $$insert into private.revoked_sessions (session_id) values ('aaaaaaaa-5555-4000-8000-000000000001')$$),
  '22023 bad_revoke', '缺 user_id 又没给 pair_hash：报 bad_revoke');

-- ================= 二、session_fate 的回答 =================
select is((select string_agg(p.proname || ':' || p.provolatile::text || ':' || p.prosecdef, ',' order by p.proname) from pg_proc p where p.proname in ('session_fate', 'session_fate_impl')),
  'session_fate:v:false,session_fate_impl:v:true', 'M2：session_fate 和 impl 都是 volatile（要写 counters）；外壳 invoker、impl definer');
select is((select proconfig from pg_proc where oid = 'private.session_fate_impl(text)'::regprocedure), array['search_path=""', 'lock_timeout=5s'],
  'session_fate_impl 带 search_path 空和 lock_timeout 5s');
select is(jsonb_build_array(
    tests.fate('aaaaaaaa-5555-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),   -- 有这个账号、会话没吊销
    tests.fate('aaaaaaaa-5555-4000-8000-000000000001', '99999999-0000-4000-8000-000000000009'),   -- 没有这个账号
    tests.fate_raw(repeat('ab', 32))),                                                             -- 随便一个哈希
  '["unknown", "unknown", "unknown"]'::jsonb, 'M1：没吊销的会话、不存在的账号、随便一个哈希回答一样，都是 unknown（不回答账号存不存在）');
select is(jsonb_build_array(tests.fate_raw(upper(repeat('ab', 32))), tests.fate_raw(repeat('a', 63)), tests.fate_raw(null), tests.fate_raw('x'), tests.fate_raw(repeat('a', 64) || ' ')),
  '["unknown", "unknown", "unknown", "unknown", "unknown"]'::jsonb, '格式不对（大写、63 位、null、乱写、带空格）一律 unknown，不报错');

-- ================= 三、吊销路径：远程移除、换绑 =================
insert into auth.sessions (id, user_id) values
  ('aaaaaaaa-4601-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('aaaaaaaa-4602-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('aaaaaaaa-4603-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('aaaaaaaa-4604-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001');
insert into public.devices (id, user_id, platform, session_id) values
  ('de000000-0000-4000-8000-0000000046a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'ios', 'aaaaaaaa-4601-4000-8000-000000000001'),
  ('de000000-0000-4000-8000-0000000046a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'web', 'aaaaaaaa-4602-4000-8000-000000000001');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select public.remove_device('de000000-0000-4000-8000-0000000046a1')$$, null,
  'aaaaaaaa-5555-4000-8000-000000000001'), 'ok', 'A 在本机（5555）远程移除 4601 那台');
select is(tests.fate('aaaaaaaa-4601-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'), 'revoked', '远程移除：被移除那台的会话查得到 revoked');
select is(tests.try_as('service_role', null, $$select private.rebind_device_impl('aaaaaaaa-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-0000000046a2',
  'aaaaaaaa-4602-4000-8000-000000000001', 'aaaaaaaa-4603-4000-8000-000000000001')$$), 'ok', '换绑：4602 换成 4603');
select is(tests.fate('aaaaaaaa-4602-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001') || '|' || tests.fate('aaaaaaaa-4603-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  'revoked|unknown', '换绑：旧会话 revoked，新会话 unknown');

-- ================= 四、revoke_my_sessions =================
-- A 现在的会话：5555（本机）、4603、4604
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', 'select public.revoke_my_sessions(false) as n', null, 'aaaaaaaa-5555-4000-8000-000000000001'),
  '[{"n": 2}]'::jsonb, 'revoke_my_sessions(false)：吊掉除本机以外的 2 个，回个数');
select is(tests.fate('aaaaaaaa-5555-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001') || '|' || tests.fate('aaaaaaaa-4603-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001')
    || '|' || tests.fate('aaaaaaaa-4604-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  'unknown|revoked|revoked', 'false：本机不吊，另外两个 revoked');
select is((select count(*)::int from auth.sessions where id in ('aaaaaaaa-4603-4000-8000-000000000001', 'aaaaaaaa-4604-4000-8000-000000000001')), 2,
  '只写吊销记录、不删 auth.sessions（客户端成功后再调 GoTrue signOut）');
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', 'select public.revoke_my_sessions(null) as n', null, 'aaaaaaaa-5555-4000-8000-000000000001')
    || jsonb_build_array(tests.fate('aaaaaaaa-5555-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001')),
  '[{"n": 2}, "unknown"]'::jsonb, 'null 当 false：本机照样不吊（重复吊销只刷新 revoked_at）');
select is(tests.fate('bbbbbbbb-5555-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002'), 'unknown', '只动本人：B 的会话没被吊');
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', 'select public.revoke_my_sessions(true) as n', null, 'aaaaaaaa-5555-4000-8000-000000000001')
    || jsonb_build_array(tests.fate('aaaaaaaa-5555-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001')),
  '[{"n": 3}, "revoked"]'::jsonb, 'true：连本机一起吊，共 3 个');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', 'select public.revoke_my_sessions(true)', null, 'aaaaaaaa-5555-4000-8000-000000000001') like '%session_revoked%',
  '本机已吊销以后再调：session_revoked');
select ok(tests.try_claims('{"sub": "bbbbbbbb-0000-4000-8000-000000000002", "role": "authenticated", "session_id": "bbbbbbbb-5555-4000-8000-000000000002", "amr": [{"method": "password"}]}',
  'select public.revoke_my_sessions(true)') like '%session_revoked%', '密码会话：session_revoked，什么都不吊');
select ok(tests.try_as('anon', null, 'select public.revoke_my_sessions(true)') like '42501%', 'anon 调不了 revoke_my_sessions');

-- ================= 五、注销：只留哈希，仍回 revoked =================
insert into auth.users (id, email) values ('dddddddd-0000-4000-8000-000000000004', 'd46@test.local');
insert into public.profiles (user_id) values ('dddddddd-0000-4000-8000-000000000004');
insert into auth.sessions (id, user_id) values ('dddddddd-5555-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004');
select ok(tests.rows_as('service_role', null, $$select private.account_request_deletion('dddddddd-0000-4000-8000-000000000004') as pa$$) -> 0 ? 'pa', 'D 申请注销');
select is(tests.fate('dddddddd-5555-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004'), 'revoked', '申请注销：会话 revoked');
insert into private.deleted_accounts (user_id) values ('dddddddd-0000-4000-8000-000000000004');
delete from auth.users where id = 'dddddddd-0000-4000-8000-000000000004';
select is((select jsonb_build_object('s', session_id, 'u', user_id) from private.revoked_sessions
            where pair_hash = private.session_pair_hash('dddddddd-5555-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004'))
          || jsonb_build_object('fate', tests.fate('dddddddd-5555-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004')),
  '{"s": null, "u": null, "fate": "revoked"}'::jsonb, 'M5：注销真删后吊销记录只留哈希（session_id、user_id 清空），离线设备一联网仍查得到 revoked');

-- ================= 六、管理员停用：只退出、不吊销（0.62） =================
select private.admin_set_disabled('bbbbbbbb-0000-4000-8000-000000000002', true);
select is((select count(*)::int from private.revoked_sessions where user_id = 'bbbbbbbb-0000-4000-8000-000000000002') || '|'
       || (select count(*)::int from auth.sessions where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'),
  '0|1', '0.62：管理员停用不写吊销记录、不删 auth.sessions');
select ok(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', 'select * from public.my_sessions()', null, 'bbbbbbbb-5555-4000-8000-000000000002') like '%account_disabled%',
  '停用后自家函数回 account_disabled（客户端据此退出）');
select is(tests.fate('bbbbbbbb-5555-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002'), 'unknown', '停用的会话查 session_fate 是 unknown（不清本机）');

-- ================= 七、库内每分钟总闸 =================
-- now() 在事务里不变，所以这一分钟的键就是 sfate:global:<事务开始的 UTC 分钟>；把它补到 600 次
insert into private.counters as c (key, window_start, count)
  values ('sfate:global:' || to_char(now() at time zone 'UTC', 'YYYYMMDD"T"HH24MI'), to_timestamp(floor(extract(epoch from now()) / 60) * 60), 600)
  on conflict (key, window_start) do update set count = 600;
select is(tests.fate('aaaaaaaa-4601-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'), 'unknown',
  '这一分钟全库已满 600 次：本来是 revoked 的也回 unknown（客户端当登录过期，不清本机，过一分钟再问）');
select is((select sum(count)::int from private.counters where key like 'sfate-capped:global:%'), 1, '超了记一条 sfate-capped:global:<分钟>');
select count(*) from (select tests.fate_raw('x') from generate_series(1, 10)) t;
select is((select sum(count)::int from private.counters where key like 'sfate-capped:global:%') || '|'
       || (select sum(count)::int from private.counters where key like 'sfate:global:%'), '1|601',
  '安全审建议 1：超额后再调 10 次，sfate-capped 仍为 1，sfate:global 停在 601（超额后只读、不写）');
select is(tests.rows_as('service_role', null, 'select * from private.security_events()'), '[{"sfate_capped": 1, "pw_revoke_failed": 0}]'::jsonb,
  'security_events：最近 15 分钟 sfate_capped 1、pw_revoke_failed 0');
select ok(not has_function_privilege('anon', 'private.security_events()', 'EXECUTE') and not has_function_privilege('authenticated', 'private.security_events()', 'EXECUTE')
  and has_function_privilege('service_role', 'private.security_events()', 'EXECUTE'), 'security_events 只给 service_role');

-- ================= 七之二、每日清理：会话还在的吊销记录不删（安全审 M1） =================
-- 9555 吊销后会话还在 auth.sessions（客户端还没 signOut、GoTrue 还没删）；9666 吊销后会话已删。两条都改到 31 天前，跑每日清理
insert into auth.users (id, email) values ('f0f0f0f0-0000-4000-8000-000000000009', 'm1@test.local');
insert into auth.sessions (id, user_id) values
  ('f0f0f0f0-9555-4000-8000-000000000009', 'f0f0f0f0-0000-4000-8000-000000000009'),
  ('f0f0f0f0-9666-4000-8000-000000000009', 'f0f0f0f0-0000-4000-8000-000000000009');
select private.revoke_session('f0f0f0f0-9555-4000-8000-000000000009', 'f0f0f0f0-0000-4000-8000-000000000009');
select private.revoke_session('f0f0f0f0-9666-4000-8000-000000000009', 'f0f0f0f0-0000-4000-8000-000000000009');
delete from auth.sessions where id = 'f0f0f0f0-9666-4000-8000-000000000009';
update private.revoked_sessions set revoked_at = now() - interval '31 days' where user_id = 'f0f0f0f0-0000-4000-8000-000000000009';
select private.cleanup_batch();
select is((select count(*)::int from private.revoked_sessions where session_id = 'f0f0f0f0-9555-4000-8000-000000000009') || '|'
       || private.session_alive('f0f0f0f0-9555-4000-8000-000000000009')::text, '1|false',
  'M1：吊销满 30 天、auth.sessions 里会话还在：清理后吊销记录仍在，session_alive 仍是 false');
select is((select count(*)::int from private.revoked_sessions where session_id = 'f0f0f0f0-9666-4000-8000-000000000009'), 0,
  'M1 对照：吊销满 30 天、会话已删：清理时删掉');

-- ================= 八、改密码触发器（复审 N1；0.61） =================
select is((select pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'users_password_change_revoke'),
  'CREATE TRIGGER users_password_change_revoke AFTER UPDATE OF encrypted_password ON auth.users FOR EACH ROW WHEN (((COALESCE(old.encrypted_password, ''''::character varying))::text IS DISTINCT FROM (COALESCE(new.encrypted_password, ''''::character varying))::text)) EXECUTE FUNCTION private.on_password_change()',
  '钉住 auth.users 上的改密码触发器：after update of encrypted_password，when 用 coalesce 比较');
select is((select array[p.prosecdef::text] || p.proconfig from pg_proc p where p.oid = 'private.on_password_change()'::regprocedure), array['true', 'search_path=""'],
  'on_password_change：security definer、search_path 空');
-- 4.0.0 的真实情况：0001 的 users_guard_no_password 把任何密码改回 ''，触发器不跑、不误踢
insert into auth.users (id, email) values ('eeeeeeee-4600-4000-8000-000000000005', 'e46@test.local');
insert into auth.sessions (id, user_id) values ('eeeeeeee-5555-4000-8000-000000000005', 'eeeeeeee-4600-4000-8000-000000000005');
update auth.users set encrypted_password = '$2a$10$abcdefghijklmnopqrstuv' where id = 'eeeeeeee-4600-4000-8000-000000000005';
select is((select coalesce(encrypted_password, 'NULL') from auth.users where id = 'eeeeeeee-4600-4000-8000-000000000005') || '|'
       || (select count(*)::int from private.revoked_sessions where user_id = 'eeeeeeee-4600-4000-8000-000000000005') || '|'
       || (select count(*)::int from auth.sessions where user_id = 'eeeeeeee-4600-4000-8000-000000000005'),
  '|0|1', '0.61：4.0.0 里改密码被挡（落库仍是 ''''），revoked_sessions 没有新行、会话还在（不误踢）');
-- 用临时表挂同一个函数、同一个 when，验“真改了密码就吊销”（以后去掉 guard、开放密码时的行为）
create table tests.pw_users (id uuid primary key, email text, encrypted_password character varying(255));
create trigger users_password_change_revoke after update of encrypted_password on tests.pw_users
  for each row when (coalesce(old.encrypted_password, '') is distinct from coalesce(new.encrypted_password, ''))
  execute function private.on_password_change();
select is(replace((select pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'tests.pw_users'::regclass), 'ON tests.pw_users', 'ON auth.users'),
  (select pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'users_password_change_revoke'),
  '临时表上的触发器和 auth.users 上的逐字一样（同一函数、同一 when）');
insert into tests.pw_users values ('eeeeeeee-4600-4000-8000-000000000005', 'e46@test.local', '');
update tests.pw_users set email = 'e46b@test.local';
update tests.pw_users set encrypted_password = '';
update tests.pw_users set encrypted_password = null;
select is((select count(*)::int from private.revoked_sessions where user_id = 'eeeeeeee-4600-4000-8000-000000000005'), 0,
  '只改别的列、写回同一个值、'''' 改成 null 都不触发（GoTrue 整行回写不踢人）');
update tests.pw_users set encrypted_password = '$2a$10$hash1';
-- 第七节已经把这一分钟的总闸补满，这里不经 session_fate，直接看吊销记录
select is((select count(*)::int from private.revoked_sessions
            where pair_hash = private.session_pair_hash('eeeeeeee-5555-4000-8000-000000000005', 'eeeeeeee-4600-4000-8000-000000000005')), 1,
  '真改了密码：这个人当时的会话写进吊销记录（客户端查 session_fate 判“被移除”）');
-- 出错只记日志、不往外抛：把 revoke_session 临时换成会报错的（随 rollback 还原；这一节放最后）
create or replace function private.revoke_session(p_session uuid, p_user uuid) returns void language plpgsql security definer set search_path = '' as $$
begin raise exception 'boom'; end $$;
select is(tests.try_as('postgres', null, $$update tests.pw_users set encrypted_password = '$2a$10$hash2'$$), 'ok', '吊销出错：update 照样成功（不能卡住 GoTrue 改密码）');
select is((select encrypted_password::text from tests.pw_users), '$2a$10$hash2', '新密码照样写进去了');
select is((select sum(count)::int from private.counters where key like 'pwrevoke-fail:global:%'), 1, '吊销出错记一条 pwrevoke-fail:global:<分钟>');
select is(tests.rows_as('service_role', null, 'select pw_revoke_failed from private.security_events()'), '[{"pw_revoke_failed": 1}]'::jsonb,
  'security_events 的 pw_revoke_failed 跟着变成 1');

select * from finish();
rollback;
