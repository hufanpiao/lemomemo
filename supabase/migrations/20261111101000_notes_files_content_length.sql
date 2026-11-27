-- B4 迁移：content_length 强制校验（B4 任务单 S10 ③；部署顺序第二步）
-- 只新建，不改旧迁移。**先核对线上 /files 已是新版（put 授权时把 Content-Length 作为 content_length 传进来）再部署这一份**；
--   /files 还是旧版时部署，随手记插图的 put 会一律回 length_required、传不上去。
-- 改一个函数（create or replace，签名不变）：private.files_authorize_impl，和 20261111100000 的定义只差随手记插图那一段多一句：
--   put 时 p_items[0] 的 content_length 缺了、不是 JSON 数字、是负数或小数 → length_required（20261111100000 里这种情况放行）。
--   “带了但对不上”回 length_mismatch（原图不等于 bytes、缩略图大于 131072）已在 20261111100000 里，这里不变；都对了再复核额度。
--   get 时带了也忽略。纪念日头像、附件（files 桶）这一步不查 content_length（接手清单 P-b4b-files-quota、P-b5-avatar-quota）。
-- 测试：supabase/tests/rls/45_files_content_length.test.sql（pgTAP）；44_media_quota 第六节改成强制以后的结果。

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
