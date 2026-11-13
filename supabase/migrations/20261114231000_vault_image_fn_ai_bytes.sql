-- 20261114231000_vault_image_fn_ai_bytes.sql：给 fn_ai 补 public.note_images 的列级 select (bytes)（B5 隐私记整块评审第 3 条）。
-- 为什么：vault-image 原来上传前只核对“这条是本人的隐私记”就写进 R2，不占存储额度、不登记，传多少都行。
--   改成和普通插图同一口径：vault {save, add_images} 先预登记 note_images 行（row_quota、media_quota_guard 触发器照常算行数和存储额度），
--   vault-image 只收已登记、没删的 image_id，原图字节数必须等于登记的 bytes——要读 bytes 这一列，0003 只给了 fn_ai
--   (id, user_id, note_id, bucket, path, has_thumb, mime, deleted_at, ai_*)。
-- 做法：只加这一列；fn_own_ai 策略照旧只放本人的行（app.uid）。已删的行不让取、不让传由 vault-image 的查询带 deleted_at is null（整块评审第 9 条，
--   deleted_at 0003 已经给了，不用改授权）。
-- 同步改的地方：build/d1/whitelist.ts 的 COLUMN_GRANTS.fn_ai、架构附录 A 末尾的逐表清单（0003 public.note_images 一行）；D1 比对。
-- 回滚：revoke select (bytes) on public.note_images from fn_ai;（回滚后 vault-image 上传一律 503）
grant select (bytes) on public.note_images to fn_ai;   -- vault-image 上传核对登记的字节数（附录 A、D1 COLUMN_GRANTS）
