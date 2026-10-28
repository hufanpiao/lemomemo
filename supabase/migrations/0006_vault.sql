-- 0006_vault.sql：隐私记的 private 表、三个隐私桶、scan_vault_preview（附录 A；6.2；数据字典 5.2；清单 vault.ts）
-- service_role 不碰这里的任何表（0.29 续第 52 条 ①）；只经 fn_vault、fn_ai 直连，会话变量版 RLS

create table private.vault (
  user_id uuid primary key references auth.users on delete cascade,   -- 0.29（P-17）
  pin_hash text not null, pin_epoch int not null default 0,   -- 第七轮：重设或改密码加 1，旧 vault_token 失效
  fail_count int default 0, lock_level int default 0, locked_until timestamptz, last_reset_at timestamptz);
create table private.vault_credentials (
  credential_id text primary key, user_id uuid not null references auth.users on delete cascade,   -- 0.29（P-17）
  public_key bytea not null, sign_count bigint not null default 0, device_label text);              -- 0.29 续第 46 条
create table private.device_secrets (   -- 0.23（R-123）：每台设备的草稿密钥盐，只在服务器上
  device_id uuid primary key, user_id uuid not null references auth.users on delete cascade,
  draft_salt bytea not null check (octet_length(draft_salt) = 32), enc_key_id smallint not null,
  created_at timestamptz not null default now(),
  foreign key (device_id, user_id) references public.devices (id, user_id) on delete cascade);
create table private.vault_ai (   -- 隐私记的图片和文档共用；VAULT_KEY 加密，AAD = user_id|kind|id
  kind text not null check (kind in ('image','file')), source_id uuid not null,
  user_id uuid not null references auth.users on delete cascade,
  image_id uuid, file_id uuid,
  foreign key (image_id, user_id) references public.note_images (id, user_id) on delete cascade,
  foreign key (file_id, user_id) references public.note_files (id, user_id) on delete cascade,
  check (source_id = case kind when 'image' then image_id else file_id end),
  desc_enc bytea not null, tags_enc bytea not null, enc_key_id smallint not null,
  updated_at timestamptz not null default now(), primary key (kind, source_id));
create index on private.vault_ai (user_id);
create table private.vault_preview (   -- 0.21（R-118）：隐私记 PPT 给微软预览的临时明文对象
  path text primary key check (path ~ '^[0-9a-f]{32}\.pptx$'),   -- 随机路径，不含 user_id 和文件名
  user_id uuid not null references auth.users on delete cascade,
  file_id uuid not null, created_at timestamptz not null default now(), expires_at timestamptz not null);
create index on private.vault_preview (expires_at);
revoke all on private.vault, private.vault_credentials, private.device_secrets, private.vault_ai, private.vault_preview
  from public, anon, authenticated;

-- ===== 会话变量版 RLS（6.2；逐表清单见附录 A 末尾） =====
alter table private.vault enable row level security;
create policy fn_own on private.vault for all to fn_vault
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
create policy fn_own_ai on private.vault for select to fn_ai
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select, insert, update, delete on private.vault to fn_vault;
grant select (user_id, pin_epoch) on private.vault to fn_ai;

alter table private.vault_credentials enable row level security;
create policy fn_own on private.vault_credentials for all to fn_vault
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select, insert, update, delete on private.vault_credentials to fn_vault;

alter table private.device_secrets enable row level security;
create policy fn_own on private.device_secrets for all to fn_vault
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select, insert, update, delete on private.device_secrets to fn_vault;

alter table private.vault_preview enable row level security;
create policy fn_own on private.vault_preview for all to fn_vault
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select, insert, update, delete on private.vault_preview to fn_vault;

alter table private.vault_ai enable row level security;
create policy fn_own on private.vault_ai for all to fn_vault, fn_ai
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select, delete on private.vault_ai to fn_vault;
grant select, insert, update on private.vault_ai to fn_ai;

-- 扫描过期预览：视图归 postgres、不设 security_invoker，只有定位列、自带过期条件（0.29 续第 40 条：security_barrier）
create view private.scan_vault_preview with (security_barrier = true) as
  select path, user_id, expires_at from private.vault_preview where expires_at <= now();
revoke all on private.scan_vault_preview from public, anon, authenticated;
grant select on private.scan_vault_preview to fn_vault;

-- ===== 三个隐私桶：不建任何策略，只能经服务器函数访问（3.3 G；0.29 续第 33 条、P-20） =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('vault-images',  'vault-images',  false, 2097152,  array['image/webp']),
  ('vault-files',   'vault-files',   false, 10551296, array['application/octet-stream']),   -- 10 MB + 64 KB
  ('vault-preview', 'vault-preview', false, 10485760, array['application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
