-- 授给 authenticated 的 *_impl 按“会被直接调”写（架构 0.38 第 5、9 条：private 对外暴露，门在 impl 里）：TC-B1-114～117 的 pgTAP 一半
--   TC-B1-114 report_tz_impl、TC-B1-115 remove_device_impl、TC-B1-116 record_consent_impl、TC-B1-117 purge_deleted_impl
--   每条四步：① anon 调 public 包装；② anon 直接调 impl；③ A 直接调 impl，结果和“同一份数据上经 public 包装做同一操作”逐项相同，
--   并核对动不到别人的数据；④ A 的密码会话直接调 impl，回 session_revoked、数据不变
-- 已有的零散覆盖（06 的密码会话、07 的 B 直接调 impl、anon 直接调 impl）照留；这里按用例编号逐条补齐、标上 TC 号
-- “同一份数据”的写法：tests.dry() 在子事务里调一次、记下返回值和状态快照，再抛一个自定义异常把子事务回滚，
--   所以 impl 和包装各跑在同一份起始数据上（离线 PGlite 不支持 psql 的 \gset，不用 savepoint + 变量）
-- 密码会话按 06、07 用 request.jwt.claims 模拟（amr 带 {"method": "password"}）；真密码会话（临时停 guard_no_password、
--   grant_type=password 登录）和 REST 带 Content-Profile: private 的那一半不在这里，见用例原文
begin;
select plan(42);
\ir _helpers.psql
select tests.seed();   -- A、B 正常（会话 SA、SB），C 停用

-- 按给定 claims 执行：角色取 claims.role；返回结果行的 jsonb 数组，出错返回 {"error": "<sqlstate> <信息>"}
create function tests.rows_cl(p_claims jsonb, p_sql text) returns jsonb language plpgsql as $$
declare res jsonb;
begin
  begin
    perform set_config('request.jwt.claims', p_claims::text, true);
    execute format('set local role %I', p_claims ->> 'role');
    execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', p_sql) into res;
    reset role;
  exception when others then
    res := jsonb_build_object('error', sqlstate || ' ' || sqlerrm);
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return res;
end $$;
-- 试跑：调一次、以 postgres 读状态快照，然后整段回滚；返回 {"ret": 调用结果, "state": 快照}
create function tests.dry(p_claims jsonb, p_call text, p_probe text) returns jsonb language plpgsql as $$
declare ret jsonb; st jsonb;
begin
  begin
    ret := tests.rows_cl(p_claims, p_call);
    execute p_probe into st;
    raise exception 'dry_run_rollback' using errcode = 'P0T99';
  exception when sqlstate 'P0T99' then null;
  end;
  return jsonb_build_object('ret', ret, 'state', st);
end $$;
-- 常用 claims
create function tests.anon() returns jsonb language sql as $$ select '{"role": "anon"}'::jsonb $$;
create function tests.cl(p_uid uuid, p_session uuid, p_password boolean default false) returns jsonb language sql as $$
  select jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'session_id', p_session,
                            'amr', case when p_password then '[{"method": "password", "timestamp": 1761700000}]'::jsonb
                                        else '[{"method": "otp", "timestamp": 1761700000}]'::jsonb end)
$$;
create function tests.ca() returns jsonb language sql as $$ select tests.cl('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001') $$;
create function tests.cb() returns jsonb language sql as $$ select tests.cl('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-5555-4000-8000-000000000002') $$;
create function tests.ca_pw() returns jsonb language sql as $$ select tests.cl('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', true) $$;
create table tests.snap (k text primary key, v jsonb);
-- void 返回值统一记成 'void'（调用处写 coalesce(nullif((…)::text, ''), 'void')）：plpgsql 的 impl 返回 null::void，language sql 的 public 包装返回空串的 void（PostgREST 两者都回空响应），
--   只比“有没有报错、报什么”，不比这个表示上的差别

-- ================= TC-B1-114：report_tz_impl =================
-- A 的设备 Da（web，绑 SA）、B 的设备 Db（web，绑 SB）；A、B 现在都是 Asia/Tokyo；
--   A 的 Da 9 分钟前已报过一次 Asia/Seoul（pending），所以这一次会被采纳、三列真的会变
insert into public.devices (id, user_id, platform, label, session_id) values
  ('de000000-0000-4000-8000-0000000114a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'web', 'Da', 'aaaaaaaa-5555-4000-8000-000000000001'),
  ('de000000-0000-4000-8000-0000000114b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'web', 'Db', 'bbbbbbbb-5555-4000-8000-000000000002');
update public.profiles set current_tz = 'Asia/Tokyo', current_tz_device = null, current_tz_at = now() - interval '1 day'
 where user_id in ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002');
insert into private.counters (key, window_start, count) values
  ('tzrep:aaaaaaaa-0000-4000-8000-000000000001:de000000-0000-4000-8000-0000000114a1@Asia/Seoul', now() - interval '9 minutes', 1);
create function tests.p114() returns text language sql as $$ select $q$
  select jsonb_build_object(
    'a', (select to_jsonb(x) from (select current_tz, current_tz_device, current_tz_at from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001') x),
    'b', (select to_jsonb(x) from (select current_tz, current_tz_device, current_tz_at from public.profiles where user_id = 'bbbbbbbb-0000-4000-8000-000000000002') x),
    'devs', (select jsonb_agg(to_jsonb(d) order by d.id) from public.devices d where d.id in ('de000000-0000-4000-8000-0000000114a1', 'de000000-0000-4000-8000-0000000114b1')),
    'ctr', (select jsonb_agg(c.key order by c.key) from private.counters c where c.key like 'tz%'),
    'rq', (select count(*) from private.remind_queue))$q$ $$;
create function tests.s114() returns jsonb language plpgsql as $$ declare r jsonb; begin execute tests.p114() into r; return r; end $$;
insert into tests.snap values ('114', tests.s114());

select ok(tests.rows_cl(tests.anon(), $$select public.report_tz('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$) ->> 'error' like '42501%',
  'TC-B1-114 ①：anon 调 report_tz 被拒（42501）');
select ok(tests.rows_cl(tests.anon(), $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$) ->> 'error' like '42501%',
  'TC-B1-114 ②：anon 直接调 private.report_tz_impl 被拒（42501）');
select is(tests.s114(), (select v from tests.snap where k = '114'), 'TC-B1-114 ①②：A、B 的 profiles、设备行、计数都不变');
select is(tests.dry(tests.ca(), $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$, tests.p114()) -> 'ret',
  '[{"r": "accepted"}]'::jsonb, 'TC-B1-114 ③：A 直接调 report_tz_impl 成功（accepted）');
select is((tests.dry(tests.ca(), $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$, tests.p114()) -> 'state' -> 'a')
            - 'current_tz_at' || jsonb_build_object('at_is_now',
          (tests.dry(tests.ca(), $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$, tests.p114()) -> 'state' -> 'a' ->> 'current_tz_at')::timestamptz = now()),
  '{"current_tz": "Asia/Seoul", "current_tz_device": "de000000-0000-4000-8000-0000000114a1", "at_is_now": true}'::jsonb,
  'TC-B1-114 ③：A 的三列变成 Asia/Seoul、Da、now()');
select is(tests.dry(tests.ca(), $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$, tests.p114()),
          tests.dry(tests.ca(), $$select public.report_tz('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$, tests.p114()),
  'TC-B1-114 ③：直接调 impl 和同一份数据上经 report_tz 调，返回值、A 和 B 的三列、设备行、计数、提醒队列逐项相同');
select ok((tests.dry(tests.ca(), $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$, tests.p114()) -> 'state' -> 'b')
            = (select v -> 'b' from tests.snap where k = '114'),
  'TC-B1-114 ③：A 直接调 impl，B 的三列不变');
select ok(tests.dry(tests.cb(), $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$, tests.p114()) -> 'ret' ->> 'error' like '%device_mismatch%',
  'TC-B1-114 ③：B 带 A 的 Da 直接调 impl，回 device_mismatch');
select is(tests.dry(tests.cb(), $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$, tests.p114()) -> 'state',
          (select v from tests.snap where k = '114'),
  'TC-B1-114 ③：B 带 Da 调完，A 的 profiles 和设备行一律不变；B 自己的行也不变（执行时记下：device_mismatch 在任何写入之前报）');
select is(tests.dry(tests.cb(), $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$, tests.p114()),
          tests.dry(tests.cb(), $$select public.report_tz('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$, tests.p114()),
  'TC-B1-114 ③：B 带 Da 直接调 impl 和经 report_tz 调结果相同');
select ok(tests.rows_cl(tests.ca_pw(), $$select private.report_tz_impl('Asia/Seoul', 'de000000-0000-4000-8000-0000000114a1', 'web') as r$$) ->> 'error' like '%session_revoked%',
  'TC-B1-114 ④：A 的密码会话直接调 report_tz_impl，回 session_revoked');
select is(tests.s114(), (select v from tests.snap where k = '114'), 'TC-B1-114 ④：A 的 profiles 不变（设备行、计数也不变）');

-- ================= TC-B1-115：remove_device_impl =================
-- A：Y（当前会话 SY）、X（另一会话 SX）；B：Z（会话 SZ）
insert into auth.sessions (id, user_id) values
  ('aaaaaaaa-1150-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001'),   -- SY
  ('aaaaaaaa-1150-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001'),   -- SX
  ('bbbbbbbb-1150-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002');   -- SZ
insert into public.devices (id, user_id, platform, label, session_id) values
  ('de000000-0000-4000-8000-0000000115a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'windows', 'Y', 'aaaaaaaa-1150-4000-8000-0000000000a1'),
  ('de000000-0000-4000-8000-0000000115a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'ios',     'X', 'aaaaaaaa-1150-4000-8000-0000000000a2'),
  ('de000000-0000-4000-8000-0000000115b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'ios',     'Z', 'bbbbbbbb-1150-4000-8000-0000000000b1');
create function tests.cy() returns jsonb language sql as $$ select tests.cl('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1150-4000-8000-0000000000a1') $$;
create function tests.cy_pw() returns jsonb language sql as $$ select tests.cl('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1150-4000-8000-0000000000a1', true) $$;
-- 快照里的 revoked、tomb 只取测试用户 A、B 的行（DBTEST-sugg ③：库里有别的用户残留时不误报；p116 的 ai、p117 的 tomb 同样）；
--   A、B 以外的行数单独放在 other 里，只和快照比（写死期望的那几条先 #- '{state,other}' 再比，另有一条比 other）；
--   revoked_sessions、tombstones（0001）、note_vectors、embed_queue（0007）的 user_id 都是 not null，not in / <> 不会漏掉 null 行
create function tests.p115() returns text language sql as $$ select $q$
  select jsonb_build_object(
    'devs', (select jsonb_agg(d.label order by d.label) from public.devices d where d.id::text like 'de000000-0000-4000-8000-0000000115%'),
    'sess', (select jsonb_agg(s.id order by s.id) from auth.sessions s where s.id::text like '%-1150-%'),
    'revoked', (select jsonb_agg(jsonb_build_object('s', r.session_id, 'u', r.user_id) order by r.session_id) from private.revoked_sessions r where r.user_id in ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002')),
    'tomb', (select jsonb_agg(t.id order by t.id) from public.tombstones t where t.tbl = 'devices' and t.user_id in ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002')),
    'other', jsonb_build_object(   -- A、B 以外的行数：只和快照比（库里别人的残留多少都行，但这次调用不能动它们）
      'revoked', (select count(*) from private.revoked_sessions r where r.user_id not in ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002')),
      'tomb', (select count(*) from public.tombstones t where t.tbl = 'devices' and t.user_id not in ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'))))$q$ $$;
create function tests.s115() returns jsonb language plpgsql as $$ declare r jsonb; begin execute tests.p115() into r; return r; end $$;
insert into tests.snap values ('115', tests.s115());

select ok(tests.rows_cl(tests.anon(), $$select coalesce(nullif((public.remove_device('de000000-0000-4000-8000-0000000115a2'))::text, ''), 'void') as r$$) ->> 'error' like '42501%',
  'TC-B1-115 ①：anon 调 remove_device(X) 被拒（42501）');
select ok(tests.rows_cl(tests.anon(), $$select coalesce(nullif((private.remove_device_impl('de000000-0000-4000-8000-0000000115a2'))::text, ''), 'void') as r$$) ->> 'error' like '42501%',
  'TC-B1-115 ②：anon 直接调 private.remove_device_impl(X) 被拒（42501）');
select is(tests.s115(), (select v from tests.snap where k = '115'), 'TC-B1-115 ①②：X 和它的会话不变');
select is(tests.dry(tests.cy(), $$select coalesce(nullif((private.remove_device_impl('de000000-0000-4000-8000-0000000115a2'))::text, ''), 'void') as r$$, tests.p115()) #- '{state,other}',
  jsonb_build_object('ret', '[{"r": "void"}]'::jsonb, 'state', jsonb_build_object(
    'devs', '["Y", "Z"]'::jsonb,
    'sess', '["aaaaaaaa-1150-4000-8000-0000000000a1", "bbbbbbbb-1150-4000-8000-0000000000b1"]'::jsonb,
    'revoked', '[{"s": "aaaaaaaa-1150-4000-8000-0000000000a2", "u": "aaaaaaaa-0000-4000-8000-000000000001"}]'::jsonb,
    'tomb', '["de000000-0000-4000-8000-0000000115a2"]'::jsonb)),
  'TC-B1-115 ③：A 在 Y 上直接调 impl(X) 成功：X 的会话写进 revoked_sessions、auth.sessions 删掉，devices 行删掉（留墓碑）');
select is(tests.dry(tests.cy(), $$select coalesce(nullif((private.remove_device_impl('de000000-0000-4000-8000-0000000115a2'))::text, ''), 'void') as r$$, tests.p115()) -> 'state' -> 'other',
          (select v -> 'other' from tests.snap where k = '115'),
  'TC-B1-115 ③：A、B 以外的吊销记录、设备墓碑行数和快照一样（没动别人的）');
select is(tests.dry(tests.cy(), $$select coalesce(nullif((private.remove_device_impl('de000000-0000-4000-8000-0000000115a2'))::text, ''), 'void') as r$$, tests.p115()),
          tests.dry(tests.cy(), $$select coalesce(nullif((public.remove_device('de000000-0000-4000-8000-0000000115a2'))::text, ''), 'void') as r$$, tests.p115()),
  'TC-B1-115 ③：impl(X) 和同一份数据上经 remove_device(X) 的返回值、会话、吊销记录、设备行、墓碑逐项相同');
select ok(tests.dry(tests.cy(), $$select coalesce(nullif((private.remove_device_impl('de000000-0000-4000-8000-0000000115a1'))::text, ''), 'void') as r$$, tests.p115()) -> 'ret' ->> 'error' like '%is_current_device%'
      and tests.dry(tests.cy(), $$select coalesce(nullif((private.remove_device_impl('de000000-0000-4000-8000-0000000115a1'))::text, ''), 'void') as r$$, tests.p115()) -> 'state' = (select v from tests.snap where k = '115'),
  'TC-B1-115 ③：impl(Y)（本机）回 is_current_device，什么都不变');
select is(tests.dry(tests.cy(), $$select coalesce(nullif((private.remove_device_impl('de000000-0000-4000-8000-0000000115a1'))::text, ''), 'void') as r$$, tests.p115()),
          tests.dry(tests.cy(), $$select coalesce(nullif((public.remove_device('de000000-0000-4000-8000-0000000115a1'))::text, ''), 'void') as r$$, tests.p115()),
  'TC-B1-115 ③：impl(Y) 和经包装调一样');
select ok(tests.dry(tests.cy(), $$select coalesce(nullif((private.remove_device_impl('de000000-0000-4000-8000-0000000115b1'))::text, ''), 'void') as r$$, tests.p115()) -> 'ret' ->> 'error' like '%device_not_found%'
      and tests.dry(tests.cy(), $$select coalesce(nullif((private.remove_device_impl('de000000-0000-4000-8000-0000000115b1'))::text, ''), 'void') as r$$, tests.p115()) -> 'state' = (select v from tests.snap where k = '115'),
  'TC-B1-115 ③：impl(Z)（B 的设备）被拒（device_not_found），Z 和 B 的会话不变');
select is(tests.dry(tests.cy(), $$select coalesce(nullif((private.remove_device_impl('de000000-0000-4000-8000-0000000115b1'))::text, ''), 'void') as r$$, tests.p115()),
          tests.dry(tests.cy(), $$select coalesce(nullif((public.remove_device('de000000-0000-4000-8000-0000000115b1'))::text, ''), 'void') as r$$, tests.p115()),
  'TC-B1-115 ③：impl(Z) 和经包装调一样');
select ok(tests.rows_cl(tests.cy_pw(), $$select coalesce(nullif((private.remove_device_impl('de000000-0000-4000-8000-0000000115a2'))::text, ''), 'void') as r$$) ->> 'error' like '%session_revoked%',
  'TC-B1-115 ④：A 的密码会话直接调 impl(X)，回 session_revoked');
select is(tests.s115(), (select v from tests.snap where k = '115'), 'TC-B1-115 ④：X 和它的会话都不变');

-- ================= TC-B1-116：record_consent_impl =================
-- 注意参数：record_consent_impl(p_ver, p_revoke)——第二个参数 true 是撤回、false 是同意（0001 起如此，见 20261029220000 版）
-- A 已同意（一天前、当前版本），有两条 note_vectors；B 未同意
create function tests.ver() returns text language sql as $$ select notice ->> 'policy_ver' from public.app_config where id = 1 $$;
update public.profiles set consent_ai_at = now() - interval '1 day', consent_policy_ver = tests.ver() where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
insert into public.notes (id, user_id, body, created_at, updated_at) values
  ('40000000-0000-4000-8000-0000000116a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'n1', 1, 1),
  ('40000000-0000-4000-8000-0000000116a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'n2', 1, 1);
insert into private.note_vectors (user_id, kind, source_id, note_id, model, content_hash, embedding)
  select 'aaaaaaaa-0000-4000-8000-000000000001', 'note', n, n, 'm', 'h', ('[' || array_to_string(array_fill(0, array[768]), ',') || ']')::extensions.halfvec
    from unnest(array['40000000-0000-4000-8000-0000000116a1', '40000000-0000-4000-8000-0000000116a2']::uuid[]) n;
create function tests.p116() returns text language sql as $$ select $q$
  select jsonb_build_object(
    'a', (select to_jsonb(x) from (select consent_ai_at, consent_policy_ver from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001') x),
    'b', (select to_jsonb(x) from (select consent_ai_at, consent_policy_ver from public.profiles where user_id = 'bbbbbbbb-0000-4000-8000-000000000002') x),
    'vec', (select count(*) from private.note_vectors where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
    'queue', (select count(*) from private.embed_queue where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
    'ai', (select jsonb_agg(jsonb_build_object('u', s.user_id, 'v', s.value) order by s.user_id) from public.settings s where s.key = 'ai.enabled' and s.user_id in ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002')),
    'other', jsonb_build_object(   -- A、B 以外（向量、队列是 A 以外）的行数：只和快照比
      'ai', (select count(*) from public.settings s where s.key = 'ai.enabled' and s.user_id not in ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002')),
      'vec', (select count(*) from private.note_vectors where user_id <> 'aaaaaaaa-0000-4000-8000-000000000001'),
      'queue', (select count(*) from private.embed_queue where user_id <> 'aaaaaaaa-0000-4000-8000-000000000001')))$q$ $$;
create function tests.s116() returns jsonb language plpgsql as $$ declare r jsonb; begin execute tests.p116() into r; return r; end $$;
insert into tests.snap values ('116', tests.s116());

select ok(tests.rows_cl(tests.anon(), format('select coalesce(nullif((public.record_consent(%L, false))::text, ''''), ''void'') as r', tests.ver())) ->> 'error' like '42501%',
  'TC-B1-116 ①：anon 调 record_consent 被拒（42501）');
select ok(tests.rows_cl(tests.anon(), format('select coalesce(nullif((private.record_consent_impl(%L, false))::text, ''''), ''void'') as r', tests.ver())) ->> 'error' like '42501%',
  'TC-B1-116 ②：anon 直接调 private.record_consent_impl 被拒（42501）');
select is(tests.s116(), (select v from tests.snap where k = '116'), 'TC-B1-116 ①②：A、B 的 profiles 不变');
-- DBTEST-sugg ④：a 键里逐列比（consent_ai_at 换成 at_is_now，consent_policy_ver 照比）；原写法 || 覆盖整个 a 键，consent_policy_ver 没比到
select is((tests.dry(tests.ca(), format('select coalesce(nullif((private.record_consent_impl(%L, false))::text, ''''), ''void'') as r', tests.ver()), tests.p116()) -> 'state') - 'a'
            || jsonb_build_object('a', (tests.dry(tests.ca(), format('select coalesce(nullif((private.record_consent_impl(%L, false))::text, ''''), ''void'') as r', tests.ver()), tests.p116()) -> 'state' -> 'a') - 'consent_ai_at'
               || jsonb_build_object('at_is_now', (tests.dry(tests.ca(), format('select coalesce(nullif((private.record_consent_impl(%L, false))::text, ''''), ''void'') as r', tests.ver()), tests.p116()) -> 'state' -> 'a' ->> 'consent_ai_at')::timestamptz = now())),
          ((select v from tests.snap where k = '116') - 'a')
            || jsonb_build_object('a', jsonb_build_object('consent_policy_ver', tests.ver(), 'at_is_now', true)),
  'TC-B1-116 ③：A 直接调 record_consent_impl（同意）成功：consent_ai_at 变成 now()、consent_policy_ver 是当前版本，B 的 profiles、A 的向量都不变');
select is(tests.dry(tests.ca(), format('select coalesce(nullif((private.record_consent_impl(%L, true))::text, ''''), ''void'') as r', tests.ver()), tests.p116()),
  jsonb_build_object('ret', '[{"r": "void"}]'::jsonb, 'state',
    ((select v from tests.snap where k = '116') - 'a' - 'vec' - 'queue' - 'ai') || jsonb_build_object(
      'a', jsonb_build_object('consent_ai_at', null, 'consent_policy_ver', tests.ver()),
      'vec', 0, 'queue', 0,
      'ai', jsonb_build_array(jsonb_build_object('u', 'aaaaaaaa-0000-4000-8000-000000000001', 'v', false)))),
  'TC-B1-116 ③（补，写死期望）：A 直接调 impl 撤回：consent_ai_at 清空、consent_policy_ver 记当前版本，A 的向量和队列删光，A 写 ai.enabled = false，B 不变');
select is(tests.dry(tests.ca(), format('select coalesce(nullif((private.record_consent_impl(%L, false))::text, ''''), ''void'') as r', tests.ver()), tests.p116()),
          tests.dry(tests.ca(), format('select coalesce(nullif((public.record_consent(%L, false))::text, ''''), ''void'') as r', tests.ver()), tests.p116()),
  'TC-B1-116 ③：同意：直接调 impl 和同一份数据上经 record_consent 调，返回值、A 两列、B、向量、设置逐项相同');
select is(tests.dry(tests.ca(), format('select coalesce(nullif((private.record_consent_impl(%L, true))::text, ''''), ''void'') as r', tests.ver()), tests.p116()),
          tests.dry(tests.ca(), format('select coalesce(nullif((public.record_consent(%L, true))::text, ''''), ''void'') as r', tests.ver()), tests.p116()),
  'TC-B1-116 ③（补）：撤回：直接调 impl 和经 record_consent 调逐项相同（向量删光、写 ai.enabled = false）');
select ok(tests.rows_cl(tests.ca_pw(), format('select coalesce(nullif((private.record_consent_impl(%L, true))::text, ''''), ''void'') as r', tests.ver())) ->> 'error' like '%session_revoked%',
  'TC-B1-116 ④：A 的密码会话直接调 record_consent_impl 撤回（p_revoke = true），回 session_revoked');
select ok(tests.rows_cl(tests.ca_pw(), format('select coalesce(nullif((private.record_consent_impl(%L, false))::text, ''''), ''void'') as r', tests.ver())) ->> 'error' like '%session_revoked%',
  'TC-B1-116 ④（补）：密码会话直接调 impl 同意（p_revoke = false）同样回 session_revoked');
select is(tests.s116(), (select v from tests.snap where k = '116'), 'TC-B1-116 ④：A 的同意不变，A 的 note_vectors 行数不变（2），没写 ai.enabled');

-- ================= TC-B1-117：purge_deleted_impl =================
-- A 的 T1 已删（在“最近删除”）、T2 没删；B 的 T3 已删
insert into public.todos (id, user_id, title, deleted_at, created_at, updated_at) values
  ('70000000-0000-4000-8000-0000000117a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'T1', 1, 1, 1),
  ('70000000-0000-4000-8000-0000000117a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'T2', null, 1, 1),
  ('70000000-0000-4000-8000-0000000117b3', 'bbbbbbbb-0000-4000-8000-000000000002', 'T3', 1, 1, 1);
create function tests.items117() returns text language sql as $$ select
  '[{"tbl": "todos", "id": "70000000-0000-4000-8000-0000000117a1"}, {"tbl": "todos", "id": "70000000-0000-4000-8000-0000000117a2"}, {"tbl": "todos", "id": "70000000-0000-4000-8000-0000000117b3"}]' $$;
create function tests.p117() returns text language sql as $$ select $q$
  select jsonb_build_object(
    'rows', (select jsonb_agg(jsonb_build_object('t', t.title, 'del', t.deleted_at) order by t.title) from public.todos t where t.id::text like '70000000-0000-4000-8000-0000000117%'),
    'tomb', (select jsonb_agg(t.id order by t.id) from public.tombstones t where t.tbl = 'todos' and t.user_id in ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002')),
    'other', jsonb_build_object(   -- A、B 以外的行数：只和快照比
      'tomb', (select count(*) from public.tombstones t where t.tbl = 'todos' and t.user_id not in ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'))))$q$ $$;
create function tests.s117() returns jsonb language plpgsql as $$ declare r jsonb; begin execute tests.p117() into r; return r; end $$;
insert into tests.snap values ('117', tests.s117());

select ok(tests.rows_cl(tests.anon(), 'select public.purge_deleted() as r') ->> 'error' like '42501%',
  'TC-B1-117 ①：anon 调 purge_deleted 被拒（42501）');
select ok(tests.rows_cl(tests.anon(), 'select private.purge_deleted_impl() as r') ->> 'error' like '42501%',
  'TC-B1-117 ②：anon 直接调 private.purge_deleted_impl 被拒（42501）');
select is(tests.s117(), (select v from tests.snap where k = '117'), 'TC-B1-117 ①②：三行都在');
select is(tests.dry(tests.ca(), format('select private.purge_deleted_impl(%L::jsonb) as r', tests.items117()), tests.p117()) #- '{state,other}',
  jsonb_build_object('ret', '[{"r": 1}]'::jsonb, 'state', jsonb_build_object(
    'rows', '[{"t": "T2", "del": null}, {"t": "T3", "del": 1}]'::jsonb,
    'tomb', '["70000000-0000-4000-8000-0000000117a1"]'::jsonb)),
  'TC-B1-117 ③：A 直接调 impl、参数同时带 T1、T2、T3：回 1，只有 T1 被永久删除（留墓碑），T2、T3 不动');
select is(tests.dry(tests.ca(), format('select private.purge_deleted_impl(%L::jsonb) as r', tests.items117()), tests.p117()) -> 'state' -> 'other',
          (select v -> 'other' from tests.snap where k = '117'),
  'TC-B1-117 ③：A、B 以外的 todos 墓碑行数和快照一样');
select is(tests.dry(tests.ca(), format('select private.purge_deleted_impl(%L::jsonb) as r', tests.items117()), tests.p117()),
          tests.dry(tests.ca(), format('select public.purge_deleted(%L::jsonb) as r', tests.items117()), tests.p117()),
  'TC-B1-117 ③：直接调 impl 和同一份数据上经 purge_deleted 同样参数，返回值、三行、墓碑逐项相同');
select ok(tests.rows_cl(tests.ca_pw(), $$select private.purge_deleted_impl('[{"tbl": "todos", "id": "70000000-0000-4000-8000-0000000117a1"}]'::jsonb) as r$$) ->> 'error' like '%session_revoked%',
  'TC-B1-117 ④：A 的密码会话直接调 impl、参数带 T1，回 session_revoked');
select is(tests.s117(), (select v from tests.snap where k = '117'), 'TC-B1-117 ④：T1 仍在“最近删除”');

select * from finish();
rollback;
