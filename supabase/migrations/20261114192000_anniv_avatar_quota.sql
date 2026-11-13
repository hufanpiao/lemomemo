-- 20261114192000_anniv_avatar_quota.sql：纪念日头像接存储额度（B5 整块评审第 4 条；B1 接手清单 P-b5-avatar-quota；架构 3.3 D 存储上限一段）。
-- ① private.media_quota_guard()（20261111100000，note_images 的写行触发器）加纪念日一支，挂到 anniversaries 的 before insert or update of avatar_bytes：
--    avatar_bytes 客户端能改（0005 的列级授权），新插带头像、把 avatar_bytes 改大都先拿 private.media_quota_lock，
--    已用（private.media_used，已含这一行原来的 avatar_bytes）− 原值 ＋ 新值 ≤ 上限，超了 quota_exceeded（取值 1～102400 由列约束管）。
--    改小、清空不判。复用同一个触发器函数和同一把锁：三种写行（插图、附件、头像）只有一套额度判断，不新增函数和授权。
-- ② private.files_authorize_impl（照 20261112090000 的定义，只改纪念日头像一支）：put 要带 content_length（length_required），
--    ≤ 102400 且等于这一行的 avatar_bytes（length_mismatch），再按 media_fits 复核一次（quota_exceeded）。get 不变。
-- 102400 和 shared/manifests/anniv.ts 头像一段的 maxBytes、0005 的列约束一致（tests/build/gen-files-rules.test.ts 对拍）。pgTAP 在 supabase/tests/rls/52_anniv_avatar_quota.test.sql。

create or replace function private.media_quota_guard() returns trigger
  language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
  cap bigint;
begin
  if session_user in ('postgres', 'supabase_admin') and coalesce(nullif(current_setting('role', true), ''), 'none') = 'none' then return new; end if;
  if tg_table_name = 'anniversaries' then
    -- B5 整块评审第 4 条（P-b5-avatar-quota）：纪念日头像。avatar_bytes 客户端能改（0005 的列级授权），insert 和改大 avatar_bytes 都判；
    --   改小、清空不判（只会少占）；合计时排除这一行原来的值再加新值。取值范围 1～102400 由列上的约束管（0005、20261111100500）
    if new.avatar_bytes is null then return new; end if;
    if tg_op = 'UPDATE' and new.avatar_bytes <= coalesce(old.avatar_bytes, 0) then return new; end if;
    perform private.media_quota_lock(new.user_id);
    cap := private.media_limit_bytes(new.user_id);
    if cap is not null and private.media_used(new.user_id, null)
         - (case when tg_op = 'UPDATE' then greatest(coalesce(old.avatar_bytes, 0), 0) else 0 end) + new.avatar_bytes > cap then
      raise exception 'quota_exceeded';
    end if;
    return new;
  end if;
  -- 安全审 M1：字节数小于 1 直接拒（列上的 check 在触发器之后才判，这里先挡；errcode 同 check 违例，apply_patch 照参数错误回）
  if new.bytes is null or new.bytes < 1 then raise exception 'bad_bytes' using errcode = '23514'; end if;
  perform private.media_quota_lock(new.user_id);
  if not private.media_fits(new.user_id, new.id, new.bytes, new.has_thumb) then
    raise exception 'quota_exceeded';
  end if;
  return new;
end $$;

-- 在 anniversaries 上建触发器要拿表锁：先 set local lock_timeout，5 秒拿不到就整个迁移回滚，等长事务结束再推（tests/build/migration-lock-timeout.test.ts）
set local lock_timeout = '5s';
create trigger anniversaries_media_quota before insert or update of avatar_bytes on public.anniversaries
  for each row execute function private.media_quota_guard();

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
  cl numeric;   -- put 时 /files 传来的 Content-Length（JSON 整数，字节数）
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
      -- 路径段先认成 uuid 再和 uuid 列比（不把列转成文本，主键索引用得上）；
      --   路径正则 [0-9a-f-]{36} 放得过、却不是 8-4-4-4-12 的段认成 null（不转换、不报错），当“没有这一行”
      seg := split_part(p, '/', 3);                 seg_id  := case when length(seg) = 36 and seg ~ uuid_re then seg::uuid end;
      seg := left(split_part(p, '/', 4), -5);       seg_id2 := case when length(seg) = 36 and seg ~ uuid_re then seg::uuid end;
      select a.avatar_id, a.avatar_bytes, a.deleted_at into row_ from public.anniversaries a
       where a.user_id = uid and a.id = seg_id;
      if not found then r := 'no_row';
      elsif row_.avatar_id is null or seg_id2 is null or row_.avatar_id <> seg_id2 then r := 'not_owner';
      elsif row_.deleted_at is not null and (p_op = 'put' or row_.deleted_at < now_ms - keep_ms) then r := 'deleted';
      -- B5 整块评审第 4 条（P-b5-avatar-quota）：put 要带 content_length，≤ 102400（清单 anniv.ts 头像 maxBytes）且等于这一行的 avatar_bytes；
      --   额度在写 avatar_bytes 时由 media_quota_guard 判过，这里按同一口径复核（这一行的 avatar_bytes 已算进已用，新增 0）
      elsif p_op = 'put' and (cl is null or cl < 0 or cl <> trunc(cl)) then r := 'length_required';
      elsif p_op = 'put' and (cl > 102400 or row_.avatar_bytes is null or cl <> row_.avatar_bytes) then r := 'length_mismatch';
      elsif p_op = 'put' and not private.media_fits(uid, null, 0, false) then r := 'quota_exceeded';
      end if;
    elsif b = 'images' then
      -- 随手记插图：先写行再传（比原来 img_ins 严）；缩略图要 has_thumb
      base := case when thumb then left(p, -7) || '.webp' else p end;
      select ni.id, ni.bytes, ni.bucket, ni.has_thumb, ni.deleted_at, n.is_private into row_ from public.note_images ni
        join public.notes n on n.id = ni.note_id and n.user_id = ni.user_id
       where ni.user_id = uid and ni.path = base;
      if not found or (thumb and not row_.has_thumb) then r := 'no_row';
      elsif row_.bucket <> 'images' then r := 'not_owner';   -- 隐私记的图（vault-images）不经 /files
      -- 挂的随手记要 is_private = false（和触发器 guard_note_image() 同一口径；纵深一道），put、get 都查
      elsif row_.is_private then r := 'bad_bucket';
      elsif row_.deleted_at is not null and (p_op = 'put' or row_.deleted_at < now_ms - keep_ms) then r := 'deleted';
      -- put 再按写行触发器同一口径复核（media_fits），合计时排除这一行自己（行已经写进去了）；
      --   原图和缩略图的 put 都核（这一行的占用 = 原图 bytes ＋ 缩略图预留，已在写行时算进去）
      elsif p_op = 'put' and (cl is null or cl < 0 or cl <> trunc(cl)) then r := 'length_required';
      elsif p_op = 'put' and cl >= 0 and cl = trunc(cl) and (case when thumb then cl > 131072 else cl <> row_.bytes end) then r := 'length_mismatch';   -- 131072 和额度里的缩略图预留、notes.ts 的 thumbSizeLimit 一致
      elsif p_op = 'put' and not private.media_fits(uid, row_.id, row_.bytes, row_.has_thumb) then r := 'quota_exceeded';
      end if;
    else
      -- 附件（原 file_slot_open）：put 只认本人、普通、pending、没删的行；get 只给 check_status = 'ok' 的
      if thumb then
        -- 缩略图按 (note_id, id) 找原文件（扩展名未知）；两段都按 uuid 比（同上）
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
