-- B2 迁移 20261103100000_core_devices_push_constraints.sql、20261103110000_core_claim_endpoint.sql
-- 用例：TC-B2-79（claim_endpoint 授权，P0）、TC-B2-80（推送端点白名单，SQL 一侧）、TC-B1-22、81（换账号后推送不会发错人，数据库一半）、
--   0.29 续第 99 条④、第 105 条（endpoint_in_use 带 holder）、3.3 D（返回值、错误码 22023）
-- 白名单向量：fixture（tests/fixtures/push-endpoints.json）逐条的断言在 29_push_endpoint_vectors.test.sql（生成的）；这里留最小一组和 fixture 之外的五条
begin;
select plan(59);
\ir _helpers.psql
select tests.seed();

-- ================= 一、push_endpoint_ok 向量（TC-B2-80） =================
create function tests.ep_ok(p text) returns boolean language sql as $$ select private.push_endpoint_ok(p) $$;
select is(
  (select string_agg(case when tests.ep_ok(v) then 'Y' else 'N' end, '' order by i) from unnest(array[
    'https://web.push.apple.com/QGdVhZy7c2o',
    'https://api.push.apple.com/QGdVhZy7c2o',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA%2b',
    'https://fcm.googleapis.com/fcm/send/dXk1:APA91b',
    'https://fcm.googleapis.com/wp/dXk1',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
    'https://' || repeat('a', 63) || '.push.apple.com/x',
    'https://fcm.googleapis.com/a%3Ab'
  ]) with ordinality as t(v, i)),
  'YYYYYYYY', 'TC-B2-80：合格组八条（四家、另一个一级子域、带查询串、标签 63 字符、路径里的 % 和 :）都认');
select is(
  (select string_agg(case when tests.ep_ok(v) then 'Y' else 'N' end, '' order by i) from unnest(array[
    'http://fcm.googleapis.com/fcm/send/x',
    'HTTPS://fcm.googleapis.com/fcm/send/x',
    'https:fcm.googleapis.com/fcm/send/x',
    'https:///fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com:443/fcm/send/x',
    'https://fcm.googleapis.com:/x',
    'https://user:pw@fcm.googleapis.com/fcm/send/x',
    'https://@fcm.googleapis.com/x',
    'https://fcm.googleapis.com@evil.example/x',
    'https://evil.com#.web.push.apple.com/x',
    'https://evil.com?.web.push.apple.com/x',
    'https://evil.com\.web.push.apple.com/x',
    'https://142.250.1.1/fcm/send/x',
    'https://[::1]/x',
    'https://evil.example/x',
    'https://a.web.push.apple.com/x',
    'https://push.apple.com/x',
    'https://web..push.apple.com/x',
    'https://-web.push.apple.com/x',
    'https://web-.push.apple.com/x',
    'https://' || repeat('a', 64) || '.push.apple.com/x',
    'https://xn--zz.push.apple.com/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com/x',
    'https://WEB.push.apple.com/x',
    'https://web.push.apple.com./x',
    'https://web%2epush%2eapple%2ecom/x',
    'https://fcm.googleapis.com',
    'https://fcm.googleapis.com?x=1',
    'https://fcm.googleapis.com/x#frag',
    'https://fcm.googleapis.com/x y',
    'https://fcm.googleapis.com/a\b',
    ' https://fcm.googleapis.com/x',
    'https://fcm.googleapis.com/x' || chr(10),
    'https://fcm' || chr(65294) || 'googleapis' || chr(65294) || 'com/x',
    'https://localhost/x',
    'https://fcm.googleapis.com/' || repeat('a', 2022),
    '',
    'https://fcm.googleapis.com/a/../x',
    'https://fcm.googleapis.com/a/%2e%2e/x',
    'https://fcm.googleapis.com/a{b}',
    'https://fcm.googleapis.com/a"b',
    'https://fcm.googleapis.com/?a''b'
  ]) with ordinality as t(v, i)),
  repeat('N', 43), 'TC-B2-80：不合格的 43 条（安全审查第六节的各类：协议、主机混淆、标签、xn--、大写、末尾点、编码、端口、IP、空白、全角点、长度；另加 WHATWG 会改写的 .. 段、%2e%2e 段、花括号、双引号、单引号五条，和 TS 一侧一致）都拒');
select is(tests.ep_ok('https://fcm.googleapis.com/' || repeat('a', 2021)), true, '正好 2048 字符认');
select is(tests.ep_ok(null), false, 'null 不认');
select is(tests.ep_ok(repeat('a', 100000)), false, '10 万字符的串拒（不超时）');
select ok((select p.provolatile = 'i' and not p.prosecdef from pg_proc p where p.oid = 'private.push_endpoint_ok(text)'::regprocedure),
  'push_endpoint_ok 是 immutable、security invoker');
select ok(not has_function_privilege('authenticated', 'private.push_endpoint_ok(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.push_endpoint_ok(text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.push_endpoint_ok(text)', 'EXECUTE'), 'push_endpoint_ok 不授任何角色执行权（3.3 C 0.49）');

-- ================= 二、devices 三列约束 =================
insert into public.devices (id, user_id, platform, label, session_id) values
  ('de000000-0000-4000-8000-00000000c0a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'ios', 'A1', 'aaaaaaaa-5555-4000-8000-000000000001');
create function tests.try_sql(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
select ok(tests.try_sql($$update public.devices set push_endpoint = 'https://fcm.googleapis.com/' || repeat('a', 2022) where id = 'de000000-0000-4000-8000-00000000c0a1'$$)
  like '23514%devices_push_endpoint_len%', '约束：push_endpoint 超过 2048 被拒（service role 写也越不过）');
select ok(tests.try_sql($$update public.devices set p256dh = repeat('A', 85) where id = 'de000000-0000-4000-8000-00000000c0a1'$$)
  like '23514%devices_p256dh_fmt%', '约束：p256dh 85 字符被拒');
select ok(tests.try_sql($$update public.devices set p256dh = 'BA' || repeat('A', 84) || '+' where id = 'de000000-0000-4000-8000-00000000c0a1'$$)
  like '23514%devices_p256dh_fmt%', '约束：p256dh 带 + 被拒');
select ok(tests.try_sql($$update public.devices set auth = repeat('A', 25) where id = 'de000000-0000-4000-8000-00000000c0a1'$$)
  like '23514%devices_auth_fmt%', '约束：auth 25 字符被拒');
select is(tests.try_sql($$update public.devices set push_endpoint = 'https://fcm.googleapis.com/x', p256dh = 'BA' || repeat('A', 85), auth = repeat('A', 22)
  where id = 'de000000-0000-4000-8000-00000000c0a1'$$), 'ok', '约束：合法的三列能写');
update public.devices set push_endpoint = null, p256dh = null, auth = null where id = 'de000000-0000-4000-8000-00000000c0a1';

-- ================= 三、claim_endpoint =================
-- A：A1（会话 S_A1 = seed 的 5555）、A2（会话 S_A2）、A3（会话已不在）；S_A4 没有设备行；B：B1（会话 S_B）
insert into auth.sessions (id, user_id) values
  ('aaaaaaaa-6666-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('aaaaaaaa-9999-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001');
insert into public.devices (id, user_id, platform, label, session_id, install_id, last_seen_at) values
  ('de000000-0000-4000-8000-00000000c0a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'windows', 'A2', 'aaaaaaaa-6666-4000-8000-000000000001', null, null),
  ('de000000-0000-4000-8000-00000000c0a3', 'aaaaaaaa-0000-4000-8000-000000000001', 'ios', 'A3', 'aaaaaaaa-dead-4000-8000-000000000001', '1e000000-0000-4000-8000-00000000c0a3', null),
  ('de000000-0000-4000-8000-00000000c0b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'web', 'B1', 'bbbbbbbb-5555-4000-8000-000000000002', null, null);
update public.devices set last_seen_at = '2026-11-01 08:00:00+00', install_id = '1e000000-0000-4000-8000-00000000c0a1' where id = 'de000000-0000-4000-8000-00000000c0a1';

create function tests.k() returns text language sql as $$ select 'BA' || repeat('A', 85) $$;   -- 65 字节、首字节 0x04
create function tests.a() returns text language sql as $$ select repeat('A', 22) $$;           -- 16 字节
create function tests.claim(p_ep text, p_k text, p_a text, p_label text, p_platform text) returns text language sql as $$
  select format('select public.claim_endpoint(%L, %L, %L, %L, %L) as r', p_ep, p_k, p_a, p_label, p_platform) $$;
-- 以 authenticated 调一次 claim_endpoint：成功回函数的 jsonb，出错回 {"error": "<sqlstate> <信息>"}
create function tests.ret(p_uid uuid, p_session uuid, p_ep text, p_k text default null, p_a text default null, p_label text default null, p_platform text default null)
  returns jsonb language plpgsql as $$
declare r jsonb := tests.rows_as('authenticated', p_uid, tests.claim(p_ep, coalesce(p_k, tests.k()), coalesce(p_a, tests.a()), p_label, p_platform), null, p_session);
begin
  return case when jsonb_typeof(r) = 'array' then r -> 0 -> 'r' else r end;
end $$;
-- 以给定 claims 的 authenticated 执行（密码会话用）：'ok' 或 '<sqlstate> <信息>'（同 07 的 try_claims）
create function tests.try_claims_ce(p_claims jsonb, p_sql text) returns text language plpgsql as $$
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

-- 授权、会话检查（TC-B2-79）
select ok(tests.try_as('anon', null, tests.claim('https://fcm.googleapis.com/e1', tests.k(), tests.a(), null, null)) like '42501%', 'TC-B2-79：anon 调 claim_endpoint 被拒（42501）');
select ok(tests.try_as('anon', null, $$select private.claim_endpoint_impl('https://fcm.googleapis.com/e1', 'x', 'y', null, null)$$) like '42501%',
  'TC-B2-79：anon 直接调 private.claim_endpoint_impl 被拒');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', tests.claim('https://fcm.googleapis.com/e1', tests.k(), tests.a(), null, null))
  like '%session_revoked%', 'TC-B2-79：JWT 没有 session_id 回 session_revoked');
select ok(tests.try_claims_ce('{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated", "session_id": "aaaaaaaa-5555-4000-8000-000000000001", "amr": [{"method": "password"}]}',
  tests.claim('https://fcm.googleapis.com/e1', tests.k(), tests.a(), null, null)) like '%session_revoked%', 'TC-B2-79：密码会话回 session_revoked');
select ok(tests.try_as('authenticated', 'cccccccc-0000-4000-8000-000000000003', tests.claim('https://fcm.googleapis.com/e1', tests.k(), tests.a(), null, null))
  like '%account_disabled%', 'TC-B2-79：停用账号回 account_disabled');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', tests.claim('https://fcm.googleapis.com/e1', tests.k(), tests.a(), null, null),
  null, 'aaaaaaaa-dead-4000-8000-000000000001') like '%session_revoked%', 'TC-B2-79：会话已不在回 session_revoked');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', tests.claim('https://fcm.googleapis.com/e1', tests.k(), tests.a(), null, null),
  null, 'aaaaaaaa-9999-4000-8000-000000000001') like '%device_not_found%', '会话还在但没有设备行：device_not_found');

-- 校验不合格：22023、一行不动（TC-B2-80）
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', tests.claim('https://evil.example/e1', tests.k(), tests.a(), null, null),
  null, 'aaaaaaaa-5555-4000-8000-000000000001') like '22023 endpoint_not_allowed%', 'TC-B2-80：白名单外的地址回 22023 endpoint_not_allowed');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', tests.claim('https://fcm.googleapis.com:8443/e1', tests.k(), tests.a(), null, null),
  null, 'aaaaaaaa-5555-4000-8000-000000000001') like '22023 endpoint_not_allowed%', 'TC-B2-80：带端口回 endpoint_not_allowed');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', tests.claim('https://fcm.googleapis.com/e1', 'AA' || repeat('A', 85), tests.a(), null, null),
  null, 'aaaaaaaa-5555-4000-8000-000000000001') like '22023 bad_push_keys%', 'TC-B2-80：p256dh 首字节不是 0x04 回 bad_push_keys');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', tests.claim('https://fcm.googleapis.com/e1', 'BA' || repeat('A', 84), tests.a(), null, null),
  null, 'aaaaaaaa-5555-4000-8000-000000000001') like '22023 bad_push_keys%', 'TC-B2-80：p256dh 解码后 64 字节回 bad_push_keys');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', tests.claim('https://fcm.googleapis.com/e1', tests.k(), repeat('A', 21), null, null),
  null, 'aaaaaaaa-5555-4000-8000-000000000001') like '22023 bad_push_keys%', 'TC-B2-80：auth 21 字符回 bad_push_keys');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', tests.claim('https://fcm.googleapis.com/e1', tests.k(), repeat('A', 21) || '.', null, null),
  null, 'aaaaaaaa-5555-4000-8000-000000000001') like '22023 bad_push_keys%', 'TC-B2-80：auth 带非 base64url 字符回 bad_push_keys');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', tests.claim('https://fcm.googleapis.com/e1', null, tests.a(), null, null),
  null, 'aaaaaaaa-5555-4000-8000-000000000001') like '22023 bad_push_keys%', 'TC-B2-80：p256dh 为空回 bad_push_keys');
select is((select count(*)::int from public.devices where push_endpoint is not null), 0, 'TC-B2-80：上面几次被拒，一行都没写');

-- 认领成功
select is(tests.ret('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', 'https://fcm.googleapis.com/e1', null, null, 'A1 新名', null),
  '{"ok": true}'::jsonb, 'A 在 A1 上认领 e1：{ok: true}');
select is((select push_endpoint || '|' || p256dh || '|' || auth || '|' || label || '|' || platform from public.devices where id = 'de000000-0000-4000-8000-00000000c0a1'),
  'https://fcm.googleapis.com/e1|' || tests.k() || '|' || tests.a() || '|A1 新名|ios', 'A1 写上三列，label 改了，platform 没传不变');
select is((select session_id::text from public.devices where id = 'de000000-0000-4000-8000-00000000c0a1'), 'aaaaaaaa-5555-4000-8000-000000000001', 'session_id 不变');
update public.devices set push_fail_count = 3 where id = 'de000000-0000-4000-8000-00000000c0a1';
select is(tests.ret('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', 'https://fcm.googleapis.com/e1', 'BA' || repeat('B', 84) || 'A', null, null, 'web'),
  '{"ok": true}'::jsonb, '同一地址重新认领（换了密钥）成功');
select is((select p256dh || '|' || platform || '|' || push_fail_count from public.devices where id = 'de000000-0000-4000-8000-00000000c0a1'),
  'BA' || repeat('B', 84) || 'A' || '|web|3', '密钥、platform 更新；地址没换，push_fail_count 不清');

-- 同一账号别的行占着、会话还在：endpoint_in_use + holder（第 99 条④、第 105 条）
create temp table t105 on commit drop as
  select tests.ret('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-6666-4000-8000-000000000001', 'https://fcm.googleapis.com/e1') as r;
select is((select r #- '{holder,last_seen_at}' from t105),
  '{"error": "endpoint_in_use", "holder": {"id": "de000000-0000-4000-8000-00000000c0a1", "label": "A1 新名", "install_id": "1e000000-0000-4000-8000-00000000c0a1"}}'::jsonb,
  '第 105 条：A2 认领 A1 占着的 e1，回 endpoint_in_use 和 holder（id、label、install_id）');
select is((select (r -> 'holder' ->> 'last_seen_at')::timestamptz from t105), '2026-11-01 08:00:00+00'::timestamptz, '第 105 条：holder 带 last_seen_at');
select is((select count(*)::int from public.devices where push_endpoint = 'https://fcm.googleapis.com/e1' and id = 'de000000-0000-4000-8000-00000000c0a1')
        + (select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-00000000c0a2' and push_endpoint is null), 2,
  '第 99 条④：A1 不被删，A2 也没写上');
-- 同一账号别的行占着、会话已不在：删掉它
update public.devices set push_endpoint = 'https://web.push.apple.com/e3', p256dh = tests.k(), auth = tests.a() where id = 'de000000-0000-4000-8000-00000000c0a3';
select is(tests.ret('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-6666-4000-8000-000000000001', 'https://web.push.apple.com/e3', null, null, null, 'ios'),
  '{"ok": true}'::jsonb, '第 99 条④：A3 的会话已不在，A2 认领 e3 成功');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-00000000c0a3'), 0, 'A3 那一行删掉');
select is((select count(*)::int from public.tombstones where tbl = 'devices' and id = 'de000000-0000-4000-8000-00000000c0a3'), 1, 'A3 留了墓碑');
select is((select push_endpoint || '|' || platform from public.devices where id = 'de000000-0000-4000-8000-00000000c0a2'), 'https://web.push.apple.com/e3|ios', 'A2 写上 e3');
-- session_id 为空的旧行占着：也算会话不在
insert into public.devices (id, user_id, platform, label, session_id, push_endpoint, p256dh, auth) values
  ('de000000-0000-4000-8000-00000000c0a5', 'aaaaaaaa-0000-4000-8000-000000000001', 'web', 'A5', null, 'https://fcm.googleapis.com/e5', tests.k(), tests.a());
select is(tests.ret('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-6666-4000-8000-000000000001', 'https://fcm.googleapis.com/e5'),
  '{"ok": true}'::jsonb, 'session_id 为空的旧行占着 e5：删掉它，A2 认领成功');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-00000000c0a5'), 0, 'A5 删掉');
select is((select push_fail_count from public.devices where id = 'de000000-0000-4000-8000-00000000c0a2'), 0, '地址换了（e3 → e5），push_fail_count 是 0');
-- 代码审查 BE-1 S6：已软删的行占着（会话还在）：设置页看不到它、移除不了，直接删掉，不回 endpoint_in_use
insert into public.devices (id, user_id, platform, label, session_id, push_endpoint, p256dh, auth, deleted_at) values
  ('de000000-0000-4000-8000-00000000c0a6', 'aaaaaaaa-0000-4000-8000-000000000001', 'web', 'A6', 'aaaaaaaa-5555-4000-8000-000000000001',
   'https://fcm.googleapis.com/e6', tests.k(), tests.a(), 1793000000000);
select is(tests.ret('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-6666-4000-8000-000000000001', 'https://fcm.googleapis.com/e6'),
  '{"ok": true}'::jsonb, 'S6：已软删、会话还在的 A6 占着 e6：不回 endpoint_in_use，A2 认领成功');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-00000000c0a6'), 0, 'S6：A6 删掉');
select is((select push_endpoint from public.devices where id = 'de000000-0000-4000-8000-00000000c0a2'), 'https://fcm.googleapis.com/e6', 'S6：A2 写上 e6');
-- 还原 A2 的地址，后面的用例按 e5 写
update public.devices set push_endpoint = 'https://fcm.googleapis.com/e5' where id = 'de000000-0000-4000-8000-00000000c0a2';

-- 换账号（M9，TC-B1-22、81）：B 在 B1 认领 A1 用着的 e1
select is(tests.ret('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-5555-4000-8000-000000000002', 'https://fcm.googleapis.com/e1'),
  '{"ok": true}'::jsonb, 'TC-B1-22：B 认领 A 名下的 e1 成功');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-00000000c0a1'), 0, 'TC-B1-22：A1（别的账号、同一 endpoint）删掉，A 的推送不再发到这台');
select is((select user_id::text from public.devices where push_endpoint = 'https://fcm.googleapis.com/e1'), 'bbbbbbbb-0000-4000-8000-000000000002', 'TC-B1-81：e1 只在 B 名下');
select is((select count(*)::int from public.tombstones where tbl = 'devices' and id = 'de000000-0000-4000-8000-00000000c0a1'), 1, 'A1 留了墓碑（A 的其他设备下次同步时去掉它）');
select is((select push_endpoint from public.devices where id = 'de000000-0000-4000-8000-00000000c0a2'), 'https://fcm.googleapis.com/e5', 'A2 不受影响');
select is((select count(*)::int from auth.sessions where id = 'aaaaaaaa-5555-4000-8000-000000000001'), 1, 'A1 的会话不动（只删设备行，不替别人吊销）');

-- 不能借 claim_endpoint 动别人的行、不能直接写三列
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.devices set push_endpoint = 'https://fcm.googleapis.com/zz' where id = 'de000000-0000-4000-8000-00000000c0a2'$$,
  null, 'aaaaaaaa-6666-4000-8000-000000000001') like '42501%', '客户端不能直接 update push_endpoint（列级授权，只能经 claim_endpoint）');
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select private.claim_endpoint_impl('https://fcm.googleapis.com/e6', 'BA' || repeat('A', 85), repeat('A', 22), null, null) as r$$,
  null, 'aaaaaaaa-6666-4000-8000-000000000001') -> 0 -> 'r', '{"ok": true}'::jsonb,
  '0.38 第 5 条：authenticated 直接调 private.claim_endpoint_impl 也走同样的检查，只写本会话那一行');
select is((select push_endpoint from public.devices where id = 'de000000-0000-4000-8000-00000000c0b1'), 'https://fcm.googleapis.com/e1', 'B1 不受 A 的认领影响');

-- 授权（3.3 C、D）
select ok(has_function_privilege('authenticated', 'public.claim_endpoint(text, text, text, text, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.claim_endpoint(text, text, text, text, text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.claim_endpoint(text, text, text, text, text)', 'EXECUTE'), 'public.claim_endpoint 只授 authenticated');
select ok(has_function_privilege('authenticated', 'private.claim_endpoint_impl(text, text, text, text, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.claim_endpoint_impl(text, text, text, text, text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.claim_endpoint_impl(text, text, text, text, text)', 'EXECUTE'), 'claim_endpoint_impl 只授 authenticated（3.3 C）');
select ok((select not p.prosecdef from pg_proc p where p.oid = 'public.claim_endpoint(text, text, text, text, text)'::regprocedure)
  and (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = 'private.claim_endpoint_impl(text, text, text, text, text)'::regprocedure),
  'public 一层 security invoker；impl 是 security definer、search_path 空');
select is((select string_agg(p.parameter_name, ',' order by p.ordinal_position) from information_schema.parameters p
  join information_schema.routines r on r.specific_name = p.specific_name
  where r.routine_schema = 'public' and r.routine_name = 'claim_endpoint' and p.parameter_mode = 'IN'),
  'endpoint,p256dh,auth,label,platform', '“接口先定”第 1 条：五个入参的名字（supabase-js 按名字传）');
select is((select pg_catalog.format_type(p.prorettype, null) from pg_proc p where p.oid = 'public.claim_endpoint(text, text, text, text, text)'::regprocedure), 'jsonb', '返回 jsonb');

select * from finish();
rollback;
