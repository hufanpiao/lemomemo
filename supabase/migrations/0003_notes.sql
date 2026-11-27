-- 0003_notes.sql：categories、notes、note_images（images 桶 0.32 起在 R2，不在这里建；附录 A；数据字典 4.10～4.12；清单 notes.ts）

-- ===== categories =====
create table public.categories (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  rev int not null default 1, fv jsonb not null default '{}', deleted_at bigint,
  undone boolean not null default false, synced_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 12),
  color text, sort int not null default 0,
  created_by text not null default 'user' check (created_by in ('ai','user')), merged_into uuid);
insert into private.table_meta (tbl, system_cols, no_conflict) values ('categories', '{}', '{sort}');
alter table public.categories add constraint categories_id_user_key unique (id, user_id);   -- 0.29 续第 81 条（P-06）
create unique index on public.categories (user_id, lower(name)) where deleted_at is null;
create index on public.categories (user_id, synced_at);

create trigger categories_touch before insert or update on public.categories for each row execute function private.touch();
create trigger categories_quota before insert on public.categories for each row execute function private.row_quota();
create trigger categories_tombstone after delete on public.categories for each row execute function private.write_tombstone();

alter table public.categories enable row level security;
create policy sel on public.categories for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.categories for insert to authenticated with check (user_id = (select auth.uid()) and private.is_active());
create policy upd on public.categories for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active()) with check (user_id = (select auth.uid()));
revoke all on public.categories from anon, authenticated;
grant select on public.categories to authenticated;
grant insert (id, name, color, sort, created_by, merged_into) on public.categories to authenticated;   -- 这张表没有 created_at、updated_at
grant update (name, color, sort, created_by, merged_into, deleted_at, undone) on public.categories to authenticated;

-- ===== notes =====
create table public.notes (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  rev int not null default 1, fv jsonb not null default '{}', deleted_at bigint,
  undone boolean not null default false, synced_at timestamptz not null default now(),
  title text check (char_length(title) <= 160), body text check (char_length(body) <= 20000),
  is_private boolean not null default false, body_enc bytea, enc_key_id smallint,
  category_id uuid, category_source text not null default 'none',
  category_seen boolean not null default true, ai_status text not null default 'pending', ai_meta jsonb,
  tags text[] not null default '{}', converted_to jsonb, source text not null default 'page',
  raw_text text not null default '', batch_id uuid, created_at bigint not null, updated_at bigint not null,
  check ((is_private and body is null and title is null and body_enc is not null
          -- 第七轮：隐私记不能留明文残留
          and raw_text = '' and tags = '{}' and ai_meta is null and converted_to is null)
      or (not is_private and body_enc is null)));
insert into private.table_meta (tbl, system_cols, no_conflict) values ('notes', '{ai_status,ai_meta}', '{updated_at}');
alter table public.notes add constraint notes_id_user_key unique (id, user_id);   -- 0.29 续第 81 条（P-06）
-- 低 3：分类删掉时只置空 category_id（PG15 起可只置空部分列）
alter table public.notes add foreign key (category_id, user_id) references public.categories (id, user_id) on delete set null (category_id);
create index on public.notes (ai_status) where ai_status = 'pending';   -- 服务器端不建全文索引（复审 L-f）
create index on public.notes (user_id, synced_at);

create trigger notes_touch before insert or update on public.notes for each row execute function private.touch();
create trigger notes_quota before insert on public.notes for each row execute function private.row_quota();
create trigger notes_tombstone after delete on public.notes for each row execute function private.write_tombstone();

alter table public.notes enable row level security;
-- 3.3 B：客户端只能写普通随手记；隐私记只经 vault 函数（service role / fn_vault）
create policy sel on public.notes for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.notes for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_active() and is_private = false and body_enc is null);
create policy upd on public.notes for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active() and is_private = false)
  with check (user_id = (select auth.uid()) and is_private = false and body_enc is null);
revoke all on public.notes from anon, authenticated;
grant select on public.notes to authenticated;
grant insert (id, title, body, is_private, category_id, category_source, category_seen, tags, converted_to,
  source, raw_text, batch_id, created_at, updated_at) on public.notes to authenticated;
grant update (title, body, category_id, category_source, category_seen, tags, converted_to,
  source, raw_text, batch_id, deleted_at, undone, updated_at) on public.notes to authenticated;   -- is_private 不给（移进隐私记由 vault 函数改）

-- ===== note_images =====
create table public.note_images (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  rev int not null default 1, fv jsonb not null default '{}', deleted_at bigint,
  undone boolean not null default false, synced_at timestamptz not null default now(),
  note_id uuid not null,
  foreign key (note_id, user_id) references public.notes (id, user_id) on delete cascade,   -- 不能挂到别人的随手记上（安全审查低 3）
  bucket text not null check (bucket in ('images','vault-images')), path text not null unique,
  bytes int not null check (bytes <= 10485760), width int, height int, mime text not null default 'image/webp',
  taken_at bigint,                                    -- R-108：不存定位
  has_thumb boolean not null default false,           -- 缩略图路径由 path 拼出 <…>/<id>.t.webp
  ai_status text not null default 'pending' check (ai_status in ('pending','done','skip','failed')),
  skip_reason text check (skip_reason in ('consent','vault_off','other')),   -- 0.29 续第 120 条（R-179）
  ai_desc text check (char_length(ai_desc) <= 200),
  ai_tags text[] not null default '{}' check (cardinality(ai_tags) <= 12), ai_tries smallint not null default 0,
  ai_next_at bigint,
  check (path = user_id::text || '/' || note_id::text || '/' || id::text || '.webp'),   -- 0.23：钉死整个拼法
  check (bucket <> 'vault-images' or taken_at is null),                               -- 隐私记图片不存拍摄时间
  check (bucket <> 'vault-images' or (ai_desc is null and ai_tags = '{}')));           -- 隐私记图片的描述放 private.vault_ai
insert into private.table_meta (tbl, system_cols, no_conflict) values ('note_images', '{ai_status,skip_reason,ai_desc,ai_tags,ai_tries,ai_next_at}', '{}');
alter table public.note_images add constraint note_images_id_user_key unique (id, user_id);   -- 0.29 续第 81 条（P-06）
create index on public.note_images (user_id, synced_at);
create index on public.note_images (note_id);

-- 0.33（B0 代码审查低 8）：客户端插的图只能挂在本人的普通随手记上（隐私记的图只经 vault-image {action: upload}）
--   和 guard_note_file() 同一口径：只拦请求角色 authenticated / anon，服务器一侧（fn_vault 移进移出、vault-image）靠列级授权；
--   update 只授 deleted_at、undone，改不了 note_id，所以只查 insert。预览项目还没部署，直接写在这里（同 0.31 第 17 条）
create function private.guard_note_image() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('role', true), '') not in ('authenticated', 'anon') then return new; end if;
  if not exists (select 1 from public.notes n where n.id = new.note_id and n.user_id = new.user_id and not n.is_private) then
    raise exception 'note_not_writable'; end if;
  return new;
end $$;
grant execute on function private.guard_note_image() to authenticated;        -- 0003  触发器函数：security definer
create trigger note_images_guard before insert on public.note_images for each row execute function private.guard_note_image();
create trigger note_images_touch before insert or update on public.note_images for each row execute function private.touch();
create trigger note_images_quota before insert on public.note_images for each row execute function private.row_quota();
create trigger note_images_tombstone after delete on public.note_images for each row execute function private.write_tombstone();

alter table public.note_images enable row level security;
create policy sel on public.note_images for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.note_images for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_active() and bucket = 'images');
create policy upd on public.note_images for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active()) with check (user_id = (select auth.uid()));
revoke all on public.note_images from anon, authenticated;
grant select on public.note_images to authenticated;
grant insert (id, note_id, bucket, path, bytes, width, height, mime, taken_at, has_thumb) on public.note_images to authenticated;
grant update (deleted_at, undone) on public.note_images to authenticated;   -- 没有 updated_at（P-19）；图片不可变

-- storage-sweep 只读定位列（0.29 续第 86 条；Supabase 默认已给 service_role 全表权限，这里只作登记和 D1 核对）
grant select (id, user_id, note_id, bucket, path, has_thumb, deleted_at) on public.note_images to service_role;   -- 0003

-- ===== fn_vault、fn_ai（6.2；0.29 续第 74 条：同步表不给 delete） =====
create policy fn_own on public.notes for all to fn_vault
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
create policy fn_own_ai on public.notes for select to fn_ai
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select, insert, update on public.notes to fn_vault;
grant select (id, user_id, title, body, body_enc, enc_key_id, is_private, category_id, deleted_at) on public.notes to fn_ai;   -- 算向量（隐私记也进，D-8）

create policy fn_own on public.note_images for all to fn_vault
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
create policy fn_own_ai on public.note_images for all to fn_ai
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select, insert, update on public.note_images to fn_vault;
grant select (id, user_id, note_id, bucket, path, has_thumb, mime, deleted_at,
  ai_status, skip_reason, ai_desc, ai_tags, ai_tries, ai_next_at) on public.note_images to fn_ai;
grant update (ai_status, skip_reason, ai_desc, ai_tags, ai_tries, ai_next_at) on public.note_images to fn_ai;

-- ===== images 桶：0.32（R-213）起存 Cloudflare R2，这里不建桶、不建存储策略 =====
-- 原来的 images 桶和 img_sel、img_ins、img_del 三条策略由 public.files_authorize（0004）和 /files/v1/* 函数取代（3.3 G“R2 起”）；
--   路径正则原样搬进 private.files_authorize_impl，清单 notes.ts、anniv.ts 的 pathPattern 是唯一出处（D1 核对一字不差）；
--   D1 核对 images 不在 storage.buckets 里（清单 store = 'r2'）。预览项目还没部署，直接改这里，不另写迁移

alter publication supabase_realtime add table public.categories, public.notes, public.note_images;
