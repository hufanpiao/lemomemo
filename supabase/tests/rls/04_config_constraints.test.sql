-- 配置、约束、桶和每日清理：TC-B0-53、74、76、88、98；TC-B1-58、66、70、72、106 ①；0.27（features、min_client_version）；P-05；0.31 第 15、17 条（remind_queue、注销级联）
begin;
select plan(52);
\ir _helpers.psql
select tests.seed();

-- ===== app_config.features（0.27 第 4 点；P-05：每项必须是对象、有布尔 on） =====
select is((select features from public.app_config), '{"event":{"on":true},"todo":{"on":true},"note":{"on":false},"anniv":{"on":false}}'::jsonb, '默认值写全四个键');
select is(tests.try_as('postgres', null, $$update public.app_config set features = features || '{"note":{"on":true,"min_client":"4.0.0"}}'$$), 'ok', '合法的开关能写');
select ok(tests.try_as('postgres', null, $$update public.app_config set features = '{"note":true}'$$) like '23514%', '值不是对象：拒绝');
select ok(tests.try_as('postgres', null, $$update public.app_config set features = '{"note":{"min_client":"4.0.0"}}'$$) like '23514%', '缺 on：拒绝');
select ok(tests.try_as('postgres', null, $$update public.app_config set features = '{"note":{"on":"true"}}'$$) like '23514%', 'on 是字符串：拒绝');
select ok(tests.try_as('postgres', null, $$update public.app_config set features = '{"note":[{"on":true}]}'$$) like '23514%',
  '值是数组：拒绝（strict 模式；lax 会把数组展开放过去）');
select ok(tests.try_as('postgres', null, $$update public.app_config set features = '[]'$$) like '23514%', 'features 不是对象：拒绝');
-- TC-B0-53
select ok(tests.try_as('postgres', null, $$update public.app_config set min_client_version = '4.1'$$) like '23514%', 'min_client_version = 4.1 被拒');
select is(tests.try_as('postgres', null, $$update public.app_config set min_client_version = '4.0.1'$$), 'ok', 'min_client_version = 4.0.1 能写');
select ok(tests.try_as('postgres', null, $$insert into public.app_config (id, ai) values (2, '{}')$$) like '23514%', 'app_config 只能有一行');
-- 换模型时间由触发器写
update public.app_config set ai = ai || '{"embed_model_next": "gemini-embedding-3"}';
select ok((select ai ? 'embed_model_next_set_at' from public.app_config), '改 embed_model_next：触发器写 embed_model_next_set_at');

-- ===== TC-B0-76：counters 键的格式（附录 A 的键各插一条，再插不合规的） =====
select is(tests.try_as('postgres', null, $$insert into private.counters (key, window_start, count) values
  ('ai:aaaaaaaa-0000-4000-8000-000000000001:2026-10-28', now(), 1),
  ('ai-min:aaaaaaaa-0000-4000-8000-000000000001:20261028T0930', now(), 1),
  ('media:aaaaaaaa-0000-4000-8000-000000000001:2026-10-28', now(), 1),
  ('search:aaaaaaaa-0000-4000-8000-000000000001:2026-10-28', now(), 1),
  ('search-min:aaaaaaaa-0000-4000-8000-000000000001:20261028T0930', now(), 1),
  ('logs:aaaaaaaa-0000-4000-8000-000000000001:2026-10-28', now(), 1),
  ('preview:aaaaaaaa-0000-4000-8000-000000000001:20261028T09', now(), 1),
  ('intake-h:aaaaaaaa-0000-4000-8000-000000000001:0b000000-0000-4000-8000-000000000001.20261028T09', now(), 1),
  ('intake-d:aaaaaaaa-0000-4000-8000-000000000001:0b000000-0000-4000-8000-000000000001.2026-10-28', now(), 1),
  ('signup-ip:ip:3f2a9c', now(), 1),
  ('signup-mail:mail:9c3f2a', now(), 1),
  ('signup:global:2026-10-28', now(), 1),
  ('ai:global:2026-10-28', now(), 1),
  ('embed:global:2026-10-28', now(), 1),
  ('account:aaaaaaaa-0000-4000-8000-000000000001:2026-10-28', now(), 1),
  ('rebind:aaaaaaaa-0000-4000-8000-000000000001:2026-10-28', now(), 1),
  ('restore:aaaaaaaa-0000-4000-8000-000000000001:2026-10-28', now(), 1),
  ('hook-err:global:20261028T0915', now(), 1),
  ('hook-alert:global:20261028T09', now(), 1)$$), 'ok', '附录 A 列的 19 种键都过得了约束');
select ok(tests.try_as('postgres', null, $$insert into private.counters values ('ai:aaaaaaaa-0000-4000-8000-000000000001:2026-10-28T09:30', now(), 1)$$) like '23514%', '第三段带冒号：拒绝');
select ok(tests.try_as('postgres', null, $$insert into private.counters values ('ai:2026-10-28', now(), 1)$$) like '23514%', '只有两段：拒绝');
select ok(tests.try_as('postgres', null, $$insert into private.counters values ('AI:global:x', now(), 1)$$) like '23514%', '用途名大写：拒绝');
select ok(tests.try_as('postgres', null, $$insert into private.counters values ('ai:someone:x', now(), 1)$$) like '23514%', '第二段既不是 uuid 也不是 global/ip/mail：拒绝');

-- ===== 架构 0.31 第 17 条（P-29）：remind_queue.table_name 只能是 events、todos、anniversaries =====
select is(tests.try_as('service_role', null, $$insert into private.remind_queue (table_name, id) values
  ('events', 'e0000000-0000-4000-8000-0000000000d1'), ('todos', '70000000-0000-4000-8000-0000000000d1'),
  ('anniversaries', 'a0000000-0000-4000-8000-0000000000d1')$$), 'ok', 'remind_queue：三张表的名字都能写（service_role，push-dispatch 的权限）');
select ok(tests.try_as('service_role', null, $$insert into private.remind_queue (table_name, id) values ('notes', 'e0000000-0000-4000-8000-0000000000d2')$$) like '23514%',
  'remind_queue：notes 被 check 拒绝');
select ok(tests.try_as('postgres', null, $$insert into private.remind_queue (table_name, id) values ('profiles', 'e0000000-0000-4000-8000-0000000000d3')$$) like '23514%',
  'remind_queue：postgres 写 profiles 也被 check 拒绝');
select ok(tests.try_as('postgres', null, $$insert into private.remind_queue (table_name, id) values ('Events', 'e0000000-0000-4000-8000-0000000000d4')$$) like '23514%',
  'remind_queue：大小写不同也拒绝');
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at) values
  ('a0000000-0000-4000-8000-0000000000d5', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', '妈妈', 'solar', 3, 5, 1, 1);
select is((select count(*)::int from private.remind_queue where table_name = 'anniversaries' and id = 'a0000000-0000-4000-8000-0000000000d5'), 1,
  'remind_queue：纪念日的触发器写入的名字过得了 check');
-- 架构 0.31 第 15 条：pending_deletions、revoked_sessions 随 auth.users 一起删（清单 cascade）；tombstones 也是
insert into private.pending_deletions (user_id, purge_after) values ('bbbbbbbb-0000-4000-8000-000000000002', now() + interval '30 days');
insert into private.revoked_sessions (session_id, user_id) values ('bbbbbbbb-5555-4000-8000-0000000000d6', 'bbbbbbbb-0000-4000-8000-000000000002');
insert into public.tombstones (tbl, id, user_id) values ('todos', '70000000-0000-4000-8000-0000000000d7', 'bbbbbbbb-0000-4000-8000-000000000002');
delete from auth.users where id = 'bbbbbbbb-0000-4000-8000-000000000002';
select is((select count(*)::int from private.pending_deletions where user_id = 'bbbbbbbb-0000-4000-8000-000000000002')
        + (select count(*)::int from private.revoked_sessions where user_id = 'bbbbbbbb-0000-4000-8000-000000000002')
        + (select count(*)::int from public.tombstones where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'), 0,
  '删 auth.users：pending_deletions、revoked_sessions、tombstones 跟着删');

-- ===== TC-B0-74（0.32 改）：storage.buckets 只剩 Supabase 的 2 个桶；images、files、vault-images、vault-files 在 R2 =====
select is((select string_agg(id || ':' || public || ':' || file_size_limit || ':' || cardinality(allowed_mime_types), ',' order by id) from storage.buckets),
  'backups:false:52428800:1,vault-preview:false:10485760:1',
  'storage.buckets 只有 backups、vault-preview，都是私有，大小和类型限制照附录 A');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'), 0,
  'storage.objects 上没有任何策略（0.32：img_*、file_* 由 files_authorize 取代；vault-preview、backups 本来就不建）');
select is((select count(*)::int from pg_proc where proname = 'file_slot_open'), 0, 'file_slot_open() 已删（判断并进 files_authorize_impl）');
-- 重跑桶的 insert … on conflict 能把手工改大的限制改回来
update storage.buckets set file_size_limit = 99999999 where id = 'backups';
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('backups', 'backups', false, 52428800, array['application/gzip'])
  on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
select is((select file_size_limit from storage.buckets where id = 'backups'), 52428800::bigint, '重跑迁移的桶语句把限制改回附录 A 的值');
-- 客户端经 storage-js 直传 Supabase Storage 一律不行（没有策略，RLS 拒绝）；能不能传改由 files_authorize 判断（05 文件）
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$insert into storage.objects (bucket_id, name) values ('backups',
  '2026-10-28/aaaaaaaa-0000-4000-8000-000000000001/todos.json.gz')$$) like '42501%', 'backups：客户端直传被拒');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$insert into storage.objects (bucket_id, name) values ('vault-preview',
  '0123456789abcdef0123456789abcdef.pptx')$$) like '42501%', 'vault-preview：客户端直传被拒');
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', 'select name from storage.objects'), '[]'::jsonb,
  'storage.objects：客户端读不到任何对象');

-- ===== TC-B0-88、98：每日清理 =====
insert into private.webauthn_challenges values ('old', 'aaaaaaaa-0000-4000-8000-000000000001', now() - interval '1 minute'),
                                               ('new', 'aaaaaaaa-0000-4000-8000-000000000001', now() + interval '1 minute');
insert into public.todos (id, user_id, title, deleted_at, created_at, updated_at) values
  ('70000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001', '31 天前删的', ((extract(epoch from now()) - 31 * 86400) * 1000)::bigint, 1, 1),
  ('70000000-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-000000000001', '昨天删的', ((extract(epoch from now()) - 86400) * 1000)::bigint, 1, 1);
select ok(private.cleanup_batch() >= 2, '每日清理跑一批');
select is((select string_agg(challenge, ',') from private.webauthn_challenges), 'new', '过期挑战清掉，没过期的留着');
select is((select string_agg(title, ',') from public.todos where id::text like '70000000-0000-4000-8000-0000000000c%'), '昨天删的', '30 天前软删除的行硬删，没满的留着');
select is((select count(*)::int from cron.job where command like 'set statement_timeout = ''4min''; select private.%'), 1, '清理的 cron 命令以 set statement_timeout 开头');
select is((select string_agg(s, ',') from pg_db_role_setting d, unnest(d.setconfig) s where d.setrole = 'service_role'::regrole), 'statement_timeout=4min',
  'service_role 的 statement_timeout = 4min');

-- ===== TC-B1-72、66、58：每日清理的保留天数（3.4；R-27；0.29 续第 48、64 条） =====
-- 天数照 private.cleanup_batch（20261029192000 版）：logs 按 t（毫秒）90 天；applied_ops 按 at 7 天；counters 按 window_start 30 天；
-- pending_signups 按 expires_at 过期即删。每种各放一条“刚超过”、一条“还差一点”的
insert into public.logs (user_id, t, kind, code) values
  ('aaaaaaaa-0000-4000-8000-000000000001', ((extract(epoch from now()) - 91 * 86400) * 1000)::bigint, 'tc72', 'd91'),
  ('aaaaaaaa-0000-4000-8000-000000000001', ((extract(epoch from now()) - 89 * 86400) * 1000)::bigint, 'tc72', 'd89');
insert into public.applied_ops (op_id, user_id, at) values
  ('0b720000-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-000000000001', now() - interval '8 days'),
  ('0b720000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001', now() - interval '6 days');
insert into private.counters (key, window_start, count) values
  ('signup-ip:ip:tc66-d31', now() - interval '31 days', 1), ('signup-ip:ip:tc66-d29', now() - interval '29 days', 1),
  ('signup-mail:mail:tc66-d31', now() - interval '31 days', 1), ('signup-mail:mail:tc66-d29', now() - interval '29 days', 1),
  ('signup:global:tc66-d31', now() - interval '31 days', 1), ('signup:global:tc66-d29', now() - interval '29 days', 1);
insert into private.pending_signups (email_hash, otp_hash, expires_at) values
  ('tc58-expired', 'x', now() - interval '1 minute'), ('tc58-valid', 'x', now() + interval '10 minutes');
select private.cleanup_batch();
-- TC-B1-72
select is((select string_agg(code, ',') from public.logs where kind = 'tc72'), 'd89', 'TC-B1-72：91 天前的 logs 删掉、89 天前的留着');
select is((select string_agg(op_id::text, ',') from public.applied_ops where op_id::text like '0b720000-%'), '0b720000-0000-4000-8000-000000000006',
  'TC-B1-72：8 天前的 applied_ops 删掉、6 天前的留着');
-- TC-B1-66
select is((select string_agg(key, ',') from private.counters where key like 'signup-ip:ip:tc66-%'), 'signup-ip:ip:tc66-d29',
  'TC-B1-66：signup-ip:ip:* 31 天前的删掉、29 天前的留着');
select is((select string_agg(key, ',') from private.counters where key like 'signup-mail:mail:tc66-%'), 'signup-mail:mail:tc66-d29',
  'TC-B1-66：signup-mail:mail:* 31 天前的删掉、29 天前的留着');
select is((select string_agg(key, ',') from private.counters where key like 'signup:global:tc66-%'), 'signup:global:tc66-d29',
  'TC-B1-66：signup:global:* 31 天前的删掉、29 天前的留着');
-- TC-B1-58
select is((select string_agg(email_hash, ',') from private.pending_signups where email_hash like 'tc58-%'), 'tc58-valid',
  'TC-B1-58：过期的 pending_signups 被每日清理删掉，没过期的留着');

-- ===== TC-B1-70：private.invites.note 最多 40 个字符（char_length 按码点数；invite-admin 用 service role 写） =====
select ok(tests.try_as('service_role', null, $$insert into private.invites (code_hash, max_uses, used_count, expires_at, note)
  values ('tc70-41', 1, 0, now() + interval '7 days', repeat('一', 40) || 'x')$$) like '23514%', 'TC-B1-70：备注 41 个码点：拒绝（23514）');
select is(tests.try_as('service_role', null, $$insert into private.invites (code_hash, max_uses, used_count, expires_at, note)
  values ('tc70-han', 1, 0, now() + interval '7 days', repeat('一', 40))$$), 'ok', 'TC-B1-70：备注 40 个汉字能写');
select is(tests.try_as('service_role', null, $$insert into private.invites (code_hash, max_uses, used_count, expires_at, note)
  values ('tc70-emoji', 1, 0, now() + interval '7 days', repeat(U&'\+01F600', 40))$$), 'ok',
  'TC-B1-70：备注 40 个 emoji（40 个码点，UTF-16 是 80 个单元）能写');

-- ===== TC-B1-106 ①：2500 行 30 天前软删除的行，每次运行只做一批（≤ 1000 行）：1000、1000、500，之后立即返回 0 =====
-- 先把前面留下的可清理行清空（各项共用一个 1000 行预算），保证下面的返回值只来自这 2500 行
do $$ begin while private.cleanup_batch() > 0 loop end loop; end $$;
select is(private.cleanup_batch(), 0, 'TC-B1-106 ①：清空后再跑一次，没有要删的，返回 0');
insert into public.todos (id, user_id, title, deleted_at, created_at, updated_at)
  select ('7b106000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'aaaaaaaa-0000-4000-8000-000000000001', 'tc106',
         ((extract(epoch from now()) - 31 * 86400) * 1000)::bigint, 1, 1
    from generate_series(1, 2500) g;
select is(private.cleanup_batch(), 1000, 'TC-B1-106 ①：第 1 次运行删 1000 行');
select is((select count(*)::int from public.todos where title = 'tc106'), 1500, 'TC-B1-106 ①：第 1 次后剩 1500 行');
select is((select (detail ->> 'rows')::int || ':' || (detail ? 'ms')::text from private.heartbeat where name = 'cleanup'), '1000:true',
  'TC-B1-106 ①：心跳 detail 记这一批的行数和用时（ms）');
select is(private.cleanup_batch(), 1000, 'TC-B1-106 ①：第 2 次运行删 1000 行');
select is((select count(*)::int from public.todos where title = 'tc106'), 500, 'TC-B1-106 ①：第 2 次后剩 500 行');
select is(private.cleanup_batch(), 500, 'TC-B1-106 ①：第 3 次运行删 500 行');
select is((select count(*)::int from public.todos where title = 'tc106'), 0, 'TC-B1-106 ①：第 3 次后删完');
select is(private.cleanup_batch(), 0, 'TC-B1-106 ①：第 4 次起没有要删的，立即返回 0');

select * from finish();
rollback;
