-- 20261114230000_vault_fn_grants.sql：给 fn_vault 补 private.note_vectors 的列级 select (user_id, note_id, image_id)（B5 隐私记 store-it 真库实测）。
-- 为什么：vault 函数移进、移出隐私记时（supabase/functions/vault/store.ts 的 dropVectors）要删这条随手记和它图片的旧向量：
--   delete from private.note_vectors where user_id = … and (note_id = … or image_id in (…))
--   Postgres 规定 delete 的 where 里引用到的列要有 select 权限；0007 只给了 fn_vault 表级 delete，在 lemo-e2e 上实测回
--   42501 permission denied for table note_vectors，移进、移出一律失败（内存假库的单测看不出来）。
-- 做法：只给 where 用到的三列（定位列，不含 embedding、content_hash）。fn_own 策略照旧只放本人的行（app.uid），看不到别人的。
--   不改成 security definer 函数：多一个函数、多一份 app.uid 核对，只为删几行，不值得；表级 select 也不给。
-- 同步改的地方：build/d1/whitelist.ts 的 COLUMN_GRANTS.fn_vault、架构附录 A 末尾的逐表清单（0007 private.note_vectors 一行）；D1 比对。
-- 回滚：revoke select (user_id, note_id, image_id) on private.note_vectors from fn_vault;（回滚后移进移出又会失败）
grant select (user_id, note_id, image_id) on private.note_vectors to fn_vault;   -- 移进移出删旧向量的 where 要读（附录 A、D1 COLUMN_GRANTS）
