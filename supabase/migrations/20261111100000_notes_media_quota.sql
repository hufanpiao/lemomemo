-- B4 迁移：每人存储上限（B4 任务单 S10 ①②④；架构 3.3 D my_ai_usage、第 3533、3540～3543 行；架构审 11-10）
-- 只新建，不改旧迁移。部署顺序上这是第一步（和 /files 新版、缩略图 128 KB 的规则表一起上）；
--   “缺了 content_length 回 length_required”在 20261111101000_notes_files_content_length.sql，是第二步，核对线上 /files 已是新版后再上。
--
-- 额度口径（同一个公式三处共用：note_images 写行触发器、files_authorize_impl 的 images put 复核、my_ai_usage 的已用量）：
--   已用 = 这个人 note_images 全部行的 bytes ＋ 131072（128 KB）× 其中 has_thumb 的行数（缩略图预留，S10 ④）
--        ＋ note_files 全部行的 bytes ＋ anniversaries 全部行的 avatar_bytes；
--   “最近删除”里的行也算（对象还在桶里），隐私记的行也算（vault-* 桶同样占存储）；30 天清理删掉的行自然不算。
--   上限 = private.user_limits.media_mb（MB）× 1048576；这个人在 user_limits 里没有行就用 app_config.limits.media_mb_default，
--     读不出（缺键、不是非负整数）按 50；user_limits 里有行但 media_mb 为 null 表示不设上限（0001 的注释“null = 不设上限”）。
--   判法：已用（不含这一行）＋ 这一行的占用 ≤ 上限，超了 quota_exceeded。
--
-- 函数：
--   private.media_row_bytes(int, boolean)：一张插图的占用（原图 bytes ＋ 有缩略图时 131072），公式只写在这里；
--   private.media_used(uuid, uuid)：已用字节数，第二个参数是要排除的 note_images.id（put 复核排除这一行自己；不排除传 null）；
--   private.media_limit_bytes(uuid)：上限字节数，null = 不设上限；
--   private.media_fits(uuid, uuid, int, boolean)：放得下吗（触发器、put 复核共用）；
--   private.media_quota_lock(uuid)：同一个人的事务级锁（锁键 media-quota:<user_id>），以后 note_files、纪念日头像的额度触发器共用；
--   private.media_quota_guard()：note_images 的 before insert 触发器。bytes < 1 直接拒（bad_bytes）；同一个人并发写行先拿这个人的锁再合计，免得两行一起越线；
--     函数级 lock_timeout 5 秒（同 ai_quota_take，等锁超时整句回滚）。迁移、SQL 编辑器（postgres / supabase_admin，role 为空）豁免，同 row_quota。
--   note_files（B4b-1）和纪念日头像（B5）写行时各自加触发器调 media_fits，到时再接。
-- 前四个只在 security definer 函数里调（以函数主人的身份执行），不授权；触发器函数照 guard_note_image 的惯例授给 authenticated。
--
-- 改两个函数（create or replace，签名不变）：
--   private.files_authorize_impl：images 桶随手记插图（原图和缩略图）的 put 再按同一口径复核一次，排除这一行自己（行已经写进去了）；
--     超了这一项回 quota_exceeded。p_items[0] 里 /files 新版多传的 content_length（S10 ③，架构审必改 2）：
--     带了（JSON 非负整数）才比——原图要等于这一行 bytes、缩略图（.t.webp）不超过 131072，对不上回 length_mismatch；
--     缺了、或不是非负整数，过渡期照旧放行（第二步 20261111101000 起回 length_required）。get 时带了也忽略。
--   private.my_ai_usage_impl：多返回 media_used（已用字节数）、media_limit（上限字节数，null = 不设上限），给设置 › 数据的个人用量条。
-- 测试：supabase/tests/rls/44_media_quota.test.sql（pgTAP）。

-- ---------- 额度公式 ----------
create function private.media_row_bytes(p_bytes int, p_has_thumb boolean) returns bigint
  language sql immutable set search_path = '' as $$
  -- 安全审 M1：每一项先 greatest(x, 0)，负数不能抵掉别的行的占用（列上的下限见 20261111100500）
  select greatest(coalesce(p_bytes, 0), 0)::bigint + case when p_has_thumb then 131072 else 0 end   -- 缩略图按 128 KB 预留（清单 notes.ts 的 thumbSizeLimit）
$$;

create function private.media_used(p_uid uuid, p_exclude_image uuid) returns bigint
  language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(private.media_row_bytes(ni.bytes, ni.has_thumb)) from public.note_images ni
                    where ni.user_id = p_uid and ni.id is distinct from p_exclude_image), 0)::bigint
       + coalesce((select sum(greatest(f.bytes, 0)::bigint) from public.note_files f where f.user_id = p_uid), 0)::bigint
       + coalesce((select sum(greatest(a.avatar_bytes, 0)::bigint) from public.anniversaries a where a.user_id = p_uid), 0)::bigint
$$;

create function private.media_limit_bytes(p_uid uuid) returns bigint
  language plpgsql stable security definer set search_path = '' as $$
declare
  mb int;
  v jsonb;
begin
  select l.media_mb into mb from private.user_limits l where l.user_id = p_uid;
  if found then
    return case when mb is null then null else greatest(mb, 0)::bigint * 1048576 end;
  end if;
  select a.limits -> 'media_mb_default' into v from public.app_config a where a.id = 1;
  if jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric >= 0
     and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric) and (v #>> '{}')::numeric <= 2147483647 then
    return (v #>> '{}')::bigint * 1048576;
  end if;
  return 50::bigint * 1048576;
end $$;

create function private.media_fits(p_uid uuid, p_exclude_image uuid, p_bytes int, p_has_thumb boolean) returns boolean
  language plpgsql stable security definer set search_path = '' as $$
declare cap bigint := private.media_limit_bytes(p_uid);
begin
  if cap is null then return true; end if;
  return private.media_used(p_uid, p_exclude_image) + private.media_row_bytes(p_bytes, p_has_thumb) <= cap;
end $$;

-- ---------- 同一个人的额度锁 ----------
-- 锁键 media-quota:<user_id>，事务级（提交或回滚时放）。以后 note_files（B4b-1）、纪念日头像（B5）的额度触发器一律先调它再合计，
--   三种写行用同一把锁，才不会两种行一起越线（架构 3.3 D 存储上限一段）。
create function private.media_quota_lock(p_uid uuid) returns void
  language sql security definer set search_path = '' set lock_timeout = '5s' as $$
  select pg_advisory_xact_lock(hashtextextended('media-quota:' || p_uid::text, 0))
$$;

-- ---------- ① 写行触发器 ----------
create function private.media_quota_guard() returns trigger
  language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
begin
  if session_user in ('postgres', 'supabase_admin') and coalesce(nullif(current_setting('role', true), ''), 'none') = 'none' then return new; end if;
  -- 安全审 M1：字节数小于 1 直接拒（列上的 check 在触发器之后才判，这里先挡；errcode 同 check 违例，apply_patch 照参数错误回）
  if new.bytes is null or new.bytes < 1 then raise exception 'bad_bytes' using errcode = '23514'; end if;
  perform private.media_quota_lock(new.user_id);
  if not private.media_fits(new.user_id, new.id, new.bytes, new.has_thumb) then
    raise exception 'quota_exceeded';
  end if;
  return new;
end $$;
grant execute on function private.media_quota_guard() to authenticated;          -- B4 新迁移（S10 ①）触发器函数：security definer，存储额度

create trigger note_images_media_quota before insert on public.note_images for each row execute function private.media_quota_guard();

-- ---------- ② files_authorize_impl：images put 复核 ----------
-- 和 20261029191000 的定义只差随手记插图那一段多查一项（row_ 多读 id、bytes），别处一字不改
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

-- ---------- my_ai_usage_impl：多返回存储用量 ----------
-- 和 20261107100000 的定义只差最后多两个键（media_used、media_limit，单位字节；media_limit 为 null 表示不设上限），别处一字不改
create or replace function private.my_ai_usage_impl()
  returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  d date := (now() at time zone 'America/Los_Angeles')::date;
  used int;
  cap int;
  v jsonb;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;   -- 0.36
  if uid is null or not private.account_usable(uid) then raise exception 'account_disabled'; end if;
  begin
    sid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then sid := null;
  end;
  if not private.session_alive(sid) then raise exception 'session_revoked'; end if;
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
