-- 触发器和 RPC：touch()（TC-B0-28、72）、settings_guard、guard_profile_disabled、devices 会话、row_quota（TC-B0-37）、
--   tombstones 和 purge_deleted（TC-B0-95、96）、admin_set_disabled、account_usable
begin;
select plan(53);
\ir _helpers.psql
select tests.seed();

-- ===== touch() =====
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todos (id, title, due, due_time, remind_before_min, created_at, updated_at)
    values ('70000000-0000-4000-8000-000000000001', 'T', '2026-11-01', '17:00', 60, 1, 1)$$), 'ok', 'A 建一条带截止时刻的待办');
select is((select rev from public.todos where id = '70000000-0000-4000-8000-000000000001'), 1, '新行 rev = 1');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.todos set title = 'T2', updated_at = 2 where id = '70000000-0000-4000-8000-000000000001'$$), 'ok', '改标题');
select is((select rev from public.todos where id = '70000000-0000-4000-8000-000000000001'), 2, '改普通列 rev 加 1');
select is((select fv->>'title' from public.todos where id = '70000000-0000-4000-8000-000000000001'), '2', 'fv 记下 title 的版本');
select ok((select not (fv ? 'updated_at') from public.todos where id = '70000000-0000-4000-8000-000000000001'), 'updated_at 不进 fv');
update public.todos set remind_at = 123 where id = '70000000-0000-4000-8000-000000000001';   -- 以 postgres 写系统列
select is((select rev from public.todos where id = '70000000-0000-4000-8000-000000000001'), 2, '只改系统列 remind_at：rev 不变');
-- 0.29 续第 136 条：旧版客户端清空 due，due_time、remind_before_min 一起清
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.todos set due = null where id = '70000000-0000-4000-8000-000000000001'$$), 'ok', '旧版客户端只清 due 也能写入');
select is((select coalesce(due_time, 'null') || '/' || coalesce(remind_before_min::text, 'null') from public.todos where id = '70000000-0000-4000-8000-000000000001'),
  'null/null', 'due_time、remind_before_min 随之置空');
select is((select fv->>'due_time' from public.todos where id = '70000000-0000-4000-8000-000000000001'), '3', 'due_time 的变化进 fv（别的设备照常同步）');
-- 提醒字段变了清空推迟和推送去重
insert into public.events (id, user_id, title, date, time, tz, pushed_for, defer_until, created_at, updated_at)
  values ('e0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'E', '2026-11-01', '09:00', 'Asia/Seoul', 5, 6, 1, 1);
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.events set time = '10:00' where id = 'e0000000-0000-4000-8000-000000000001'$$), 'ok', '改日程时刻');
select is((select coalesce(pushed_for::text, 'null') || '/' || coalesce(defer_until::text, 'null') from public.events where id = 'e0000000-0000-4000-8000-000000000001'),
  'null/null', '改时刻清空 pushed_for、defer_until');
select is((select count(*)::int from private.remind_queue where id = 'e0000000-0000-4000-8000-000000000001'), 1, '改时刻入 remind_queue');

-- TC-B0-28：没登记 table_meta 的表挂 touch() 报 table_meta_missing
create table public.qa_probe (id uuid primary key, user_id uuid, rev int, fv jsonb, synced_at timestamptz, x int);
create trigger qa_probe_touch before insert or update on public.qa_probe for each row execute function private.touch();
select ok(tests.try_as('postgres', null, $$insert into public.qa_probe values ('99999999-0000-4000-8000-000000000001', null, 1, '{}', now(), 1)$$)
  like '%table_meta_missing: qa_probe%', '没登记的表写入时报 table_meta_missing（不悄悄多加 rev）');
select ok(tests.try_as('postgres', null, $$select * from private.table_meta_of('qa_probe')$$) like '%table_meta_missing%', 'table_meta_of(qa_probe) 报错');

-- TC-B0-72：四种角色写挂 touch() 的表都不报 42501
select is(tests.try_as('service_role', null, $$
  insert into public.settings (id, user_id, key, value) values (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-000000000001', 'remind.enabled', 'true');
  insert into public.events (id, user_id, title, date, created_at, updated_at) values (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-000000000001', 'S', '2026-11-02', 1, 1);
  insert into public.notes (id, user_id, body, created_at, updated_at) values ('40000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'n', 1, 1);
  insert into public.note_images (id, user_id, note_id, bucket, path, bytes) values ('1e000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001/1e000000-0000-4000-8000-000000000001.webp', 1)$$),
  'ok', 'service_role 写 settings、events、notes、note_images');
select is(tests.try_as('fn_vault', null, $$
  update public.notes set title = null, body = null, is_private = true, body_enc = '\x01', enc_key_id = 1 where id = '40000000-0000-4000-8000-000000000001'$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), 'ok', 'fn_vault 把随手记移进隐私记（touch 不报 42501）');
select is(tests.try_as('fn_ai', null, $$
  update public.note_images set ai_desc = '猫', ai_status = 'done' where id = '1e000000-0000-4000-8000-000000000001'$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), 'ok', 'fn_ai 写图片描述');
select is((select rev from public.note_images where id = '1e000000-0000-4000-8000-000000000001'), 1, 'ai_desc 是系统列：rev 不变');
select is((select rev from public.notes where id = '40000000-0000-4000-8000-000000000001'), 2, '移进隐私记加 rev（is_private、body_enc 不是系统列，P-39）');

-- ===== settings_guard：ai.vault 只能经服务器打开 =====
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.settings (id, key, value) values (gen_random_uuid(), 'ai.vault', 'true')$$) like '%vault_required%', '客户端打开 ai.vault 被拒');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.settings (id, key, value) values ('5e000000-0000-4000-8000-000000000001', 'ai.vault', 'false')$$), 'ok', '客户端关掉 ai.vault 可以');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  update public.settings set value = 'true' where id = '5e000000-0000-4000-8000-000000000001'$$) like '%vault_required%', '客户端改回 true 被拒');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  update public.settings set value = '"yes"' where id = '5e000000-0000-4000-8000-000000000001'$$) like '%vault_required%', '客户端写非布尔值也被拒');
select ok(tests.try_as('service_role', null, $$
  update public.settings set value = '"yes"' where id = '5e000000-0000-4000-8000-000000000001'$$) like '23514%', 'ai.vault 非布尔值违反 check（service_role 也不行）');
select is(tests.try_as('service_role', null, $$
  update public.settings set value = 'true' where id = '5e000000-0000-4000-8000-000000000001'$$), 'ok', 'service_role 能打开 ai.vault');
select is((select count(*)::int from private.embed_queue where source_id = '40000000-0000-4000-8000-000000000001' and kind = 'note'), 1,
  '打开 ai.vault：隐私记正文重新入队（vault_ai_on）');

-- ===== guard_profile_disabled：列级授权之外的第二道 =====
grant update (disabled_at, disabled_reason) on public.profiles to authenticated;   -- 模拟列授权被误加
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.profiles set disabled_at = now(), disabled_reason = 'admin' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '%disabled_readonly%',
  '误加列授权时触发器仍拦下客户端改停用列');
revoke update (disabled_at, disabled_reason) on public.profiles from authenticated;
select is(tests.try_as('service_role', null,
  $$update public.profiles set disabled_at = now(), disabled_reason = 'deletion' where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'$$), 'ok', 'service_role 能停用');
select is(private.account_usable('bbbbbbbb-0000-4000-8000-000000000002'), false, '停用后 account_usable = false');
insert into private.pending_deletions (user_id, purge_after) values ('bbbbbbbb-0000-4000-8000-000000000002', now() + interval '7 days');
select private.admin_set_disabled('bbbbbbbb-0000-4000-8000-000000000002', false);
select is((select disabled_reason from public.profiles where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'), 'deletion', '冷静期内解除管理员停用：仍是 deletion');
delete from private.pending_deletions;
select private.admin_set_disabled('bbbbbbbb-0000-4000-8000-000000000002', false);
select is(private.account_usable('bbbbbbbb-0000-4000-8000-000000000002'), true, '没有冷静期时解除停用');

-- ===== devices：会话 =====
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.devices (id, platform) values (gen_random_uuid(), 'ios')$$, null, 'aaaaaaaa-9999-4000-8000-000000000009') like '%session_revoked%',
  '会话不在 auth.sessions：写 devices 报 session_revoked');
insert into private.revoked_sessions (session_id, user_id) values ('aaaaaaaa-5555-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.devices (id, platform) values (gen_random_uuid(), 'ios')$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '%session_revoked%',
  '会话已吊销：写 devices 报 session_revoked');
delete from private.revoked_sessions;

-- ===== row_quota（TC-B0-37） =====
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.settings (id, key, value) values (gen_random_uuid(), 'ui.big', to_jsonb(repeat('x', 5000)))$$) like '23514%', 'settings 值超过 4 KB 被拒');
insert into public.categories (id, user_id, name)   -- postgres 写，豁免
  select gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-000000000001', 'c' || g from generate_series(1, 19999) g;
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.categories (id, name) values (gen_random_uuid(), '第两万个')$$), 'ok', '第 20000 行能写');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.categories (id, name) values (gen_random_uuid(), '超了')$$) like '%quota%', '第 20001 行报 quota');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.logs (t) select g from generate_series(1, 2000) g$$), 'ok', '一天 2000 条日志能写');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.logs (t) values (1)$$) like '%quota%', '第 2001 条日志报 quota');
delete from public.categories where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
delete from public.tombstones;

-- ===== purge_deleted 和 tombstones（TC-B0-95、96） =====
insert into public.todos (id, user_id, title, deleted_at, created_at, updated_at) values
  ('70000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-000000000001', 'T1', 1, 1, 1),
  ('70000000-0000-4000-8000-0000000000d2', 'aaaaaaaa-0000-4000-8000-000000000001', 'T2', null, 1, 1),
  ('70000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'TB', 1, 1, 1);
insert into public.events (id, user_id, title, date, deleted_at, undone, created_at, updated_at) values
  ('e0000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-000000000001', 'E1', '2026-11-01', 1, false, 1, 1),
  ('e0000000-0000-4000-8000-0000000000d2', 'aaaaaaaa-0000-4000-8000-000000000001', 'U', '2026-11-01', 1, true, 1, 1);
insert into public.notes (id, user_id, body, deleted_at, created_at, updated_at) values
  ('40000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-000000000001', 'N1', 1, 1, 1);
insert into public.notes (id, user_id, is_private, body_enc, deleted_at, created_at, updated_at) values
  ('40000000-0000-4000-8000-0000000000d2', 'aaaaaaaa-0000-4000-8000-000000000001', true, '\x01', 1, 1, 1);
insert into public.note_images (id, user_id, note_id, bucket, path, bytes) values ('1e000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-0000000000d1', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000d1/1e000000-0000-4000-8000-0000000000d1.webp', 1);
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select public.purge_deleted('[{"tbl":"profiles","id":"aaaaaaaa-0000-4000-8000-000000000001"}]')$$) like '%bad_table%', 'purge_deleted 不认的表名：bad_table');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select public.purge_deleted((select jsonb_agg(jsonb_build_object('tbl','todos','id',gen_random_uuid())) from generate_series(1, 501)))$$) like '%too_many_items%',
  'purge_deleted 超过 500 项整批拒绝');
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select public.purge_deleted() as n$$), '[{"n": 4}]'::jsonb,
  'A 全部清空：删 T1、E1、撤销行 U、普通随手记 N1');
select is((select string_agg(title, ',' order by title) from public.todos where id in ('70000000-0000-4000-8000-0000000000d2', '70000000-0000-4000-8000-0000000000b1')), 'T2,TB',
  '没删的 T2、B 的 TB 还在');
select is((select count(*)::int from public.notes where id = '40000000-0000-4000-8000-0000000000d2'), 1, '隐私随手记 V1 不归 purge_deleted');
select is((select count(*)::int from public.note_images where id = '1e000000-0000-4000-8000-0000000000d1'), 0, 'N1 的图片随外键级联删掉');
select is((select string_agg(t.tbl || ':' || right(t.id::text, 2), ',' order by t.tbl, t.id) from public.tombstones t),
  'events:d1,events:d2,note_images:d1,notes:d1,todos:d1', '硬删的 5 行都留了墓碑（只有 id）');
select is(jsonb_array_length(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select id from public.tombstones$$)), 5, 'A 读得到自己的墓碑');
select is(jsonb_array_length(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$select id from public.tombstones$$)), 0, 'B 读不到 A 的墓碑');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$delete from public.tombstones$$) like '42501%', '客户端不能删墓碑');
select is(tests.try_as('fn_vault', null, $$select private.purge_vault_impl('aaaaaaaa-0000-4000-8000-000000000001')$$, 'aaaaaaaa-0000-4000-8000-000000000001'), 'ok',
  'fn_vault 清空 A 的隐私记');
select is((select count(*)::int from public.notes where id = '40000000-0000-4000-8000-0000000000d2'), 0, 'V1 已删');
select ok(tests.try_as('fn_vault', null, $$select private.purge_vault_impl('bbbbbbbb-0000-4000-8000-000000000002')$$, 'aaaaaaaa-0000-4000-8000-000000000001') like '%uid_mismatch%',
  'p_user 和 app.uid 不一致：uid_mismatch');
-- 停用账号硬删不写墓碑（注销冷静期、管理员停用）
delete from public.tombstones;
update public.profiles set disabled_at = now(), disabled_reason = 'admin' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
delete from public.todos where id = '70000000-0000-4000-8000-0000000000d2';
select is((select count(*)::int from public.tombstones), 0, '停用账号的行硬删时不写墓碑');

select * from finish();
rollback;
