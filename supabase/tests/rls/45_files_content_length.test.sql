-- B4 S10 ③（部署第二步）：迁移 20261111101000_notes_files_content_length.sql，files_authorize_impl 的 content_length 强制校验
--   随手记插图（images 桶）put：缺了或不是非负整数 length_required（第二步新加）；
--   原图不等于这一行 bytes、缩略图大于 131072 length_mismatch（第一步 20261111100000 就有，这里连同强制后的次序一起复核）；
--   get 带了也忽略；纪念日头像、附件这一步不查；对上了以后照旧复核额度（quota_exceeded，见 44_media_quota）。
begin;
select plan(20);
\ir _helpers.psql
select tests.seed();

-- A 以自己的身份调一次 files_authorize，只看第一项：'ok' 或 reason
create function tests.fa1(p_op text, p_item jsonb) returns text language plpgsql as $$
declare r jsonb := tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  format('select public.files_authorize(%L, %L::jsonb) as r', p_op, jsonb_build_array(p_item)::text), null, 'aaaaaaaa-5555-4000-8000-000000000001') -> 0 -> 'r';
begin
  if r ? 'error' then return 'error:' || (r ->> 'error'); end if;
  return case when (r -> 'items' -> 0 ->> 'ok')::boolean then 'ok' else r -> 'items' -> 0 ->> 'reason' end;
end $$;
-- 随手记插图 4e…c1（1000 字节，有缩略图）的原图、缩略图 put 项，content_length 取 p_len（jsonb，null 表示不带这个键）
create function tests.item(p_thumb boolean, p_len jsonb) returns jsonb language sql as $$
  select jsonb_build_object('bucket', 'images', 'path',
    'aaaaaaaa-0000-4000-8000-000000000001/45000000-0000-4000-8000-0000000000a1/4e000000-0000-4000-8000-0000000000c1'
      || case when p_thumb then '.t.webp' else '.webp' end)
    || case when p_len is null then '{}'::jsonb else jsonb_build_object('content_length', p_len) end $$;

insert into public.notes (id, user_id, body, created_at, updated_at) values
  ('45000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'n', 1, 1);
insert into public.note_images (id, user_id, note_id, bucket, path, bytes, has_thumb) values
  ('4e000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001', '45000000-0000-4000-8000-0000000000a1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/45000000-0000-4000-8000-0000000000a1/4e000000-0000-4000-8000-0000000000c1.webp', 1000, true);
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at, avatar_id, avatar_bytes) values
  ('4a000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', '妈妈', 'solar', 3, 5, 1, 1,
   '4b000000-0000-4000-8000-0000000000c1', 100);

-- ===== 原图 =====
select is(tests.fa1('put', tests.item(false, '1000')), 'ok', '原图：content_length 等于这一行 bytes，放行');
select is(tests.fa1('put', tests.item(false, null)), 'length_required', '强制后原图缺 content_length：length_required');
select is(tests.fa1('put', tests.item(false, '"1000"')), 'length_required', '是字符串不是 JSON 数字：length_required');
select is(tests.fa1('put', tests.item(false, '-1')), 'length_required', '负数：length_required');
select is(tests.fa1('put', tests.item(false, '1000.5')), 'length_required', '小数：length_required');
select is(tests.fa1('put', tests.item(false, 'null')), 'length_required', 'JSON null：length_required');
select is(tests.fa1('put', tests.item(false, '999')), 'length_mismatch', '声明大小比 bytes 小：length_mismatch');
select is(tests.fa1('put', tests.item(false, '1001')), 'length_mismatch', '声明大小比 bytes 大：length_mismatch');
select is(tests.fa1('put', tests.item(false, '1000.0')), 'ok', '1000.0 是整数值，按 1000 认');

-- ===== 缩略图 =====
select is(tests.fa1('put', tests.item(true, '131072')), 'ok', '缩略图：刚好 128 KB 放行');
select is(tests.fa1('put', tests.item(true, '0')), 'ok', '缩略图：0 字节也算合法声明（≤ 128 KB）');
select is(tests.fa1('put', tests.item(true, '131073')), 'length_mismatch', '缩略图超过 128 KB：length_mismatch');
select is(tests.fa1('put', tests.item(true, null)), 'length_required', '强制后缩略图缺 content_length：length_required');

-- ===== 次序和别的项 =====
select is(tests.fa1('put', tests.item(false, '1000') || '{"foo": "bar"}'::jsonb), 'ok', '别的多余键照旧忽略');
select is(tests.fa1('get', tests.item(false, null)), 'ok', 'get 不带 content_length 照常放行');
select is(tests.fa1('get', tests.item(false, '"x"')), 'ok', 'get 带了坏的 content_length 也忽略');
select is(tests.fa1('put', jsonb_build_object('bucket', 'images', 'path',
  'aaaaaaaa-0000-4000-8000-000000000001/anniv/4a000000-0000-4000-8000-0000000000c1/4b000000-0000-4000-8000-0000000000c1.webp')), 'length_required',
  '纪念日头像 put 也要 content_length（20261114192000 起，B5 整块评审第 4 条；等于 avatar_bytes 等见 52_anniv_avatar_quota）');
select is(tests.fa1('put', jsonb_build_object('bucket', 'images', 'path',
  'aaaaaaaa-0000-4000-8000-000000000001/45000000-0000-4000-8000-0000000000a1/4e000000-0000-4000-8000-0000000000c9.webp')), 'no_row',
  '没有这一行时先回 no_row（不因缺 content_length 改口）');
insert into private.user_limits (user_id, media_mb) values ('aaaaaaaa-0000-4000-8000-000000000001', 0);
select is(tests.fa1('put', tests.item(false, '999')), 'length_mismatch', '大小对不上先于额度报（length_mismatch）');
select is(tests.fa1('put', tests.item(false, '1000')), 'quota_exceeded', '大小对上了再复核额度：超了 quota_exceeded');

select * from finish();
rollback;
