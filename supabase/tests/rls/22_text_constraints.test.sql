-- 同步表文本列的长度和取值约束（架构 0.47 第 20 条 ③；迁移 20261031110000_core_text_constraints.sql；TC-B1-145、TC-B1-146）
-- ① 每列一条超限 / 清单外被拒（23514，报错里带约束名，能读出是哪一列）、一条边界 / 清单内通过；客户端可写的列以 authenticated 经 REST 的写法插，
--    ai_status 只有服务器写（客户端没有列授权），用 service_role 插；
-- ② 长度按 char_length（码点）算：2000 个汉字、韩文、emoji 都通过，2001 个 emoji 被拒；
-- ③ 经 apply_patch 改成超限的值回 patch_bad_args（不悄悄截断、行不变），改成边界值照常成功；
-- ④ 约束都已 validate；private.tags_ok 是 immutable、search_path 空，null 和空数组算通过；anon 不能执行、authenticated 能执行（安全审查 K4）；
-- ⑤ 库里已有违规旧行时 validate 失败（23514），约束停在 not valid（发布会停下，不会半途改坏）；
-- ①' 架构 0.47 第 20 条补的 9 列（categories.color 等）每列一组被拒、一组边界通过，note_files 另加 kind 和 mime 对不上被拒（TC-B1-145 ⑦）。
begin;
select plan(71);
\ir _helpers.psql
select tests.seed();   -- A、B 正常，C 停用

-- 以 A 的身份插一行（列 = p_row 的键；像 PostgREST 一样只写带上的列），回 'ok' 或 '<sqlstate> <信息>'
create function tests.ins(p_role text, p_table text, p_row jsonb) returns text language plpgsql as $$
declare cols text := (select string_agg(quote_ident(k), ',') from jsonb_object_keys(p_row) k);
begin
  return tests.try_as(p_role, case when p_role = 'authenticated' then 'aaaaaaaa-0000-4000-8000-000000000001'::uuid end,
    format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, %L::jsonb)', p_table, cols, cols, p_table, p_row));
end $$;
-- 三张表各自最少要带的列（id 每次新生成）
create function tests.todo(p jsonb) returns text language sql as $$
  select tests.ins('authenticated', 'todos', jsonb_build_object('id', gen_random_uuid(), 'title', 't', 'created_at', 0, 'updated_at', 0) || p) $$;
create function tests.note(p jsonb) returns text language sql as $$
  select tests.ins('authenticated', 'notes', jsonb_build_object('id', gen_random_uuid(), 'title', 'n', 'created_at', 0, 'updated_at', 0) || p) $$;
create function tests.anniv(p jsonb) returns text language sql as $$
  select tests.ins('authenticated', 'anniversaries', jsonb_build_object('id', gen_random_uuid(), 'kind', 'birthday', 'name', 'x', 'calendar', 'solar',
    'month', 1, 'day', 1, 'created_at', 0, 'updated_at', 0) || p) $$;
-- 服务器写的列（ai_status）：service_role 插，带上 user_id
create function tests.sys(p_table text, p jsonb) returns text language sql as $$
  select tests.ins('service_role', p_table, jsonb_build_object('id', gen_random_uuid(), 'user_id', 'aaaaaaaa-0000-4000-8000-000000000001', 'title', 't',
    'created_at', 0, 'updated_at', 0) || p) $$;
create function tests.rej(r text, con text) returns boolean language sql as $$ select r like '23514%' and r like '%"' || con || '"%' $$;

-- ===== ① anniversaries =====
select ok(tests.rej(tests.anniv(jsonb_build_object('note', repeat('a', 2001))), 'anniversaries_note_len'), 'anniversaries.note 2001 字被拒（anniversaries_note_len）');
select is(tests.anniv(jsonb_build_object('note', repeat('a', 2000))), 'ok', 'anniversaries.note 2000 字通过');

-- ===== ① todos =====
select ok(tests.rej(tests.todo(jsonb_build_object('project', repeat('p', 41))), 'todos_project_len'), 'todos.project 41 字被拒');
select is(tests.todo(jsonb_build_object('project', repeat('p', 40))), 'ok', 'todos.project 40 字通过');
select ok(tests.rej(tests.todo(jsonb_build_object('note', repeat('n', 2001))), 'todos_note_len'), 'todos.note 2001 字被拒');
select is(tests.todo(jsonb_build_object('note', repeat('n', 2000))), 'ok', 'todos.note 2000 字通过');
select ok(tests.rej(tests.todo(jsonb_build_object('raw_text', repeat('r', 2001))), 'todos_raw_text_len'), 'todos.raw_text 2001 字被拒');
select is(tests.todo(jsonb_build_object('raw_text', repeat('r', 2000))), 'ok', 'todos.raw_text 2000 字通过');
select ok(tests.rej(tests.todo('{"source": "web"}'), 'todos_source_in'), 'todos.source 写 web（清单外）被拒');
select is((select string_agg(tests.todo(jsonb_build_object('source', s)), ',') from unnest(array['page', 'chat', 'voice', 'import']) s),
  'ok,ok,ok,ok', 'todos.source 写 page / chat / voice / import 都通过');
select ok(tests.rej(tests.sys('todos', '{"ai_status": "failed"}'), 'todos_ai_status_in'), 'todos.ai_status 写 failed（清单外）被拒');
select is((select string_agg(tests.sys('todos', jsonb_build_object('ai_status', s)), ',') from unnest(array['none', 'pending', 'done', 'rule', 'skipped']) s),
  'ok,ok,ok,ok,ok', 'todos.ai_status 写清单里每个值都通过（同 events）');
select ok(tests.rej(tests.todo('{"remind_time": "24:00"}'), 'todos_remind_time_fmt'), 'todos.remind_time 24:00 被拒');
select ok(tests.rej(tests.todo('{"remind_time": "9:00"}'), 'todos_remind_time_fmt'), 'todos.remind_time 9:00（少一位）被拒');
select ok(tests.rej(tests.todo('{"remind_time": "12:60"}'), 'todos_remind_time_fmt'), 'todos.remind_time 12:60 被拒');
select is(tests.todo('{"remind_time": "23:59"}') || ',' || tests.todo('{"remind_time": "00:00"}'), 'ok,ok', 'todos.remind_time 23:59、00:00 通过');
select ok(tests.todo('{"remind_time": null}') like '23502%', 'todos.remind_time 是 not null（默认 09:00），写 null 回 23502，不是这次的约束');

-- ===== ① notes =====
select ok(tests.rej(tests.note(jsonb_build_object('raw_text', repeat('r', 2001))), 'notes_raw_text_len'), 'notes.raw_text 2001 字被拒');
select is(tests.note(jsonb_build_object('raw_text', repeat('r', 2000))), 'ok', 'notes.raw_text 2000 字通过');
select ok(tests.rej(tests.note('{"source": "web"}'), 'notes_source_in'), 'notes.source 写 web 被拒');
select is((select string_agg(tests.note(jsonb_build_object('source', s)), ',') from unnest(array['page', 'chat', 'voice', 'import']) s),
  'ok,ok,ok,ok', 'notes.source 清单里每个值都通过');
select ok(tests.rej(tests.note('{"category_source": "user"}'), 'notes_category_source_in'), 'notes.category_source 写 user 被拒');
select is((select string_agg(tests.note(jsonb_build_object('category_source', s)), ',') from unnest(array['ai', 'rule', 'manual', 'none']) s),
  'ok,ok,ok,ok', 'notes.category_source 写 ai / rule / manual / none 都通过');
select ok(tests.rej(tests.sys('notes', '{"ai_status": "none"}'), 'notes_ai_status_in'), 'notes.ai_status 写 none（清单外）被拒');
select is((select string_agg(tests.sys('notes', jsonb_build_object('ai_status', s)), ',') from unnest(array['pending', 'done', 'rule']) s),
  'ok,ok,ok', 'notes.ai_status 写 pending / done / rule 都通过');
select ok(tests.rej(tests.note(jsonb_build_object('tags', (select jsonb_agg('t' || g) from generate_series(1, 21) g))), 'notes_tags_count'), 'notes.tags 21 个被拒');
select is(tests.note(jsonb_build_object('tags', (select jsonb_agg('t' || g) from generate_series(1, 20) g))), 'ok', 'notes.tags 20 个通过');
select ok(tests.rej(tests.note(jsonb_build_object('tags', jsonb_build_array(repeat('标', 21)))), 'notes_tags_items'), '一个标签 21 字被拒');
select is(tests.note(jsonb_build_object('tags', jsonb_build_array(repeat('标', 20)))), 'ok', '一个标签正好 20 字通过');
select is(tests.note('{"tags": []}'), 'ok', 'notes.tags 空数组通过');
select ok(tests.rej(tests.note('{"tags": [""]}'), 'notes_tags_items'), '空串标签被拒');
select ok(tests.rej(tests.note('{"tags": ["a", null]}'), 'notes_tags_items'), '数组里有 null 被拒');

-- ===== ①' 架构 0.47 第 20 条补：D1 查出的 9 列（TC-B1-145 ⑦）=====
create function tests.cat(p jsonb) returns text language sql as $$
  select tests.ins('authenticated', 'categories', jsonb_build_object('id', gen_random_uuid(), 'name', 'c' || substr(md5(random()::text), 1, 8)) || p) $$;
-- devices 的触发器要 JWT 里有 session_id：带上 A 的种子会话（同 15 号）
create function tests.dev(p jsonb) returns text language plpgsql as $$
declare r jsonb := jsonb_build_object('id', gen_random_uuid(), 'platform', 'web') || p;
  cols text := (select string_agg(quote_ident(k), ',') from jsonb_object_keys(r) k);
begin
  return tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
    format('insert into public.devices (%s) select %s from jsonb_populate_record(null::public.devices, %L::jsonb)', cols, cols, r),
    null, 'aaaaaaaa-5555-4000-8000-000000000001');
end $$;
create function tests.ev(p jsonb) returns text language sql as $$
  select tests.ins('authenticated', 'events', jsonb_build_object('id', gen_random_uuid(), 'title', 'e', 'date', '2026-11-01', 'created_at', 0, 'updated_at', 0) || p) $$;
create function tests.st(p_key text) returns text language sql as $$
  select tests.ins('authenticated', 'settings', jsonb_build_object('id', gen_random_uuid(), 'key', p_key, 'value', 1)) $$;
-- note_files、note_images 挂在 A 的一条普通随手记上；path 按约束拼
insert into public.notes (id, user_id, title, created_at, updated_at) values
  ('ad000000-0000-4000-8000-0000000000f0', 'aaaaaaaa-0000-4000-8000-000000000001', '挂附件', 0, 0);
create function tests.nf(p_kind text, p_mime text, p_sha text) returns text language plpgsql as $$
declare i uuid := gen_random_uuid();
begin
  return tests.ins('authenticated', 'note_files', jsonb_build_object('id', i, 'note_id', 'ad000000-0000-4000-8000-0000000000f0', 'kind', p_kind,
    'path', 'aaaaaaaa-0000-4000-8000-000000000001/ad000000-0000-4000-8000-0000000000f0/' || i || '.' || p_kind,
    'name', 'f.' || p_kind, 'mime', p_mime, 'bytes', 1, 'sha256', p_sha, 'created_at', 0, 'updated_at', 0));
end $$;
create function tests.ni(p_mime text) returns text language plpgsql as $$
declare i uuid := gen_random_uuid();
begin
  return tests.ins('authenticated', 'note_images', jsonb_build_object('id', i, 'note_id', 'ad000000-0000-4000-8000-0000000000f0', 'bucket', 'images',
    'path', 'aaaaaaaa-0000-4000-8000-000000000001/ad000000-0000-4000-8000-0000000000f0/' || i || '.webp', 'bytes', 1, 'mime', p_mime));
end $$;

select ok((select bool_and(tests.rej(tests.cat(jsonb_build_object('color', c)), 'categories_color_fmt'))
             from unnest(array['#FFFFFF', '#fff', '1abc', 'a' || repeat('b', 32)]) c),
  'categories.color 写 #FFFFFF（大写）、#fff、1abc、33 字的令牌名都被拒');
select is((select string_agg(tests.cat(jsonb_build_object('color', c)), ',') from unnest(array['#a1b2c3', 'lemon', 'c3', 'a' || repeat('b', 31), null]) c),
  'ok,ok,ok,ok,ok', 'categories.color 写 #a1b2c3、lemon、c3、32 字的令牌名、null 都通过');
select ok(tests.rej(tests.dev(jsonb_build_object('label', repeat('机', 81))), 'devices_label_len'), 'devices.label 81 字被拒');
select is(tests.dev(jsonb_build_object('label', repeat('机', 80))), 'ok', 'devices.label 80 字通过');
select ok((select bool_and(tests.rej(tests.dev(jsonb_build_object('app_version', v)), 'devices_app_version_fmt'))
             from unnest(array[repeat('1', 41), '4.0 beta', '版本4', '']) v),
  'devices.app_version 写 41 字、带空格、带中文、空串都被拒');
select is((select string_agg(tests.dev(jsonb_build_object('app_version', v)), ',') from unnest(array['4.0.0', '4.0.0-beta.1+abc', repeat('1', 40), null]) v),
  'ok,ok,ok,ok', 'devices.app_version 写 4.0.0、4.0.0-beta.1+abc、40 字、null 都通过');
select ok((select bool_and(tests.rej(tests.ev(jsonb_build_object('tz', z)), 'events_tz_fmt'))
             from unnest(array[repeat('a', 65), 'Asia/ Seoul', 'Asia/Seoul;drop', '']) z),
  'events.tz 写 65 字、带空格、带分号、空串都被拒');
select is((select string_agg(tests.ev(jsonb_build_object('tz', z)), ',')
             from unnest(array['Asia/Seoul', 'America/Argentina/Buenos_Aires', 'Etc/GMT+9', 'UTC', repeat('a', 64), null]) z),
  'ok,ok,ok,ok,ok,ok', 'events.tz 写 Asia/Seoul、America/Argentina/Buenos_Aires、Etc/GMT+9、UTC、64 字、null 都通过');
select ok(tests.ev('{"time": "09:00"}') like '23514%', 'events 原有的“有 time 必须有 tz”不变：只写 time 不写 tz 照样被拒');
select ok((select bool_and(tests.rej(tests.nf('pdf', m, repeat('0', 64)), 'note_files_mime_kind'))
             from unnest(array['text/plain', 'image/webp', 'application/PDF']) m),
  'note_files.mime 写清单外的值（text/plain、image/webp、大写的 application/PDF）被拒');
select ok(tests.rej(tests.nf('pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', repeat('0', 64)), 'note_files_mime_kind'),
  'note_files 的 kind 和 mime 对不上（kind = pdf 配 docx 的 MIME）被拒');
-- kind → mime 照 shared/manifests/attachments.ts 的 DOC_MIME
select is((select string_agg(tests.nf(k, m, repeat('0', 64)), ',') from (values ('pdf', 'application/pdf'),
             ('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
             ('xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
             ('pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
             ('docm', 'application/vnd.ms-word.document.macroEnabled.12'), ('xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'),
             ('pptm', 'application/vnd.ms-powerpoint.presentation.macroEnabled.12'), ('doc', 'application/msword'),
             ('xls', 'application/vnd.ms-excel'), ('ppt', 'application/vnd.ms-powerpoint')) v(k, m)),
  'ok,ok,ok,ok,ok,ok,ok,ok,ok,ok', 'note_files 10 种 kind 各配对应的 mime 都通过');
select ok((select bool_and(tests.rej(tests.nf('pdf', 'application/pdf', h), 'note_files_sha256_fmt'))
             from unnest(array[repeat('A', 64), repeat('0', 63), repeat('0', 65), repeat('g', 64)]) h),
  'note_files.sha256 写大写、63 位、65 位、非十六进制字符都被拒');
select is(tests.nf('pdf', 'application/pdf', repeat('0123456789abcdef', 4)), 'ok', 'note_files.sha256 写 64 位小写十六进制通过（隐私记行的 HMAC 同格式）');
select ok((select bool_and(tests.rej(tests.ni(m), 'note_images_mime_webp')) from unnest(array['image/png', 'image/jpeg']) m),
  'note_images.mime 写 image/png、image/jpeg 被拒');
select is(tests.ni('image/webp'), 'ok', 'note_images.mime 写 image/webp 通过');
select ok((select bool_and(tests.rej(tests.note(jsonb_build_object('converted_to', v)), 'notes_converted_to_size'))
             from unnest(array['"todo"'::jsonb, '1'::jsonb, jsonb_build_array(repeat('x', 3000))]) v),
  'notes.converted_to 写 jsonb 字符串、数字、超过 2048 字节的数组都被拒');
select is((select string_agg(tests.note(jsonb_build_object('converted_to', v)), ',')
             from unnest(array['{"type": "todo", "id": "ad000000-0000-4000-8000-000000000001"}'::jsonb, '[]'::jsonb, null]) v),
  'ok,ok,ok', 'notes.converted_to 写对象、数组、null 都通过');
-- 2048 字节按 jsonb 的文字形式算（octet_length(converted_to::text)，安全审查 10-31）：找出文字形式正好 2048 字节的单串数组，它通过、多一字被拒
select is((select tests.note(jsonb_build_object('converted_to', jsonb_build_array(repeat('x', n)))) || ',' ||
                  left(tests.note(jsonb_build_object('converted_to', jsonb_build_array(repeat('x', n + 1)))), 5)
             from generate_series(1900, 2100) n where octet_length(jsonb_build_array(repeat('x', n))::text) = 2048 limit 1),
  'ok,23514', 'notes.converted_to 正好 2048 字节通过、2049 字节被拒');
select ok((select bool_and(tests.rej(tests.st(k), 'settings_key_fmt'))
             from unnest(array['', 'a' || repeat('b', 80), 'UI.font', 'ui..font', 'notes.view@tablet', 'layout.today@inst:abc', '.ui', 'ui.font ']) k),
  'settings.key 写空串、81 字、大写、ui..font、notes.view@tablet、@inst: 后面不是 36 位、点开头、末尾空格都被拒');
select is((select string_agg(tests.st(k), ',') from unnest(array['ui.font', 'cal.week_start', 'notes.view@mobile', 'notes.view@desktop',
             'layout.today@inst:aaaaaaaa-0000-4000-8000-000000000001', 'a' || repeat('b', 79)]) k),
  'ok,ok,ok,ok,ok,ok', 'settings.key 写 ui.font、cal.week_start、notes.view@mobile / @desktop、layout.today@inst:<uuid>、80 字都通过');
-- 带换行（安全审查 10-31）：正则的 $ 只认整串末尾，末尾、中间夹一个换行都要被拒
select ok(tests.rej(tests.st(E'ui.font\n'), 'settings_key_fmt') and tests.rej(tests.st(E'ui.\nfont'), 'settings_key_fmt')
          and tests.rej(tests.ev(jsonb_build_object('tz', E'UTC\n')), 'events_tz_fmt') and tests.rej(tests.dev(jsonb_build_object('app_version', E'4.0.0\n')), 'devices_app_version_fmt')
          and tests.rej(tests.cat(jsonb_build_object('color', E'lemon\n')), 'categories_color_fmt') and tests.rej(tests.nf('pdf', 'application/pdf', repeat('0', 63) || E'\n'), 'note_files_sha256_fmt'),
  E'带换行被拒：settings.key ''ui.font\\n''、''ui.\\nfont''，events.tz ''UTC\\n''，devices.app_version、categories.color、note_files.sha256 末尾带换行');

-- ===== ② 按字（码点）算 =====
select is(tests.todo(jsonb_build_object('note', repeat('汉', 2000))), 'ok', '2000 个汉字通过');
select is(tests.todo(jsonb_build_object('note', repeat('한', 2000))), 'ok', '2000 个韩文通过');
select is(tests.todo(jsonb_build_object('note', repeat('😀', 2000))), 'ok', '2000 个 emoji 通过（每个按 1 字算）');
select ok(tests.rej(tests.todo(jsonb_build_object('note', repeat('😀', 2001))), 'todos_note_len'), '2001 个 emoji 被拒');

-- ===== ③ 经 apply_patch =====
insert into public.todos (id, user_id, title, created_at, updated_at) values
  ('ad000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '原来', 0, 0);
create function tests.ap(p_patch jsonb, p_op uuid) returns jsonb language sql as $$
  with x as (select tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
    format('select public.apply_patch(%L, %L::uuid, %L::jsonb, %s, %L::uuid, %L::int[]) as r', 'todos', 'ad000000-0000-4000-8000-000000000001', p_patch,
      (select rev from public.todos where id = 'ad000000-0000-4000-8000-000000000001'), p_op, '{}')) j)
  select coalesce(j -> 0 -> 'r', j) from x $$;
select is(tests.ap(jsonb_build_object('project', repeat('p', 41)), 'a0b00000-0000-4000-8000-000000000001') ->> 'error', 'P0001 patch_bad_args',
  'apply_patch 把 project 改成 41 字：回 patch_bad_args（不截断）');
select is((select project from public.todos where id = 'ad000000-0000-4000-8000-000000000001'), '', '被拒以后行没变');
select ok(tests.ap(jsonb_build_object('note', repeat('n', 2001)), 'a0b00000-0000-4000-8000-000000000002') ->> 'error' = 'P0001 patch_bad_args'
  and tests.ap('{"source": "web"}', 'a0b00000-0000-4000-8000-000000000003') ->> 'error' = 'P0001 patch_bad_args'
  and tests.ap('{"remind_time": "24:00"}', 'a0b00000-0000-4000-8000-000000000004') ->> 'error' = 'P0001 patch_bad_args',
  'apply_patch 写超长 note、清单外 source、24:00 都回 patch_bad_args');
select is(tests.ap(jsonb_build_object('project', repeat('p', 40), 'remind_time', '23:59'), 'a0b00000-0000-4000-8000-000000000005') ->> 'error', null,
  'apply_patch 写边界值（40 字、23:59）照常成功');
select is((select char_length(project) || ' ' || remind_time from public.todos where id = 'ad000000-0000-4000-8000-000000000001'), '40 23:59', '边界值写进去了');

-- ===== ④ 约束和函数 =====
select is((select string_agg(conname, ',' order by conname) from pg_constraint
  where conrelid in ('public.anniversaries'::regclass, 'public.todos'::regclass, 'public.notes'::regclass, 'public.categories'::regclass,
      'public.devices'::regclass, 'public.events'::regclass, 'public.note_files'::regclass, 'public.note_images'::regclass, 'public.settings'::regclass)
    and conname in (
      'anniversaries_note_len', 'todos_project_len', 'todos_note_len', 'todos_raw_text_len', 'todos_source_in',
      'todos_ai_status_in', 'todos_remind_time_fmt', 'notes_raw_text_len', 'notes_source_in', 'notes_category_source_in',
      'notes_ai_status_in', 'notes_tags_count', 'notes_tags_items', 'categories_color_fmt', 'devices_label_len',
      'devices_app_version_fmt', 'events_tz_fmt', 'note_files_mime_kind', 'note_files_sha256_fmt', 'note_images_mime_webp',
      'notes_converted_to_size', 'settings_key_fmt')
    and contype = 'c' and convalidated),
  'anniversaries_note_len,categories_color_fmt,devices_app_version_fmt,devices_label_len,events_tz_fmt,note_files_mime_kind,note_files_sha256_fmt,note_images_mime_webp,notes_ai_status_in,notes_category_source_in,notes_converted_to_size,'
  || 'notes_raw_text_len,notes_source_in,notes_tags_count,notes_tags_items,settings_key_fmt,todos_ai_status_in,todos_note_len,todos_project_len,todos_raw_text_len,todos_remind_time_fmt,todos_source_in',
  '13 + 9 条约束都在、都已 validate（TC-B1-146 ②）');
select is((select p.provolatile::text || '|' || array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'private.tags_ok(text[])'::regprocedure),
  'i|search_path=""', 'private.tags_ok 是 immutable、search_path 空（TC-B1-146 ⑤）');
select is(array[private.tags_ok(null), private.tags_ok('{}'), private.tags_ok(array[repeat('x', 20)]), private.tags_ok(array[repeat('x', 21)])],
  array[true, true, true, false], 'tags_ok：null、空数组通过；20 字通过、21 字不过');
select ok(not has_function_privilege('anon', 'private.tags_ok(text[])', 'EXECUTE')
  and has_function_privilege('authenticated', 'private.tags_ok(text[])', 'EXECUTE'), 'tags_ok：anon 不能执行、authenticated 能执行（安全审查 K4）');
select ok(has_function_privilege('service_role', 'private.tags_ok(text[])', 'EXECUTE')
  and has_function_privilege('fn_vault', 'private.tags_ok(text[])', 'EXECUTE')
  and not has_function_privilege('fn_ai', 'private.tags_ok(text[])', 'EXECUTE'), 'tags_ok：service_role、fn_vault 能执行（也写 notes），fn_ai 不能');

-- ===== ⑤ 库里已有违规旧行：validate 失败、约束停在 not valid =====
alter table public.anniversaries drop constraint anniversaries_note_len;
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, note, created_at, updated_at) values
  ('ae000000-0000-4000-8000-0000000000aa', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', '旧', 'solar', 1, 1, repeat('o', 2001), 0, 0);
alter table public.anniversaries add constraint anniversaries_note_len check (char_length(note) <= 2000) not valid;
create function tests.sqlstate_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end $$;
select is(tests.sqlstate_of('alter table public.anniversaries validate constraint anniversaries_note_len'), '23514',
  '已有 2001 字的旧行：validate 报 23514（整个迁移在一个事务里，会一起回滚）');
select is((select convalidated from pg_constraint where conname = 'anniversaries_note_len'), false, 'validate 失败以后约束仍是 not valid');
select ok(tests.rej(tests.anniv(jsonb_build_object('note', repeat('a', 2001))), 'anniversaries_note_len'), 'not valid 的约束对新写入照样生效');

select * from finish();
rollback;
