-- 客户端身份（A、B、anon）的 RLS 和列级授权：TC-B0-32、38、54、55、79、94
-- 跑法：supabase test db（待 Docker）；离线：supabase/tests/offline/run.mjs
begin;
select plan(48);
\ir _helpers.psql
select tests.seed();

-- A 的数据（以 A 的身份写，顺便验证正常写入能过）
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.events (id, title, date, created_at, updated_at) values ('e0000000-0000-4000-8000-00000000000a', 'A 的日程', '2026-11-01', 1, 1);
  insert into public.todos (id, title, created_at, updated_at) values ('70000000-0000-4000-8000-00000000000a', 'A 的待办', 1, 1);
  insert into public.categories (id, name) values ('ca000000-0000-4000-8000-00000000000a', '工作');
  insert into public.notes (id, body, category_id, created_at, updated_at) values ('40000000-0000-4000-8000-00000000000a', '正文', 'ca000000-0000-4000-8000-00000000000a', 1, 1);
  insert into public.anniversaries (id, kind, name, calendar, month, day, created_at, updated_at) values ('a0000000-0000-4000-8000-00000000000a', 'birthday', '妈妈', 'lunar', 3, 5, 1, 1);
  insert into public.settings (id, key, value) values ('5e000000-0000-4000-8000-00000000000a', 'ui.theme', '"dark"');
  insert into public.logs (t, kind, act) values (1, 'sync', 'push');
  insert into public.applied_ops (op_id, result) values ('0b000000-0000-4000-8000-00000000000a', '{}');
$$), 'ok', 'A 能写自己的 events、todos、categories、notes、anniversaries、settings、logs、applied_ops');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.note_images (id, note_id, bucket, path, bytes) values ('1e000000-0000-4000-8000-00000000000a', '40000000-0000-4000-8000-00000000000a', 'images',
    'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-00000000000a/1e000000-0000-4000-8000-00000000000a.webp', 100);
  insert into public.note_files (id, note_id, kind, path, name, mime, bytes, sha256, created_at, updated_at) values ('f0000000-0000-4000-8000-00000000000a', '40000000-0000-4000-8000-00000000000a', 'pdf',
    'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-00000000000a/f0000000-0000-4000-8000-00000000000a.pdf', 'a.pdf', 'application/pdf', 100, 'x', 1, 1);
$$), 'ok', 'A 能给自己的随手记加图片和附件');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.devices (id, platform) values ('de000000-0000-4000-8000-00000000000a', 'web')$$,
  null, 'aaaaaaaa-5555-4000-8000-000000000001'), 'ok', 'A 能登记本机设备');
select is((select session_id::text from public.devices where id = 'de000000-0000-4000-8000-00000000000a'), 'aaaaaaaa-5555-4000-8000-000000000001',
  'devices.session_id 由触发器取 JWT 的会话');

-- B 读不到 A 的任何行
select is(jsonb_array_length(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$
  select id from public.events union all select id from public.todos union all select id from public.categories
  union all select id from public.notes union all select id from public.note_images union all select id from public.note_files
  union all select id from public.anniversaries union all select id from public.settings union all select id from public.devices$$)), 0,
  'B 读不到 A 的 9 张同步表');
select is(jsonb_array_length(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$
  select user_id from public.profiles where user_id <> 'bbbbbbbb-0000-4000-8000-000000000002'
  union all select user_id from public.logs union all select user_id from public.applied_ops union all select user_id from public.tombstones$$)), 0,
  'B 读不到 A 的 profiles、logs、applied_ops、tombstones');

-- B 改、删 A 的行：RLS 过滤成 0 行，A 的数据不变
select is(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$
  update public.events set title = 'B 改的' where id = 'e0000000-0000-4000-8000-00000000000a';
  update public.notes set body = 'B 改的' where id = '40000000-0000-4000-8000-00000000000a';
  update public.settings set value = '"x"' where id = '5e000000-0000-4000-8000-00000000000a'$$), 'ok', 'B 的 update 不报错（被 RLS 过滤）');
select is((select title from public.events where id = 'e0000000-0000-4000-8000-00000000000a'), 'A 的日程', 'A 的日程没被 B 改');
select is((select body from public.notes where id = '40000000-0000-4000-8000-00000000000a'), '正文', 'A 的随手记没被 B 改');
select ok(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002',
  $$delete from public.events where id = 'e0000000-0000-4000-8000-00000000000a'$$) like '42501%', 'B 删 events：没有表级 DELETE（42501）');
select is(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002',
  $$delete from public.devices where id = 'de000000-0000-4000-8000-00000000000a'$$, null, 'bbbbbbbb-5555-4000-8000-000000000002'), 'ok', 'B 删 A 的设备：不报错');
select is((select count(*)::int from public.devices where id = 'de000000-0000-4000-8000-00000000000a'), 1, 'A 的设备还在');

-- B 冒用 A 的 user_id 写入
select ok(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$
  insert into public.todos (id, user_id, title, created_at, updated_at) values (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-000000000001', 'x', 1, 1)$$) like '42501%',
  'B 不能以 A 的 user_id 写 todos（user_id 没有列授权）');
-- TC-B0-38：复合外键
select ok(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$
  insert into public.notes (id, body, category_id, created_at, updated_at) values (gen_random_uuid(), 'x', 'ca000000-0000-4000-8000-00000000000a', 1, 1)$$) like '23503%',
  'B 引用 A 的分类：复合外键拒绝（23503）');
select ok(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$
  insert into public.note_images (id, note_id, bucket, path, bytes) values ('1e000000-0000-4000-8000-00000000000b', '40000000-0000-4000-8000-00000000000a', 'images',
    'bbbbbbbb-0000-4000-8000-000000000002/40000000-0000-4000-8000-00000000000a/1e000000-0000-4000-8000-00000000000b.webp', 1)$$) ~ '^(23503|P0001 note_not_writable)',
  'B 把图片挂到 A 的随手记：被拒（0.33 起 guard_note_image 先拦，复合外键是第二道）');
select ok(tests.try_as('service_role', null, $$
  insert into public.note_images (id, user_id, note_id, bucket, path, bytes) values ('1e000000-0000-4000-8000-00000000000c', 'bbbbbbbb-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-00000000000a', 'images',
    'bbbbbbbb-0000-4000-8000-000000000002/40000000-0000-4000-8000-00000000000a/1e000000-0000-4000-8000-00000000000c.webp', 1)$$) like '23503%',
  '触发器不拦的服务器一侧：B 的图挂到 A 的随手记仍被复合外键拒绝（23503）');
select ok(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$
  insert into public.applied_ops (op_id, result) values ('0b000000-0000-4000-8000-00000000000a', '{}')$$) = 'ok',
  'B 用 A 用过的 op_id：主键 (user_id, op_id)，不撞库');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.applied_ops (op_id, result) values ('0b000000-0000-4000-8000-00000000000a', '{}')$$) like '23505%',
  'A 同一个 op_id 插两次：主键冲突（23505）');

-- 3.3 B：客户端不能写隐私记
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.notes (id, is_private, created_at, updated_at) values (gen_random_uuid(), true, 1, 1)$$) like '42501%'
  or tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.notes (id, is_private, created_at, updated_at) values (gen_random_uuid(), true, 1, 1)$$) like '23514%',
  'A 写 is_private = true 被拒');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  update public.notes set is_private = true where id = '40000000-0000-4000-8000-00000000000a'$$) like '42501%', 'A 不能把随手记改成隐私记（没有列授权）');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.note_images (id, note_id, bucket, path, bytes) values ('1e000000-0000-4000-8000-00000000000c', '40000000-0000-4000-8000-00000000000a', 'vault-images',
    'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-00000000000a/1e000000-0000-4000-8000-00000000000c.webp', 1)$$) like '42501%',
  'A 写 vault-images 的图片行被 RLS 拒');

-- TC-B0-79：系统列和派生列，客户端写被拒（42501）
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.events set remind_at = 1 where id = 'e0000000-0000-4000-8000-00000000000a'$$) like '42501%', 'events.remind_at 不能写');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.events set pushed_for = 1 where id = 'e0000000-0000-4000-8000-00000000000a'$$) like '42501%', 'events.pushed_for 不能写');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.events set ai_status = 'done' where id = 'e0000000-0000-4000-8000-00000000000a'$$) like '42501%', 'events.ai_status 不能写');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.anniversaries set next_date = '2027-01-01' where id = 'a0000000-0000-4000-8000-00000000000a'$$) like '42501%', 'anniversaries.next_date 不能写');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.anniversaries set archived_at = 1 where id = 'a0000000-0000-4000-8000-00000000000a'$$) like '42501%', 'anniversaries.archived_at 不能写');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.devices set push_fail_count = 0 where id = 'de000000-0000-4000-8000-00000000000a'$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%', 'devices.push_fail_count 不能写');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.note_files set check_status = 'ok' where id = 'f0000000-0000-4000-8000-00000000000a'$$) like '42501%', 'note_files.check_status 不能写');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.note_images set ai_desc = 'x' where id = '1e000000-0000-4000-8000-00000000000a'$$) like '42501%', 'note_images.ai_desc 不能写');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.notes set ai_meta = '{}' where id = '40000000-0000-4000-8000-00000000000a'$$) like '42501%', 'notes.ai_meta 不能写');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.todos set rev = 99 where id = '70000000-0000-4000-8000-00000000000a'$$) like '42501%', 'todos.rev 不能写');

-- TC-B0-55：profiles 只能改三列
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.profiles set beta_features = '{note}' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '42501%', 'A 不能改自己的 beta_features');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.profiles set disabled_at = null where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '42501%', 'A 不能改 disabled_at');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.profiles set display_name = '阿A' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$), 'ok', 'A 能改自己的 display_name');

-- 停用的 C：读写都不行（is_active）
select is(jsonb_array_length(tests.rows_as('authenticated', 'cccccccc-0000-4000-8000-000000000003', $$select id from public.settings$$)), 0, '停用的 C 读不到行');
select ok(tests.try_as('authenticated', 'cccccccc-0000-4000-8000-000000000003', $$
  insert into public.settings (id, key, value) values (gen_random_uuid(), 'ui.theme', '"x"')$$) like '42501%', '停用的 C 不能写');

-- anon：同步表一律拒；app_config 只能读四列（TC-B0-54）
select ok(tests.try_as('anon', null, $$select 1 from public.events$$) like '42501%', 'anon 读 events 被拒');
select ok(tests.try_as('anon', null, $$select 1 from public.profiles$$) like '42501%', 'anon 读 profiles 被拒');
select ok(tests.try_as('anon', null, $$insert into public.logs (t) values (1)$$) like '42501%', 'anon 写 logs 被拒');
select is(tests.rows_as('anon', null, $$select min_client_version from public.app_config$$), '[{"min_client_version": "4.0.0"}]'::jsonb, 'anon 能读 min_client_version');
select ok(tests.try_as('anon', null, $$select * from public.app_config$$) like '42501%', 'anon select * from app_config 被拒');
select ok(tests.try_as('anon', null, $$select features, ai, limits from public.app_config$$) like '42501%', 'anon 读 features、ai、limits 被拒');
select is(jsonb_array_length(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select features, ai, limits from public.app_config$$)), 1, 'authenticated 能读整行');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$update public.app_config set notice = '{}'$$) like '42501%', 'authenticated 不能改 app_config');

-- private：客户端一律拒
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select 1 from private.remind_queue$$) like '42501%', 'authenticated 读 private 表被拒');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select 1 from private.scan_note_files$$) like '42501%', 'authenticated 读扫描视图被拒');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select private.admin_set_disabled('aaaaaaaa-0000-4000-8000-000000000001', false)$$) like '42501%', 'authenticated 调 admin_set_disabled 被拒');

-- TC-B0-94：A 删分类（30 天清理硬删），引用它的随手记只置空 category_id
delete from public.categories where id = 'ca000000-0000-4000-8000-00000000000a';
select is((select category_id from public.notes where id = '40000000-0000-4000-8000-00000000000a'), null, '分类删掉后随手记的 category_id 置空、行还在');

select * from finish();
rollback;
