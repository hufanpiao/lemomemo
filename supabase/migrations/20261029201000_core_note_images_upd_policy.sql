-- B1 迁移：note_images 的 upd 策略排除隐私记图片（apply_patch 审查必改；漏洞在 0003_notes.sql 第 118～119 行的原策略）
-- 原策略 using (user_id = 本人 and private.is_active()) with check (user_id = 本人) 没看 bucket；
--   guard_note_image() 只挂 insert（0003 注释：update 只授 deleted_at、undone，改不了 note_id），
--   于是客户端经 apply_patch 或直接 REST PATCH 能把 bucket = 'vault-images' 的隐私记图片行全部软删（deleted_at），30 天后被清理硬删。
-- 以原策略为底，只加 bucket = 'images'（和 ins 策略同一口径；隐私记图片只经 vault-image / fn_vault 改）：
--   客户端看得到隐私记图片行（sel 不变，列表要用），但 update 匹配不到，apply_patch 回 not_found、直接 PATCH 影响 0 行。
-- note_files 的 upd 策略原本就有 is_vault = false，不用改。
-- 纵深防御（架构 0.38 第 61 条）：using 再要求所属随手记不是隐私记。万一 B5 的 vault 函数移进隐私记时漏改了 bucket
--   （图片行还是 'images'、却挂在隐私记下），客户端照样改不了它。with check 不加：客户端只能改 deleted_at、undone，note_id 改不了。
--   子查询以调用人身份读 notes（受 notes 的 sel 策略约束，本人的隐私记看得到）；note_id 写全成 note_images.note_id，免得被解析成 notes 的列
alter policy upd on public.note_images
  using (user_id = (select auth.uid()) and private.is_active() and bucket = 'images'
         and exists (select 1 from public.notes n where n.id = note_images.note_id and not n.is_private))
  with check (user_id = (select auth.uid()) and bucket = 'images');
