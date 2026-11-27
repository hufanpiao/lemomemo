-- 20261119120000_categories_vault.sql：隐私记有自己的一套分类（负责人 11-19：“隐私记可以新建分类，然后里面的记录可以拖进分类里面，
-- 也可以在分类里倒入没分类的记录”；问“隐私记的分类跟随手记分开吗”答“隐私记自己一套”；问分类名要不要加密答“不加密，只分开”）。
-- 本迁移做的事：
--   ① public.categories 加 vault boolean not null default false：true 是隐私记的分类，false 是随手记的（原有的行全是随手记的）；
--      建好以后不改（不进 apply_patch 白名单、不给 update 授权）：一个分类不会从随手记挪到隐私记；
--   ② 同名唯一索引换成按 (user_id, vault, lower(name))：随手记、隐私记各自不重名，两边可以各有一个“证件”；
--   ③ 列级授权：authenticated 能 insert vault（客户端新建隐私记分类时带 vault = true）。
--   ④ 老的隐私记记录指着随手记分类的，复制一份隐私记分类、改指过去（见第 ④ 段）。
-- RLS、触发器（touch、row_quota、tombstone）都不动；ai-classify 只读、只建 vault = false 的（隐私记记录不送 AI）。
-- 改 categories 的索引要拿锁：5 秒拿不到就整个迁移回滚，等长事务结束再推。
set local lock_timeout = '5s';

-- ===== ① 新列 =====
alter table public.categories add column vault boolean not null default false;

-- ===== ② 同名唯一索引按两套分开 =====
drop index public.categories_user_id_lower_idx;
create unique index categories_user_vault_name_key on public.categories (user_id, vault, lower(name)) where deleted_at is null;

-- ===== ③ 列级授权 =====
grant insert (vault) on public.categories to authenticated;

-- ===== ④ 老的隐私记记录搬到隐私记自己的分类（独立评审 11-19 高 1） =====
-- 这之前隐私记编辑页、AI 归类读的是同一套分类，is_private 的记录可能指着随手记分类（category_id 是明文列）。
-- 不搬的话上线后这些记录在隐私记里全变成“没分类”。做法：被隐私记记录用到的、活着的随手记分类，按用户各复制一份 vault = true
-- （名字、颜色、排序、来源照抄，新 id），再把这些隐私记记录改指新分类。随手记那一份不动（随手记记录照旧用它）。
-- 已删的分类不复制（原来归类时就当没分类）。迁移连接配额触发器豁免；touch 照常记版本、synced_at，客户端增量同步拿到改动。
create temp table vault_cat_map on commit drop as
  select c.id as old_id, gen_random_uuid() as new_id, c.user_id, c.name, c.color, c.sort, c.created_by
  from public.categories c
  where c.vault = false and c.deleted_at is null
    and exists (select 1 from public.notes n where n.user_id = c.user_id and n.category_id = c.id and n.is_private);

insert into public.categories (id, user_id, name, color, sort, created_by, vault)
  select new_id, user_id, name, color, sort, created_by, true from vault_cat_map;

update public.notes n set category_id = m.new_id
  from vault_cat_map m
  where n.user_id = m.user_id and n.category_id = m.old_id and n.is_private;
