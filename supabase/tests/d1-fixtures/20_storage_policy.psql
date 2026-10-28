-- expect: storage.objects 上有策略 qa_probe
-- 架构 0.32：客户端不直接访问 Supabase Storage，storage.objects 上一条策略都不建（原 img_*、file_* 由 files_authorize 取代）
create policy qa_probe on storage.objects for select to authenticated using (bucket_id = 'vault-preview');
