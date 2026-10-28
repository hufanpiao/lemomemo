-- 0004_attachments.sql：note_files、guard_note_file()、file_slot_open()、files 桶（附录 A；3.3 A / G；数据字典 4.13；清单 attachments.ts）

create table public.note_files (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  rev int not null default 1, fv jsonb not null default '{}', deleted_at bigint,
  undone boolean not null default false, synced_at timestamptz not null default now(),
  note_id uuid not null,
  foreign key (note_id, user_id) references public.notes (id, user_id) on delete cascade,
  kind text not null check (kind in ('pdf','docx','xlsx','pptx','docm','xlsm','pptm','doc','xls','ppt')),   -- R-114 D-4
  path text not null unique check (path = user_id::text || '/' || note_id::text || '/' || id::text || '.' || kind),
  has_thumb boolean not null default false,
  is_vault boolean not null default false,            -- R-115：对象在 vault-files 桶、加密
  -- 0.20 L3：去掉控制字符、方向控制字符和 Windows 不允许的字符；不能以点或空格结尾；不能是保留名
  name text check (name is null or (char_length(name) between 1 and 120
      and name !~ '[\u0000-\u001f‪-‮⁦-⁩\\/:*?"<>|]' and name !~ '[. ]$'
      and lower(split_part(name,'.',1)) !~ '^(con|prn|aux|nul|com[0-9]|lpt[0-9])$')),
  mime text not null, bytes int not null check (bytes <= 10485760),
  sha256 text not null, pages int, text_excerpt text check (char_length(text_excerpt) <= 20000),
  name_enc bytea, text_enc bytea, dek_enc bytea, enc_key_id smallint,   -- R-115；is_vault 的行 sha256 存 HMAC
  etag text,
  check_status text not null default 'pending' check (check_status in ('pending','ok','rejected')),
  ai_status text not null default 'pending' check (ai_status in ('pending','done','skip','failed')),
  skip_reason text check (skip_reason in ('consent','vault_off','other')),   -- 0.29 续第 120 条（R-179）
  ai_desc text check (char_length(ai_desc) <= 200),
  ai_tags text[] not null default '{}' check (cardinality(ai_tags) <= 12), ai_tries smallint not null default 0, ai_next_at bigint,
  created_at bigint not null, updated_at bigint not null,
  unique (id, user_id),
  -- 普通的：名字明文、没有密文；隐私记的：明文列和 AI 描述全空，密文列和数据密钥齐全
  check ((not is_vault and name is not null and name_enc is null and text_enc is null and dek_enc is null)
      or (is_vault and name is null and text_excerpt is null and ai_desc is null and ai_tags = '{}'
          and name_enc is not null and dek_enc is not null and enc_key_id is not null)));
insert into private.table_meta (tbl, system_cols, no_conflict) values
  ('note_files', '{ai_status,skip_reason,ai_desc,ai_tags,ai_tries,ai_next_at,check_status,etag}', '{updated_at}');
create index on public.note_files (user_id, synced_at);
create index on public.note_files (note_id);

-- 0.20：客户端写的行，挂的随手记必须是本人的普通随手记、is_vault 必须 false；update 时不可变列一变就报错
--   只管客户端（请求角色 authenticated / anon，0.29 续第 142 条的写法）：vault-file 移进隐私记时要改 sha256（换成 HMAC）、bytes（密文）
create function private.guard_note_file() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('role', true), '') not in ('authenticated', 'anon') then return new; end if;
  if new.is_vault then raise exception 'vault_file_readonly'; end if;
  if not exists (select 1 from public.notes n where n.id = new.note_id and n.user_id = new.user_id and not n.is_private) then
    raise exception 'note_not_writable'; end if;
  if tg_op = 'UPDATE' and (new.note_id, new.kind, new.mime, new.bytes, new.sha256, new.has_thumb, new.path)
       is distinct from (old.note_id, old.kind, old.mime, old.bytes, old.sha256, old.has_thumb, old.path) then
    raise exception 'file_immutable'; end if;
  return new;
end $$;
grant execute on function private.guard_note_file() to authenticated;         -- 0004  触发器函数：security definer
create trigger note_files_guard before insert or update on public.note_files for each row execute function private.guard_note_file();
create trigger note_files_touch before insert or update on public.note_files for each row execute function private.touch();
create trigger note_files_quota before insert on public.note_files for each row execute function private.row_quota();
create trigger note_files_tombstone after delete on public.note_files for each row execute function private.write_tombstone();

alter table public.note_files enable row level security;
create policy sel on public.note_files for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.note_files for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_active() and is_vault = false);
create policy upd on public.note_files for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active() and is_vault = false)
  with check (user_id = (select auth.uid()) and is_vault = false);
revoke all on public.note_files from anon, authenticated;
grant select on public.note_files to authenticated;
-- 列级授权（0.20；0.29 P-40）：is_vault、密文列、etag、check_status、ai_* 只有服务器函数能写
grant insert (id, note_id, kind, path, has_thumb, name, mime, bytes, sha256, pages, text_excerpt, created_at, updated_at)
  on public.note_files to authenticated;
grant update (name, deleted_at, undone, updated_at) on public.note_files to authenticated;

grant select (id, user_id, note_id, kind, path, has_thumb, is_vault, check_status, deleted_at) on public.note_files to service_role;   -- 0004  storage-sweep

-- fn_vault、fn_ai（6.2）
create policy fn_own on public.note_files for all to fn_vault
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
create policy fn_own_ai on public.note_files for all to fn_ai
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select, insert, update on public.note_files to fn_vault;
grant select (id, user_id, note_id, kind, path, has_thumb, is_vault, name, mime, bytes, text_excerpt, text_enc, enc_key_id, deleted_at,
  etag, check_status, ai_status, skip_reason, ai_desc, ai_tags, ai_tries, ai_next_at) on public.note_files to fn_ai;
grant update (check_status, etag, ai_status, skip_reason, ai_desc, ai_tags, ai_tries, ai_next_at) on public.note_files to fn_ai;

-- files 桶 insert 策略用：只认本人 pending、还没有对象的路径（0.20 S1）
create function private.file_slot_open(p_name text) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.note_files f
     where f.user_id = (select auth.uid()) and not f.is_vault and f.check_status = 'pending' and f.deleted_at is null
       and (f.path = p_name
            or (f.has_thumb and p_name = f.user_id::text || '/' || f.note_id::text || '/' || f.id::text || '.t.webp')))
  and not exists (select 1 from storage.objects o where o.bucket_id = 'files' and o.name = p_name)
$$;
grant execute on function private.file_slot_open(text) to authenticated;       -- 0004

-- ===== files 桶（3.3 G）：10 种文档类型和 image/webp（缩略图） =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('files', 'files', false, 10485760, array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',     -- docx
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',           -- xlsx
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',   -- pptx
    'application/vnd.ms-word.document.macroEnabled.12',                            -- docm
    'application/vnd.ms-excel.sheet.macroEnabled.12',                              -- xlsm
    'application/vnd.ms-powerpoint.presentation.macroEnabled.12',                  -- pptm
    'application/msword',                                                          -- doc
    'application/vnd.ms-excel',                                                    -- xls
    'application/vnd.ms-powerpoint',                                               -- ppt
    'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
create policy file_sel on storage.objects for select to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy file_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text
    and private.file_slot_open(name));
-- 不建 update、delete 策略：检查过的文件不能被换掉；对象由 storage-sweep 删

alter publication supabase_realtime add table public.note_files;
