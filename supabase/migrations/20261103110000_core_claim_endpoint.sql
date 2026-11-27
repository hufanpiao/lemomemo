-- 20261103110000_core_claim_endpoint.sql：认领推送订阅 claim_endpoint（架构 3.3 D、0.49 第 1、2 条、0.29 续第 99 条④、第 105 条、0.38 第 2、35 条；
--   B2 任务单 BE-1 ①、第二节“接口先定”第 1 条；TC-B2-79、TC-B2-80、TC-B1-22、81）
-- 0001 里只留了位置（3.3 C 行尾标“B2 新迁移”，0.31 第 23 条），这里新建；不改 0001～0007。
--
-- ① private.push_endpoint_ok(text)：推送端点校验（5.3“推送端点校验”，按 B2 安全审查 D1-1、第五节第 1、3 条）。immutable、不授任何角色执行权，
--    只在 claim_endpoint_impl 里调。和 supabase/functions/_shared/push/endpoint.ts 的 checkEndpoint() 同一套规则，同一组向量
--    （tests/fixtures/push-endpoints.json）在 pgTAP 和 Deno 各跑一遍。**只收已经是规范形式的原串，不做任何规范化**
--    （不转小写、不去末尾点；浏览器给的 PushSubscription.endpoint 本来就是规范形式，不会误伤）。比较一律区分大小写（不用 ~*、ilike、lower()）：
--    a. 纯 ASCII 可见字符 0x21～0x7E（没有空白、控制字符、非 ASCII；反斜杠在 c 里拒）；
--    b. 再查长度 ≤ 2048（纯 ASCII 以后 char_length 和 JS 的 .length 一样）；
--    c. 整串匹配 ^https://(<主机>)(<路径>)(?<查询>)?$（安全审查 1.5 第 ① 点，取代 D1-1 第 ③ 步原来的 (/[^\#\s]*)）：主机只许 [a-z0-9.-]；
--       路径以 / 开头，路径和查询串只许 [A-Za-z0-9._~:/=&+-] 和 %XX（正好两位十六进制），最多一个 ?，不许 #。
--       这串正则和 supabase/functions/_shared/push/endpoint.ts 的 SHAPE_SOURCE 一字不差（tests/build/push-path-rule-sync.test.ts 核对），改时两边一起改；
--       另外两条两边都做：原串里不许有 %2e / %2E；? 之前的路径用 (^|/)\.{1,2}(/|$) 匹配，命中就拒（点段）；
--    d. 主机完全等于 fcm.googleapis.com、updates.push.services.mozilla.com，或匹配
--       ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.push\.apple\.com$、^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.notify\.windows\.com$
--       （一级子域；标签 1～63 字符，不以 - 开头结尾），且子域标签不以 xn-- 开头。IP、末尾点、空标签都不可能匹配。不做 DNS 解析、不缓存。
-- ② 订阅密钥 private.push_keys_ok(p256dh, auth)（D1-S1；immutable、不授任何角色执行权，同样读 fixture 的 keys 向量）：p256dh 匹配 ^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]=?$、auth 匹配 ^[A-Za-z0-9_-]{21}[AQgw](==)?$（devices 的约束是同一条正则），
--    再解码核对 p256dh 65 字节、首字节 0x04，auth 16 字节。点在不在曲线上 SQL 查不了，Deno 一侧 importKey 失败按 bad_keys 处理（C-3）。
--    两个错误码一律 errcode 22023，不带 detail、hint，也不把原串写进异常（D1-S4）。
-- ③ claim_endpoint_impl(endpoint, p256dh, auth, label, platform) → jsonb，按 3.3 D 的顺序：
--    a. 照 0.38 第 2 条先查 not_password_session()、account_usable()、session_alive()：回 session_revoked / account_disabled；
--    b. 地址不合格 raise 'endpoint_not_allowed'、密钥不合格 raise 'bad_push_keys'（errcode 22023 → PostgREST 回 HTTP 400），一行不动；
--    c. 本会话那一行（user_id = 本人、session_id = JWT 的会话、没软删）不在就 raise 'device_not_found'（客户端先建 devices 行再认领）；
--    d. 删掉别的账号名下同一 endpoint 的行（M9，换账号后推送不会发错人）；
--    e. 同一账号别的行占着：那一行的会话已不在（session_alive 为假，含 session_id 为空）就删；还在就返回
--       {error: 'endpoint_in_use', holder: {id, label, last_seen_at, install_id}}，本行不改（第 99 条④、第 105 条）；
--    f. 写本会话那一行的 push_endpoint、p256dh、auth（label、platform 传了才改）；地址换了时 push_fail_count 清零；返回 {ok: true}。
--    d 在 e 之前：返回 endpoint_in_use 时别的账号的行已经删掉（3.3 D 的顺序；那些行本来就不该再收这台设备的推送）。
--    删 devices 行会经 write_tombstone() 留墓碑；本行 update 经 devices_session_guard()（session_id 保持原值、会话还在）和 touch()。
--    两个会话同时认领同一个地址时，后提交的那个撞 push_endpoint 的唯一约束（23505）失败，客户端下次启动再认领即可，不另加锁。
-- ④ public.claim_endpoint：security invoker 转调，只授 authenticated（3.3 D 九个 RPC 之一）；进 version-gate 免查名单（S-B2 P0）。

create function private.push_endpoint_ok(p text) returns boolean
  language sql immutable parallel safe set search_path = '' as $$
  select coalesce((
    select y.h in ('fcm.googleapis.com', 'updates.push.services.mozilla.com')
        or ((y.h ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.push\.apple\.com$'
             or y.h ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.notify\.windows\.com$')
            and y.h !~ '^xn--')
      from (select pg_catalog.regexp_match(p, '^https://([a-z0-9.-]+)(/(?:[A-Za-z0-9._~:/=&+-]|%[0-9A-Fa-f]{2})*)([?](?:[A-Za-z0-9._~:/=&+-]|%[0-9A-Fa-f]{2})*)?$') as m) x
     cross join lateral (select x.m[1] as h, x.m[2] as path) y
     where p ~ '^[!-~]*$'
       and pg_catalog.char_length(p) <= 2048
       and x.m is not null
       and p !~ '%2[eE]'
       and y.path !~ '(^|/)[.]{1,2}(/|$)'
  ), false)
$$;

-- ② 的实现：两个都合格才回 true，null 回 false。用 case 保证正则不过就不解码（and 不保证求值顺序），decode 不会抛错
create function private.push_keys_ok(p256dh text, auth text) returns boolean
  language sql immutable parallel safe set search_path = '' as $$
  select case
    when p256dh is null or auth is null then false
    when p256dh !~ '^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]=?$' or auth !~ '^[A-Za-z0-9_-]{21}[AQgw](==)?$' then false
    else pg_catalog.length(pg_catalog.decode(pg_catalog.translate(pg_catalog.substr(p256dh, 1, 87), '-_', '+/') || '=', 'base64')) = 65
     and pg_catalog.get_byte(pg_catalog.decode(pg_catalog.translate(pg_catalog.substr(p256dh, 1, 87), '-_', '+/') || '=', 'base64'), 0) = 4
     and pg_catalog.length(pg_catalog.decode(pg_catalog.translate(pg_catalog.substr(auth, 1, 22), '-_', '+/') || '==', 'base64')) = 16
  end
$$;

create function private.claim_endpoint_impl(p_endpoint text, p_p256dh text, p_auth text, p_label text, p_platform text) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  me record;
  holder record;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;   -- 0.36（依赖 S1 迁移）
  if uid is null or not private.account_usable(uid) then raise exception 'account_disabled'; end if;
  begin
    sid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then sid := null;
  end;
  if not private.session_alive(sid) then raise exception 'session_revoked'; end if;

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
grant execute on function private.claim_endpoint_impl(text, text, text, text, text) to authenticated;   -- B2 新迁移（0.31 第 23 条）

create function public.claim_endpoint(endpoint text, p256dh text, auth text, label text, platform text) returns jsonb
  language sql security invoker set search_path = '' as $$
  select private.claim_endpoint_impl(endpoint, p256dh, auth, label, platform) $$;
revoke execute on function public.claim_endpoint(text, text, text, text, text) from public, anon, service_role;
grant execute on function public.claim_endpoint(text, text, text, text, text) to authenticated;
