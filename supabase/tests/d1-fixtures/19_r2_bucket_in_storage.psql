-- expect: 桶 images 是 R2 桶
-- TC-B0-118（架构 0.32）：有人又在 Supabase 建了 images 桶（客户端就能经 storage-js 绕过 /files 和 files_authorize）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('images', 'images', false, 2097152, array['image/webp']);
