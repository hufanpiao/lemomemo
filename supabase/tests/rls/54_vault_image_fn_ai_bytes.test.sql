-- 迁移 20261114231000_vault_image_fn_ai_bytes.sql：fn_ai 对 public.note_images 的列级 select 加上 bytes（B5 隐私记整块评审第 3、9 条）
-- 覆盖：
--   ① 授权形状：fn_ai 在 note_images 上能 select bytes，还是没有表级 select（path 以外的列照旧按 0003 的清单）；
--   ② vault-image 的 imageMeta 那一句（supabase/functions/vault-image/store.ts）以 fn_ai 跑得通：本人没删的行读得到 bytes，已删的行读不到；
--   ③ RLS 照旧：A 的事务里读不到 B 的行；app.uid 没设时一行都读不到。
-- 用户：A、B（tests.seed）
begin;
select plan(6);
\ir _helpers.psql
select tests.seed();

insert into public.notes (id, user_id, body, created_at, updated_at) values
  ('53000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'a', 1, 1),
  ('53000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'b', 1, 1);
insert into public.note_images (id, user_id, note_id, bucket, path, bytes, has_thumb, deleted_at) values
  ('53000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', '53000000-0000-4000-8000-0000000000a1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/53000000-0000-4000-8000-0000000000a1/53000000-0000-4000-8000-0000000000a2.webp', 1234, true, null),
  ('53000000-0000-4000-8000-0000000000a3', 'aaaaaaaa-0000-4000-8000-000000000001', '53000000-0000-4000-8000-0000000000a1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/53000000-0000-4000-8000-0000000000a1/53000000-0000-4000-8000-0000000000a3.webp', 99, false, 5),
  ('53000000-0000-4000-8000-0000000000b2', 'bbbbbbbb-0000-4000-8000-000000000002', '53000000-0000-4000-8000-0000000000b1', 'images',
   'bbbbbbbb-0000-4000-8000-000000000002/53000000-0000-4000-8000-0000000000b1/53000000-0000-4000-8000-0000000000b2.webp', 77, false, null);

-- ===== ① 授权形状 =====
select ok(has_column_privilege('fn_ai', 'public.note_images', 'bytes', 'SELECT'), 'fn_ai 能读 note_images.bytes');
select ok(not has_table_privilege('fn_ai', 'public.note_images', 'SELECT'), 'fn_ai 照旧没有 note_images 的表级 select');

-- ===== ② imageMeta 那一句 =====
select is(tests.rows_as('fn_ai', null, $$select note_id, bucket, has_thumb, bytes from public.note_images
    where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and id = '53000000-0000-4000-8000-0000000000a2' and deleted_at is null$$,
  'aaaaaaaa-0000-4000-8000-000000000001'),
  '[{"bytes": 1234, "bucket": "images", "note_id": "53000000-0000-4000-8000-0000000000a1", "has_thumb": true}]'::jsonb,
  'A 的事务里读得到本人没删那张图的 note_id、bucket、has_thumb、bytes');
select is(tests.rows_as('fn_ai', null, $$select bytes from public.note_images
    where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and id = '53000000-0000-4000-8000-0000000000a3' and deleted_at is null$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), '[]'::jsonb, '已删的那张读不到（整块评审第 9 条）');

-- ===== ③ RLS 照旧 =====
select is(tests.rows_as('fn_ai', null, $$select bytes from public.note_images where id = '53000000-0000-4000-8000-0000000000b2'$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), '[]'::jsonb, 'A 的事务里读不到 B 的图');
select is(tests.rows_as('fn_ai', null, $$select bytes from public.note_images$$), '[]'::jsonb, '没设 app.uid 时一行都读不到');

select * from finish();
rollback;
