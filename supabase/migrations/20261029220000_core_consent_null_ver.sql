-- 20261029220000_core_consent_null_ver.sql：record_consent_impl 拒绝 policy_ver 为 null（接手清单 SEC-210000-sugg ④）
-- 必须排在 20261029210000_core_settings_ai_guard.sql 之后：函数体以 210000 版为底稿 create or replace，
--   并且调用 S1 才有的 private.not_password_session()、private.session_alive()（依赖 20261029191000～20261029201000）
--
-- 漏洞：210000 版第 138 行写的是 `p_ver is distinct from (select notice->>'policy_ver' …)`。
--   app_config.notice 被清空（null）或没有 policy_ver 键时，右边是 null；客户端传 null 时 null is distinct from null 为假，
--   检查放行，profiles 记下 consent_ai_at = now()、consent_policy_ver = null（等于没看过任何一版告知就记成同意）。
--   notice 正常时（R-239 由 210000 给了初值）传 null 本来就会被拒，这里补的是 notice 被误清空的情况。
-- 修法：判断改成 `p_ver is null or p_ver is distinct from (...)`，报同一个码 policy_ver_mismatch（客户端已认，重读 notice 再提交）。
--   其余逐字照 20261029210000 版（开头三句检查、row_count 检查、撤回分支 on conflict 清 deleted_at / undone 都保留）。
--   create or replace：属主和 0001 的执行权保留，这里不再 grant。以后再改这个函数，在比本文件更晚的迁移里整段照抄本文件的版本

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
