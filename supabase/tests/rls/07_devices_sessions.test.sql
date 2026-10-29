-- B1 迁移 20261029192000_core_devices_sessions.sql：移除设备、交接设备行、没有设备行的会话、时区上报、同意记录、每日清理的设备三项、墓碑拉取
-- 用例：TC-B1-77、78（数据库一半）、79 ④⑤、84 ②、85 ①③⑤⑥⑦⑧⑨⑩（数据库一半）、89 ②、92 ②③⑤⑥、96 ②（拉墓碑）、97 ④、13，
--   以及架构 4.6（时区：手机优先、10 分钟防抖、fixed）、3.3 通用规则（新 *_impl 先查 account_usable 和 not_password_session）
-- JWT 用 request.jwt.claims 模拟；函数（account、vault）那一半、真会话刷新失败在 deno 测试和 B1 实测里
begin;
select plan(172);
\ir _helpers.psql
select tests.seed();

-- 以给定 claims 的 authenticated 执行（密码会话用）：'ok' 或 '<sqlstate> <信息>'
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

-- ================= 一、remove_device（TC-B1-77、78、79 ④、97 ④） =================
-- A：Y（本机，会话 S_Y）、X（丢了的手机，S_X）、Z（S_Z）、Z2（session_id 为空、和 Z 同一个 install_id）、N（session_id 为空）；B：W
insert into auth.sessions (id, user_id) values
  ('aaaaaaaa-7777-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('aaaaaaaa-8888-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001');
insert into public.devices (id, user_id, platform, label, session_id, install_id) values
  ('de000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'windows', 'Y', 'aaaaaaaa-5555-4000-8000-000000000001', '1e000000-0000-4000-8000-0000000000a1'),
  ('de000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'ios',     'X', 'aaaaaaaa-7777-4000-8000-000000000001', '1e000000-0000-4000-8000-0000000000a2'),
  ('de000000-0000-4000-8000-0000000000a3', 'aaaaaaaa-0000-4000-8000-000000000001', 'windows', 'Z', 'aaaaaaaa-8888-4000-8000-000000000001', '1e000000-0000-4000-8000-0000000000a3'),
  ('de000000-0000-4000-8000-0000000000a5', 'aaaaaaaa-0000-4000-8000-000000000001', 'windows', 'Z2', null,                                  '1e000000-0000-4000-8000-0000000000a3'),
  ('de000000-0000-4000-8000-0000000000a4', 'aaaaaaaa-0000-4000-8000-000000000001', 'web',     'N', null,                                   null),
  ('de000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'ios',     'W', 'bbbbbbbb-5555-4000-8000-000000000002', null);
insert into private.device_secrets (device_id, user_id, draft_salt, enc_key_id) values
  ('de000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', decode(repeat('ab', 32), 'hex'), 1),
  ('de000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', decode(repeat('cd', 32), 'hex'), 1);
insert into public.settings (id, user_id, key, value) values
  ('5e000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'layout.today@inst:1e000000-0000-4000-8000-0000000000a2', '{}'),
  ('5e000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'layout.today@inst:1e000000-0000-4000-8000-0000000000a1', '{}'),
  ('5e000000-0000-4000-8000-0000000000a3', 'aaaaaaaa-0000-4000-8000-000000000001', 'layout.today@inst:1e000000-0000-4000-8000-0000000000a3', '{}');

-- ① 移除本机：is_current_device，Y 和它的会话都还在
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select public.remove_device('de000000-0000-4000-8000-0000000000a1')$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '%is_current_device%',
  'TC-B1-78 ①：移除本机回 is_current_device');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-0000000000a1')
        + (select count(*)::int from auth.sessions where id = 'aaaaaaaa-5555-4000-8000-000000000001'), 2, 'TC-B1-78 ①：Y 的行和会话都还在');
-- ② B 移除 A 的 Z：只认本人的设备
select ok(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002',
  $$select public.remove_device('de000000-0000-4000-8000-0000000000a3')$$, null, 'bbbbbbbb-5555-4000-8000-000000000002') like '%device_not_found%',
  'TC-B1-78 ②：B 移除 A 的设备回 device_not_found');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-0000000000a3')
        + (select count(*)::int from auth.sessions where id = 'aaaaaaaa-8888-4000-8000-000000000001')
        + (select count(*)::int from private.revoked_sessions), 2, 'TC-B1-78 ②：Z 的行和会话都还在，没写吊销记录');
-- anon、没有会话的 authenticated、密码会话、停用账号
select ok(tests.try_as('anon', null, $$select public.remove_device('de000000-0000-4000-8000-0000000000a2')$$) like '42501%', 'anon 调 remove_device 被拒（42501）');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select public.remove_device('de000000-0000-4000-8000-0000000000a2')$$) like '%session_revoked%', 'JWT 没有 session_id：remove_device 回 session_revoked');
select ok(tests.try_claims('{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated", "session_id": "aaaaaaaa-5555-4000-8000-000000000001", "amr": [{"method": "password"}]}',
  $$select public.remove_device('de000000-0000-4000-8000-0000000000a2')$$) like '%session_revoked%', '密码会话：remove_device 回 session_revoked（依赖 S1 的 not_password_session）');
select ok(tests.try_as('authenticated', 'cccccccc-0000-4000-8000-000000000003',
  $$select public.remove_device('de000000-0000-4000-8000-0000000000a2')$$) like '%account_disabled%', '停用账号：remove_device 回 account_disabled');
-- 0.38 第 5 条：private 对外暴露，authenticated 能直接调 remove_device_impl（经 /rest/v1/rpc 带 Accept-Profile: private），只能动自己的设备
select ok(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002',
  $$select private.remove_device_impl('de000000-0000-4000-8000-0000000000a2')$$, null, 'bbbbbbbb-5555-4000-8000-000000000002') ->> 'error' like '%device_not_found%',
  '0.38 第 5 条：B 直接调 private.remove_device_impl 移除 A 的 X，回 device_not_found');
select ok(tests.try_as('anon', null, $$select private.remove_device_impl('de000000-0000-4000-8000-0000000000a2')$$) like '42501%', 'anon 直接调 remove_device_impl 被拒');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-0000000000a2'), 1, '上面几次被拒，X 都还在');

-- ③ A 在 Y 上移除 X（TC-B1-77）
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select public.remove_device('de000000-0000-4000-8000-0000000000a2')$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'), 'ok', 'TC-B1-77：A 在 Y 上移除 X 成功');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-0000000000a2'), 0, 'TC-B1-77：X 的 devices 行没了');
select is((select user_id::text from private.revoked_sessions where session_id = 'aaaaaaaa-7777-4000-8000-000000000001'),
  'aaaaaaaa-0000-4000-8000-000000000001', 'TC-B1-77：X 的会话记进 revoked_sessions');
select is((select count(*)::int from auth.sessions where id = 'aaaaaaaa-7777-4000-8000-000000000001'), 0, 'TC-B1-77：同一事务里删了 auth.sessions 那一行');
select is(private.session_alive('aaaaaaaa-7777-4000-8000-000000000001'), false, 'TC-B1-77 ②：session_alive 查得到 X 已失效（函数立刻回 session_revoked）');
select is((select count(*)::int from private.device_secrets where device_id = 'de000000-0000-4000-8000-0000000000a2'), 0, 'TC-B1-77：X 的盐随外键删掉');
select is((select count(*)::int from private.device_secrets where device_id = 'de000000-0000-4000-8000-0000000000a1'), 1, 'TC-B1-77：Y 的盐不受影响');
select is((select count(*)::int from public.settings where id = '5e000000-0000-4000-8000-0000000000a2'), 0, 'TC-B1-77：X 的布局行（@inst:X 的 install_id）删掉');
select is((select count(*)::int from public.settings where id in ('5e000000-0000-4000-8000-0000000000a1', '5e000000-0000-4000-8000-0000000000a3')), 2,
  'TC-B1-77：Y、Z 的布局行不动');
select is((select string_agg(tbl, ',' order by tbl) from public.tombstones where id in ('de000000-0000-4000-8000-0000000000a2', '5e000000-0000-4000-8000-0000000000a2')),
  'devices,settings', 'TC-B1-97 ④：devices 行、布局行被删时各留一条墓碑');
select is((select count(*)::int from public.devices where id in ('de000000-0000-4000-8000-0000000000a1', 'de000000-0000-4000-8000-0000000000a3')), 2, 'TC-B1-77：Y、Z 不变');
-- ④ X 在残留窗口里：写回自己的行、反过来移除 Y 都不行
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.devices (id, platform) values ('de000000-0000-4000-8000-0000000000a2', 'ios')$$, null, 'aaaaaaaa-7777-4000-8000-000000000001') like '%session_revoked%',
  'TC-B1-77 ④：X 写回自己的 devices 行被 devices_session_guard 拒（session_revoked）');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select public.remove_device('de000000-0000-4000-8000-0000000000a1')$$, null, 'aaaaaaaa-7777-4000-8000-000000000001') like '%session_revoked%',
  '被移除的 X 拿着没过期的令牌也移除不了主人的 Y（session_revoked）');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-0000000000a1'), 1, 'Y 还在');

-- ⑤ 移除 session_id 为空的旧行 N：只删行、不碰 auth.sessions（TC-B1-79 ④、第 103 条①）
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select public.remove_device('de000000-0000-4000-8000-0000000000a4')$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'), 'ok', 'TC-B1-79 ④：能移除 session_id 为空的 N');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-0000000000a4')
        + (select count(*)::int from private.revoked_sessions where session_id <> 'aaaaaaaa-7777-4000-8000-000000000001'), 0, 'TC-B1-79 ④：N 删掉，没多写吊销记录');
select is((select count(*)::int from auth.sessions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 2, 'TC-B1-79 ④：A 剩下的两个会话（Y、Z）都还在');
-- ⑥ 移除 Z：Z2 用着同一个 install_id，布局留着（第 109 条）
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select public.remove_device('de000000-0000-4000-8000-0000000000a3')$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'), 'ok', '移除 Z 成功');
select is((select count(*)::int from public.settings where id = '5e000000-0000-4000-8000-0000000000a3'), 1, '第 109 条：同一 install_id 还有 Z2 的行，Z 的布局留着');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select private.remove_device_impl('de000000-0000-4000-8000-0000000000a5')$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'), 'ok',
  '0.38 第 9 条：A 直接调 remove_device_impl 移除自己的 Z2 成功');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-0000000000a5'), 0, 'Z2 删掉了');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-0000000000b1')
        + (select count(*)::int from auth.sessions where id = 'bbbbbbbb-5555-4000-8000-000000000002'), 2, 'B 的设备和会话全程不受影响');

-- ================= 二、拉墓碑（TC-B1-96 ②、TC-B1-105：按 deleted_at > 游标 − 10 分钟） =================
select is((tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select tbl, id from public.tombstones where deleted_at > now() - interval '10 minutes' and tbl = 'devices' order by id$$, null, 'aaaaaaaa-5555-4000-8000-000000000001')),
  '[{"tbl": "devices", "id": "de000000-0000-4000-8000-0000000000a2"}, {"tbl": "devices", "id": "de000000-0000-4000-8000-0000000000a3"}, {"tbl": "devices", "id": "de000000-0000-4000-8000-0000000000a4"}, {"tbl": "devices", "id": "de000000-0000-4000-8000-0000000000a5"}]'::jsonb,
  'TC-B1-96 ②：A 按游标拉到四台被移除设备（X、Z、N、Z2）的墓碑（只有 id）');
select is((tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select count(*)::int as n from public.tombstones where deleted_at > now() + interval '1 minute'$$, null, 'aaaaaaaa-5555-4000-8000-000000000001')),
  '[{"n": 0}]'::jsonb, '游标之后没有新的墓碑时拉到 0 条');
select is((tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002',
  $$select count(*)::int as n from public.tombstones$$, null, 'bbbbbbbb-5555-4000-8000-000000000002')), '[{"n": 0}]'::jsonb, 'TC-B1-96：B 拉不到 A 的墓碑（RLS）');
select ok(tests.rows_as('anon', null, $$select count(*) from public.tombstones$$) ->> 'error' like '42501%', 'anon 读 tombstones 被拒');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$delete from public.tombstones$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%', '客户端不能删墓碑');

-- ================= 三、rebind_device（TC-B1-84 ②、85） =================
-- R：设备 D（会话 S1）、E（会话 SE）、F（会话 S3）；重新验证后的新会话 S2
insert into auth.users (id, email) values ('eeeeeeee-0000-4000-8000-000000000005', 'r@test.local');
insert into public.profiles (user_id) values ('eeeeeeee-0000-4000-8000-000000000005');
insert into auth.sessions (id, user_id) values
  ('eeeeeeee-1111-4000-8000-000000000005', 'eeeeeeee-0000-4000-8000-000000000005'),
  ('eeeeeeee-2222-4000-8000-000000000005', 'eeeeeeee-0000-4000-8000-000000000005'),
  ('eeeeeeee-3333-4000-8000-000000000005', 'eeeeeeee-0000-4000-8000-000000000005'),
  ('eeeeeeee-4444-4000-8000-000000000005', 'eeeeeeee-0000-4000-8000-000000000005');
insert into public.devices (id, user_id, platform, label, session_id) values
  ('de000000-0000-4000-8000-0000000000e1', 'eeeeeeee-0000-4000-8000-000000000005', 'windows', 'D', 'eeeeeeee-1111-4000-8000-000000000005'),
  ('de000000-0000-4000-8000-0000000000e2', 'eeeeeeee-0000-4000-8000-000000000005', 'windows', 'E', 'eeeeeeee-3333-4000-8000-000000000005'),
  ('de000000-0000-4000-8000-0000000000e3', 'eeeeeeee-0000-4000-8000-000000000005', 'ios',     'F', 'eeeeeeee-4444-4000-8000-000000000005');

-- ① 拿 D 的会话交接 E：device_mismatch
select ok(tests.try_as('service_role', null, $$select private.rebind_device_impl('eeeeeeee-0000-4000-8000-000000000005',
  'de000000-0000-4000-8000-0000000000e2', 'eeeeeeee-1111-4000-8000-000000000005', 'eeeeeeee-2222-4000-8000-000000000005')$$) like '%device_mismatch%',
  'TC-B1-85 ①：拿别的设备行的 id 交接被拒');
-- ② 旧会话是 B 的：session_mismatch
select ok(tests.try_as('service_role', null, $$select private.rebind_device_impl('eeeeeeee-0000-4000-8000-000000000005',
  'de000000-0000-4000-8000-0000000000e1', 'bbbbbbbb-5555-4000-8000-000000000002', 'eeeeeeee-2222-4000-8000-000000000005')$$) like '%session_mismatch%',
  'TC-B1-85 ②：旧、新会话不是同一账号被拒');
select ok(tests.try_as('service_role', null, $$select private.rebind_device_impl('bbbbbbbb-0000-4000-8000-000000000002',
  'de000000-0000-4000-8000-0000000000e1', 'eeeeeeee-1111-4000-8000-000000000005', 'bbbbbbbb-5555-4000-8000-000000000002')$$) like '%session_mismatch%',
  'TC-B1-85 ②：反过来（p_user 是 B）也被拒');
-- ⑤ S1 已被吊销
insert into private.revoked_sessions (session_id, user_id) values ('eeeeeeee-1111-4000-8000-000000000005', 'eeeeeeee-0000-4000-8000-000000000005');
select ok(tests.try_as('service_role', null, $$select private.rebind_device_impl('eeeeeeee-0000-4000-8000-000000000005',
  'de000000-0000-4000-8000-0000000000e1', 'eeeeeeee-1111-4000-8000-000000000005', 'eeeeeeee-2222-4000-8000-000000000005')$$) like '%session_revoked%',
  'TC-B1-85 ⑤：旧会话已在 revoked_sessions 里被拒');
delete from private.revoked_sessions where session_id = 'eeeeeeee-1111-4000-8000-000000000005';
-- 新会话已绑在 F 上
select ok(tests.try_as('service_role', null, $$select private.rebind_device_impl('eeeeeeee-0000-4000-8000-000000000005',
  'de000000-0000-4000-8000-0000000000e1', 'eeeeeeee-1111-4000-8000-000000000005', 'eeeeeeee-4444-4000-8000-000000000005')$$) like '%session_in_use%',
  '新会话已绑在别的设备行上：session_in_use');
select is((select string_agg(session_id::text, ',' order by id) from public.devices where user_id = 'eeeeeeee-0000-4000-8000-000000000005'),
  'eeeeeeee-1111-4000-8000-000000000005,eeeeeeee-3333-4000-8000-000000000005,eeeeeeee-4444-4000-8000-000000000005', 'TC-B1-85 ①～⑤：D、E、F 一个字段都没变');
select is((select count(*)::int from auth.sessions where id = 'eeeeeeee-1111-4000-8000-000000000005'), 1, 'TC-B1-85 ①～⑤：S1 没被吊销');
-- ⑥⑧ authenticated 设了 lemo.rebind 再改自己那一行的 session_id：列授权就不给（42501），触发器另有一道
select ok(tests.try_as('authenticated', 'eeeeeeee-0000-4000-8000-000000000005', $$
  select set_config('lemo.rebind', 'de000000-0000-4000-8000-0000000000e1', true);
  update public.devices set session_id = 'eeeeeeee-2222-4000-8000-000000000005' where id = 'de000000-0000-4000-8000-0000000000e1'$$,
  null, 'eeeeeeee-1111-4000-8000-000000000005') like '42501%', 'TC-B1-85 ⑥⑧：authenticated 设了 lemo.rebind 也改不了 session_id');
select is(tests.try_as('authenticated', 'eeeeeeee-0000-4000-8000-000000000005', $$
  select set_config('lemo.rebind', 'de000000-0000-4000-8000-0000000000e1', true);
  update public.devices set label = 'D2' where id = 'de000000-0000-4000-8000-0000000000e1'$$,
  null, 'eeeeeeee-1111-4000-8000-000000000005'), 'ok', '同一句里改 label 照常成功');
select is((select session_id::text from public.devices where id = 'de000000-0000-4000-8000-0000000000e1'), 'eeeeeeee-1111-4000-8000-000000000005', 'TC-B1-85 ⑧：session_id 仍是 S1');
select set_config('lemo.rebind', '', true);   -- 上一句成功的那次把 lemo.rebind 留在了事务里，清掉
-- ⑦ anon、authenticated 执行不了 rebind_device_impl
select ok(tests.try_as('anon', null, $$select private.rebind_device_impl('eeeeeeee-0000-4000-8000-000000000005',
  'de000000-0000-4000-8000-0000000000e1', 'eeeeeeee-1111-4000-8000-000000000005', 'eeeeeeee-2222-4000-8000-000000000005')$$) like '42501%', 'TC-B1-85 ⑦：anon 执行 rebind_device_impl 被拒');
select ok(tests.try_as('authenticated', 'eeeeeeee-0000-4000-8000-000000000005', $$select private.rebind_device_impl('eeeeeeee-0000-4000-8000-000000000005',
  'de000000-0000-4000-8000-0000000000e1', 'eeeeeeee-1111-4000-8000-000000000005', 'eeeeeeee-2222-4000-8000-000000000005')$$,
  null, 'eeeeeeee-1111-4000-8000-000000000005') like '42501%', 'TC-B1-85 ⑦：authenticated 执行 rebind_device_impl 被拒');
-- ⑩ 直连数据库（role 不是 service_role）：触发器不放行，函数报 rebind_denied，什么都没改
create function tests.rebind_direct() returns text language plpgsql as $$
begin
  perform private.rebind_device_impl('eeeeeeee-0000-4000-8000-000000000005',
    'de000000-0000-4000-8000-0000000000e1', 'eeeeeeee-1111-4000-8000-000000000005', 'eeeeeeee-2222-4000-8000-000000000005');
  return 'ok';
exception when others then return sqlstate || ' ' || sqlerrm;
end $$;
select ok(tests.rebind_direct() like '%rebind_denied%', 'TC-B1-85 ⑩：直连数据库（role = none）交接失败（rebind_denied），不放宽第 112 条');
select is((select session_id::text from public.devices where id = 'de000000-0000-4000-8000-0000000000e1')
       || '|' || (select count(*)::int from auth.sessions where id = 'eeeeeeee-1111-4000-8000-000000000005'),
  'eeeeeeee-1111-4000-8000-000000000005|1', 'TC-B1-85 ⑩：D 不变、S1 没被吊销（整句回滚）');
-- 参数不对、新会话已吊销
select ok(tests.try_as('service_role', null, $$select private.rebind_device_impl('eeeeeeee-0000-4000-8000-000000000005',
  'de000000-0000-4000-8000-0000000000e1', 'eeeeeeee-1111-4000-8000-000000000005', 'eeeeeeee-1111-4000-8000-000000000005')$$) like '22023%bad_rebind%',
  '新旧会话相同：bad_rebind');
select ok(tests.try_as('service_role', null, $$select private.rebind_device_impl('eeeeeeee-0000-4000-8000-000000000005',
  null, 'eeeeeeee-1111-4000-8000-000000000005', 'eeeeeeee-2222-4000-8000-000000000005')$$) like '22023%bad_rebind%', '设备 id 为空：bad_rebind');
insert into private.revoked_sessions (session_id, user_id) values ('eeeeeeee-2222-4000-8000-000000000005', 'eeeeeeee-0000-4000-8000-000000000005');
select ok(tests.try_as('service_role', null, $$select private.rebind_device_impl('eeeeeeee-0000-4000-8000-000000000005',
  'de000000-0000-4000-8000-0000000000e1', 'eeeeeeee-1111-4000-8000-000000000005', 'eeeeeeee-2222-4000-8000-000000000005')$$) like '%session_revoked%',
  '新会话已在 revoked_sessions 里：session_revoked');
delete from private.revoked_sessions where session_id = 'eeeeeeee-2222-4000-8000-000000000005';
-- 第 112 条：service_role 不经 rebind_device_impl 直接改 session_id——不设 lemo.rebind、或设成别的行的 id，触发器都把它还原
select is(tests.try_as('service_role', null, $$update public.devices set session_id = 'eeeeeeee-2222-4000-8000-000000000005' where id = 'de000000-0000-4000-8000-0000000000e2'$$),
  'ok', 'service_role 不设 lemo.rebind 直接 update session_id：语句不报错');
select is((select session_id::text from public.devices where id = 'de000000-0000-4000-8000-0000000000e2'), 'eeeeeeee-3333-4000-8000-000000000005', '……但 session_id 被触发器还原成原值');
select is(tests.try_as('service_role', null, $$select set_config('lemo.rebind', 'de000000-0000-4000-8000-0000000000e1', true);
  update public.devices set session_id = 'eeeeeeee-2222-4000-8000-000000000005' where id = 'de000000-0000-4000-8000-0000000000e2'$$), 'ok',
  'service_role 把 lemo.rebind 设成 D 的 id、去改 E 的 session_id：语句不报错');
select is((select session_id::text from public.devices where id = 'de000000-0000-4000-8000-0000000000e2'), 'eeeeeeee-3333-4000-8000-000000000005', '……E 的 session_id 不变（lemo.rebind 只放行本行）');
select set_config('lemo.rebind', '', true);
-- ⑨ 经 PostgREST 以 service_role 调：成功
select is(tests.try_as('service_role', null, $$select private.rebind_device_impl('eeeeeeee-0000-4000-8000-000000000005',
  'de000000-0000-4000-8000-0000000000e1', 'eeeeeeee-1111-4000-8000-000000000005', 'eeeeeeee-2222-4000-8000-000000000005')$$), 'ok',
  'TC-B1-85 ⑨：service_role 交接 D 成功');
select is((select session_id::text from public.devices where id = 'de000000-0000-4000-8000-0000000000e1'), 'eeeeeeee-2222-4000-8000-000000000005',
  'TC-B1-84 ①：D 的 session_id 改成 S2，device_id 不变');
select is((select count(*)::int from private.revoked_sessions where session_id = 'eeeeeeee-1111-4000-8000-000000000005')
       || '|' || (select count(*)::int from auth.sessions where id = 'eeeeeeee-1111-4000-8000-000000000005'), '1|0', 'TC-B1-84 ①：S1 写进 revoked_sessions、auth.sessions 删掉');
select is(coalesce(current_setting('lemo.rebind', true), ''), '', '交接后 lemo.rebind 已清空');
-- TC-B1-84 ②：交接后用 S2 移除 D 仍是“本机”
select ok(tests.try_as('authenticated', 'eeeeeeee-0000-4000-8000-000000000005',
  $$select public.remove_device('de000000-0000-4000-8000-0000000000e1')$$, null, 'eeeeeeee-2222-4000-8000-000000000005') like '%is_current_device%',
  'TC-B1-84 ②：交接后 remove_device(D) 回 is_current_device');
select is(tests.try_as('authenticated', 'eeeeeeee-0000-4000-8000-000000000005',
  $$update public.devices set label = 'D3' where id = 'de000000-0000-4000-8000-0000000000e1'$$, null, 'eeeeeeee-2222-4000-8000-000000000005'), 'ok', 'S2 能改本机那一行');
select is((select label from public.devices where id = 'de000000-0000-4000-8000-0000000000e1'), 'D3', 'S2 改 label 生效');

-- ================= 四、my_sessions（TC-B1-92） =================
-- M：当前会话 SM0（有设备行）、S9（没有设备行，3 分钟前建）、S10（1 分钟前建）、S11（已吊销）、S12（有设备行）；B 另有一个没有设备行的会话
insert into auth.users (id, email) values ('dddddddd-0000-4000-8000-000000000004', 'm@test.local');
insert into public.profiles (user_id) values ('dddddddd-0000-4000-8000-000000000004');
insert into auth.sessions (id, user_id, created_at, refreshed_at) values
  ('dddddddd-5555-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004', now() - interval '1 day', null),
  ('dddddddd-9999-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004', now() - interval '3 minutes', '2026-10-29 01:02:03'),
  ('dddddddd-1010-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004', now() - interval '1 minute', null),
  ('dddddddd-1111-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004', now() - interval '3 minutes', null),
  ('dddddddd-1212-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004', now() - interval '3 minutes', null),
  ('bbbbbbbb-9999-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', now() - interval '3 minutes', null);
insert into private.revoked_sessions (session_id, user_id) values ('dddddddd-1111-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004');
insert into public.devices (id, user_id, platform, session_id) values
  ('de000000-0000-4000-8000-0000000000d0', 'dddddddd-0000-4000-8000-000000000004', 'ios', 'dddddddd-5555-4000-8000-000000000004'),
  ('de000000-0000-4000-8000-0000000000d2', 'dddddddd-0000-4000-8000-000000000004', 'web', 'dddddddd-1212-4000-8000-000000000004');

select is(tests.rows_as('authenticated', 'dddddddd-0000-4000-8000-000000000004', $$select * from public.my_sessions()$$, null, 'dddddddd-5555-4000-8000-000000000004'),
  jsonb_build_array(jsonb_build_object('orphan_count', 1, 'orphan_last_at', '2026-10-29 01:02:03+00'::timestamptz, 'signed_out_device_ids', '[]'::jsonb)),
  'TC-B1-92 ②⑥：只算 S9（当前、有设备行、已吊销、不到 2 分钟的都不算）；只回三个字段（20261029193000 加了 signed_out_device_ids，M 的两台都在线所以为空），最近时间取 refreshed_at（按 UTC）');
select is(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$select orphan_count from public.my_sessions()$$, null, 'bbbbbbbb-5555-4000-8000-000000000002'),
  '[{"orphan_count": 1}]'::jsonb, 'TC-B1-92 ②：B 只看到自己那一个，M 的不算进来');
update auth.sessions set created_at = now() - interval '3 minutes' where id = 'dddddddd-1010-4000-8000-000000000004';
select is(tests.rows_as('authenticated', 'dddddddd-0000-4000-8000-000000000004', $$select orphan_count from public.my_sessions()$$, null, 'dddddddd-5555-4000-8000-000000000004'),
  '[{"orphan_count": 2}]'::jsonb, 'TC-B1-92 ⑥：过了 2 分钟仍没插设备行就算上');
delete from auth.sessions where id in ('dddddddd-9999-4000-8000-000000000004', 'dddddddd-1010-4000-8000-000000000004');   -- “退出其他所有设备”：GoTrue 删会话
select is(tests.rows_as('authenticated', 'dddddddd-0000-4000-8000-000000000004', $$select orphan_count, orphan_last_at from public.my_sessions()$$, null, 'dddddddd-5555-4000-8000-000000000004'),
  '[{"orphan_count": 0, "orphan_last_at": null}]'::jsonb, 'TC-B1-92 ③④：退出其他所有设备后计数回到 0');
select ok(tests.rows_as('anon', null, $$select * from public.my_sessions()$$) ->> 'error' like '42501%', 'TC-B1-92 ⑤：anon 调 my_sessions 被拒');
select ok(tests.rows_as('anon', null, $$select * from private.my_sessions_impl()$$) ->> 'error' like '42501%', 'TC-B1-92 ⑤：anon 直接调 my_sessions_impl 被拒');
select is(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$select * from private.my_sessions_impl()$$, null, 'bbbbbbbb-5555-4000-8000-000000000002'),
  tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$select * from public.my_sessions()$$, null, 'bbbbbbbb-5555-4000-8000-000000000002'),
  '0.38 第 5、9 条：B 直接调 private.my_sessions_impl 能成功，结果和 my_sessions() 一样');
select is(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$select orphan_count from private.my_sessions_impl()$$, null, 'bbbbbbbb-5555-4000-8000-000000000002'),
  '[{"orphan_count": 1}]'::jsonb, '直接调也只算 B 自己的（M 的不算进来；只有两个字段，不回会话 id）');
select is(tests.rows_as('authenticated', 'dddddddd-0000-4000-8000-000000000004', $$select * from private.my_sessions_impl()$$, null, 'dddddddd-5555-4000-8000-000000000004'),
  tests.rows_as('authenticated', 'dddddddd-0000-4000-8000-000000000004', $$select * from public.my_sessions()$$, null, 'dddddddd-5555-4000-8000-000000000004'),
  'M 直接调 my_sessions_impl 和经包装的结果一样');
select ok(tests.rows_as('service_role', null, $$select * from public.my_sessions()$$) ->> 'error' like '42501%', 'service_role 调 my_sessions 被拒（public RPC 只给 authenticated）');
select ok(tests.try_claims('{"sub": "dddddddd-0000-4000-8000-000000000004", "role": "authenticated", "session_id": "dddddddd-5555-4000-8000-000000000004", "amr": ["password"]}',
  $$select * from public.my_sessions()$$) like '%session_revoked%', '密码会话：my_sessions 回 session_revoked（依赖 S1 的 not_password_session）');
select ok(tests.try_as('authenticated', 'cccccccc-0000-4000-8000-000000000003', $$select * from public.my_sessions()$$) like '%account_disabled%', '停用账号：my_sessions 回 account_disabled');

-- ================= 五、report_tz（4.6） =================
-- T：手机 P（ios，会话 SP）、电脑 W2（windows，会话 SW）；全天日程 ev1、定时日程 ev2、待办 td1、纪念日 an1，提醒都还没到
insert into auth.users (id, email) values ('ffffffff-0000-4000-8000-000000000006', 't@test.local');
insert into public.profiles (user_id) values ('ffffffff-0000-4000-8000-000000000006');
insert into auth.sessions (id, user_id) values
  ('ffffffff-5555-4000-8000-000000000006', 'ffffffff-0000-4000-8000-000000000006'),
  ('ffffffff-6666-4000-8000-000000000006', 'ffffffff-0000-4000-8000-000000000006');
insert into public.devices (id, user_id, platform, session_id) values
  ('de000000-0000-4000-8000-0000000000f1', 'ffffffff-0000-4000-8000-000000000006', 'ios',     'ffffffff-5555-4000-8000-000000000006'),
  ('de000000-0000-4000-8000-0000000000f2', 'ffffffff-0000-4000-8000-000000000006', 'windows', 'ffffffff-6666-4000-8000-000000000006');
insert into public.events (id, user_id, title, date, time, tz, remind_at, created_at, updated_at) values
  ('0e000000-0000-4000-8000-0000000000f1', 'ffffffff-0000-4000-8000-000000000006', '全天', current_date + 3, null, null, (extract(epoch from now()) * 1000)::bigint + 86400000, 0, 0),
  ('0e000000-0000-4000-8000-0000000000f2', 'ffffffff-0000-4000-8000-000000000006', '定时', current_date + 3, '15:00', 'Asia/Seoul', (extract(epoch from now()) * 1000)::bigint + 86400000, 0, 0);
insert into public.todos (id, user_id, title, due, remind_at, created_at, updated_at) values
  ('0d000000-0000-4000-8000-0000000000f1', 'ffffffff-0000-4000-8000-000000000006', '待办', current_date + 3, (extract(epoch from now()) * 1000)::bigint + 86400000, 0, 0);
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, remind_at, created_at, updated_at)
  select '0a000000-0000-4000-8000-0000000000f1', 'ffffffff-0000-4000-8000-000000000006', 'birthday', '生日', 'solar', 12, 1,
         (extract(epoch from now()) * 1000)::bigint + 86400000, 0, 0;
-- 不该入队的：已完成的待办 td2、已删除的全天日程 ev3、提醒已过的全天日程 ev4
insert into public.todos (id, user_id, title, due, done, remind_at, created_at, updated_at) values
  ('0d000000-0000-4000-8000-0000000000f2', 'ffffffff-0000-4000-8000-000000000006', '已完成', current_date + 3, true, (extract(epoch from now()) * 1000)::bigint + 86400000, 0, 0);
insert into public.events (id, user_id, title, date, remind_at, deleted_at, created_at, updated_at) values
  ('0e000000-0000-4000-8000-0000000000f3', 'ffffffff-0000-4000-8000-000000000006', '已删除', current_date + 3, (extract(epoch from now()) * 1000)::bigint + 86400000, 1, 0, 0),
  ('0e000000-0000-4000-8000-0000000000f4', 'ffffffff-0000-4000-8000-000000000006', '已过期', current_date - 3, (extract(epoch from now()) * 1000)::bigint - 86400000, null, 0, 0);
delete from private.remind_queue;   -- 插入时触发器入的队，清掉，只看 report_tz 入的

create function tests.tz(p_session text, p_tz text, p_device text, p_platform text) returns text language sql as $$
  select coalesce(tests.rows_as('authenticated', 'ffffffff-0000-4000-8000-000000000006',
    format('select public.report_tz(%L, %L::uuid, %L) as r', p_tz, p_device, p_platform), null, p_session::uuid) -> 0 ->> 'r',
    tests.rows_as('authenticated', 'ffffffff-0000-4000-8000-000000000006',
    format('select public.report_tz(%L, %L::uuid, %L) as r', p_tz, p_device, p_platform), null, p_session::uuid) ->> 'error')
$$;

select is(tests.tz('ffffffff-5555-4000-8000-000000000006', 'Asia/Shanghai', 'de000000-0000-4000-8000-0000000000f1', 'ios'), 'pending', '4.6 防抖：手机第一次报新时区只记下来');
select is((select current_tz from public.profiles where user_id = 'ffffffff-0000-4000-8000-000000000006'), 'Asia/Seoul', '第一次不改 current_tz');
select is(tests.tz('ffffffff-5555-4000-8000-000000000006', 'Asia/Shanghai', 'de000000-0000-4000-8000-0000000000f1', 'ios'), 'accepted', '4.6 防抖：10 分钟内第二次报同一个新时区就采纳');
select is((select current_tz || '|' || current_tz_device || '|' || (current_tz_at is not null) from public.profiles where user_id = 'ffffffff-0000-4000-8000-000000000006'),
  'Asia/Shanghai|de000000-0000-4000-8000-0000000000f1|true', '采纳后写 current_tz、current_tz_device、current_tz_at');
select is((select string_agg(table_name || ':' || id, ',' order by table_name, id) from private.remind_queue),
  'anniversaries:0a000000-0000-4000-8000-0000000000f1,events:0e000000-0000-4000-8000-0000000000f1,todos:0d000000-0000-4000-8000-0000000000f1',
  '4.6：浮动的、提醒还没到的记录（全天日程、待办、纪念日）入 remind_queue；定时日程、已完成、已删除、提醒已过的不入');
select is(tests.tz('ffffffff-6666-4000-8000-000000000006', 'Asia/Tokyo', 'de000000-0000-4000-8000-0000000000f2', 'windows'), 'phone_priority', '4.6 手机优先：24 小时内手机报过，电脑报的不采纳');
select is(tests.tz('ffffffff-6666-4000-8000-000000000006', 'Asia/Tokyo', 'de000000-0000-4000-8000-0000000000f2', 'windows'), 'phone_priority', '电脑再报一次也不采纳');
update private.counters set window_start = now() - interval '25 hours' where key = 'tzphone:ffffffff-0000-4000-8000-000000000006:last';
select is(tests.tz('ffffffff-6666-4000-8000-000000000006', 'Asia/Tokyo', 'de000000-0000-4000-8000-0000000000f2', 'windows'), 'pending', '手机 25 小时没报过：电脑第一次报先记下');
select is(tests.tz('ffffffff-6666-4000-8000-000000000006', 'Asia/Tokyo', 'de000000-0000-4000-8000-0000000000f2', 'windows'), 'accepted', '电脑第二次报同一个时区采纳');
select is((select current_tz from public.profiles where user_id = 'ffffffff-0000-4000-8000-000000000006'), 'Asia/Tokyo', 'current_tz 改成电脑报的 Asia/Tokyo');
select is((select count(*)::int || '|' || count(distinct (table_name, id))::int from private.remind_queue), '3|3', '采纳两次，队列里还是那三条，不重复入队');
select is(tests.tz('ffffffff-5555-4000-8000-000000000006', 'Asia/Tokyo', 'de000000-0000-4000-8000-0000000000f1', 'ios'), 'unchanged', '报和现有值相同的时区：unchanged');
select is(tests.tz('ffffffff-5555-4000-8000-000000000006', 'Europe/London', 'de000000-0000-4000-8000-0000000000f1', 'ios'), 'pending', '手机报 Europe/London，先记下');
update private.counters set window_start = now() - interval '11 minutes' where key = 'tzrep:ffffffff-0000-4000-8000-000000000006:de000000-0000-4000-8000-0000000000f1@Europe/London';
select is(tests.tz('ffffffff-5555-4000-8000-000000000006', 'Europe/London', 'de000000-0000-4000-8000-0000000000f1', 'ios'), 'pending', '4.6 防抖：两次隔了 11 分钟不算连续，重新计');
select is(tests.tz('ffffffff-5555-4000-8000-000000000006', 'America/New_York', 'de000000-0000-4000-8000-0000000000f1', 'ios'), 'pending', '中间换了别的新时区：重新计');
select is(tests.tz('ffffffff-5555-4000-8000-000000000006', 'Europe/London', 'de000000-0000-4000-8000-0000000000f1', 'ios'), 'pending', '再报回 London 也要重新计');
select is((select current_tz from public.profiles where user_id = 'ffffffff-0000-4000-8000-000000000006'), 'Asia/Tokyo', '以上都没改 current_tz');
-- 每人每小时最多采纳 6 次（已采纳 2 次，注入成 6）：第 7 次回 rate_limited，current_tz 不变，那一笔还留着
update private.counters set count = 6 where key like 'tzacc:ffffffff-0000-4000-8000-000000000006:%';
select is(tests.tz('ffffffff-5555-4000-8000-000000000006', 'Europe/London', 'de000000-0000-4000-8000-0000000000f1', 'ios'), 'rate_limited', '这一小时采纳满 6 次：rate_limited');
select is((select current_tz from public.profiles where user_id = 'ffffffff-0000-4000-8000-000000000006')
       || '|' || (select count(*)::int from private.counters where key like 'tzrep:ffffffff-0000-4000-8000-000000000006:%@Europe/London'), 'Asia/Tokyo|1',
  'rate_limited 时不改 current_tz，London 那一笔留着');
delete from private.counters where key like 'tzacc:ffffffff-0000-4000-8000-000000000006:%';
-- 参数和身份
select ok(tests.tz('ffffffff-5555-4000-8000-000000000006', 'Mars/Base', 'de000000-0000-4000-8000-0000000000f1', 'ios') like '22023%bad_tz%', '不存在的时区：bad_tz');
select ok(tests.tz('ffffffff-5555-4000-8000-000000000006', 'Asia/Seoul', 'de000000-0000-4000-8000-0000000000f1', 'android') like '22023%bad_platform%', '不认识的平台：bad_platform');
select ok(tests.tz('ffffffff-5555-4000-8000-000000000006', 'Asia/Seoul', 'de000000-0000-4000-8000-0000000000f1', 'windows') like '22023%platform_mismatch%', '平台和设备行登记的不一致：platform_mismatch（电脑冒充手机也一样）');
select ok(tests.tz('ffffffff-6666-4000-8000-000000000006', 'Asia/Seoul', 'de000000-0000-4000-8000-0000000000f1', 'ios') like '%device_mismatch%', '拿别的会话的设备行上报：device_mismatch');
select ok(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002',
  $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000000f1', 'ios')$$, null, 'bbbbbbbb-5555-4000-8000-000000000002') ->> 'error' like '%device_mismatch%',
  '0.38 第 5 条：B 直接调 private.report_tz_impl、拿 T 的设备：device_mismatch');
select is((select current_tz from public.profiles where user_id = 'ffffffff-0000-4000-8000-000000000006'), 'Asia/Tokyo', 'B 改不到 T 的行');
select is((select current_tz from public.profiles where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'), 'Asia/Seoul', 'B 自己的行也没被改');
select ok(tests.try_as('anon', null, $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000000f1', 'ios')$$) like '42501%', 'anon 直接调 report_tz_impl 被拒');
select ok(tests.try_as('anon', null, $$select public.report_tz('Asia/Seoul', 'de000000-0000-4000-8000-0000000000f1', 'ios')$$) like '42501%', 'anon 调 report_tz 被拒');
select ok(tests.try_as('authenticated', 'cccccccc-0000-4000-8000-000000000003', $$select public.report_tz('Asia/Seoul', 'de000000-0000-4000-8000-0000000000f1', 'ios')$$) like '%account_disabled%',
  '停用账号：report_tz 回 account_disabled');
select ok(tests.try_as('authenticated', 'ffffffff-0000-4000-8000-000000000006', $$select public.report_tz('Asia/Seoul', 'de000000-0000-4000-8000-0000000000f1', 'ios')$$) like '%session_revoked%',
  'JWT 没有 session_id：report_tz 回 session_revoked');
select ok(tests.try_claims('{"sub": "ffffffff-0000-4000-8000-000000000006", "role": "authenticated", "session_id": "ffffffff-5555-4000-8000-000000000006", "amr": [{"method": "password"}]}',
  $$select public.report_tz('Asia/Seoul', 'de000000-0000-4000-8000-0000000000f1', 'ios')$$) like '%session_revoked%', '密码会话：report_tz 回 session_revoked（依赖 S1 的 not_password_session）');
-- tz_mode = fixed
update public.profiles set tz_mode = 'fixed', current_tz = 'Asia/Seoul' where user_id = 'ffffffff-0000-4000-8000-000000000006';
select is(tests.tz('ffffffff-5555-4000-8000-000000000006', 'Asia/Shanghai', 'de000000-0000-4000-8000-0000000000f1', 'ios')
       || tests.tz('ffffffff-5555-4000-8000-000000000006', 'Asia/Shanghai', 'de000000-0000-4000-8000-0000000000f1', 'ios'), 'fixedfixed', '4.6：tz_mode = fixed 不接受上报');
select is((select current_tz from public.profiles where user_id = 'ffffffff-0000-4000-8000-000000000006'), 'Asia/Seoul', 'fixed 时 current_tz 保持 Asia/Seoul');
-- 删 pending 键的前缀范围不误删（K1 复审）：本设备 f1 的两笔（含非 ASCII 时区名）删掉；另一台设备 f2 的、前缀相近的 f1X@、f1?、别人的同设备号键都留着
insert into private.counters (key, window_start, count) values
  ('tzrep:ffffffff-0000-4000-8000-000000000006:de000000-0000-4000-8000-0000000000f1@Asia/Tokyo', now(), 1),
  ('tzrep:ffffffff-0000-4000-8000-000000000006:de000000-0000-4000-8000-0000000000f1@東京', now(), 1),
  ('tzrep:ffffffff-0000-4000-8000-000000000006:de000000-0000-4000-8000-0000000000f2@Asia/Tokyo', now(), 1),
  ('tzrep:ffffffff-0000-4000-8000-000000000006:de000000-0000-4000-8000-0000000000f1X@Asia/Tokyo', now(), 1),
  ('tzrep:ffffffff-0000-4000-8000-000000000006:de000000-0000-4000-8000-0000000000f1?x', now(), 1),
  ('tzrep:aaaaaaaa-0000-4000-8000-000000000001:de000000-0000-4000-8000-0000000000f1@Asia/Tokyo', now(), 1);
select is(tests.tz('ffffffff-5555-4000-8000-000000000006', 'Asia/Shanghai', 'de000000-0000-4000-8000-0000000000f1', 'ios'), 'fixed', '不误删：上报一次（fixed 分支会删这台设备的 pending 键）');
select is((select string_agg(substr(key, 7, 1) || ':' || right(key, length(key) - 43), ',' order by key collate "C") from private.counters
            where key like 'tzrep:%' and key like '%0000000000f_%'),
  'a:de000000-0000-4000-8000-0000000000f1@Asia/Tokyo,f:de000000-0000-4000-8000-0000000000f1?x,f:de000000-0000-4000-8000-0000000000f1X@Asia/Tokyo,f:de000000-0000-4000-8000-0000000000f2@Asia/Tokyo',   -- a: 是别人（aaaaaaaa…）的键，f: 是 T 的
  '不误删：只删本人这台设备的 tzrep 键；另一台设备、前缀相近的（f1X@、f1?）、别人的同设备号键都还在');

-- ================= 六、record_consent（TC-B1-13；3.3 通用规则） =================
update public.app_config set notice = '{"policy_ver": "2026-10"}' where id = 1;
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select public.record_consent('2026-10', false)$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'), 'ok', 'A 同意');
select is((select (consent_ai_at is not null)::text || '|' || consent_policy_ver from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 'true|2026-10', '同意后 consent_ai_at、consent_policy_ver 写上');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select public.record_consent('2026-10', true)$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'), 'ok', 'TC-B1-13：A 撤回');
select is((select (consent_ai_at is null)::text || '|' || consent_policy_ver from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001')
       || '|' || (select value::text from public.settings where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and key = 'ai.enabled'),
  'true|2026-10|false', 'TC-B1-13：撤回后 consent_ai_at 为空、版本照记、ai.enabled = false');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select public.record_consent('2026-09', false)$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '%policy_ver_mismatch%',
  'TC-B1-13：版本不对报 policy_ver_mismatch');
select is(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$select public.record_consent('2026-10', false)$$, null, 'bbbbbbbb-5555-4000-8000-000000000002'), 'ok', 'B 同意');
select is((select consent_ai_at is null from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), true, 'TC-B1-13：B 同意只写 B 自己，A 的仍是撤回状态');
select ok(tests.try_as('authenticated', 'cccccccc-0000-4000-8000-000000000003', $$select public.record_consent('2026-10', true)$$) like '%account_disabled%',
  '停用账号：record_consent 回 account_disabled（B1 补的 account_usable）');
select is((select count(*)::int from public.settings where user_id = 'cccccccc-0000-4000-8000-000000000003'), 0, '停用账号撤回时一条设置都没写');
select ok(tests.try_claims('{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated", "session_id": "aaaaaaaa-5555-4000-8000-000000000001", "amr": [{"method": "password"}]}',
  $$select public.record_consent('2026-10', false)$$) like '%session_revoked%', '密码会话：record_consent 回 session_revoked');
-- 0.38 第 9 条：直接调 record_consent_impl 也只能动本人的数据（B 撤回，A 不变）
select is(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$select private.record_consent_impl('2026-10', true)$$, null, 'bbbbbbbb-5555-4000-8000-000000000002'), 'ok',
  'B 直接调 record_consent_impl 撤回');
select is((select (consent_ai_at is null)::text from public.profiles where user_id = 'bbbbbbbb-0000-4000-8000-000000000002')
       || '|' || (select count(*)::int from public.settings where key = 'ai.enabled' and user_id = 'bbbbbbbb-0000-4000-8000-000000000002')
       || '|' || (select consent_policy_ver from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001')
       || '|' || (select count(*)::int from public.settings where key = 'ai.enabled' and user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'true|1|2026-10|1', '直接调只改了 B 自己的 profile 和设置，A 的不变');
-- K1 安全审查必改 2：被移除的 X 在 10 分钟残留窗口里（JWT 还没过期）调 record_consent、my_sessions 都回 session_revoked
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select public.record_consent('2026-10', true)$$, null, 'aaaaaaaa-7777-4000-8000-000000000001') like '%session_revoked%',
  '被移除的 X 在窗口里撤回同意：session_revoked（不会删掉 A 的向量）');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select * from public.my_sessions()$$, null, 'aaaaaaaa-7777-4000-8000-000000000001') like '%session_revoked%',
  '被移除的 X 在窗口里查 my_sessions：session_revoked');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select public.record_consent('2026-10', false)$$) like '%session_revoked%',
  'JWT 没有 session_id：record_consent 回 session_revoked');
-- 0.38 第 9 条：用密码会话直接调各个 impl，一律 session_revoked
select ok(tests.try_claims('{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated", "session_id": "aaaaaaaa-5555-4000-8000-000000000001", "amr": [{"method": "password"}]}', $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000000a1', 'windows')$$) like '%session_revoked%', '密码会话直接调 report_tz_impl：session_revoked');
select ok(tests.try_claims('{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated", "session_id": "aaaaaaaa-5555-4000-8000-000000000001", "amr": [{"method": "password"}]}', $$select private.remove_device_impl('de000000-0000-4000-8000-0000000000a1')$$) like '%session_revoked%', '密码会话直接调 remove_device_impl：session_revoked');
select ok(tests.try_claims('{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated", "session_id": "aaaaaaaa-5555-4000-8000-000000000001", "amr": [{"method": "password"}]}', $$select * from private.my_sessions_impl()$$) like '%session_revoked%', '密码会话直接调 my_sessions_impl：session_revoked');
select ok(tests.try_claims('{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated", "session_id": "aaaaaaaa-5555-4000-8000-000000000001", "amr": [{"method": "password"}]}', $$select private.record_consent_impl('2026-10', true)$$) like '%session_revoked%', '密码会话直接调 record_consent_impl：session_revoked');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-0000000000a1'), 1, '密码会话什么都没删');

-- ================= 七、每日清理的设备三项（TC-B1-79 ⑤、TC-B1-89 ②） =================
-- K：k1 会话已不在、k2 正常、k3 session_id 为空、k4 181 天没用（会话还在）、k6 179 天；
--   k5 last_seen 为空、created_at 181 天前，但推送一直在写 push_fail_count（synced_at 是刚刚的，0.38 第 8 条）；
--   k7 created_at 181 天前、last_seen 是今天（不清）；k8 last_seen 为空、created_at 是今天（不清）；
--   k9 last_seen 200 天前、created_at 181 天前，但会话刚刷新过（不清，0.38 变更表第 14 条）；
--   k10 last_seen 写成未来 2 天、created_at 181 天前、没有会话（未来时间不认，删）；
--   revoked_sessions：R1 会话已不在、R2 会话还在（模拟第三条路）
insert into auth.users (id, email) values ('0a0a0a0a-0000-4000-8000-000000000007', 'k@test.local');
insert into public.profiles (user_id) values ('0a0a0a0a-0000-4000-8000-000000000007');
insert into auth.sessions (id, user_id) values
  ('0a0a0a0a-2222-4000-8000-000000000007', '0a0a0a0a-0000-4000-8000-000000000007'),
  ('0a0a0a0a-4444-4000-8000-000000000007', '0a0a0a0a-0000-4000-8000-000000000007'),
  ('0a0a0a0a-5555-4000-8000-000000000007', '0a0a0a0a-0000-4000-8000-000000000007'),
  ('0a0a0a0a-6666-4000-8000-000000000007', '0a0a0a0a-0000-4000-8000-000000000007'),
  ('0a0a0a0a-7777-4000-8000-000000000007', '0a0a0a0a-0000-4000-8000-000000000007');
insert into public.devices (id, user_id, platform, session_id, last_seen_at) values
  ('de000000-0000-4000-8000-0000000000c1', '0a0a0a0a-0000-4000-8000-000000000007', 'ios', '0a0a0a0a-1111-4000-8000-000000000007', now()),
  ('de000000-0000-4000-8000-0000000000c2', '0a0a0a0a-0000-4000-8000-000000000007', 'ios', '0a0a0a0a-2222-4000-8000-000000000007', now()),
  ('de000000-0000-4000-8000-0000000000c3', '0a0a0a0a-0000-4000-8000-000000000007', 'web', null, now()),
  ('de000000-0000-4000-8000-0000000000c4', '0a0a0a0a-0000-4000-8000-000000000007', 'ios', '0a0a0a0a-4444-4000-8000-000000000007', now() - interval '181 days'),
  ('de000000-0000-4000-8000-0000000000c5', '0a0a0a0a-0000-4000-8000-000000000007', 'web', '0a0a0a0a-5555-4000-8000-000000000007', null),
  ('de000000-0000-4000-8000-0000000000c6', '0a0a0a0a-0000-4000-8000-000000000007', 'ios', '0a0a0a0a-6666-4000-8000-000000000007', now() - interval '179 days'),
  ('de000000-0000-4000-8000-0000000000c7', '0a0a0a0a-0000-4000-8000-000000000007', 'ios', '0a0a0a0a-9999-4000-8000-000000000007', now()),
  ('de000000-0000-4000-8000-0000000000c8', '0a0a0a0a-0000-4000-8000-000000000007', 'web', '0a0a0a0a-aaaa-4000-8000-000000000007', null),
  ('de000000-0000-4000-8000-0000000000c9', '0a0a0a0a-0000-4000-8000-000000000007', 'ios', '0a0a0a0a-bbbb-4000-8000-000000000007', now() - interval '200 days'),
  ('de000000-0000-4000-8000-0000000000ca', '0a0a0a0a-0000-4000-8000-000000000007', 'web', null, now() + interval '2 days');
insert into auth.sessions (id, user_id) values
  ('0a0a0a0a-9999-4000-8000-000000000007', '0a0a0a0a-0000-4000-8000-000000000007'),
  ('0a0a0a0a-aaaa-4000-8000-000000000007', '0a0a0a0a-0000-4000-8000-000000000007');
insert into auth.sessions (id, user_id, created_at, refreshed_at) values   -- c9 的会话：200 天前建的，刚刚刷新过（refreshed_at 是不带时区的 UTC 时刻）
  ('0a0a0a0a-bbbb-4000-8000-000000000007', '0a0a0a0a-0000-4000-8000-000000000007', now() - interval '200 days', now() at time zone 'UTC');
update public.devices set created_at = now() - interval '181 days'
 where id in ('de000000-0000-4000-8000-0000000000c4', 'de000000-0000-4000-8000-0000000000c5', 'de000000-0000-4000-8000-0000000000c7',
              'de000000-0000-4000-8000-0000000000c9', 'de000000-0000-4000-8000-0000000000ca');
-- 推送（service role）写 c5 的 push_fail_count：touch() 把 synced_at 刷成现在
select is(tests.try_as('service_role', null, $$update public.devices set push_fail_count = push_fail_count + 1 where id = 'de000000-0000-4000-8000-0000000000c5'$$), 'ok', 'service role 写 c5 的推送失败计数');
select is((select (synced_at > now() - interval '1 minute')::text || '|' || (created_at < now() - interval '180 days')::text || '|' || (last_seen_at is null)::text
             from public.devices where id = 'de000000-0000-4000-8000-0000000000c5'), 'true|true|true',
  '0.38 第 8 条：c5 的 synced_at 是刚刚的，created_at 超过 180 天，last_seen_at 为空');
insert into private.revoked_sessions (session_id, user_id) values
  ('0a0a0a0a-8888-4000-8000-000000000007', '0a0a0a0a-0000-4000-8000-000000000007'),
  ('0a0a0a0a-7777-4000-8000-000000000007', '0a0a0a0a-0000-4000-8000-000000000007');
select ok(private.cleanup_batch() >= 5, '跑一批每日清理');
select is((select string_agg(right(id::text, 2), ',' order by id) from public.devices where user_id = '0a0a0a0a-0000-4000-8000-000000000007'), 'c2,c3,c6,c7,c8,c9',
  'TC-B1-79 ⑤、89 ②：删会话已不在的 c1、181 天没用的 c4，synced_at 一直在刷新但 created_at 超过 180 天的 c5、last_seen 写成未来的 c10；c2、c3、c6、c7、c8 和会话刚刷新过的 c9 不动');
select is((select string_agg(substr(id::text, 10, 4), ',' order by id) from auth.sessions where user_id = '0a0a0a0a-0000-4000-8000-000000000007'),
  '2222,6666,7777,9999,aaaa,bbbb', 'TC-B1-89 ②：c4、c5 的会话先吊销（auth.sessions 删掉），剩 c2、c6、c7、c8、c9 和 R2 的');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-0000000000c9'), 1,
  '0.38 变更表第 14 条：last_seen_at 写成很久以前、会话刚刷新过（refreshed_at）的 c9 不删');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-0000000000ca'), 0,
  '0.38 变更表第 14 条：last_seen_at 写成未来 2 天（不认）、created_at 181 天前、没有会话的 c10 删掉');
select is((select count(*)::int from auth.sessions where id in ('0a0a0a0a-4444-4000-8000-000000000007', '0a0a0a0a-5555-4000-8000-000000000007')), 0, 'TC-B1-89 ③：c4、c5 的会话不在了（刷新会失败）');
select is((select string_agg(session_id::text, ',') from private.revoked_sessions where user_id = '0a0a0a0a-0000-4000-8000-000000000007'),
  '0a0a0a0a-7777-4000-8000-000000000007', 'TC-B1-79 ⑤：revoked_sessions 里会话已不在的删掉，会话还在的 R2 留下');
select is((select count(*)::int from public.tombstones where id in ('de000000-0000-4000-8000-0000000000c1', 'de000000-0000-4000-8000-0000000000c4', 'de000000-0000-4000-8000-0000000000c5', 'de000000-0000-4000-8000-0000000000ca')), 4,
  '清理删掉的设备行都留了墓碑');

select is((select system_cols from private.table_meta where tbl = 'devices'), '{last_push_ok_at,push_fail_count,created_at}'::text[], '0.38 第 8 条：table_meta 的 devices.system_cols 带上 created_at');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.devices (id, platform, created_at) values (gen_random_uuid(), 'web', now() - interval '1 year')$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%',
  '客户端写不了 devices.created_at（系统列，不授 insert）');
-- ================= 八、tz_mode 切到 fixed 改回首尔（4.6；0.38 第 18 条，K-tz-fixed） =================
-- U：当前时区 Asia/Tokyo（某台设备上报的）；浮动记录 u1 全天日程、u2 待办、u3 纪念日；不该入队的 u4 定时日程、u5 已完成待办、u6 已删除全天日程、u7 提醒已过的全天日程
insert into auth.users (id, email) values ('abcdabcd-0000-4000-8000-000000000008', 'u@test.local');
insert into public.profiles (user_id, current_tz, current_tz_device, current_tz_at) values
  ('abcdabcd-0000-4000-8000-000000000008', 'Asia/Tokyo', 'de000000-0000-4000-8000-0000000000aa', now() - interval '3 days');
insert into auth.sessions (id, user_id) values ('abcdabcd-5555-4000-8000-000000000008', 'abcdabcd-0000-4000-8000-000000000008');
insert into public.events (id, user_id, title, date, time, tz, remind_at, deleted_at, created_at, updated_at) values
  ('0e000000-0000-4000-8000-0000000000a1', 'abcdabcd-0000-4000-8000-000000000008', '全天', current_date + 3, null, null, (extract(epoch from now()) * 1000)::bigint + 86400000, null, 0, 0),
  ('0e000000-0000-4000-8000-0000000000a4', 'abcdabcd-0000-4000-8000-000000000008', '定时', current_date + 3, '15:00', 'Asia/Tokyo', (extract(epoch from now()) * 1000)::bigint + 86400000, null, 0, 0),
  ('0e000000-0000-4000-8000-0000000000a6', 'abcdabcd-0000-4000-8000-000000000008', '已删除', current_date + 3, null, null, (extract(epoch from now()) * 1000)::bigint + 86400000, 1, 0, 0),
  ('0e000000-0000-4000-8000-0000000000a7', 'abcdabcd-0000-4000-8000-000000000008', '已过期', current_date - 3, null, null, (extract(epoch from now()) * 1000)::bigint - 86400000, null, 0, 0);
insert into public.todos (id, user_id, title, due, done, remind_at, created_at, updated_at) values
  ('0d000000-0000-4000-8000-0000000000a2', 'abcdabcd-0000-4000-8000-000000000008', '待办', current_date + 3, false, (extract(epoch from now()) * 1000)::bigint + 86400000, 0, 0),
  ('0d000000-0000-4000-8000-0000000000a5', 'abcdabcd-0000-4000-8000-000000000008', '已完成', current_date + 3, true, (extract(epoch from now()) * 1000)::bigint + 86400000, 0, 0);
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, remind_at, created_at, updated_at) values
  ('0a000000-0000-4000-8000-0000000000a3', 'abcdabcd-0000-4000-8000-000000000008', 'birthday', '生日', 'solar', 12, 1, (extract(epoch from now()) * 1000)::bigint + 86400000, 0, 0);
delete from private.remind_queue;   -- 插入时触发器入的队和前面各段留下的，清掉，只看切换时入的

-- ① 客户端只改 tz_mode（列级授权只给 display_name、ui_locale、tz_mode）就能触发
select is(tests.try_as('authenticated', 'abcdabcd-0000-4000-8000-000000000008', $$update public.profiles set tz_mode = 'fixed' where user_id = 'abcdabcd-0000-4000-8000-000000000008'$$, null, 'abcdabcd-5555-4000-8000-000000000008'), 'ok',
  'K-tz-fixed：客户端只改 tz_mode = fixed 成功');
select is((select tz_mode || '|' || current_tz || '|' || (current_tz_device is null)::text || '|' || (current_tz_at = now())::text from public.profiles where user_id = 'abcdabcd-0000-4000-8000-000000000008'),
  'fixed|Asia/Seoul|true|true', 'K-tz-fixed：切到 fixed 后 current_tz 改回 Asia/Seoul、current_tz_device 置空、current_tz_at = now()');
select is((select string_agg(table_name || ':' || right(id::text, 2), ',' order by table_name, id) from private.remind_queue),
  'anniversaries:a3,events:a1,todos:a2', 'K-tz-fixed：时区变了（东京 → 首尔），浮动提醒入队；定时日程、已完成、已删除、提醒已过的不入');
-- ② 切回 device：不动 current_tz、不入队
delete from private.remind_queue;
update public.profiles set current_tz = 'Asia/Tokyo', current_tz_at = now() - interval '1 day' where user_id = 'abcdabcd-0000-4000-8000-000000000008';   -- postgres 直改（不改 tz_mode，不触发）
select is((select current_tz from public.profiles where user_id = 'abcdabcd-0000-4000-8000-000000000008'), 'Asia/Tokyo', '只改 current_tz、不改 tz_mode 时触发器不动它');
select is(tests.try_as('authenticated', 'abcdabcd-0000-4000-8000-000000000008', $$update public.profiles set tz_mode = 'device' where user_id = 'abcdabcd-0000-4000-8000-000000000008'$$, null, 'abcdabcd-5555-4000-8000-000000000008'), 'ok', '客户端切回 device 成功');
select is((select tz_mode || '|' || current_tz || '|' || (current_tz_at < now())::text from public.profiles where user_id = 'abcdabcd-0000-4000-8000-000000000008'),
  'device|Asia/Tokyo|true', 'K-tz-fixed：切回 device 不改 current_tz、current_tz_at');
select is((select count(*)::int from private.remind_queue), 0, '切回 device 不入队');
-- ③ 时区本来就是首尔：切到 fixed 照样置空设备、写时刻，但不入队
update public.profiles set current_tz = 'Asia/Seoul', current_tz_device = 'de000000-0000-4000-8000-0000000000aa', current_tz_at = now() - interval '1 day' where user_id = 'abcdabcd-0000-4000-8000-000000000008';
select is(tests.try_as('authenticated', 'abcdabcd-0000-4000-8000-000000000008', $$update public.profiles set tz_mode = 'fixed' where user_id = 'abcdabcd-0000-4000-8000-000000000008'$$, null, 'abcdabcd-5555-4000-8000-000000000008'), 'ok', '再切到 fixed');
select is((select current_tz || '|' || (current_tz_device is null)::text || '|' || (current_tz_at = now())::text from public.profiles where user_id = 'abcdabcd-0000-4000-8000-000000000008'),
  'Asia/Seoul|true|true', '时区没变：仍置空 current_tz_device、current_tz_at = now()');
select is((select count(*)::int from private.remind_queue), 0, 'K-tz-fixed：时区没变时不入队');
-- ④ 已经是 fixed 再写一次 fixed、或只改别的列：触发器不动
update public.profiles set current_tz_at = now() - interval '2 days' where user_id = 'abcdabcd-0000-4000-8000-000000000008';
select is(tests.try_as('authenticated', 'abcdabcd-0000-4000-8000-000000000008', $$update public.profiles set tz_mode = 'fixed', display_name = 'U' where user_id = 'abcdabcd-0000-4000-8000-000000000008'$$, null, 'abcdabcd-5555-4000-8000-000000000008'), 'ok', 'fixed 时再写 fixed、顺带改昵称');
select is((select (current_tz_at < now() - interval '1 day')::text || '|' || display_name from public.profiles where user_id = 'abcdabcd-0000-4000-8000-000000000008'), 'true|U',
  'tz_mode 没变：触发器不改 current_tz_at');
-- ④b 停用账号切到 fixed：照样改回首尔，但不入队（K1 复审）
update public.profiles set tz_mode = 'device', current_tz = 'Asia/Tokyo', disabled_at = now(), disabled_reason = 'admin' where user_id = 'abcdabcd-0000-4000-8000-000000000008';
delete from private.remind_queue;
update public.profiles set tz_mode = 'fixed' where user_id = 'abcdabcd-0000-4000-8000-000000000008';
select is((select current_tz || '|' || (current_tz_device is null)::text from public.profiles where user_id = 'abcdabcd-0000-4000-8000-000000000008'), 'Asia/Seoul|true', '停用账号切到 fixed：current_tz 照样改回首尔');
select is((select count(*)::int from private.remind_queue), 0, 'K-tz-fixed：停用账号切到 fixed 不入队');
update public.profiles set disabled_at = null, disabled_reason = null where user_id = 'abcdabcd-0000-4000-8000-000000000008';
-- ⑤ 两个新函数都不授执行权
select ok(not has_function_privilege('authenticated', 'private.enqueue_floating(uuid)', 'EXECUTE')
      and not has_function_privilege('anon', 'private.enqueue_floating(uuid)', 'EXECUTE')
      and not has_function_privilege('service_role', 'private.enqueue_floating(uuid)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.tz_fixed_reset()', 'EXECUTE')
      and not has_function_privilege('service_role', 'private.tz_fixed_reset()', 'EXECUTE'), 'enqueue_floating、tz_fixed_reset 不授任何角色执行权');
select ok(tests.try_as('authenticated', 'abcdabcd-0000-4000-8000-000000000008', $$select private.enqueue_floating('abcdabcd-0000-4000-8000-000000000008')$$, null, 'abcdabcd-5555-4000-8000-000000000008') like '42501%', 'authenticated 直接调 enqueue_floating 被拒（42501）');

-- ================= 九、my_sessions 的 signed_out_device_ids（架构 4.1、0.38 第 38 条，K-dev-signedout；迁移 20261029193000） =================
-- G：当前会话 G0 绑设备 g0；会话 G1 在线绑 g1；会话 G2 绑 g2 后被删（已退出）；g3 的 session_id 为空；会话 G4 绑 g4、在 revoked_sessions 里（吊销残留窗口）
--   另有 B 的设备 gb，绑的会话也不在了（别人的已退出设备不该出现）
insert into auth.users (id, email) values ('abcdef00-0000-4000-8000-000000000009', 'g@test.local');
insert into public.profiles (user_id) values ('abcdef00-0000-4000-8000-000000000009');
insert into auth.sessions (id, user_id, created_at) values
  ('abcdef00-0000-4000-8000-000000000009', 'abcdef00-0000-4000-8000-000000000009', now() - interval '1 day'),
  ('abcdef00-1111-4000-8000-000000000009', 'abcdef00-0000-4000-8000-000000000009', now() - interval '1 day'),
  ('abcdef00-2222-4000-8000-000000000009', 'abcdef00-0000-4000-8000-000000000009', now() - interval '1 day'),
  ('abcdef00-4444-4000-8000-000000000009', 'abcdef00-0000-4000-8000-000000000009', now() - interval '1 day');
insert into private.revoked_sessions (session_id, user_id) values ('abcdef00-4444-4000-8000-000000000009', 'abcdef00-0000-4000-8000-000000000009');
insert into public.devices (id, user_id, platform, session_id) values
  ('de000000-0000-4000-8000-0000000009a0', 'abcdef00-0000-4000-8000-000000000009', 'ios', 'abcdef00-0000-4000-8000-000000000009'),
  ('de000000-0000-4000-8000-0000000009a1', 'abcdef00-0000-4000-8000-000000000009', 'web', 'abcdef00-1111-4000-8000-000000000009'),
  ('de000000-0000-4000-8000-0000000009a2', 'abcdef00-0000-4000-8000-000000000009', 'windows', 'abcdef00-2222-4000-8000-000000000009'),
  ('de000000-0000-4000-8000-0000000009a3', 'abcdef00-0000-4000-8000-000000000009', 'web', null),
  ('de000000-0000-4000-8000-0000000009a4', 'abcdef00-0000-4000-8000-000000000009', 'tauri', 'abcdef00-4444-4000-8000-000000000009'),
  ('de000000-0000-4000-8000-0000000009b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'web', 'bbbbbbbb-7777-4000-8000-000000000009');
select is(tests.rows_as('authenticated', 'abcdef00-0000-4000-8000-000000000009', $$select signed_out_device_ids from public.my_sessions()$$, null, 'abcdef00-0000-4000-8000-000000000009'),
  '[{"signed_out_device_ids": ["de000000-0000-4000-8000-0000000009a3", "de000000-0000-4000-8000-0000000009a4"]}]'::jsonb,
  'K-dev-signedout：会话都在时只列 session_id 为空的 g3（4.1 算已退出）和已吊销的 g4；当前这台 g0、在线的 g1 不出现');
-- g5、g6：软删除的设备行（一台会话已不在、一台 session_id 为空），都不该列出
insert into public.devices (id, user_id, platform, session_id, deleted_at) values
  ('de000000-0000-4000-8000-0000000009a5', 'abcdef00-0000-4000-8000-000000000009', 'web', 'abcdef00-5555-4000-8000-000000000009', 1),
  ('de000000-0000-4000-8000-0000000009a6', 'abcdef00-0000-4000-8000-000000000009', 'web', null, 1);
delete from auth.sessions where id = 'abcdef00-2222-4000-8000-000000000009';   -- G2 那台退出登录：GoTrue 删会话，devices 行还在
select is(tests.rows_as('authenticated', 'abcdef00-0000-4000-8000-000000000009', $$select signed_out_device_ids from public.my_sessions()$$, null, 'abcdef00-0000-4000-8000-000000000009'),
  '[{"signed_out_device_ids": ["de000000-0000-4000-8000-0000000009a2", "de000000-0000-4000-8000-0000000009a3", "de000000-0000-4000-8000-0000000009a4"]}]'::jsonb,
  'K-dev-signedout：会话被删以后，那台设备 g2 出现在列表里（按 id 排序）');
select ok(not (tests.rows_as('authenticated', 'abcdef00-0000-4000-8000-000000000009', $$select signed_out_device_ids from public.my_sessions()$$, null, 'abcdef00-0000-4000-8000-000000000009')::text
               ~ '0000000009a[56]'),
  'K-dev-signedout：软删除的设备行（会话已不在的 g5、session_id 为空的 g6）不出现');
select ok(not (tests.rows_as('authenticated', 'abcdef00-0000-4000-8000-000000000009', $$select signed_out_device_ids from public.my_sessions()$$, null, 'abcdef00-0000-4000-8000-000000000009')::text
               like '%de000000-0000-4000-8000-0000000009b1%'),
  'K-dev-signedout：别人（B）的已退出设备不会出现');
select ok(not (tests.rows_as('authenticated', 'abcdef00-0000-4000-8000-000000000009', $$select * from public.my_sessions()$$, null, 'abcdef00-0000-4000-8000-000000000009')::text ~ 'abcdef00-[0-9]{4}-'),
  'K-dev-signedout：返回里不含任何会话 id，只有设备 id');
select is(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$select signed_out_device_ids from public.my_sessions()$$, null, 'bbbbbbbb-5555-4000-8000-000000000002') -> 0 -> 'signed_out_device_ids' @> '["de000000-0000-4000-8000-0000000009b1"]'::jsonb,
  true, 'B 自己调时看得到自己的 gb（只按本人过滤，不是漏算）');
select is(tests.rows_as('authenticated', 'abcdef00-0000-4000-8000-000000000009', $$select * from private.my_sessions_impl()$$, null, 'abcdef00-0000-4000-8000-000000000009'),
  tests.rows_as('authenticated', 'abcdef00-0000-4000-8000-000000000009', $$select * from public.my_sessions()$$, null, 'abcdef00-0000-4000-8000-000000000009'),
  '0.38 第 5 条：G 直接调 my_sessions_impl 和经包装的结果一样（含新列）');
select is(tests.rows_as('authenticated', 'abcdef00-0000-4000-8000-000000000009', $$select orphan_count from public.my_sessions()$$, null, 'abcdef00-0000-4000-8000-000000000009'),
  '[{"orphan_count": 0}]'::jsonb, 'orphan_count 不受新列影响：G 的会话都有设备行，计数仍为 0');
-- 终审建议 5：会话 G7 只绑着一条软删除的设备行 g7，这个会话算 orphan（not exists 子查询加了 d.deleted_at is null，和 signed_out 同一口径）
insert into auth.sessions (id, user_id, created_at) values
  ('abcdef00-7777-4000-8000-000000000009', 'abcdef00-0000-4000-8000-000000000009', now() - interval '1 day');
insert into public.devices (id, user_id, platform, session_id, deleted_at) values
  ('de000000-0000-4000-8000-0000000009a7', 'abcdef00-0000-4000-8000-000000000009', 'web', 'abcdef00-7777-4000-8000-000000000009', 1);
select is(tests.rows_as('authenticated', 'abcdef00-0000-4000-8000-000000000009', $$select orphan_count, signed_out_device_ids from public.my_sessions()$$, null, 'abcdef00-0000-4000-8000-000000000009'),
  '[{"orphan_count": 1, "signed_out_device_ids": ["de000000-0000-4000-8000-0000000009a2", "de000000-0000-4000-8000-0000000009a3", "de000000-0000-4000-8000-0000000009a4"]}]'::jsonb,
  '会话只绑着软删除的设备行 g7：算 orphan（计数 1），g7 也不出现在已退出列表里');
select ok(tests.try_as('authenticated', 'abcdef00-0000-4000-8000-000000000009', $$select * from public.my_sessions()$$, null, 'abcdef00-4444-4000-8000-000000000009') like '%session_revoked%',
  '已吊销的 g4 那台自己来查：session_revoked（开头自查照旧）');
select is((select pg_get_function_result('public.my_sessions()'::regprocedure)),
  'TABLE(orphan_count integer, orphan_last_at timestamp with time zone, signed_out_device_ids uuid[])', 'public.my_sessions() 新的返回形状');

select * from finish();
rollback;
