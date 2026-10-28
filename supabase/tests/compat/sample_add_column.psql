-- expect-old-client: ok
-- 兼容样例（TC-B0-57，0.27 第 1 点“先加后删”）：只加列。新列可空或有默认值，旧版客户端照常读写
-- 这只是样例，不进 supabase/migrations；真迁移里加列还要同步改清单 clientWritable、列级授权、rows.ts（D1 核对）
alter table public.todos add column color text check (color is null or char_length(color) <= 16);
grant insert (color), update (color) on public.todos to authenticated;
