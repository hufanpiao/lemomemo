-- 角色属性和授权白名单：TC-B0-33、34、69、70、77、78、81、86、87、95（表级 DELETE）；3.3 C、6.2
begin;
select plan(41);
\ir _helpers.psql
select tests.seed();

-- ===== TC-B0-33：fn_vault、fn_ai 的角色属性 =====
select is((select string_agg(rolname || ':' || (rolsuper or rolinherit or rolcreaterole or rolcreatedb or rolbypassrls or rolreplication), ',' order by rolname)
  from pg_roles where rolname in ('fn_vault', 'fn_ai')), 'fn_ai:false,fn_vault:false', '两个函数角色：非超级、noinherit、不能建角色和库、不绕过 RLS');
select ok(not exists (select 1 from pg_roles where rolname in ('fn_vault', 'fn_ai') and rolcanlogin and rolpassword is null),
  '迁移不设密码（能登录的一定是负责人手工设过密码的）');
select ok(not has_schema_privilege('fn_vault', 'public', 'CREATE') and not has_schema_privilege('fn_ai', 'public', 'CREATE')
  and not has_schema_privilege('fn_vault', 'private', 'CREATE') and not has_schema_privilege('fn_ai', 'private', 'CREATE'), '两个角色在 public、private 都没有 CREATE');
select ok(has_schema_privilege('fn_ai', 'extensions', 'USAGE') and not has_schema_privilege('fn_vault', 'extensions', 'USAGE'), 'extensions 的 USAGE 只给 fn_ai');

-- ===== TC-B0-77：API 角色不是函数角色的成员（不能经 PostgREST 切过去） =====
select ok(not exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
   where r.rolname in ('fn_vault', 'fn_ai') and u.rolname in ('authenticator', 'anon', 'authenticated', 'service_role')),
  'authenticator、anon、authenticated、service_role 都不是 fn_vault、fn_ai 的成员');
select ok(not exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
   where u.rolname in ('fn_vault', 'fn_ai')), 'fn_vault、fn_ai 自己不是任何角色的成员');

-- ===== TC-B0-78：四个扫描视图 =====
select is((select string_agg(c.relname || ':' || pg_get_userbyid(c.relowner) || ':' || array_to_string(c.reloptions, ';'), ',' order by c.relname)
  from pg_class c where c.relnamespace = 'private'::regnamespace and c.relkind = 'v'),
  'scan_embed_queue:postgres:security_barrier=true,scan_note_files:postgres:security_barrier=true,scan_note_images:postgres:security_barrier=true,scan_vault_preview:postgres:security_barrier=true',
  '扫描视图正好四个，归 postgres，都带 security_barrier');
select is((select string_agg(table_name || ':' || grantee, ',' order by table_name, grantee) from information_schema.role_table_grants
  where table_schema = 'private' and table_name like 'scan\_%' and grantee <> 'postgres'),
  'scan_embed_queue:fn_ai,scan_note_files:fn_ai,scan_note_images:fn_ai,scan_vault_preview:fn_vault', '扫描视图只给 fn_ai（三个）、fn_vault（一个）');

-- ===== TC-B0-81：private 的表和视图对 anon、authenticated 没有任何权限 =====
select is((select count(*)::int from pg_class c cross join (values ('anon'), ('authenticated')) r(role)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
  where c.relnamespace = 'private'::regnamespace and c.relkind in ('r', 'v') and has_table_privilege(r.role, c.oid, p.priv)), 0,
  'anon、authenticated 对 private 任何表、视图都没有权限');
select is((select count(*)::int from information_schema.column_privileges where table_schema = 'private' and grantee in ('anon', 'authenticated')), 0,
  'anon、authenticated 对 private 也没有列权限');

-- service_role 对 private 的表级授权和 3.3 C 白名单逐项相等
select is((select string_agg(table_name || ':' || privilege_type, ',' order by table_name, privilege_type) from information_schema.role_table_grants
  where table_schema = 'private' and grantee = 'service_role'),
  'admins:SELECT,ai_state:INSERT,ai_state:SELECT,ai_state:UPDATE,counters:DELETE,counters:INSERT,counters:SELECT,counters:UPDATE,deleted_accounts:INSERT,deleted_accounts:SELECT,'
  || 'heartbeat:INSERT,heartbeat:SELECT,heartbeat:UPDATE,invites:INSERT,invites:SELECT,invites:UPDATE,pending_deletions:DELETE,pending_deletions:INSERT,pending_deletions:SELECT,pending_deletions:UPDATE,'
  || 'pending_signups:DELETE,pending_signups:INSERT,pending_signups:SELECT,pending_signups:UPDATE,remind_queue:DELETE,remind_queue:INSERT,remind_queue:SELECT,user_limits:SELECT',
  'service_role 对 private 的授权 = 3.3 C 白名单');

-- fn_vault、fn_ai 的表级授权 = 6.2 逐表清单（列级的另由 D1 核对）
select is((select string_agg(table_schema || '.' || table_name || ':' || privilege_type, ',' order by table_schema, table_name, privilege_type)
  from information_schema.role_table_grants where grantee = 'fn_vault'),
  'private.counters:INSERT,private.counters:SELECT,private.counters:UPDATE,private.device_secrets:DELETE,private.device_secrets:INSERT,private.device_secrets:SELECT,private.device_secrets:UPDATE,'
  || 'private.embed_queue:DELETE,private.note_vectors:DELETE,private.scan_vault_preview:SELECT,'
  || 'private.vault:DELETE,private.vault:INSERT,private.vault:SELECT,private.vault:UPDATE,private.vault_ai:DELETE,private.vault_ai:SELECT,'
  || 'private.vault_credentials:DELETE,private.vault_credentials:INSERT,private.vault_credentials:SELECT,private.vault_credentials:UPDATE,'
  || 'private.vault_preview:DELETE,private.vault_preview:INSERT,private.vault_preview:SELECT,private.vault_preview:UPDATE,'
  || 'private.webauthn_challenges:DELETE,private.webauthn_challenges:INSERT,private.webauthn_challenges:SELECT,'
  || 'public.note_files:INSERT,public.note_files:SELECT,public.note_files:UPDATE,public.note_images:INSERT,public.note_images:SELECT,public.note_images:UPDATE,'
  || 'public.notes:INSERT,public.notes:SELECT,public.notes:UPDATE',
  'fn_vault 的表级授权 = 6.2（同步表不给 delete，settings 什么都不给）');
select is((select string_agg(table_schema || '.' || table_name || ':' || privilege_type, ',' order by table_schema, table_name, privilege_type)
  from information_schema.role_table_grants where grantee = 'fn_ai'),
  'private.counters:INSERT,private.counters:SELECT,private.counters:UPDATE,private.embed_queue:DELETE,private.embed_queue:INSERT,private.embed_queue:SELECT,private.embed_queue:UPDATE,'
  || 'private.heartbeat:INSERT,private.heartbeat:UPDATE,private.note_vectors:INSERT,private.note_vectors:SELECT,private.note_vectors:UPDATE,'
  || 'private.scan_embed_queue:SELECT,private.scan_note_files:SELECT,private.scan_note_images:SELECT,private.user_limits:SELECT,'
  || 'private.vault_ai:INSERT,private.vault_ai:SELECT,private.vault_ai:UPDATE',
  'fn_ai 的表级授权 = 6.2（public 表只有列级）');

-- ===== 函数执行权（3.3 C；0.29 续第 55 条） =====
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace
  and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))), 0, 'private 没有一个函数给 PUBLIC 执行权');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace and pg_get_userbyid(p.proowner) <> 'postgres'), 0,
  'private 每个函数的属主都是 postgres');
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
  where p.pronamespace = 'private'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  'devices_session_guard,enqueue_anniv_defaults,enqueue_embed,enqueue_remind,files_authorize_impl,guard_note_file,guard_note_image,guard_token_revoke,is_active,'
  || 'my_sessions_impl,not_password_session,purge_deleted_impl,record_consent_impl,remove_device_impl,report_tz_impl,row_quota,table_meta_of,touch,vault_ai_off',
  'authenticated 能执行的 private 函数 = 白名单（B1 迁移 20261029192000 建了 report_tz_impl、remove_device_impl、my_sessions_impl；claim_endpoint_impl B2、my_ai_usage_impl B3）');
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
  where p.pronamespace = 'private'::regnamespace and has_function_privilege('anon', p.oid, 'EXECUTE')), null, 'anon 不能执行任何 private 函数');
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
  where p.pronamespace = 'private'::regnamespace and has_function_privilege('service_role', p.oid, 'EXECUTE')),
  'account_request_deletion,account_restore,account_usable,auth_mail_counts,long_transactions,rebind_device_impl,session_alive,take_rate', 'service_role 能执行的 private 函数 = 白名单（auth_mail_counts 是 B1 迁移 20261029230000 建的；rebind_device_impl 是 B1 迁移 20261029192000 建的；take_rate 是 B1 迁移 20261029130000 建的；account_request_deletion、account_restore 是 B1 迁移 20261029150000 建的）');
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
  where p.pronamespace = 'private'::regnamespace and has_function_privilege('fn_vault', p.oid, 'EXECUTE')), 'purge_vault_impl', 'fn_vault 只能执行 purge_vault_impl');
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
  where p.pronamespace = 'private'::regnamespace and has_function_privilege('fn_ai', p.oid, 'EXECUTE')), null, 'fn_ai 不能执行任何 private 函数');
select is((select string_agg(p.proname || ':' || p.prosecdef, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace),
  'apply_patch:false,files_authorize:false,my_sessions:false,purge_deleted:false,record_consent:false,remove_device:false,report_tz:false',
  'public 里只有这七个 RPC，都是 security invoker（B1 迁移 20261029192000 加了 report_tz、remove_device、my_sessions，20261029200000 加了 apply_patch；claim_endpoint B2、my_ai_usage B3）');
select ok(not has_function_privilege('anon', 'public.purge_deleted(jsonb)', 'EXECUTE') and not has_function_privilege('anon', 'public.record_consent(text, boolean)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.purge_deleted(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.files_authorize(text, jsonb)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.files_authorize(text, jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.files_authorize(text, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.report_tz(text, uuid, text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.report_tz(text, uuid, text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.report_tz(text, uuid, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.remove_device(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.remove_device(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.remove_device(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.my_sessions()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.my_sessions()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.my_sessions()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.apply_patch(text, uuid, jsonb, int, uuid, int[])', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.apply_patch(text, uuid, jsonb, int, uuid, int[])', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.apply_patch(text, uuid, jsonb, int, uuid, int[])', 'EXECUTE'), 'public RPC 只授给 authenticated');

-- ===== TC-B0-95：表级 DELETE 只有 devices =====
select is((select string_agg(table_name || ':' || grantee, ',' order by table_name, grantee) from information_schema.role_table_grants
  where table_schema = 'public' and privilege_type = 'DELETE' and grantee in ('anon', 'authenticated')), 'devices:authenticated', '客户端的表级 DELETE 只有 devices');
select is((select string_agg(table_name || ':' || privilege_type, ',' order by table_name, privilege_type) from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')), null,
  '客户端没有表级 INSERT、UPDATE（只有列级）');
select is((select string_agg(event_object_table, ',' order by event_object_table) from information_schema.triggers
  where action_statement like '%write_tombstone%'), 'anniversaries,categories,devices,events,note_files,note_images,notes,settings,todos', 'write_tombstone 挂在 9 张同步表上');

-- ===== 会话变量版 RLS =====
insert into private.user_limits (user_id, media_mb) values ('aaaaaaaa-0000-4000-8000-000000000001', 700), ('bbbbbbbb-0000-4000-8000-000000000002', 50);
insert into public.notes (id, user_id, body, created_at, updated_at) values
  ('40000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'A', 1, 1),
  ('40000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'B', 1, 1);
insert into public.note_files (id, user_id, note_id, kind, path, name, mime, bytes, sha256, text_excerpt, created_at, updated_at) values
  ('f0000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', '40000000-0000-4000-8000-0000000000b1', 'pdf',
   'bbbbbbbb-0000-4000-8000-000000000002/40000000-0000-4000-8000-0000000000b1/f0000000-0000-4000-8000-0000000000b1.pdf', 'b-secret.pdf', 'application/pdf', 1, 'x', 'B 的正文', 1, 1);
-- TC-B0-34：漏写 where user_id 也只看到本人
select is(tests.rows_as('fn_ai', null, $$select count(*) as n from private.user_limits$$, 'aaaaaaaa-0000-4000-8000-000000000001'), '[{"n": 1}]'::jsonb,
  'fn_ai 漏写 where：只看到 A 的一行');
-- TC-B0-69：没设 app.uid（上一事务设过，读到空串）
select is(tests.rows_as('fn_ai', null, $$select count(*) as n from private.user_limits$$), '[{"n": 0}]'::jsonb, '没设 app.uid：什么都读不到，也不报错');
select ok(tests.try_as('fn_vault', null, $$insert into private.counters values ('preview:aaaaaaaa-0000-4000-8000-000000000001:2026102809', now(), 1)$$) like '42501%',
  '没设 app.uid：写入被拒');
-- TC-B0-70：扫描视图看得到待处理条目，直接读别人的列读不到
select is(jsonb_array_length(tests.rows_as('fn_ai', null, $$select id from private.scan_note_files$$, 'aaaaaaaa-0000-4000-8000-000000000001')), 1,
  'fn_ai 用扫描视图列出全部待处理附件（含 B 的）');
select is(tests.rows_as('fn_ai', null, $$select name, text_excerpt from public.note_files$$, 'aaaaaaaa-0000-4000-8000-000000000001'), '[]'::jsonb,
  'fn_ai 以 A 的身份读不到 B 的 name、text_excerpt');
select ok(tests.try_as('fn_ai', null, $$select * from private.scan_note_files where user_id is not null and text_excerpt is not null$$,
  'aaaaaaaa-0000-4000-8000-000000000001') like '42703%', '扫描视图里没有正文列');
-- TC-B0-86：fn_vault 只认本人的计数键，不给 global
select is(tests.try_as('fn_vault', null, $$insert into private.counters values ('preview:aaaaaaaa-0000-4000-8000-000000000001:2026102809', now(), 1)$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), 'ok', 'fn_vault 写本人的 preview 键');
select ok(tests.try_as('fn_vault', null, $$insert into private.counters values ('preview:bbbbbbbb-0000-4000-8000-000000000002:2026102809', now(), 1)$$,
  'aaaaaaaa-0000-4000-8000-000000000001') like '42501%', 'fn_vault 写 B 的键被拒');
select ok(tests.try_as('fn_vault', null, $$insert into private.counters values ('ai:global:2026-10-28', now(), 1)$$,
  'aaaaaaaa-0000-4000-8000-000000000001') like '42501%', 'fn_vault 写 global 键被拒');
select is(tests.try_as('fn_ai', null, $$insert into private.counters values ('ai:global:2026-10-28', now(), 1)$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), 'ok', 'fn_ai 写 global 键（fn_global 策略）');
-- TC-B0-87：webauthn_challenges
insert into private.webauthn_challenges values ('chal-a', 'aaaaaaaa-0000-4000-8000-000000000001', now() + interval '1 minute'),
                                               ('chal-b', 'bbbbbbbb-0000-4000-8000-000000000002', now() + interval '1 minute');
select is(tests.rows_as('fn_vault', null, $$select challenge from private.webauthn_challenges$$, 'aaaaaaaa-0000-4000-8000-000000000001'),
  '[{"challenge": "chal-a"}]'::jsonb, 'fn_vault 只读到 A 的挑战');
select is(tests.try_as('fn_vault', null, $$delete from private.webauthn_challenges where challenge in ('chal-a', 'chal-b')$$, 'aaaaaaaa-0000-4000-8000-000000000001'), 'ok', 'fn_vault 删挑战');
select is((select string_agg(challenge, ',') from private.webauthn_challenges), 'chal-b', '只删掉了 A 的，B 的还在');
select ok(tests.try_as('fn_ai', null, $$select 1 from private.webauthn_challenges$$, 'aaaaaaaa-0000-4000-8000-000000000001') like '42501%', 'fn_ai 读挑战被拒');
select ok(tests.try_as('service_role', null, $$select 1 from private.webauthn_challenges$$) like '42501%', 'service_role 读挑战被拒（0.29 续第 63 条）');
select ok(tests.try_as('service_role', null, $$select 1 from private.vault$$) like '42501%', 'service_role 读 private.vault 被拒（0.29 续第 52 条 ①）');

select * from finish();
rollback;
