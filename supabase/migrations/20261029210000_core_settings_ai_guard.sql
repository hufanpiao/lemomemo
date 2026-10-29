-- 20261029210000_core_settings_ai_guard.sql：settings 里 ai.vault、ai.enabled 不准客户端软删 / 撤销；notice 初值（R-239）；
--   record_consent_impl 一行都没写时报错
-- 必须排在 S1 批（20261029191000～20261029201000）之后、随 S1 一起或在 S1 之后提交：
--   record_consent_impl、cleanup_batch 都以 20261029192000_core_devices_sessions.sql 的定义为底稿 create or replace，
--   并且调用 S1 才有的 private.not_password_session()、private.session_alive()、devices.created_at；
--   apply_patch（20261029200000）的 settings 白名单含 deleted_at、undone，本文件的 settings_guard 同样挡住经它的写入
--
-- ① 安全漏洞：authenticated 有 settings 的 update (value, deleted_at, undone) 权限，0001 的 settings_guard 只拦“ai.vault 改成非 false”，
--   不拦软删。_shared/consent.ts 读 ai.vault 不看 deleted_at（值为 false 就挡），所以软删本身当下不会打开隐私记 AI；
--   漏洞真正生效的路径只有一条：客户端把 ai.vault = false 那一行写上 deleted_at（直接 PATCH 或经 apply_patch），
--   30 天后被每日清理（cleanup_batch）硬删，行没了，consent.ts 按“没有这一行”取默认 true 放行
--   （数据字典 ai.vault：客户端只能关、打开走 set_ai_vault），等于不用 vault_token 打开了隐私记 AI。
--   修法：
--   a. settings_guard：请求角色是 authenticated / anon 时，key 为 ai.vault、ai.enabled 的行不准把 deleted_at 写成非空（insert 或改成别的值），
--      不准把 undone 写成 true（insert 或由 false 改 true）。恢复（deleted_at 改回 null、undone 改回 false）不拦。
--      错误照 0001 guard 的风格（raise exception '<码>'，sqlstate P0001），用客户端 outbox 已认的丢弃码（DROP_CODES）：
--        ai.vault → vault_required（这一行没了就等于打开，和“客户端不能打开”同一个码）；
--        ai.enabled → settings_key_immutable（这个键的行只能改值、不能删）。
--      客户端收到这两个码都是丢掉这一项、整表重拉，不用改前端。
--      判断看请求角色（current_setting('role')），不看 current_user：apply_patch 是 security invoker，照样被挡；
--      security definer 的 record_consent_impl 在 authenticated 请求里也会过这个 guard，它只写 value，并把 deleted_at 清成 null、undone 改回 false（③ 撤回分支，属于不拦的“恢复”），不受影响；
--      set_ai_vault（vault 函数，以 service_role 写）、pg_cron、迁移不受这个 guard 约束（角色不是 authenticated / anon）。
--   b. 一次性修正：已经被软删 / 撤销的这两个键（理论上预览库里没有）原样救回，保持服务器现在的实际效果不变
--      （例外：ai.enabled 值为 true、只有 undone = true（deleted_at 为空）的行，修正后变成 false，方向是“关”，安全）：
--      ai.vault：只清 deleted_at、undone（consent.ts 读 ai.vault 本来就不看 deleted_at，值不变则效果不变；
--        也让这一行不再进 30 天硬删、回到默认 true 的那条路）；
--      ai.enabled：值改成 false 再清 deleted_at、undone（consent.ts 把软删行当成“没打开”，救回时不能变成打开）。
--      修完以后 guard 保证客户端再也写不出这种行。
--   c. cleanup_batch：30 天硬删软删行时跳过这两个键（双保险：service_role 写的软删行也不会被清掉、从而回到默认值）。
-- ② R-239（架构 0.40 第 2 条）：notice 初值由迁移给，日期按 R-238 写 YYYY-MM-DD；where notice is null，不覆盖线上调过的值。
-- ③ record_consent_impl：update profiles 一行都没更新（没有 profile 行、账号停用）时报 account_disabled，
--   不再返回成功让前端以为记下了、反复弹告知页。开头的 account_usable 已经挡了这两种情况，这里补的是检查和 update 之间账号被停用的窗口，
--   并且以后谁删了开头那句也不会再静默成功。
--   另外撤回分支写 ai.enabled 的 on conflict 改成同时清 deleted_at、undone：已有的 ai.enabled 行被软删 / 撤销过（服务器写的），
--   撤回后救回成活着的 false，不留一条软删行等 30 天被清掉。其余逐字照 20261029192000 版（三句开头检查都保留）。

-- ===== ① a. settings_guard =====
-- create or replace：属主、触发器、0001 的 revoke 保留。前两段逐字照 0001
create or replace function private.settings_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('role', true), '') not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'UPDATE' and new.key is distinct from old.key then raise exception 'settings_key_immutable'; end if;
  if new.key = 'ai.vault' and new.value is distinct from 'false'::jsonb
     and (tg_op = 'INSERT' or old.value is distinct from new.value) then
    raise exception 'vault_required';
  end if;
  -- 20261029210000：ai.vault、ai.enabled 不准客户端软删、撤销（软删 ai.vault 等于打开隐私记 AI）
  if new.key in ('ai.vault', 'ai.enabled')
     and ((new.deleted_at is not null and (tg_op = 'INSERT' or new.deleted_at is distinct from old.deleted_at))
       or (new.undone and (tg_op = 'INSERT' or not old.undone))) then
    if new.key = 'ai.vault' then raise exception 'vault_required'; end if;
    raise exception 'settings_key_immutable';
  end if;
  return new;
end $$;

-- ===== ① b. 一次性修正（以迁移角色执行，不过 guard） =====
update public.settings set deleted_at = null, undone = false
 where key = 'ai.vault' and (deleted_at is not null or undone);
update public.settings set value = 'false'::jsonb, deleted_at = null, undone = false
 where key = 'ai.enabled' and (deleted_at is not null or undone);

-- ===== ① c. 每日清理跳过 ai.vault、ai.enabled =====
-- create or replace：逐字照 20261029192000 版，只改 settings 那一句（加 key not in (…)）
create or replace function private.cleanup_batch(p_limit int default 1000) returns int language plpgsql set search_path = '' as $$
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
    if r.session_id is not null and exists (select 1 from auth.sessions s where s.id = r.session_id and s.user_id = r.user_id) then
      insert into private.revoked_sessions (session_id, user_id) values (r.session_id, r.user_id) on conflict (session_id) do nothing;
      delete from auth.sessions s where s.id = r.session_id and s.user_id = r.user_id;
    end if;
    delete from public.devices d where d.id = r.id;
    left_ := left_ - 1;
  end loop;
  -- B1 c：会话已不在 auth.sessions 的吊销记录（第 101 条）
  delete from private.revoked_sessions rs where rs.ctid in (select y.ctid from private.revoked_sessions y
     where not exists (select 1 from auth.sessions s where s.id = y.session_id) limit left_);
  get diagnostics k = row_count; left_ := left_ - k;
  insert into private.heartbeat (name, at, detail)
    values ('cleanup', now(), jsonb_build_object('rows', p_limit - left_, 'ms', (extract(epoch from clock_timestamp() - t0) * 1000)::int))
    on conflict (name) do update set at = excluded.at, detail = excluded.detail;
  return p_limit - left_;
end $$;

-- ===== ② R-239：notice 初值（R-238：YYYY-MM-DD，两个键相同 = 告知页、隐私说明这一版文字定稿的日期） =====
update public.app_config
   set notice = jsonb_build_object('policy_ver', '2026-10-29', 'min_consent_ver', '2026-10-29')
 where id = 1 and notice is null;

-- ===== ③ record_consent_impl：一行都没写时报错 =====
-- create or replace（属主和 0001 的执行权保留，这里不再 grant）。逐字照 20261029192000 版，只改两处：
--   update profiles 后加 row_count 检查；撤回分支 on conflict 同时把 deleted_at 清成 null、undone 改回 false（救回软删 / 撤销的 ai.enabled）。
--   以后再改这个函数，在比本文件更晚的迁移里连开头三句和这句一起写
create or replace function private.record_consent_impl(p_ver text, p_revoke boolean default false) returns void
  language plpgsql security definer set search_path = '' as $$
declare sid uuid; n int;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;   -- 0.36：密码会话不能替用户同意 / 撤销 AI（依赖 S1 迁移）
  if (select auth.uid()) is null or not private.account_usable((select auth.uid())) then raise exception 'account_disabled'; end if;   -- B1：3.3 通用规则
  begin
    sid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then sid := null;
  end;
  if not private.session_alive(sid) then raise exception 'session_revoked'; end if;   -- B1：K1 安全审查必改 2
  if p_ver is distinct from (select c.notice->>'policy_ver' from public.app_config c where c.id = 1) then
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
