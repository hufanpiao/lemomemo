-- 20261126130000_core_backup_read_dispatch.sql：B7a 每日备份的定时任务、发请求函数和备份专用读取口（评审返工，负责人 11-26 弹窗定的做法）。
-- ① private.backup_read(p_table text, p_user uuid, p_after uuid, p_limit int) returns jsonb：备份专用读取口。
--    隐私记四张表（vault、vault_credentials、device_secrets、vault_ai）只授 fn_vault / fn_ai（0006_vault.sql），service_role 读它们
--    permission denied，backup-daily 永远写不出 _manifest（评审第 1 条）。负责人 11-26 选“只给备份开一个专用读取口”：不给 service_role
--    授这四张表的表级权限（3.3 C、build/d1/whitelist.ts、03_roles_grants 的表级授权都不变），只开这一个只读函数。
--    AI 长期记忆 private.ai_memories 负责人 11-26 选“加进备份”，同一个口子读（它本来有 service_role 的 select，只给账号导出用，这里不另放宽）。
--    • security definer、stable、search_path 置空；只给 service_role 执行；
--    • p_table 只认这五张表（case 写死，不拼 SQL）；只按 user_id = p_user 读本人的行；
--    • 分页：device_secrets 按 device_id、vault_ai 按 source_id、ai_memories 按 id 往后翻（p_after 为上一页最后一个主键，没有为 null），
--      每页最多 p_limit 行（1～1001）；vault（每人一行）和 vault_credentials（text 主键，每人最多 1000 条）一次读完，p_after 必须为 null；
--    • 回一个 jsonb 数组，每行 to_jsonb(行)（bytea 写成 \x 开头的十六进制，和 PostgREST 返回的一样；恢复脚本按表类型写回）。
-- ② private.backup_dispatch(p_mode text) returns int：给每个可用账号各发一个 net.http_post 调 backup-daily，回发了几个。
--    定时任务（架构第 10 节“服务器端”、第 6 节 backup-daily 行、0.38 第 46 条；ADR-016 第 1 条；TC-B7a-23）、补跑、发布前触发三处都调这一个函数
--    （评审第 5、7、15 条；原来的迁移 20261126120000 两条 cron 各内联一份同样的 SQL，没进 main，B7a 复审“重复和简化”并进本文件后删掉）：
--    • 一人一次独立调用（第七轮）：架构写的“每人间隔 5 秒”在一条 cron 命令里做不到（pg_net 在事务提交后才统一发出，pg_sleep 错不开），
--      一个人的数据一次写不完时函数自己分段接着写（backup-daily/core.ts 文件头）；timeout_milliseconds 30000（函数写完第一段就回）；
--    • Vault 里没设 functions_url、cron_secret 时 url 为 null、请求发不出，backup-daily 没有心跳，lemo-ops 超过 26 小时告警——不会静默；
--    • URL 写成 check_backend F9 认得出的 … 'functions_url') || '/backup-daily'，config.toml 的 [functions.backup-daily] verify_jwt = false 由 F9 ① 核对；
--    • mode：start（00:30 定时）、retry（02:30 补跑，已做完的跳过）、publish（publish.ps1 改库前触发，单独计次数，不占每天的 4 次）；
--    • 挑人用 private.account_usable（0.29 续第 138 条④；D1 第 12 节认它调的 private 函数体）；
--    • 回值是这次实际发了请求的人数：publish.ps1 拿它当“要等几个人做完”（停用、冷静期的人这次没发请求，不会把发布卡住，评审第 7 条）；
--    • 只有 postgres 能执行（cron 和 Supabase 管理接口的 SQL 接口都用 postgres），不授给任何角色；
--    • 地址、密钥照旧运行时从数据库 Vault 读（functions_url、cron_secret），函数里不写任何值；pg_net 不记请求头。
--    两条定时任务：每天首尔 00:30（= 15:30 UTC，pg_cron 按 UTC）backup_dispatch('start')；02:30（= 17:30 UTC）backup_dispatch('retry')，
--    当天已经有 _manifest.json.gz 的直接跳过。cron.job 里只存这一行调用，pg_net 不记请求头，密钥不落日志。
-- ③ private.backup_missing(p_date text) returns int：首尔日期 p_date 当天还没做完备份（backups 桶里没有 <p_date>/<user_id>/_manifest.json.gz）的可用账号数，
--    只回个数（评审第 11 条：心跳只说明有人做完，lemo-ops 要能发现“当天没做完的人数 > 0”）。
--    只算那一天首尔 00:00 之前建的账号（当天才注册的，00:30 那一轮可能还没有它）。security definer（读 auth.users、storage.objects）、stable、
--    search_path 置空；只给 service_role 执行（usage-report {part: usage}）。
-- 授权行同步进架构 3.3 C 和附录 A、build/d1/whitelist.ts 的 FUNCTION_EXEC.service_role、03_roles_grants 的函数名单、shared/db.types.ts。
-- pgTAP：supabase/tests/rls/77_backup_read_dispatch.test.sql（读取口、授权、没做完人数、两条任务、发请求的写法）。
-- 回滚：select cron.unschedule('backup-daily'), cron.unschedule('backup-daily-retry');
--       drop function private.backup_read(text, uuid, uuid, int), private.backup_dispatch(text), private.backup_missing(text);

-- ① 备份专用读取口
create function private.backup_read(p_table text, p_user uuid, p_after uuid, p_limit int)
  returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r jsonb;
begin
  if p_user is null or p_limit is null or p_limit < 1 or p_limit > 1001 then
    raise exception 'backup_read: bad arguments' using errcode = '22023';
  end if;
  case p_table
    when 'vault' then
      if p_after is not null then raise exception 'backup_read: no paging' using errcode = '22023'; end if;
      select coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb) into r from private.vault v where v.user_id = p_user;
    when 'vault_credentials' then
      if p_after is not null then raise exception 'backup_read: no paging' using errcode = '22023'; end if;
      select coalesce(jsonb_agg(to_jsonb(c) order by c.credential_id), '[]'::jsonb) into r
        from (select * from private.vault_credentials x where x.user_id = p_user order by x.credential_id limit p_limit) c;
    when 'device_secrets' then
      select coalesce(jsonb_agg(to_jsonb(c) order by c.device_id), '[]'::jsonb) into r
        from (select * from private.device_secrets x where x.user_id = p_user and (p_after is null or x.device_id > p_after)
               order by x.device_id limit p_limit) c;
    when 'vault_ai' then
      select coalesce(jsonb_agg(to_jsonb(c) order by c.source_id), '[]'::jsonb) into r
        from (select * from private.vault_ai x where x.user_id = p_user and (p_after is null or x.source_id > p_after)
               order by x.source_id limit p_limit) c;
    when 'ai_memories' then
      select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]'::jsonb) into r
        from (select * from private.ai_memories x where x.user_id = p_user and (p_after is null or x.id > p_after)
               order by x.id limit p_limit) c;
    else
      raise exception 'backup_read: table not allowed' using errcode = '22023';
  end case;
  return r;
end $$;
grant execute on function private.backup_read(text, uuid, uuid, int) to service_role;

-- ② 发 backup-daily 的请求（定时任务、补跑、发布前触发共用）
create function private.backup_dispatch(p_mode text)
  returns int language plpgsql volatile set search_path = '' as $$
declare
  u record;
  n int := 0;
begin
  if p_mode is null or p_mode not in ('start', 'retry', 'publish') then
    raise exception 'backup_dispatch: bad mode' using errcode = '22023';
  end if;
  for u in select p.user_id from public.profiles p where private.account_usable(p.user_id) order by p.user_id loop
    perform net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/backup-daily',
      headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := jsonb_build_object('user_id', u.user_id, 'mode', p_mode), timeout_milliseconds := 30000);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function private.backup_dispatch(text) from public;

select cron.schedule('backup-daily', '30 15 * * *', $$select private.backup_dispatch('start')$$);          -- 00:30 首尔 = 15:30 UTC
select cron.schedule('backup-daily-retry', '30 17 * * *', $$select private.backup_dispatch('retry')$$);    -- 02:30 首尔 = 17:30 UTC

-- ③ 当天没做完备份的人数
create function private.backup_missing(p_date text)
  returns int language plpgsql stable security definer set search_path = '' as $$
declare
  n int;
begin
  if p_date is null or p_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'backup_missing: bad date' using errcode = '22023';
  end if;
  select count(*)::int into n
    from public.profiles p join auth.users u on u.id = p.user_id
   where private.account_usable(p.user_id)
     -- 真库 auth.users.created_at 没有默认值、可以为空（GoTrue 建号时自己写）：没写的也算该有备份，免得漏报（本机 lemo-e2e 实测）
     and (u.created_at is null or u.created_at < (p_date::date)::timestamp at time zone 'Asia/Seoul')
     and not exists (select 1 from storage.objects o
                      where o.bucket_id = 'backups' and o.name = p_date || '/' || p.user_id::text || '/_manifest.json.gz');
  return n;
end $$;
grant execute on function private.backup_missing(text) to service_role;
