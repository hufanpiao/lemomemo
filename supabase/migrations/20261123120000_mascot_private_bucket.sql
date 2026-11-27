-- 吉祥物 #2 的私有存储：同人作品不随 App 分发，只有管理员本人能按需下载（负责人 11-23）
-- • 桶不公开，只收 .riv（内容类型 application/x-rive），单个不超过 1 MB；路径固定 2.riv（shared/manifests/core.ts）
-- • storage.objects 只加一条 SELECT 策略给管理员；不给任何人写入策略，文件只能用 service_role 上传
-- • 判定和其他地方一样看 private.admins，并要求账号可用、不是密码会话（private.is_active）
-- 测试：supabase/tests/rls/73_mascot_private.test.sql；D1 逐字核这条策略（build/d1/policies.ts）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('mascot-private', 'mascot-private', false, 1048576, array['application/x-rive'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create function private.is_self_admin() returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.is_active() and exists (select 1 from private.admins a where a.user_id = (select auth.uid()))
$$;
grant execute on function private.is_self_admin() to authenticated;

create policy mascot_private_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'mascot-private' and (select private.is_self_admin()));
