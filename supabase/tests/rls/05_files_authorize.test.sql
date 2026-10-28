-- files_authorize（架构 0.32，3.3 D、3.3 G“R2 起”；数据字典 6.1、6.2）：TC-B0-99～105
-- /files 函数带用户的 JWT 调 public.files_authorize；这里用 tests.fa 模拟“以某人、某会话的身份经 PostgREST 调”
-- 返回值：{uid, items: [{i, ok, reason?}]}，整批不过时 {uid, error, items: []}；入参不对报 22023
begin;
select plan(55);
\ir _helpers.psql
select tests.seed();

-- 以 p_uid、p_session 的身份（authenticated）调一次，返回 RPC 的结果；出错时返回 {"error": "<sqlstate> <信息>"}
create function tests.fa(p_uid uuid, p_session uuid, p_op text, p_items jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r := tests.rows_as('authenticated', p_uid, format('select public.files_authorize(%L, %L::jsonb) as r', p_op, p_items::text), null, p_session);
  return coalesce(r -> 0 -> 'r', r);
end $$;
-- A 的身份、A 的会话调，只看第一项的 reason（ok 时为 'ok'）
create function tests.fa1(p_op text, p_bucket text, p_path text) returns text language plpgsql as $$
declare r jsonb := tests.fa('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', p_op,
  jsonb_build_array(jsonb_build_object('bucket', p_bucket, 'path', p_path)));
begin
  if r ? 'error' then return 'error:' || (r ->> 'error'); end if;
  return case when (r -> 'items' -> 0 ->> 'ok')::boolean then 'ok' else r -> 'items' -> 0 ->> 'reason' end;
end $$;

-- ===== 测试数据 =====
-- A：一条随手记；插图 a1（没有缩略图）、a2（有缩略图）、a3（昨天删的）、a4（31 天前删的）、a5（隐私记的图）；
--    纪念日一条（有头像）、一条昨天删的；附件 a1 ok、a2 隐私记、a3 已删 pending、a4 pending 带缩略图、a5 rejected
-- B：一条随手记、一张插图
insert into public.notes (id, user_id, body, created_at, updated_at) values
  ('40000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'n', 1, 1),
  ('40000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'n', 1, 1);
insert into public.note_images (id, user_id, note_id, bucket, path, bytes, has_thumb, deleted_at) values
  ('1e000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', '40000000-0000-4000-8000-0000000000a1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.webp', 1, false, null),
  ('1e000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', '40000000-0000-4000-8000-0000000000a1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a2.webp', 1, true, null),
  ('1e000000-0000-4000-8000-0000000000a3', 'aaaaaaaa-0000-4000-8000-000000000001', '40000000-0000-4000-8000-0000000000a1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a3.webp', 1, false,
   ((extract(epoch from now()) - 86400) * 1000)::bigint),
  ('1e000000-0000-4000-8000-0000000000a4', 'aaaaaaaa-0000-4000-8000-000000000001', '40000000-0000-4000-8000-0000000000a1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a4.webp', 1, false,
   ((extract(epoch from now()) - 31 * 86400) * 1000)::bigint),
  ('1e000000-0000-4000-8000-0000000000a5', 'aaaaaaaa-0000-4000-8000-000000000001', '40000000-0000-4000-8000-0000000000a1', 'vault-images',
   'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a5.webp', 1, false, null),
  ('1e000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', '40000000-0000-4000-8000-0000000000b1', 'images',
   'bbbbbbbb-0000-4000-8000-000000000002/40000000-0000-4000-8000-0000000000b1/1e000000-0000-4000-8000-0000000000b1.webp', 1, false, null);
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at, avatar_id, avatar_bytes, deleted_at) values
  ('a0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', '妈妈', 'solar', 3, 5, 1, 1,
   '0a000000-0000-4000-8000-0000000000a1', 100, null),
  ('a0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', '爸爸', 'solar', 4, 6, 1, 1,
   '0a000000-0000-4000-8000-0000000000a2', 100, ((extract(epoch from now()) - 86400) * 1000)::bigint);
insert into public.note_files (id, user_id, note_id, kind, path, has_thumb, is_vault, name, name_enc, dek_enc, enc_key_id, mime, bytes, sha256,
                               check_status, deleted_at, created_at, updated_at) values
  ('f0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', '40000000-0000-4000-8000-0000000000a1', 'pdf',
   'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a1.pdf', false, false,
   'ok.pdf', null, null, null, 'application/pdf', 1, 'x', 'ok', null, 1, 1),
  ('f0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', '40000000-0000-4000-8000-0000000000a1', 'pdf',
   'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a2.pdf', false, true,
   null, '\x00', '\x00', 1, 'application/pdf', 1, 'x', 'pending', null, 1, 1),
  ('f0000000-0000-4000-8000-0000000000a3', 'aaaaaaaa-0000-4000-8000-000000000001', '40000000-0000-4000-8000-0000000000a1', 'pdf',
   'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a3.pdf', false, false,
   'del.pdf', null, null, null, 'application/pdf', 1, 'x', 'pending', 1, 1, 1),
  ('f0000000-0000-4000-8000-0000000000a4', 'aaaaaaaa-0000-4000-8000-000000000001', '40000000-0000-4000-8000-0000000000a1', 'pptx',
   'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a4.pptx', true, false,
   'p.pptx', null, null, null, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 1, 'x', 'pending', null, 1, 1),
  ('f0000000-0000-4000-8000-0000000000a5', 'aaaaaaaa-0000-4000-8000-000000000001', '40000000-0000-4000-8000-0000000000a1', 'pdf',
   'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a5.pdf', false, false,
   'rej.pdf', null, null, null, 'application/pdf', 1, 'x', 'rejected', null, 1, 1);

-- ===== 授权（3.3 C、D） =====
select ok(has_function_privilege('authenticated', 'public.files_authorize(text, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.files_authorize(text, jsonb)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.files_authorize(text, jsonb)', 'EXECUTE'), 'files_authorize 只授给 authenticated');
select is((select p.prosecdef::text || ':' || coalesce(array_to_string(p.proconfig, ','), '') from pg_proc p where p.oid = 'private.files_authorize_impl(text, jsonb)'::regprocedure),
  'true:search_path=""', 'files_authorize_impl 是 security definer，search_path = 空');
select is((select p.prosecdef from pg_proc p where p.oid = 'public.files_authorize(text, jsonb)'::regprocedure), false, 'public.files_authorize 是 security invoker');
select ok(tests.try_as('anon', null, $$select public.files_authorize('get', '[]')$$) like '42501%', 'anon 调不了');

-- ===== TC-B0-99：跨用户一律拒 =====
select is(tests.fa('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', 'put',
  '[{"bucket":"images","path":"aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.webp"}]'),
  '{"uid":"aaaaaaaa-0000-4000-8000-000000000001","items":[{"i":0,"ok":true}]}'::jsonb, 'A 传自己那行的插图：ok，返回的 uid 是 A');
select is(tests.fa1('put', 'images', 'bbbbbbbb-0000-4000-8000-000000000002/40000000-0000-4000-8000-0000000000b1/1e000000-0000-4000-8000-0000000000b1.webp'),
  'not_owner', 'A 传 B 的插图路径：not_owner');
select is(tests.fa1('get', 'images', 'bbbbbbbb-0000-4000-8000-000000000002/40000000-0000-4000-8000-0000000000b1/1e000000-0000-4000-8000-0000000000b1.webp'),
  'not_owner', 'A 取 B 的插图：not_owner');
select is(tests.fa1('put', 'files', 'bbbbbbbb-0000-4000-8000-000000000002/40000000-0000-4000-8000-0000000000b1/f0000000-0000-4000-8000-0000000000a4.pptx'),
  'not_owner', 'A 往 B 的目录传附件：not_owner');
-- TC-B0-114 的数据库那一半：混进别人的项只标那一项，不整批失败
select is(tests.fa('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', 'get',
  '[{"bucket":"images","path":"bbbbbbbb-0000-4000-8000-000000000002/40000000-0000-4000-8000-0000000000b1/1e000000-0000-4000-8000-0000000000b1.webp"},
    {"bucket":"images","path":"aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.webp"}]') -> 'items',
  '[{"i":0,"ok":false,"reason":"not_owner"},{"i":1,"ok":true}]'::jsonb, '批量 get 里混进 B 的图：只有那一项 not_owner');

-- ===== TC-B0-100：先写行再传，不只看路径 =====
select is(tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000ff.webp'),
  'no_row', '符合正则、表里没有的插图：no_row');
select is(tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.t.webp'),
  'no_row', '缩略图而 has_thumb = false：no_row');
select is(tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a2.t.webp'),
  'ok', '缩略图且 has_thumb = true：ok');
select is(tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/anniv/a0000000-0000-4000-8000-0000000000a1/0a000000-0000-4000-8000-0000000000ff.webp'),
  'not_owner', '头像路径里的 avatar_id 不等于这一行的：not_owner');
select is(tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/anniv/a0000000-0000-4000-8000-0000000000a1/0a000000-0000-4000-8000-0000000000a1.webp'),
  'ok', '头像路径和 avatar_id 一致：ok');
select is(tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/anniv/a0000000-0000-4000-8000-0000000000ff/0a000000-0000-4000-8000-0000000000a1.webp'),
  'no_row', '头像：没有这条纪念日：no_row');
select is(tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/anniv/a0000000-0000-4000-8000-0000000000a2/0a000000-0000-4000-8000-0000000000a2.webp'),
  'deleted', '头像：纪念日已删，不能再传：deleted');
select is(tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a3.webp'),
  'deleted', '插图已删（最近删除里）：不能再传');
select is(tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a5.webp'),
  'not_owner', '隐私记的图（bucket = vault-images）不经 /files：not_owner');

-- ===== TC-B0-101：附件只认本人、普通、pending、没删的行（原 file_slot_open） =====
select is(tests.fa1('put', 'files', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a1.pdf'),
  'not_pending', '已检查过（ok）的附件：not_pending（换不掉）');
select is(tests.fa1('put', 'files', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a2.pdf'),
  'not_owner', '隐私记的附件（is_vault）：not_owner');
select is(tests.fa1('put', 'files', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a3.pdf'),
  'deleted', '已删的 pending 附件：deleted');
select is(tests.fa1('put', 'files', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a4.pptx'),
  'ok', 'pending 的附件：ok');
select is(tests.fa1('put', 'files', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a4.t.webp'),
  'ok', 'pending 且 has_thumb 的缩略图：ok');
select is(tests.fa1('put', 'files', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a3.t.webp'),
  'no_row', '没有缩略图的那条附件的缩略图路径：no_row');
select is(tests.fa1('put', 'files', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a4.pdf'),
  'no_row', '扩展名和行里的 kind 不一致：no_row');

-- ===== TC-B0-102：桶和路径 =====
select is(tests.fa1('put', 'vault-images', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a5.webp'),
  'bad_bucket', 'put vault-images：bad_bucket');
select is(tests.fa1('put', 'vault-files', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a2.pdf'),
  'bad_bucket', 'put vault-files：bad_bucket');
select is(tests.fa1('put', 'backups', '2026-10-28/aaaaaaaa-0000-4000-8000-000000000001/todos.json.gz'), 'bad_bucket', 'put backups：bad_bucket');
select is(tests.fa1('put', 'xyz', 'aaaaaaaa-0000-4000-8000-000000000001/x.webp'), 'bad_bucket', 'put xyz：bad_bucket');
select is((select string_agg(x ->> 'reason', ',' order by (x ->> 'i')::int) from jsonb_array_elements(tests.fa('aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-5555-4000-8000-000000000001', 'get',
  '[{"bucket":"vault-images","path":"p"},{"bucket":"vault-files","path":"p"},{"bucket":"backups","path":"p"},{"bucket":"xyz","path":"p"},{"path":"p"},"images"]') -> 'items') x),
  'bad_bucket,bad_bucket,bad_bucket,bad_bucket,bad_bucket,bad_bucket', 'get 的 6 种坏桶（含没写桶、项不是对象）：一律 bad_bucket');
select is((select string_agg(x ->> 'reason', ',' order by (x ->> 'i')::int) from jsonb_array_elements(tests.fa('aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-5555-4000-8000-000000000001', 'get', jsonb_build_array(
    jsonb_build_object('bucket', 'images', 'path', 'aaaaaaaa-0000-4000-8000-000000000001/../bbbbbbbb-0000-4000-8000-000000000002/1e000000-0000-4000-8000-0000000000b1.webp'),
    jsonb_build_object('bucket', 'images', 'path', 'aaaaaaaa-0000-4000-8000-000000000001%2F40000000-0000-4000-8000-0000000000a1%2F1e000000-0000-4000-8000-0000000000a1.webp'),
    jsonb_build_object('bucket', 'images', 'path', 'aaaaaaaa-0000-4000-8000-000000000001/x/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.webp'),
    jsonb_build_object('bucket', 'images', 'path', 'AAAAAAAA-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.webp'),
    jsonb_build_object('bucket', 'images', 'path', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.png'),
    jsonb_build_object('bucket', 'files', 'path', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a1.exe'),
    jsonb_build_object('bucket', 'files', 'path', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a1.pdf' || chr(10)),
    jsonb_build_object('bucket', 'images'))) -> 'items') x),
  'bad_path,bad_path,bad_path,bad_path,bad_path,bad_path,bad_path,bad_path', '路径含 ..、%2F、多一级、大写十六进制、扩展名不对、结尾换行、没写路径：一律 bad_path');

-- ===== TC-B0-103：get 只给检查过的附件；最近删除里的图还能看；超过 100 项整批报错 =====
select is((select string_agg(coalesce(x ->> 'reason', 'ok'), ',' order by (x ->> 'i')::int) from jsonb_array_elements(tests.fa('aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-5555-4000-8000-000000000001', 'get', '[
    {"bucket":"files","path":"aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a4.pptx"},
    {"bucket":"files","path":"aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a5.pdf"},
    {"bucket":"files","path":"aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a1.pdf"},
    {"bucket":"files","path":"aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-0000000000a2.pdf"},
    {"bucket":"images","path":"aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a3.webp"},
    {"bucket":"images","path":"aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a4.webp"},
    {"bucket":"images","path":"aaaaaaaa-0000-4000-8000-000000000001/anniv/a0000000-0000-4000-8000-0000000000a2/0a000000-0000-4000-8000-0000000000a2.webp"},
    {"bucket":"images","path":"aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a2.t.webp"}
  ]') -> 'items') x),
  'not_checked,not_checked,ok,not_owner,ok,deleted,ok,ok',
  'get：附件 pending、rejected 不给，ok 的给，隐私记的不给；昨天删的图、最近删除里的头像能取，31 天前删的不给；缩略图能取');
select ok(tests.fa('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', 'get',
  (select jsonb_agg(jsonb_build_object('bucket', 'images', 'path', 'p')) from generate_series(1, 101))) ->> 'error' like '22023 too_many_items%',
  'get 101 项：整批报错 too_many_items');
select is(jsonb_array_length(tests.fa('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', 'get',
  (select jsonb_agg(jsonb_build_object('bucket', 'images', 'path', 'p')) from generate_series(1, 100))) -> 'items'), 100, 'get 100 项：照常逐项判断');
select ok(tests.fa('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', 'put',
  '[{"bucket":"images","path":"p"},{"bucket":"images","path":"q"}]') ->> 'error' like '22023 put_one_item%', 'put 两项：报错（put 只许 1 项）');
select ok(tests.fa('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', 'delete',
  '[{"bucket":"images","path":"p"}]') ->> 'error' like '22023 bad_op%', 'p_op 不是 put / get：报错（没有删除）');
select ok(tests.fa('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', 'get', '{"bucket":"images"}') ->> 'error' like '22023 bad_items%'
  and tests.fa('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', 'get', '[]') ->> 'error' like '22023 bad_items%',
  'p_items 不是数组、是空数组：报错');

-- ===== TC-B0-104：停用、注销冷静期、会话吊销，一项都不判 =====
select is(tests.fa('cccccccc-0000-4000-8000-000000000003', null, 'get', '[{"bucket":"images","path":"p"}]'),
  '{"uid":"cccccccc-0000-4000-8000-000000000003","error":"account_disabled","items":[]}'::jsonb, '停用的 C：account_disabled，items 为空');
update public.profiles set disabled_at = now(), disabled_reason = 'deletion' where user_id = 'bbbbbbbb-0000-4000-8000-000000000002';
select is(tests.fa('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-5555-4000-8000-000000000002', 'put',
  '[{"bucket":"images","path":"bbbbbbbb-0000-4000-8000-000000000002/40000000-0000-4000-8000-0000000000b1/1e000000-0000-4000-8000-0000000000b1.webp"}]') ->> 'error',
  'account_disabled', '注销冷静期里的 B：account_disabled（不再能传）');
update public.profiles set disabled_at = null, disabled_reason = null where user_id = 'bbbbbbbb-0000-4000-8000-000000000002';
insert into auth.sessions (id, user_id) values ('aaaaaaaa-5555-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-000000000001');
insert into private.revoked_sessions (session_id, user_id) values ('aaaaaaaa-5555-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-000000000001');
select is(tests.fa('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-0000000000e1', 'put',
  '[{"bucket":"images","path":"aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.webp"}]'),
  '{"uid":"aaaaaaaa-0000-4000-8000-000000000001","error":"session_revoked","items":[]}'::jsonb, '被 remove_device 吊销的会话：session_revoked');
select is(tests.fa('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-0000000000e1', 'get',
  '[{"bucket":"images","path":"aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.webp"}]') ->> 'error',
  'session_revoked', '吊销的会话 get 也不行');
select is(tests.fa('aaaaaaaa-0000-4000-8000-000000000001', null, 'get', '[{"bucket":"images","path":"p"}]') ->> 'error', 'session_revoked',
  'JWT 里没有 session_id：session_revoked');
select is(tests.fa('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-0000000000ff', 'get', '[{"bucket":"images","path":"p"}]') ->> 'error', 'session_revoked',
  'session_id 不在 auth.sessions 里（已退出登录）：session_revoked');
select is((select count(*)::int from private.counters where key like 'files_%:cccccccc-%' or key like 'files_%:bbbbbbbb-%'), 0,
  '停用、冷静期的调用不计数（先查身份再限流）');

-- ===== 按 uuid 比 id（代码审查低 3）：路径里的 id 段先认成 uuid 再和 uuid 列比，不把列转成文本（主键索引用得上）；
--       过得了路径正则、却不是合法 uuid 的段（正则 [0-9a-f-]{36} 放得过）只当“没有这一行”，不报错 =====
select is((select count(*)::int from pg_proc p where p.oid = 'private.files_authorize_impl(text, jsonb)'::regprocedure
  and p.prosrc ~ '\.(id|note_id|avatar_id)::text'), 0, 'files_authorize_impl 不把 id、note_id、avatar_id 列转成文本再比');
select is(tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/anniv/a0000000-0000-4000-8000-00000000000-/0a000000-0000-4000-8000-0000000000a1.webp'),
  'no_row', '头像：纪念日 id 段不是合法 uuid → no_row（不报错）');
select is(tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/anniv/a0000000-0000-4000-8000-0000000000a1/0a000000-0000-4000-8000-00000000000-.webp'),
  'not_owner', '头像：avatar 段不是合法 uuid → not_owner（不报错）');
select is(tests.fa1('put', 'files', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-00000000000-/f0000000-0000-4000-8000-0000000000a4.t.webp'),
  'no_row', '附件缩略图：note_id 段不是合法 uuid → no_row（不报错）');

-- ===== TC-B0-105：限流（一个事务里 now() 不变，分钟窗口不会跨） =====
delete from private.counters where key like 'files_%';
select is((select count(*)::int from generate_series(1, 30) g
  where tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.webp') = 'ok'), 30,
  '一分钟内 put 30 次都 ok');
select is(tests.fa1('put', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.webp'),
  'error:rate_limited', '第 31 次 put：rate_limited');
select is((select count(*)::int from generate_series(1, 120) g
  where tests.fa1('get', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.webp') = 'ok'), 120,
  '一分钟内 get 120 次都 ok（put 的计数不影响 get）');
select is(tests.fa1('get', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/40000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1.webp'),
  'error:rate_limited', '第 121 次 get：rate_limited');
select is((select string_agg(regexp_replace(key, '[0-9]{8}T[0-9]{4}$', '<分钟>') || '=' || count, ',' order by key) from private.counters where key like 'files_%'),
  'files_get:aaaaaaaa-0000-4000-8000-000000000001:<分钟>=121,files_put:aaaaaaaa-0000-4000-8000-000000000001:<分钟>=31',
  'counters 的键是 files_put / files_get:<A>:<UTC 分钟 YYYYMMDDTHHMI>，过得了 check 约束');
select is(tests.fa1('get', 'images', 'bbbbbbbb-0000-4000-8000-000000000002/40000000-0000-4000-8000-0000000000b1/1e000000-0000-4000-8000-0000000000b1.webp'),
  'error:rate_limited', 'A 被限流时整批拒，不逐项判断');
select is(tests.fa('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-5555-4000-8000-000000000002', 'get',
  '[{"bucket":"images","path":"bbbbbbbb-0000-4000-8000-000000000002/40000000-0000-4000-8000-0000000000b1/1e000000-0000-4000-8000-0000000000b1.webp"}]') -> 'items',
  '[{"i":0,"ok":true}]'::jsonb, '按人计数：A 被限流不影响 B');

select * from finish();
rollback;
