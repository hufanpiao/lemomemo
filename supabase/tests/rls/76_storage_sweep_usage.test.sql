-- B7a 迁移 20261126100000_ops_storage_sweep_usage.sql：storage-sweep 的定时任务、profiles 定位列的登记、private.usage_stats。
-- usage-report 那一半（index.ts 接 rpc、各项算百分比）在 tests/functions/usage-report-usage.test.ts，storage-sweep 的判断在 tests/functions/storage-sweep.test.ts。
-- 真库上可能已有别的数据：计数一律和开头的基数比差值；日期用 20000101 这种不会有真数据的日子。
begin;
select plan(17);
\ir _helpers.psql
select tests.seed();

-- ① 定时任务（照 50_anniv_roll_cron 的口径）
select is((select count(*)::int from cron.job where jobname = 'storage-sweep'), 1, 'cron.job 里有且只有一条 storage-sweep');
select is((select schedule from cron.job where jobname = 'storage-sweep'), '30 17 * * *', '每天 17:30 UTC（首尔 02:30），在 03:00 的删行之前');
select ok((select command from cron.job where jobname = 'storage-sweep') like '%net.http_post(%'
          and (select command from cron.job where jobname = 'storage-sweep') like '%|| ''/storage-sweep''%',
  '经 net.http_post 调 <functions_url>/storage-sweep');
select ok((select command from cron.job where jobname = 'storage-sweep') like '%''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''cron_secret'')%',
  'x-cron-secret 每次从 Vault 读');
select ok((select command from cron.job where jobname = 'storage-sweep') like '%timeout_milliseconds := 150000%', 'pg_net 等 150 秒');
select ok(not exists (
    select 1 from regexp_matches((select command from cron.job where jobname = 'storage-sweep'), '[A-Za-z0-9+/=_-]{32,}', 'g') as m(t)
  ), '命令里没有写死的长串（密钥只在 Vault）');

-- ② usage_stats 只给 service_role
select ok(not has_function_privilege('anon', 'private.usage_stats(text[], int)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.usage_stats(text[], int)', 'EXECUTE')
          and has_function_privilege('service_role', 'private.usage_stats(text[], int)', 'EXECUTE'), 'usage_stats 只给 service_role');
select is((select p.prosecdef and p.provolatile = 's' and pg_get_userbyid(p.proowner) = 'postgres'
          and p.proconfig = array['search_path=""']
   from pg_proc p where p.oid = 'private.usage_stats(text[], int)'::regprocedure), true,
  'usage_stats：security definer、stable、search_path 置空、属主 postgres');
select is(pg_get_function_result('private.usage_stats(text[], int)'::regprocedure),
  'TABLE(db_bytes bigint, vectors_bytes bigint, storage_bytes bigint, media_max_pct integer, media_near_full integer, export_capped integer)',
  '返回一行六个数（usage-report 的 index.ts 按这个读），没有任何 user_id 列');

create temp table base as select * from private.usage_stats(array['20000101'], 72);
create temp table base3 as select * from private.usage_stats(array['20000101', '20000102', '20000103'], 72);
select ok((select db_bytes > 0 and vectors_bytes >= 0 from base), '库大小大于 0，向量表大小不是负数');

-- ③ Supabase 文件存储：metadata.size 合计；size 不是数字的按 0
insert into storage.objects (bucket_id, name, metadata) values
  ('backups', '2000-01-01/aaaaaaaa-0000-4000-8000-000000000001/usage-probe.json.gz', '{"size": 12345}'),
  ('backups', '2000-01-01/aaaaaaaa-0000-4000-8000-000000000001/usage-probe-bad.json.gz', '{"size": "abc"}');
select is((select storage_bytes from private.usage_stats(array['20000101'], 72)) - (select storage_bytes from base), 12345::bigint,
  'storage_bytes 加上 12345，size 不是数字的那个不算');

-- ④ 每人存储：A 的上限设成 1 MB，插一张 1,000,000 字节的图（约 95%）
insert into private.user_limits (user_id, media_mb) values ('aaaaaaaa-0000-4000-8000-000000000001', 1)
  on conflict (user_id) do update set media_mb = 1;
insert into public.notes (id, user_id, body, created_at, updated_at) values
  ('75000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'n', 1, 1);
insert into public.note_images (id, user_id, note_id, bucket, path, bytes, has_thumb) values
  ('75000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001', '75000000-0000-4000-8000-0000000000a1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/75000000-0000-4000-8000-0000000000a1/75000000-0000-4000-8000-0000000000c1.webp', 1000000, false);
select ok((select media_max_pct from private.usage_stats(array['20000101'], 72)) >= 95, 'media_max_pct 至少 95（1,000,000 ÷ 1,048,576 向下取整）');
select is((select media_near_full from private.usage_stats(array['20000101'], 72)) - (select media_near_full from base), 1,
  '到上限 90% 的人多了 A 一个');
-- 不设上限（media_mb 为 null）的人不算
update private.user_limits set media_mb = null where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is((select media_near_full from private.usage_stats(array['20000101'], 72)) - (select media_near_full from base), 0,
  'media_mb 为 null（不设上限）时不算到 90%');

-- ⑤ 导出分片到上限：只数 p_days 里那几天、计数到 p_export_cap 的人；同一人两天都到只算一个
insert into private.counters (key, window_start, count) values
  ('export-part:aaaaaaaa-0000-4000-8000-000000000001:20000101', now(), 72),
  ('export-part:aaaaaaaa-0000-4000-8000-000000000001:20000102', now(), 72),
  ('export-part:bbbbbbbb-0000-4000-8000-000000000002:20000101', now(), 71),
  ('export-part:cccccccc-0000-4000-8000-000000000003:20000103', now(), 72),
  ('account:bbbbbbbb-0000-4000-8000-000000000002:20000101', now(), 99);
select is((select export_capped from private.usage_stats(array['20000101'], 72)) - (select export_capped from base), 1,
  '20000101 到 72 的只有 A（B 是 71，别的用途的键不算）');
select is((select export_capped from private.usage_stats(array['20000101', '20000102', '20000103'], 72)) - (select export_capped from base3), 2,
  '三天合起来：A 只算一次，加上 C');

-- ⑥ storage-sweep 读我的头像的两列（登记的列级授权在 service_role 上）
select ok(has_column_privilege('service_role', 'public.profiles', 'avatar_id', 'SELECT')
          and has_column_privilege('service_role', 'public.profiles', 'user_id', 'SELECT'), 'service_role 能读 profiles 的 user_id、avatar_id');

select * from finish();
rollback;
