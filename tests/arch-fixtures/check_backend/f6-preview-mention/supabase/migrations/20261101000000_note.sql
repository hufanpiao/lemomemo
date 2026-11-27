-- 违规 F6：迁移的注释里也不准提到预览专用目录
-- 见 supabase/functions/_preview/r2-probe
-- 对照：表名 vault_preview 前面是字母，不算
select 1 from private.vault_preview;
