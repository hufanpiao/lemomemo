-- B4b-2 识图：ai-media 的定时任务、重新同意 / 重新打开 AI 时把“没交给 AI”的图片改回 pending（架构 5.13 第 5 点、第 6 节 ai-media 行；R-112、R-179）。
--
-- ① ai-media 每 5 分钟一次（照 20261115020000_search_embed_cron.sql 的写法）：
--    带 x-cron-secret、x-region: ap-northeast-2（14.2 第 5 点）；timeout_milliseconds := 55000（一轮墙钟预算 40 秒，ai-media/core.ts 的 ROUND_BUDGET_MS）；
--    迁移里不写任何值：functions_url、cron_secret 两条在数据库 Vault，任务的 SQL 每次运行时读；Vault 里没设时请求发不出、没有心跳 ai-media，不会静默；
--    URL 写成 check_backend F9 认得出的 … 'functions_url') || '/ai-media'，config.toml 的 [functions.ai-media] verify_jwt = false 由 F9 ① 核对。
--    不加表授权：ai-media 只用 0003、0007 已给 fn_ai 的授权（ai-media/store.ts 文件头逐项列出）。
--
-- ② private.ai_consent_resume()（R-179，0.29 续第 35、120 条“重新同意、重新打开时恢复”；record_consent_impl 注释里写明“同意分支的恢复属于 B4b-2”）：
--    ai-media 遇到没同意、关了 AI、同意版本过期的人，把 pending 的普通图片写成 skip / consent（界面“没交给 AI · 去打开”）。条件满足以后要改回来：
--    a. settings 的 ai.enabled 写成 true（after insert or update of value，同 0007 的 settings_vault_ai_on 写法）；
--    b. profiles.consent_ai_at 写成非空（record_consent 同意分支；重新同意新版本时 consent_ai_at 也会重写），触发器挂在 profiles 上，
--       不 create or replace record_consent_impl（那个函数的三句开头检查只在 20261112090000 一处定义，不再复制一份）。
--    两种都做同一件事：取 embed:<user_id> 的 advisory 锁（和撤回同意删向量、vault_ai_off 互斥，0.27），
--    把这个人 skip_reason = consent 的普通图片（images 桶）改回 pending、清 skip_reason、ai_tries 清零（一条集合式 update，不逐行，0.29 续第 146 条；
--    文档这一批不识别、没人写 skip / consent，不改 note_files）；这个人向量队列里被推后的（关着 AI 时 ai-embed 推后 1 天）清掉推后、tries 归零；
--    ai-media 处理时照旧查 aiAllowed，恢复只是重新排队、不是放行（只开了 AI 没同意的，下一轮又写回 skip）。
--    b 另外补向量队列：撤回同意时 record_consent_impl 删光了这个人的向量和 embed_queue，重新同意不补就“开了也没用”（第 35 条 a 的原话）——
--    给这个人没删的普通随手记、日程、待办、有描述的普通图片、普通文档里还没有任何向量的写 embed_queue（已在队列里的上面已清掉推后）。
--    重复写同一个值（ai.enabled 本来就是 true、已同意又同意一次）也会触发：只是两条按人的 update 和一次补队列，不另加 old/new 比较（insert 分支没有 old）。
--    隐私记的（is_private、vault-images、is_vault）不进（ai-embed 这一批不算隐私记的向量）。识图、算向量都由 ai-media、ai-embed 之后按队列分批做。
--    security definer、search_path = ''；只给触发器用，revoke execute from public（同 vault_ai_on，3.3 C、附录 A 末尾同步）。
-- 测试：supabase/tests/rls/58_ai_media.test.sql（pgTAP：cron 登记、两种恢复、隐私记不动、补队列、撤回后再同意）。
-- 回滚：select cron.unschedule('ai-media'); drop trigger settings_ai_consent_resume on public.settings; drop trigger profiles_ai_consent_resume on public.profiles;
--       drop function private.ai_consent_resume();

-- 下面要在 public.settings、public.profiles 上建触发器（拿强锁）：先 set local lock_timeout，5 秒拿不到就整个迁移回滚，等长事务结束再推（migration-lock-timeout 规矩）
set local lock_timeout = '5s';

select cron.schedule('ai-media', '*/5 * * * *',
  $$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/ai-media',
      headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{}'::jsonb, timeout_milliseconds := 55000)$$);

create function private.ai_consent_resume() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('embed:' || new.user_id::text));   -- 和撤回同意、vault_ai_off、ai-embed 写向量同一把锁
  update public.note_images set ai_status = 'pending', skip_reason = null, ai_tries = 0, ai_next_at = null
   where user_id = new.user_id and bucket = 'images' and ai_status = 'skip' and skip_reason = 'consent';
  -- 关着 AI 期间新写的内容照样入队、被 ai-embed 推后 1 天：打开时清掉推后，下一轮就算
  update private.embed_queue set next_at = null, tries = 0 where user_id = new.user_id and next_at is not null;
  if tg_table_name = 'profiles' then
    insert into private.embed_queue as q (kind, source_id, user_id)
      select x.kind, x.id, new.user_id from (
        select 'note' as kind, n.id from public.notes n where n.user_id = new.user_id and n.deleted_at is null and not n.is_private
        union all select 'event', e.id from public.events e where e.user_id = new.user_id and e.deleted_at is null
        union all select 'todo', t.id from public.todos t where t.user_id = new.user_id and t.deleted_at is null
        union all select 'image', i.id from public.note_images i
                   where i.user_id = new.user_id and i.deleted_at is null and i.bucket = 'images' and i.ai_desc is not null
        union all select 'file', f.id from public.note_files f where f.user_id = new.user_id and f.deleted_at is null and not f.is_vault) x
       where not exists (select 1 from private.note_vectors v where v.kind = x.kind and v.source_id = x.id)
    on conflict (kind, source_id, model) do update set next_at = null, tries = 0;
  end if;
  return null;
end $$;
revoke execute on function private.ai_consent_resume() from public;

create trigger settings_ai_consent_resume after insert or update of value on public.settings
  for each row when (new.key = 'ai.enabled' and new.value = 'true'::jsonb) execute function private.ai_consent_resume();
create trigger profiles_ai_consent_resume after update of consent_ai_at on public.profiles
  for each row when (new.consent_ai_at is not null) execute function private.ai_consent_resume();
