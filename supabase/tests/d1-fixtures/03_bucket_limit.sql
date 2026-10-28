-- expect: 桶 backups 的 file_size_limit
-- TC-B0-74：手工把 backups 的大小限制改大（0.32 起 Supabase 里只剩 backups、vault-preview）
update storage.buckets set file_size_limit = 99999999 where id = 'backups';
