-- 迁移 20261114200000_vault_fn_grants.sql：fn_vault 对 private.note_vectors 的列级 select (user_id, note_id, image_id)（B5 隐私记 store-it 真库实测）
-- 覆盖：
--   ① 授权形状：fn_vault 在 note_vectors 上的列级 select 正好是这三列，没有表级 select，embedding、content_hash 读不到；
--   ② vault 函数移进移出时 dropVectors 那句 delete（where 引用 user_id、note_id、image_id）以 fn_vault 跑得通，删掉本人这条的向量；
--   ③ RLS 照旧：同一句 where 指着 B 的随手记，A 的事务里删 0 行，B 的向量还在；app.uid 没设时一行都删不到。
-- 用户：A、B（tests.seed）
begin;
select plan(7);
\ir _helpers.psql
select tests.seed();

insert into public.notes (id, user_id, body, created_at, updated_at) values
  ('51000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'a', 1, 1),
  ('51000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'b', 1, 1);
insert into public.note_images (id, user_id, note_id, bucket, path, bytes) values
  ('51000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', '51000000-0000-4000-8000-0000000000a1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/51000000-0000-4000-8000-0000000000a1/51000000-0000-4000-8000-0000000000a2.webp', 1);
insert into private.note_vectors (user_id, kind, source_id, note_id, image_id, model, content_hash, embedding)
  select u, k, s, n, i, 'm', 'h', ('[' || array_to_string(array_fill(0, array[768]), ',') || ']')::extensions.halfvec
  from (values
    ('aaaaaaaa-0000-4000-8000-000000000001'::uuid, 'note', '51000000-0000-4000-8000-0000000000a1'::uuid, '51000000-0000-4000-8000-0000000000a1'::uuid, null::uuid),
    ('aaaaaaaa-0000-4000-8000-000000000001'::uuid, 'image', '51000000-0000-4000-8000-0000000000a2'::uuid, null::uuid, '51000000-0000-4000-8000-0000000000a2'::uuid),
    ('bbbbbbbb-0000-4000-8000-000000000002'::uuid, 'note', '51000000-0000-4000-8000-0000000000b1'::uuid, '51000000-0000-4000-8000-0000000000b1'::uuid, null::uuid)
  ) v(u, k, s, n, i);

-- ===== ① 授权形状 =====
select is((select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
  where grantee = 'fn_vault' and table_schema = 'private' and table_name = 'note_vectors' and privilege_type = 'SELECT'),
  'image_id,note_id,user_id', 'fn_vault 在 note_vectors 上的列级 select 正好是 user_id、note_id、image_id');
select ok(not has_table_privilege('fn_vault', 'private.note_vectors', 'SELECT'), 'fn_vault 没有 note_vectors 的表级 select');
select ok(tests.try_as('fn_vault', null, 'select embedding from private.note_vectors', 'aaaaaaaa-0000-4000-8000-000000000001') like '42501 %',
  'fn_vault 读 embedding 被拒（42501）');

-- ===== ② dropVectors 那句 delete 以 fn_vault 跑得通 =====
select is(tests.try_as('fn_vault', null, $$delete from private.note_vectors where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'
  and (note_id = '51000000-0000-4000-8000-0000000000a1' or image_id in (select id from public.note_images
    where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and note_id = '51000000-0000-4000-8000-0000000000a1'))$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), 'ok', 'A 的事务里删 A 这条随手记和它图片的向量：不再报 permission denied');
select is((select count(*)::int from private.note_vectors where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 0, 'A 的两条向量都删掉了');

-- ===== ③ RLS 照旧 =====
select is(tests.try_as('fn_vault', null, $$delete from private.note_vectors where note_id = '51000000-0000-4000-8000-0000000000b1'$$,
  'aaaaaaaa-0000-4000-8000-000000000001') || '|' || tests.try_as('fn_vault', null,
  $$delete from private.note_vectors where note_id = '51000000-0000-4000-8000-0000000000b1'$$), 'ok|ok',
  'A 的事务、没设 app.uid 的事务删 B 的向量：语句不报错（RLS 过滤）');
select is((select count(*)::int from private.note_vectors where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'), 1, 'B 的向量还在（删到 0 行）');

select * from finish();
rollback;
