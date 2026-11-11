-- 20261112090000_core_session_helpers.sql：会话校验、吊销会话各收成一个出口；session_fate 挪到 public，anon 不再有 private 的 usage（架构约定 10.1、10.7）。
-- 不变量：会话校验只经 private.require_live_session()；删 auth.sessions 只经 private.kill_session()（D1 build/d1/session-revoke.ts 核对）。
-- 下面 create or replace 的函数体照现行定义，只把开场白换成 require_live_session、把“吊销 + 删会话”换成 kill_session。

-- ===== 会话校验：密码会话、账号能用、JWT 的 session_id 活着；不过就抛 session_revoked / account_disabled，过了回 session_id =====
create function private.require_live_session() returns uuid
  language plpgsql stable set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;
  if uid is null or not private.account_usable(uid) then raise exception 'account_disabled'; end if;
  begin
    sid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then sid := null;
  end;
  if not private.session_alive(sid) then raise exception 'session_revoked'; end if;
  return sid;
end $$;
revoke execute on function private.require_live_session() from public;   -- 只给下面这些 security definer 函数（属主 postgres）调

-- ===== 吊销并删掉一个会话：会话不在（或不是这个人的）什么都不做 =====
create function private.kill_session(p_session uuid, p_user uuid) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  delete from auth.sessions s where s.id = p_session and s.user_id = p_user;
  if found then perform private.revoke_session(p_session, p_user); end if;
end $$;
revoke execute on function private.kill_session(uuid, uuid) from public;

-- ===== session_fate：不登录可调，放 public 的 security definer（原 private.session_fate_impl 的函数体），收回 anon 对 private 的 usage =====
create or replace function public.session_fate(p_pair text) returns text
  language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s' as $$
declare
  m text := to_char(now() at time zone 'UTC', 'YYYYMMDD"T"HH24MI');
begin
  -- 先过总闸再看参数：格式不对的调用同样算次数；已经越线的只读计数、直接回 unknown，不再写 counters
  if coalesce((select c.count from private.counters c
                where c.key = 'sfate:global:' || m and c.window_start = to_timestamp(floor(extract(epoch from now()) / 60) * 60)), 0) > 600 then
    return 'unknown';
  end if;
  if not private.take_rate('sfate:global:' || m, 600, 60) then
    -- 只有越线的那一次走到这里：记一条 sfate-capped；并发同时越线的也只留一条
    insert into private.counters (key, window_start, count) values ('sfate-capped:global:' || m, date_trunc('minute', now()), 1)
      on conflict (key, window_start) do nothing;
    return 'unknown';
  end if;
  if p_pair is null or p_pair !~ '^[0-9a-f]{64}$' then return 'unknown'; end if;
  return case when exists (select 1 from private.revoked_sessions r where r.pair_hash = p_pair) then 'revoked' else 'unknown' end;
end $$;
drop function private.session_fate_impl(text);
revoke usage on schema private from anon;

create or replace function private.claim_endpoint_impl(p_endpoint text, p_p256dh text, p_auth text, p_label text, p_platform text) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  me record;
  holder record;
begin
  sid := private.require_live_session();

  -- b. 校验（不合格整次拒绝、一行不动）
  if p_endpoint is null or not private.push_endpoint_ok(p_endpoint) then
    raise exception 'endpoint_not_allowed' using errcode = '22023';
  end if;
  if not private.push_keys_ok(p_p256dh, p_auth) then
    raise exception 'bad_push_keys' using errcode = '22023';
  end if;

  -- c. 本会话那一行
  select d.id, d.push_endpoint into me from public.devices d
   where d.user_id = uid and d.session_id = sid and d.deleted_at is null
   order by d.id limit 1 for update;
  if not found then raise exception 'device_not_found'; end if;

  -- d. 别的账号名下同一 endpoint 的行（M9）
  delete from public.devices d where d.push_endpoint = p_endpoint and d.user_id <> uid;

  -- e. 同一账号别的行占着：会话还在、而且没软删的才回 endpoint_in_use；会话已失效或已软删（设置页的设备列表按 deleted_at is null
  --    过滤，用户看不到、也移除不了）的直接删掉（代码审查 BE-1 S6）
  select d.id, d.label, d.last_seen_at, d.install_id, d.session_id, d.deleted_at into holder from public.devices d
   where d.push_endpoint = p_endpoint and d.user_id = uid and d.id <> me.id for update;
  if found then
    if holder.deleted_at is null and private.session_alive(holder.session_id) then
      return pg_catalog.jsonb_build_object('error', 'endpoint_in_use',
        'holder', pg_catalog.jsonb_build_object('id', holder.id, 'label', holder.label,
                                                 'last_seen_at', holder.last_seen_at, 'install_id', holder.install_id));
    end if;
    delete from public.devices d where d.id = holder.id and d.user_id = uid;
  end if;

  -- f. 写本会话那一行
  update public.devices d
     set push_endpoint = p_endpoint, p256dh = p_p256dh, auth = p_auth,
         label = coalesce(p_label, d.label), platform = coalesce(p_platform, d.platform),
         push_fail_count = case when d.push_endpoint is distinct from p_endpoint then 0 else d.push_fail_count end
   where d.id = me.id and d.user_id = uid;
  return pg_catalog.jsonb_build_object('ok', true);
end $$;

create or replace function private.my_ai_usage_impl() returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  d date := (now() at time zone 'America/Los_Angeles')::date;
  used int;
  cap int;
  v jsonb;
begin
  perform private.require_live_session();
  select coalesce(sum(c.count), 0)::int into used
    from private.counters c
   where c.key = 'ai:' || uid::text || ':' || to_char(d, 'YYYY-MM-DD');
  select a.ai -> 'per_user_daily' into v from public.app_config a where a.id = 1;
  cap := case when jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric >= 0
                   and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric) and (v #>> '{}')::numeric <= 2147483647
              then (v #>> '{}')::int else 50 end;
  return jsonb_build_object('ai_used', used, 'ai_limit', cap, 'pacific_date', to_char(d, 'YYYY-MM-DD'),
                            'media_used', private.media_used(uid, null), 'media_limit', private.media_limit_bytes(uid));   -- B4 S10 ①
end $$;

create or replace function private.my_sessions_impl() returns TABLE(orphan_count integer, orphan_last_at timestamp with time zone, signed_out_device_ids uuid[])
  language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
begin
  sid := private.require_live_session();
  return query
    select o.n, o.last_at, x.ids
      from (select count(*)::int as n,
                   max(coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at)) as last_at
              from auth.sessions s
             where s.user_id = uid
               and s.id <> sid
               and s.created_at < now() - interval '2 minutes'
               and not exists (select 1 from public.devices d where d.session_id = s.id and d.deleted_at is null)   -- 只绑着软删除设备行的会话也算 orphan（和 signed_out 同一口径）
               and not exists (select 1 from private.revoked_sessions r where r.session_id = s.id)) o
     cross join
           (select coalesce(array_agg(d.id order by d.id), '{}'::uuid[]) as ids
              from public.devices d
             where d.user_id = uid
               and d.deleted_at is null
               and (d.session_id is null
                    or not exists (select 1 from auth.sessions s where s.id = d.session_id and s.user_id = uid)
                    or exists (select 1 from private.revoked_sessions r where r.session_id = d.session_id))) x;
end $$;

create or replace function private.purge_deleted_impl(p_items jsonb DEFAULT NULL::jsonb) returns integer
  language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); n int := 0; k int;
  ev uuid[]; td uuid[]; an uuid[]; nt uuid[];
begin
  perform private.require_live_session();
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

create or replace function private.record_consent_impl(p_ver text, p_revoke boolean DEFAULT false) returns void
  language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_live_session();
  -- 20261029220000：p_ver 为 null 一律拒绝（notice 被清空或缺 policy_ver 时，null 与 null 不是 distinct，原写法会放行）
  if p_ver is null or p_ver is distinct from (select c.notice->>'policy_ver' from public.app_config c where c.id = 1) then
    raise exception 'policy_ver_mismatch'; end if;
  if p_revoke then   -- 0.27：和换模型补算互斥，同一把锁
    perform pg_advisory_xact_lock(hashtext('embed:' || (select auth.uid())::text)); end if;
  update public.profiles
     set consent_ai_at = case when p_revoke then null else now() end,
         consent_policy_ver = p_ver   -- 拒绝时也记版本
   where user_id = (select auth.uid()) and disabled_at is null;
  get diagnostics n = row_count;
  -- 20261029210000：没有 profile 行或刚被停用，一行都没写：报错（整个调用回滚，撤回分支也不写 ai.enabled、不删向量）
  if n = 0 then raise exception 'account_disabled'; end if;
  if p_revoke then
    insert into public.settings (id, user_id, key, value) values (gen_random_uuid(), (select auth.uid()), 'ai.enabled', 'false')
      on conflict (user_id, key) do update set value = 'false', deleted_at = null, undone = false;
    -- 0.29（P-13）：删这个人全部的向量（所有模型）和队列；两张表在 0007，plpgsql 运行时才解析
    delete from private.note_vectors where user_id = (select auth.uid());
    delete from private.embed_queue  where user_id = (select auth.uid());
  end if;
  -- 同意分支的“恢复 skip 的图片和附件”（R-179，0.29 续第 120 条）属于 B4b-2，那时 create or replace
end $$;

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
  cl numeric;   -- B4 S10 ③：put 时 /files 传来的 Content-Length（JSON 整数，字节数）
  -- 8-4-4-4-12 的小写 uuid（和 uuid::text 一致）；不加首尾锚点，配合 length = 36 判整段（D1 把函数体里带首尾锚点的字符串都当成路径正则和清单核对）
  uuid_re constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  out_ jsonb := '[]'::jsonb;
begin
  if p_op is null or p_op not in ('put', 'get') then raise exception 'bad_op' using errcode = '22023'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'bad_items' using errcode = '22023'; end if;
  if p_op = 'put' and jsonb_array_length(p_items) <> 1 then raise exception 'put_one_item' using errcode = '22023'; end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'too_many_items' using errcode = '22023'; end if;

  begin   -- 会话校验和各 *_impl 同一个出口；这里不抛错，错误码放进返回值
    sid := private.require_live_session();
  exception when raise_exception then
    return jsonb_build_object('uid', uid, 'error', sqlerrm, 'items', '[]'::jsonb);
  end;

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
    -- get 时带了也忽略；不是 JSON 数字的当没传
    cl := case when p_op = 'put' and jsonb_typeof(it.v) = 'object' and jsonb_typeof(it.v -> 'content_length') = 'number'
               then (it.v ->> 'content_length')::numeric end;
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
      select ni.id, ni.bytes, ni.bucket, ni.has_thumb, ni.deleted_at, n.is_private into row_ from public.note_images ni
        join public.notes n on n.id = ni.note_id and n.user_id = ni.user_id
       where ni.user_id = uid and ni.path = base;
      if not found or (thumb and not row_.has_thumb) then r := 'no_row';
      elsif row_.bucket <> 'images' then r := 'not_owner';   -- 隐私记的图（vault-images）不经 /files
      -- 0.33（B0 代码审查低 8）：挂的随手记要 is_private = false（和触发器 guard_note_image() 同一口径；纵深一道）；
      --   0.34 第 2 条：put、get 都查（原来只查 put）
      elsif row_.is_private then r := 'bad_bucket';
      elsif row_.deleted_at is not null and (p_op = 'put' or row_.deleted_at < now_ms - keep_ms) then r := 'deleted';
      -- B4 S10 ②：put 再按写行触发器同一口径复核（media_fits），合计时排除这一行自己（行已经写进去了）；
      --   原图和缩略图的 put 都核（这一行的占用 = 原图 bytes ＋ 缩略图预留，已在写行时算进去）
      -- B4 S10 ③：带了合法的 content_length 才比（原图要等于这一行 bytes，缩略图 ≤ 131072，和额度里的缩略图预留、清单 notes.ts 的
      --   thumbSizeLimit 一致），对不上 length_mismatch；缺了或不合法这一步放行，第二步（20261111101000）起 length_required
      -- B4 S10 ③ 第二步（20261111101000）：缺了或不是非负整数 length_required
      elsif p_op = 'put' and (cl is null or cl < 0 or cl <> trunc(cl)) then r := 'length_required';
      elsif p_op = 'put' and cl >= 0 and cl = trunc(cl) and (case when thumb then cl > 131072 else cl <> row_.bytes end) then r := 'length_mismatch';
      elsif p_op = 'put' and not private.media_fits(uid, row_.id, row_.bytes, row_.has_thumb) then r := 'quota_exceeded';
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

create or replace function private.remove_device_impl(p_device uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  dev record;
begin
  sid := private.require_live_session();
  if p_device is null then raise exception 'device_not_found'; end if;

  select d.id, d.session_id, d.install_id into dev from public.devices d
   where d.id = p_device and d.user_id = uid for update;
  if not found then raise exception 'device_not_found'; end if;   -- 别人的设备和不存在的一样回
  if dev.session_id is not null and dev.session_id = sid then raise exception 'is_current_device'; end if;

  perform private.kill_session(dev.session_id, uid);
  -- 第 109 条：布局按安装存（layout.<页>@inst:<install_id>）；同一个 install_id 还有别的行（这台重新登录过）就留着
  if dev.install_id is not null and not exists (
       select 1 from public.devices o where o.user_id = uid and o.install_id = dev.install_id and o.id <> dev.id) then
    delete from public.settings s
     where s.user_id = uid and s.key like 'layout.%' and right(s.key, 42) = '@inst:' || dev.install_id::text;
  end if;
  delete from public.devices d where d.id = dev.id and d.user_id = uid;
end $$;

create or replace function private.report_tz_impl(p_tz text, p_device uuid, p_platform text) returns text
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  dev record;
  prof record;
  is_phone boolean;
  k_pre text; k_end text; k_rep text; k_phone text; k_acc text;
  pend_at timestamptz;
  n int;
begin
  sid := private.require_live_session();
  if p_platform is null or p_platform not in ('ios', 'windows', 'web', 'tauri') then
    raise exception 'bad_platform' using errcode = '22023'; end if;
  if p_tz is null or char_length(p_tz) > 64 or p_tz like '%:%' then raise exception 'bad_tz' using errcode = '22023'; end if;
  -- 只认本人、本会话的那一行（第 99 条：设备行绑在会话上）；平台以行里登记的为准，和参数不一致就拒
  select d.id, d.platform into dev from public.devices d
   where d.id = p_device and d.user_id = uid and d.session_id = sid;
  if not found then raise exception 'device_mismatch'; end if;
  if dev.platform <> p_platform then raise exception 'platform_mismatch' using errcode = '22023'; end if;
  is_phone := dev.platform = 'ios';

  select p.tz_mode, p.current_tz into prof from public.profiles p where p.user_id = uid for update;
  k_pre := 'tzrep:' || uid::text || ':' || p_device::text || '@';
  k_end := 'tzrep:' || uid::text || ':' || p_device::text || 'A';   -- 前缀范围的上界（见本节开头）
  k_rep := k_pre || p_tz;
  k_phone := 'tzphone:' || uid::text || ':last';

  if is_phone then   -- 手机每次上报都记一笔（不论采不采纳），电脑据此让路
    delete from private.counters c where c.key = k_phone;
    insert into private.counters (key, window_start, count) values (k_phone, now(), 1);
  end if;

  if prof.tz_mode = 'fixed' then
    delete from private.counters c where c.key like 'tzrep:%' and c.key collate "C" >= k_pre and c.key collate "C" < k_end;
    return 'fixed';
  end if;
  if p_tz = prof.current_tz then
    delete from private.counters c where c.key like 'tzrep:%' and c.key collate "C" >= k_pre and c.key collate "C" < k_end;   -- 报回原值：之前那次“新时区”作废
    return 'unchanged';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz) then
    raise exception 'bad_tz' using errcode = '22023'; end if;
  if not is_phone and exists (select 1 from private.counters c where c.key = k_phone and c.window_start > now() - interval '24 hours') then
    delete from private.counters c where c.key like 'tzrep:%' and c.key collate "C" >= k_pre and c.key collate "C" < k_end;
    return 'phone_priority';
  end if;

  select c.window_start into pend_at from private.counters c where c.key = k_rep;
  if found and pend_at > now() - interval '10 minutes' then
    -- 同一台设备 10 分钟内第二次报同一个新时区：采纳（先过每人每小时的次数上限；超了留着这一笔，下一小时再报就采纳）
    k_acc := 'tzacc:' || uid::text || ':' || to_char(date_trunc('hour', now(), 'UTC') at time zone 'UTC', 'YYYYMMDD"T"HH24');
    insert into private.counters as c (key, window_start, count) values (k_acc, date_trunc('hour', now(), 'UTC'), 1)   -- 按 UTC 整点截断，不随会话时区
      on conflict (key, window_start) do update set count = c.count + 1
      returning c.count into n;
    if n > 6 then return 'rate_limited'; end if;
    delete from private.counters c where c.key like 'tzrep:%' and c.key collate "C" >= k_pre and c.key collate "C" < k_end;
    update public.profiles set current_tz = p_tz, current_tz_device = p_device, current_tz_at = now() where user_id = uid;
    perform private.enqueue_floating(uid);   -- 浮动提醒按新时区重算（主键去重，重复采纳不重复入队）
    return 'accepted';
  end if;
  -- 第一次报（或换了别的新时区、或上一次已超过 10 分钟）：这台设备只留这一笔
  delete from private.counters c where c.key like 'tzrep:%' and c.key collate "C" >= k_pre and c.key collate "C" < k_end;
  insert into private.counters (key, window_start, count) values (k_rep, now(), 1);
  return 'pending';
end $$;

create or replace function private.revoke_my_sessions_impl(p_include_current boolean) returns integer
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  n int := 0;
  r record;
begin
  sid := private.require_live_session();
  for r in select s.id from auth.sessions s
            where s.user_id = uid and (coalesce(p_include_current, false) or s.id <> sid) loop
    perform private.revoke_session(r.id, uid);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function private.rebind_device_impl(p_user uuid, p_device uuid, p_old_session uuid, p_new_session uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  dev record;
  got uuid;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;   -- 0.36（依赖 S1 迁移；service role 的令牌没有 amr，照常通过）
  if p_user is null or not private.account_usable(p_user) then raise exception 'account_disabled'; end if;
  if p_device is null or p_old_session is null or p_new_session is null or p_old_session = p_new_session then
    raise exception 'bad_rebind' using errcode = '22023'; end if;
  if not exists (select 1 from auth.sessions s where s.id = p_old_session and s.user_id = p_user)
     or not exists (select 1 from auth.sessions s where s.id = p_new_session and s.user_id = p_user) then
    raise exception 'session_mismatch'; end if;
  if not private.session_alive(p_old_session) or not private.session_alive(p_new_session) then
    raise exception 'session_revoked'; end if;

  -- 先锁住这个人的全部设备行（for update），两次交接同时拿同一个新会话时第二次排队、看得到第一次的结果，session_in_use 不会漏
  perform 1 from public.devices d where d.user_id = p_user order by d.id for update;   -- 按 id 顺序加锁，和别的多行加锁不互相等死
  select d.id, d.user_id, d.session_id into dev from public.devices d where d.id = p_device for update;
  if not found or dev.user_id <> p_user or dev.session_id is distinct from p_old_session then
    raise exception 'device_mismatch'; end if;
  if exists (select 1 from public.devices d where d.session_id = p_new_session and d.id <> p_device) then
    raise exception 'session_in_use'; end if;

  perform set_config('lemo.rebind', p_device::text, true);
  update public.devices d set session_id = p_new_session where d.id = p_device returning d.session_id into got;
  perform set_config('lemo.rebind', '', true);
  if got is distinct from p_new_session then raise exception 'rebind_denied'; end if;   -- 不是经 PostgREST 以 service_role 调的

  perform private.kill_session(p_old_session, p_user);
end $$;

create or replace function private.account_request_deletion(p_user uuid) returns timestamp with time zone
  language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
  st text;
  pa timestamptz := now() + interval '7 days';
begin
  if p_user is null then raise exception 'bad_user' using errcode = '22023'; end if;
  if exists (select 1 from private.admins a where a.user_id = p_user) then raise exception 'admin_cannot_delete'; end if;
  -- 锁 profile 这一行：和 admin_set_disabled、并发的第二次申请互斥
  select case when p.disabled_at is null then 'ok' when p.disabled_reason = 'deletion' then 'deletion' else 'admin' end
    into st from public.profiles p where p.user_id = p_user for update;
  if st is null or st = 'admin' then raise exception 'account_disabled'; end if;
  if st = 'deletion' then raise exception 'account_pending_deletion'; end if;
  -- profile 能用却留着 pending_deletions 行（正常不会出现）：按这次申请重写，冷静期重新计
  insert into private.pending_deletions as d (user_id, requested_at, purge_after) values (p_user, now(), pa)
    on conflict (user_id) do update set requested_at = excluded.requested_at, purge_after = excluded.purge_after,
      notice_sent = false, purge_started_at = null;
  update public.profiles set disabled_at = now(), disabled_reason = 'deletion' where user_id = p_user;
  perform private.kill_session(s.id, p_user) from auth.sessions s where s.user_id = p_user;
  return pa;
end $$;

create or replace function private.cleanup_batch(p_limit integer DEFAULT 1000) returns integer
  language plpgsql set search_path = '' as $$
declare left_ int := p_limit; k int; t0 timestamptz := clock_timestamp();
  cut30 bigint := ((extract(epoch from now()) - 30 * 86400) * 1000)::bigint;
  cut90 bigint := ((extract(epoch from now()) - 90 * 86400) * 1000)::bigint;
  r record;
begin
  -- 30 天前软删除的行（向量、vault_ai 靠外键级联；墓碑由触发器写）
  delete from public.events        where ctid in (select ctid from public.events        where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.todos         where ctid in (select ctid from public.todos         where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.anniversaries where ctid in (select ctid from public.anniversaries where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.note_images   where ctid in (select ctid from public.note_images   where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.note_files    where ctid in (select ctid from public.note_files    where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.notes         where ctid in (select ctid from public.notes         where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.categories    where ctid in (select ctid from public.categories    where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- 20261029210000：ai.vault、ai.enabled 不硬删（删了就回到默认值，ai.vault 的默认是打开）
  delete from public.settings      where ctid in (select ctid from public.settings      where deleted_at < cut30 and key not in ('ai.vault', 'ai.enabled') limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- 不同步的表
  delete from public.logs          where ctid in (select ctid from public.logs where t < cut90 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.applied_ops   where ctid in (select ctid from public.applied_ops where at < now() - interval '7 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.tombstones    where ctid in (select ctid from public.tombstones where deleted_at < now() - interval '30 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.pending_signups     where ctid in (select ctid from private.pending_signups where expires_at < now() limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.webauthn_challenges where ctid in (select ctid from private.webauthn_challenges where expires_at < now() limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.counters            where ctid in (select ctid from private.counters where window_start < now() - interval '30 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- B1 a：会话已不在的设备行（第 98 条；session_id 为空的不碰）
  delete from public.devices d where d.ctid in (select x.ctid from public.devices x
     where x.session_id is not null and not exists (select 1 from auth.sessions s where s.id = x.session_id) limit left_);
  get diagnostics k = row_count; left_ := left_ - k;
  -- B1 b：180 天没用的设备行，先吊销会话再删（第 108 条）
  for r in select x.id, x.user_id, x.session_id from public.devices x
            where greatest(
                    case when x.last_seen_at <= now() + interval '1 day' then x.last_seen_at end,
                    x.created_at,
                    (select max(coalesce(s.refreshed_at at time zone 'UTC', s.updated_at)) from auth.sessions s
                      where x.session_id is not null and s.id = x.session_id and s.user_id = x.user_id)
                  ) < now() - interval '180 days'
            limit left_ loop
    perform private.kill_session(r.session_id, r.user_id);
    delete from public.devices d where d.id = r.id;
    left_ := left_ - 1;
  end loop;
  -- B1 c（R-382 改口径）：吊销记录按 revoked_at 留 30 天，到期并且会话已不在 auth.sessions 才删（不管明文清没清）；
  --   离线 30 天以内的丢失设备一联网还能经 session_fate 查出 revoked。
  --   安全审 M1：会话还在的不删——session_alive 只看这张表，删了它，一个被吊销却还没从 auth.sessions 删掉的会话就又活了
  delete from private.revoked_sessions rs where rs.ctid in (select y.ctid from private.revoked_sessions y
     where y.revoked_at < now() - interval '30 days'
       and (y.session_id is null or not exists (select 1 from auth.sessions s where s.id = y.session_id))
     limit left_);
  get diagnostics k = row_count; left_ := left_ - k;
  insert into private.heartbeat (name, at, detail)
    values ('cleanup', now(), jsonb_build_object('rows', p_limit - left_, 'ms', (extract(epoch from clock_timestamp() - t0) * 1000)::int))
    on conflict (name) do update set at = excluded.at, detail = excluded.detail;
  return p_limit - left_;
end $$;
