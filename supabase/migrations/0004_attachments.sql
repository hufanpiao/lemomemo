-- 0004_attachments.sql：note_files、guard_note_file()、files_authorize（0.32 起取代 file_slot_open 和 images、files 两个桶的存储策略，两个桶在 R2）（附录 A；3.3 A / D / G；数据字典 4.13、6.1、6.2；清单 attachments.ts）

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

-- ===== 0.32（R-213）：files_authorize —— /files/v1/* 函数问数据库“这个人能不能传、能不能取”（3.3 D、3.3 G“R2 起”） =====
-- images、files 两个桶改存 Cloudflare R2：原来的 files 桶、file_sel、file_ins 策略和 file_slot_open()（以及 0003 的 img_sel、img_ins、img_del）
--   由这里取代。路径正则原样搬进来（清单 notes.ts、anniv.ts、attachments.ts 的 pathPattern 是唯一出处，D1 核对这里出现的正则和清单一字不差）；
--   file_slot_open 的判断并进来，“对象还不存在”那半句去掉，改由 /files 用 R2 条件写（If-None-Match: *）保证，已存在回 409
-- 用法：/files 函数带用户的 JWT 原样经 PostgREST 调 public.files_authorize（/sb 转发层拒绝这个路径）；只判断“能不能”，不查大小和类型
-- 返回（jsonb）：
--   整批不过：{uid, error, items: []}，error 取 account_disabled（停用、注销冷静期、没有 profile）、session_revoked（会话不在或已吊销）、rate_limited
--   否则：{uid, items: [{i, ok: true} | {i, ok: false, reason}]}，i 是 p_items 里的下标（从 0 起），
--     reason 取 bad_bucket、bad_path、not_owner、not_pending、no_row、deleted、not_checked；一项不过只标那一项
-- 入参不对直接报错（errcode 22023，/files 当 400）：p_op 不是 put / get（bad_op）；p_items 不是数组或为空（bad_items）；
--   put 不是 1 项（put_one_item）；get 超过 100 项（too_many_items）
-- 限流按调用计（不按项）：put 每人每分钟 30 次、get 120 次，键 files_put:<user_id>:<分钟>、files_get:<user_id>:<分钟>（0.29 续第 34 条的格式）
create function private.files_authorize_impl(p_op text, p_items jsonb) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  n int;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  keep_ms constant bigint := 30::bigint * 86400 * 1000;   -- “最近删除”里的图和附件 30 天内还能取（3.4）
  it record; row_ record;
  b text; p text; base text; thumb boolean; r text;
  out_ jsonb := '[]'::jsonb;
begin
  if p_op is null or p_op not in ('put', 'get') then raise exception 'bad_op' using errcode = '22023'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'bad_items' using errcode = '22023'; end if;
  if p_op = 'put' and jsonb_array_length(p_items) <> 1 then raise exception 'put_one_item' using errcode = '22023'; end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'too_many_items' using errcode = '22023'; end if;

  -- 先查一次（同 requireActiveUser 的口径）：账号能用；JWT 的 session_id 在 auth.sessions 里、没被吊销
  if uid is null or not private.account_usable(uid) then
    return jsonb_build_object('uid', uid, 'error', 'account_disabled', 'items', '[]'::jsonb);
  end if;
  begin
    sid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then sid := null;
  end;
  if not private.session_alive(sid) then
    return jsonb_build_object('uid', uid, 'error', 'session_revoked', 'items', '[]'::jsonb);
  end if;

  -- 限流：先计数再判断，超了的这次也算（不抛错，计数留着）
  insert into private.counters as c (key, window_start, count)
    values ('files_' || p_op || ':' || uid::text || ':' || to_char(date_trunc('minute', now()) at time zone 'UTC', 'YYYYMMDD"T"HH24MI'),
            date_trunc('minute', now()), 1)
    on conflict (key, window_start) do update set count = c.count + 1
    returning c.count into n;
  if n > (case p_op when 'put' then 30 else 120 end) then
    return jsonb_build_object('uid', uid, 'error', 'rate_limited', 'items', '[]'::jsonb);
  end if;

  for it in select e.value as v, (e.ord - 1)::int as i from jsonb_array_elements(p_items) with ordinality as e(value, ord) loop
    b := case when jsonb_typeof(it.v) = 'object' then it.v ->> 'bucket' end;
    p := case when jsonb_typeof(it.v) = 'object' then it.v ->> 'path' end;
    thumb := coalesce(p like '%.t.webp', false);
    r := null;
    -- 共同：桶只认 images、files（vault-* 只经服务器函数）；整条路径符合清单的 pathPattern；第一段是本人
    if b is null or b not in ('images', 'files') then
      r := 'bad_bucket';
    elsif p is null or not (
         (b = 'images' and (p ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}(\.t)?\.webp$'          -- 随手记插图和缩略图（notes.ts）
                         or p ~ '^[0-9a-f-]{36}/anniv/[0-9a-f-]{36}/[0-9a-f-]{36}\.webp$'))        -- 纪念日头像（anniv.ts）
      or (b = 'files' and p ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}(\.(pdf|docx|xlsx|pptx|docm|xlsm|pptm|doc|xls|ppt)|\.t\.webp)$')) then   -- 附件（attachments.ts）
      r := 'bad_path';
    elsif split_part(p, '/', 1) <> uid::text then
      r := 'not_owner';
    elsif b = 'images' and split_part(p, '/', 2) = 'anniv' then
      -- 纪念日头像：本人这一行的 avatar_id 等于路径里的那个 id
      select a.avatar_id, a.deleted_at into row_ from public.anniversaries a
       where a.user_id = uid and a.id::text = split_part(p, '/', 3);
      if not found then r := 'no_row';
      elsif row_.avatar_id is null or row_.avatar_id::text || '.webp' <> split_part(p, '/', 4) then r := 'not_owner';
      elsif row_.deleted_at is not null and (p_op = 'put' or row_.deleted_at < now_ms - keep_ms) then r := 'deleted';
      end if;
    elsif b = 'images' then
      -- 随手记插图：先写行再传（比原来 img_ins 严）；缩略图要 has_thumb
      base := case when thumb then left(p, -7) || '.webp' else p end;
      select ni.bucket, ni.has_thumb, ni.deleted_at into row_ from public.note_images ni
       where ni.user_id = uid and ni.path = base;
      if not found or (thumb and not row_.has_thumb) then r := 'no_row';
      elsif row_.bucket <> 'images' then r := 'not_owner';   -- 隐私记的图（vault-images）不经 /files
      elsif row_.deleted_at is not null and (p_op = 'put' or row_.deleted_at < now_ms - keep_ms) then r := 'deleted';
      end if;
    else
      -- 附件（原 file_slot_open）：put 只认本人、普通、pending、没删的行；get 只给 check_status = 'ok' 的
      if thumb then
        select f.is_vault, f.has_thumb, f.deleted_at, f.check_status into row_ from public.note_files f
         where f.user_id = uid and f.note_id::text = split_part(p, '/', 2) and f.id::text = split_part(split_part(p, '/', 3), '.', 1);
      else
        select f.is_vault, f.has_thumb, f.deleted_at, f.check_status into row_ from public.note_files f
         where f.user_id = uid and f.path = p;
      end if;
      if not found or (thumb and not row_.has_thumb) then r := 'no_row';
      elsif row_.is_vault then r := 'not_owner';   -- 隐私记的附件（vault-files）不经 /files
      elsif p_op = 'put' and row_.deleted_at is not null then r := 'deleted';
      elsif p_op = 'put' and row_.check_status <> 'pending' then r := 'not_pending';
      elsif p_op = 'get' and row_.deleted_at is not null and row_.deleted_at < now_ms - keep_ms then r := 'deleted';
      elsif p_op = 'get' and row_.check_status <> 'ok' then r := 'not_checked';
      end if;
    end if;
    out_ := out_ || jsonb_build_array(case when r is null then jsonb_build_object('i', it.i, 'ok', true)
                                          else jsonb_build_object('i', it.i, 'ok', false, 'reason', r) end);
  end loop;
  return jsonb_build_object('uid', uid, 'items', out_);
end $$;
grant execute on function private.files_authorize_impl(text, jsonb) to authenticated;   -- 0004  /files 函数带用户 JWT 经 public.files_authorize 调：查停用、会话、路径归属、pending、限流（0.32，R-213）

-- 3.3 D 的第九个 RPC：security invoker，只授给 authenticated；只给 /files 函数用
create function public.files_authorize(p_op text, p_items jsonb) returns jsonb
  language sql security invoker set search_path = '' as $$ select private.files_authorize_impl(p_op, p_items) $$;
revoke execute on function public.files_authorize(text, jsonb) from public, anon, service_role;
grant execute on function public.files_authorize(text, jsonb) to authenticated;

-- ===== files 桶：0.32（R-213）起存 Cloudflare R2，这里不建桶、不建存储策略 =====
-- 大小（10 MB）和类型（DOC_MIME ＋ image/webp）由 /files 函数按清单生成的规则表执行（functions/_generated/files-rules.ts）；
--   没有删除和覆盖接口：删除附件只写 deleted_at，对象由 storage-sweep 经 shared/objstore.ts 删（3.4）。D1 核对 files 不在 storage.buckets 里

alter publication supabase_realtime add table public.note_files;
