-- 0007_search.sql：向量、重算队列、enqueue_embed()、vault_ai_off() / vault_ai_on()、三个扫描视图（附录 A；5.13、5.14；清单 search.ts）

create extension if not exists vector with schema extensions;

create table private.note_vectors (
  user_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('note','image','file','event','todo')),
  source_id uuid not null, is_vault boolean not null default false,   -- R-114 D-8：隐私记也进，向量不加密
  -- 按 kind 各有一个外键列，源头删掉时向量跟着删（第四轮安全 M3）
  note_id uuid, image_id uuid, file_id uuid, event_id uuid, todo_id uuid,
  foreign key (note_id, user_id) references public.notes (id, user_id) on delete cascade,
  foreign key (image_id, user_id) references public.note_images (id, user_id) on delete cascade,
  foreign key (file_id, user_id) references public.note_files (id, user_id) on delete cascade,
  foreign key (event_id, user_id) references public.events (id, user_id) on delete cascade,
  foreign key (todo_id, user_id) references public.todos (id, user_id) on delete cascade,
  check (source_id = case kind when 'note' then note_id when 'image' then image_id when 'file' then file_id
                               when 'event' then event_id else todo_id end),   -- 对应的列为空时结果为 null，check 失败
  model text not null, content_hash text not null,
  embedding extensions.halfvec(768) not null, updated_at timestamptz not null default now(),
  primary key (kind, source_id, model));   -- 0.27：新旧模型的向量并存
create index on private.note_vectors (user_id, model);   -- 单人超过 2 万条再加 HNSW（5.13）
create table private.embed_queue (   -- 要重算向量的条目，参照 remind_queue
  kind text not null check (kind in ('note','image','file','event','todo')), source_id uuid not null,
  user_id uuid not null references auth.users on delete cascade,
  queued_at timestamptz not null default now(), tries smallint not null default 0, next_at timestamptz,
  model text not null default '',   -- 0.27：空串 = 当前模型；换模型补算时写新模型名
  primary key (kind, source_id, model));
create index on private.embed_queue (user_id);
revoke all on private.note_vectors, private.embed_queue from public, anon, authenticated;

-- 0.29 续第 34 条之外：fn_vault 只删（注销、永久删除的第二道），fn_ai 读写（6.2）
alter table private.note_vectors enable row level security;
create policy fn_own on private.note_vectors for all to fn_vault, fn_ai
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant delete on private.note_vectors to fn_vault;
grant select, insert, update on private.note_vectors to fn_ai;

alter table private.embed_queue enable row level security;
create policy fn_own on private.embed_queue for all to fn_vault, fn_ai
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant delete on private.embed_queue to fn_vault;
grant select, insert, update, delete on private.embed_queue to fn_ai;   -- 处理完删行

-- ===== 写队列（5.13 第 6 点、5.14 第 3 点） =====
-- 已入队的再改一次：重置重试，模型仍是当前模型（空串）
create function private.enqueue_embed() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare k text; sid uuid;
begin
  if tg_table_name = 'vault_ai' then k := new.kind; sid := new.source_id;
  else
    k := case tg_table_name when 'notes' then 'note' when 'note_images' then 'image' when 'note_files' then 'file'
                            when 'events' then 'event' when 'todos' then 'todo' end;
    sid := new.id;
  end if;
  insert into private.embed_queue as q (kind, source_id, user_id) values (k, sid, new.user_id)
    on conflict (kind, source_id, model) do update set queued_at = now(), tries = 0, next_at = null;
  return null;
end $$;
grant execute on function private.enqueue_embed() to authenticated;           -- 0007  触发器函数：security definer
create trigger notes_embed after insert or update of title, body, body_enc, category_id, is_private
  on public.notes for each row execute function private.enqueue_embed();
create trigger note_images_embed after insert or update of ai_desc, ai_tags
  on public.note_images for each row execute function private.enqueue_embed();
create trigger note_files_embed after insert or update of ai_desc, ai_tags, name, text_excerpt
  on public.note_files for each row execute function private.enqueue_embed();
create trigger events_embed after insert or update of title, note, location
  on public.events for each row execute function private.enqueue_embed();
create trigger todos_embed after insert or update of title, note   -- todos 没有 location（P-03）
  on public.todos for each row execute function private.enqueue_embed();
create trigger vault_ai_embed after insert or update
  on private.vault_ai for each row execute function private.enqueue_embed();

-- ===== ai.vault 关掉 / 打开（0.29 P-13；续第 120、146 条） =====
-- 关掉：删隐私记的向量和队列；pending 的隐私记图片、文档改成 skip（skip_reason = vault_off，重新打开时恢复）
create function private.vault_ai_off() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('embed:' || new.user_id::text));   -- 和补算、撤回同意同一把锁
  delete from private.note_vectors where user_id = new.user_id and is_vault;
  delete from private.embed_queue q where q.user_id = new.user_id and (   -- 队列没有 is_vault 列，按 kind 回查
       (q.kind = 'note'  and exists (select 1 from public.notes n       where n.id = q.source_id and n.user_id = q.user_id and n.is_private))
    or (q.kind = 'image' and exists (select 1 from public.note_images i where i.id = q.source_id and i.user_id = q.user_id and i.bucket = 'vault-images'))
    or (q.kind = 'file'  and exists (select 1 from public.note_files f  where f.id = q.source_id and f.user_id = q.user_id and f.is_vault)));
  update public.note_images set ai_status = 'skip', skip_reason = 'vault_off'
   where user_id = new.user_id and bucket = 'vault-images' and ai_status = 'pending';
  update public.note_files set ai_status = 'skip', skip_reason = 'vault_off'
   where user_id = new.user_id and is_vault and ai_status = 'pending';
  return null;
end $$;
grant execute on function private.vault_ai_off() to authenticated;            -- 0007  触发器函数：security definer
create trigger settings_vault_ai_off after insert or update of value on public.settings
  for each row when (new.key = 'ai.vault' and new.value = 'false'::jsonb) execute function private.vault_ai_off();

-- 打开（只有服务器能打开，settings_guard）：一条集合式 update + 一条 insert … select，不逐行循环（第 146 条）
create function private.vault_ai_on() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('embed:' || new.user_id::text));
  update public.note_images set ai_status = 'pending', skip_reason = null, ai_tries = 0, ai_next_at = null
   where user_id = new.user_id and bucket = 'vault-images' and ai_status = 'skip' and skip_reason in ('consent', 'vault_off');
  update public.note_files set ai_status = 'pending', skip_reason = null, ai_tries = 0, ai_next_at = null
   where user_id = new.user_id and is_vault and ai_status = 'skip' and skip_reason in ('consent', 'vault_off');
  -- 隐私记正文的向量：关掉时删了，重新入队（图片、文档识别完由 vault_ai 写入时入队）
  insert into private.embed_queue (kind, source_id, user_id)
    select 'note', n.id, n.user_id from public.notes n
     where n.user_id = new.user_id and n.is_private and n.deleted_at is null
  on conflict (kind, source_id, model) do nothing;
  return null;
end $$;
revoke execute on function private.vault_ai_on() from public;           -- 0007  触发器函数，仅触发器调用
create trigger settings_vault_ai_on after insert or update of value on public.settings
  for each row when (new.key = 'ai.vault' and new.value = 'true'::jsonb) execute function private.vault_ai_on();

-- ===== 扫描视图（0.29：取代 app.scan 策略；续第 40 条：security_barrier） =====
create view private.scan_embed_queue with (security_barrier = true) as
  select kind, source_id, model, user_id, next_at from private.embed_queue where next_at is null or next_at <= now();
create view private.scan_note_images with (security_barrier = true) as
  select id, user_id, ai_status, ai_next_at from public.note_images where ai_status = 'pending' and deleted_at is null;
create view private.scan_note_files with (security_barrier = true) as
  select id, user_id, check_status, ai_status, ai_next_at from public.note_files
   where (check_status = 'pending' or ai_status = 'pending') and deleted_at is null;
revoke all on private.scan_embed_queue, private.scan_note_images, private.scan_note_files from public, anon, authenticated;
grant select on private.scan_embed_queue, private.scan_note_images, private.scan_note_files to fn_ai;
