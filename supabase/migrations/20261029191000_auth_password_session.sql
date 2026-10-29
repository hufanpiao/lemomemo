-- 20261029191000_auth_password_session.sql：拒绝密码会话（架构 0.36 第 1 条 ②、0.38 第 2 条；B0 第三轮安全 N1 的纵深，TC-B1-111）
-- 背景：账号按设计不带密码（0001 的 users_guard_no_password 触发器把写进 auth.users 的密码置空），但 GoTrue 关不掉邮箱密码登录；
--   这里是第二道：JWT 的 amr 里有 password 的会话一律不认。刷新出来的令牌沿用原会话的 amr，所以密码会话刷新以后照样被拒。
--   只拒 password（黑名单），otp、magiclink、recovery、email_change 等照常。
-- 判断全库只写一处：private.not_password_session()。is_active（全部 RLS、Realtime）、files_authorize_impl、purge_deleted_impl、
--   profiles 的 prof_sel / prof_upd 都调它（profiles 不改成 is_active：停用、冷静期账号仍要读得到自己的 profile）。
--   record_consent_impl 的同一句判断（和补的 account_usable）只写在 20261029192000_core_devices_sessions.sql 里，以那里为准，这里不再定义。
-- 其余函数 create or replace（保留原有的属主和执行权），除注明的几行外函数体逐字照 0001 / 0004。
--   新授权只有一句（not_password_session 给 authenticated），3.3 C 和附录 A 末尾同批加了同一行。0001～0007 已发布，不改。

-- ① 是不是密码会话：
--   JWT 里没有 amr（键不在，或根本没有 JWT）→ 放行；有 amr 但不是数组（含 JSON null、字符串标量）→ 当密码会话拒（GoTrue 签的一定是数组）；
--   数组里两种写法都认——对象 {"method": "password", "timestamp": …}（GoTrue 文档）和裸字符串 "password"（B0 第四轮 QA 真库实测 amr = ["password"]）。
--   security invoker、不读任何表；profiles 的策略以调用者身份执行，所以给 authenticated 执行权（只读 JWT，0.38）
create function private.not_password_session() returns boolean language sql stable security invoker set search_path = '' as $$
  select case
           when j.a is null then true
           when jsonb_typeof(j.a) <> 'array' then false
           else not (j.a @> '[{"method": "password"}]' or j.a ? 'password')
         end
    from (select (select auth.jwt()) -> 'amr' as a) j
$$;
grant execute on function private.not_password_session() to authenticated;   -- B1  RLS（profiles）用；只读 JWT（0.38）

-- ② private.is_active()：全部 RLS（含 Realtime）都经它，密码会话读 0 行、写被拒
create or replace function private.is_active() returns boolean language sql stable security definer set search_path = '' as $$
  select private.account_usable((select auth.uid())) and private.not_password_session()
$$;

-- ③ private.files_authorize_impl：不经 is_active，在“先查一次”那一段加同一个判断，整批回 session_revoked（/files 照现有口径映射成 401）
create or replace function private.files_authorize_impl(p_op text, p_items jsonb) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  n int;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  keep_ms constant bigint := 30::bigint * 86400 * 1000;   -- “最近删除”里的图和附件 30 天内还能取（3.4）
  it record; row_ record;
  b text; p text; base text; thumb boolean; r text;
  seg_id uuid; seg_id2 uuid; seg text;
  -- 8-4-4-4-12 的小写 uuid（和 uuid::text 一致）；不加首尾锚点，配合 length = 36 判整段（D1 把函数体里带首尾锚点的字符串都当成路径正则和清单核对）
  uuid_re constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  out_ jsonb := '[]'::jsonb;
begin
  if p_op is null or p_op not in ('put', 'get') then raise exception 'bad_op' using errcode = '22023'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'bad_items' using errcode = '22023'; end if;
  if p_op = 'put' and jsonb_array_length(p_items) <> 1 then raise exception 'put_one_item' using errcode = '22023'; end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'too_many_items' using errcode = '22023'; end if;

  -- 先查一次（同 requireActiveUser 和各 *_impl 的顺序）：先拒密码会话；再查账号能用；JWT 的 session_id 在 auth.sessions 里、没被吊销
  -- 0.36 第 1 条 ②（TC-B1-111）：密码会话（或由它刷新出来的令牌）当会话不在，停用账号用密码会话来也回 session_revoked
  if not private.not_password_session() then
    return jsonb_build_object('uid', uid, 'error', 'session_revoked', 'items', '[]'::jsonb);
  end if;
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
      -- 代码审查低 3：路径段先认成 uuid 再和 uuid 列比（不把列转成文本，主键索引用得上）；
      --   路径正则 [0-9a-f-]{36} 放得过、却不是 8-4-4-4-12 的段认成 null（不转换、不报错），当“没有这一行”
      seg := split_part(p, '/', 3);                 seg_id  := case when length(seg) = 36 and seg ~ uuid_re then seg::uuid end;
      seg := left(split_part(p, '/', 4), -5);       seg_id2 := case when length(seg) = 36 and seg ~ uuid_re then seg::uuid end;
      select a.avatar_id, a.deleted_at into row_ from public.anniversaries a
       where a.user_id = uid and a.id = seg_id;
      if not found then r := 'no_row';
      elsif row_.avatar_id is null or seg_id2 is null or row_.avatar_id <> seg_id2 then r := 'not_owner';
      elsif row_.deleted_at is not null and (p_op = 'put' or row_.deleted_at < now_ms - keep_ms) then r := 'deleted';
      end if;
    elsif b = 'images' then
      -- 随手记插图：先写行再传（比原来 img_ins 严）；缩略图要 has_thumb
      base := case when thumb then left(p, -7) || '.webp' else p end;
      select ni.bucket, ni.has_thumb, ni.deleted_at, n.is_private into row_ from public.note_images ni
        join public.notes n on n.id = ni.note_id and n.user_id = ni.user_id
       where ni.user_id = uid and ni.path = base;
      if not found or (thumb and not row_.has_thumb) then r := 'no_row';
      elsif row_.bucket <> 'images' then r := 'not_owner';   -- 隐私记的图（vault-images）不经 /files
      -- 0.33（B0 代码审查低 8）：挂的随手记要 is_private = false（和触发器 guard_note_image() 同一口径；纵深一道）；
      --   0.34 第 2 条：put、get 都查（原来只查 put）
      elsif row_.is_private then r := 'bad_bucket';
      elsif row_.deleted_at is not null and (p_op = 'put' or row_.deleted_at < now_ms - keep_ms) then r := 'deleted';
      end if;
    else
      -- 附件（原 file_slot_open）：put 只认本人、普通、pending、没删的行；get 只给 check_status = 'ok' 的
      if thumb then
        -- 缩略图按 (note_id, id) 找原文件（扩展名未知）；两段都按 uuid 比（同上，代码审查低 3）
        seg := split_part(p, '/', 2);                         seg_id  := case when length(seg) = 36 and seg ~ uuid_re then seg::uuid end;
        seg := split_part(split_part(p, '/', 3), '.', 1);     seg_id2 := case when length(seg) = 36 and seg ~ uuid_re then seg::uuid end;
        select f.is_vault, f.has_thumb, f.deleted_at, f.check_status into row_ from public.note_files f
         where f.user_id = uid and f.note_id = seg_id and f.id = seg_id2;
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

-- ④ purge_deleted_impl：security definer、不经 RLS，第一句先查密码会话（报 session_revoked），再查账号能用（报 account_disabled）
--   record_consent_impl 不在这里改：以 20261029192000_core_devices_sessions.sql 为准（同一函数只定义一处，在这里改不生效）
create or replace function private.purge_deleted_impl(p_items jsonb default null) returns int
  language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); n int := 0; k int;
  ev uuid[]; td uuid[]; an uuid[]; nt uuid[];
  sid uuid;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;   -- 0.36 / 0.38：密码会话不能永久清空“最近删除”
  if uid is null or not private.account_usable(uid) then raise exception 'account_disabled'; end if;
  -- K1 审查：远程移除设备后，旧令牌在过期前（最多约 10 分钟）还能调到这里；会话不在或已吊销一律拒（写法同 remove_device_impl）
  begin
    sid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then sid := null;
  end;
  if not private.session_alive(sid) then raise exception 'session_revoked'; end if;
  if p_items is null then   -- 全部清空（含撤销留下的 undone 行；不含隐私记）
    delete from public.events        where user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
    delete from public.todos         where user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
    delete from public.anniversaries where user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
    delete from public.notes         where user_id = uid and deleted_at is not null and not is_private; get diagnostics k = row_count; n := n + k;
    return n;
  end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'bad_items'; end if;
  if jsonb_array_length(p_items) > 500 then raise exception 'too_many_items'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
              where coalesce(e->>'tbl', '') not in ('events','todos','anniversaries','notes')) then
    raise exception 'bad_table'; end if;
  select array_agg((e->>'id')::uuid) filter (where e->>'tbl' = 'events'),
         array_agg((e->>'id')::uuid) filter (where e->>'tbl' = 'todos'),
         array_agg((e->>'id')::uuid) filter (where e->>'tbl' = 'anniversaries'),
         array_agg((e->>'id')::uuid) filter (where e->>'tbl' = 'notes')
    into ev, td, an, nt from jsonb_array_elements(p_items) e;
  delete from public.events        where id = any(ev) and user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
  delete from public.todos         where id = any(td) and user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
  delete from public.anniversaries where id = any(an) and user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
  delete from public.notes         where id = any(nt) and user_id = uid and deleted_at is not null and not is_private; get diagnostics k = row_count; n := n + k;
  return n;
end $$;

-- ⑤ profiles：读、改自己这一行也不认密码会话（不经 is_active：停用账号照样能读到自己的停用状态）
alter policy prof_sel on public.profiles
  using (user_id = (select auth.uid()) and private.not_password_session());
alter policy prof_upd on public.profiles
  using (user_id = (select auth.uid()) and private.not_password_session())
  with check (user_id = (select auth.uid()) and private.not_password_session());
