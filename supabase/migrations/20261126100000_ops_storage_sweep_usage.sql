-- 20261126100000_ops_storage_sweep_usage.sql：B7a 上线前的文件清理和用量盯防（接手清单 P-b4-sweep-gate、P-b4-quota-sweep；架构 3.4、6.1、第 6 节
-- storage-sweep、usage-report 两行；1.3 B7a“usage-report 能报 R2 用量和两条告警线”“出网盯防”）。
-- ① storage-sweep 的定时任务：每天 17:30 UTC（首尔 02:30）调一次，03:00 的 SQL 清理删行之前先删对象（架构 3.4）。
--    照 20261113181000_anniv_roll_cron.sql 的写法：带 x-cron-secret、x-region；functions_url、cron_secret 在数据库 Vault，任务的 SQL 每次运行时读，
--    迁移里不写任何值；命令只经 pg_net 调函数、不直接碰表（D1 的 CRON_WITHOUT_USABLE 不用登记）；URL 写成 check_backend F9 认得出的
--    … 'functions_url') || '/storage-sweep'，config.toml 的 [functions.storage-sweep] verify_jwt = false 由 F9 ① 核对。
--    timeout_milliseconds := 150000：函数一轮最多跑 100 秒（storage-sweep/core.ts 的 TIME_BUDGET_MS），pg_net 多等一些再放手。
-- ② storage-sweep 读“我的头像”（R-384，<user_id>/me/<avatar_id>.webp）要 profiles 的 user_id、avatar_id：登记一行列级授权
--    （同 0003、0004、0005 的三行：Supabase 默认已给 service_role public 全表权限，这里只作登记和 3.3 C 核对）。
-- ③ private.usage_stats(p_days text[], p_export_cap int)：usage-report {part: usage} 一次读回数据库这边的数（只回个数和字节数，不回任何 user_id）：
--    db_bytes        pg_database_size（对免费版 500 MB）；
--    vectors_bytes   private.note_vectors 的表加索引大小（架构第 6 节 usage-report 行“单列 note_vectors 的大小”）；
--    storage_bytes   storage.objects 里各桶 metadata.size 合计（Supabase 文件存储，0.32 起只剩 backups、vault-preview 和管理员的 mascot-private；对 1 GB）；
--    media_max_pct   各账号已用存储 ÷ 自己的上限的最大百分比（向下取整；不设上限的人不算；上限为 0 时有用量算 100）；
--    media_near_full 到自己上限 90% 的账号个数（3.4 ③“每人到自己上限 90% 发邮件”）；
--    export_capped   p_days（UTC 日期 yyyymmdd）里任何一天 export-part 计数到 p_export_cap 的账号个数（0.47 第 19 条 Q6：某个账号当天分片到上限）。
--    已用、上限沿用 private.media_used、private.media_limit_bytes（20261111100000、20261115080000，和写行触发器、my_ai_usage 同一口径）。
--    security definer（要读 storage.objects 和 private 表）、stable、search_path 置空；只给 service_role 执行。
-- 授权行同步进架构 3.3 C 和附录 A（M4 逐行比对）、build/d1/whitelist.ts 的 FUNCTION_EXEC.service_role。
-- pgTAP：supabase/tests/rls/76_storage_sweep_usage.test.sql。
-- 回滚：select cron.unschedule('storage-sweep'); drop function private.usage_stats(text[], int); revoke select (user_id, avatar_id) on public.profiles from service_role;

-- ① 定时任务
select cron.schedule('storage-sweep', '30 17 * * *',
  $$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/storage-sweep',
      headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{}'::jsonb, timeout_milliseconds := 150000)$$);

-- ② 我的头像的定位列
grant select (user_id, avatar_id) on public.profiles to service_role;

-- ③ 用量统计
create function private.usage_stats(p_days text[], p_export_cap int)
  returns table (db_bytes bigint, vectors_bytes bigint, storage_bytes bigint, media_max_pct int, media_near_full int, export_capped int)
  language sql stable security definer set search_path = '' as $$
  with m as (
    select private.media_used(p.user_id, null) as used, private.media_limit_bytes(p.user_id) as cap
      from public.profiles p
  )
  select
    pg_catalog.pg_database_size(pg_catalog.current_database()),
    pg_catalog.pg_total_relation_size('private.note_vectors'::regclass),
    (select coalesce(sum(case when (o.metadata ->> 'size') ~ '^[0-9]{1,18}$' then (o.metadata ->> 'size')::bigint else 0 end), 0)::bigint
       from storage.objects o),
    (select coalesce(max(case when m.cap = 0 then (case when m.used > 0 then 100 else 0 end)
                              else floor(m.used * 100.0 / m.cap)::int end), 0)::int
       from m where m.cap is not null),
    (select count(*)::int from m where m.cap is not null and m.used > 0 and m.used * 10 >= m.cap * 9),
    (select count(distinct split_part(c.key, ':', 2))::int from private.counters c
       where c.key like 'export-part:%' and split_part(c.key, ':', 3) = any (p_days) and c.count >= p_export_cap)
$$;
grant execute on function private.usage_stats(text[], int) to service_role;
