-- B5 S13：anniv-roll 的定时任务（迁移 20261113181000，架构第 6 节 anniv-roll 行“cron，每天 00:10（UTC）”、0.38 第 46 条）
-- 照 12_account_purge_cron.test.sql：只看 cron.job 里登记的那一条（时刻、调哪个函数、带哪些请求头、值从哪里读、命令里没有写死的值），
-- 再核对纪念日开关已经打开（迁移 20261113182000，代定 D17）。真的调用要在本机 supabase start 后做，不在这里（离线 PGlite 没有 pg_net）。
begin;
select plan(9);
\ir _target.psql

select is((select count(*)::int from cron.job where jobname = 'anniv-roll'), 1, 'cron.job 里有且只有一条 anniv-roll');
select is((select schedule from cron.job where jobname = 'anniv-roll'), '10 0 * * *', '每天 00:10 UTC');
select ok((select command from cron.job where jobname = 'anniv-roll') like '%net.http_post(%'
          and (select command from cron.job where jobname = 'anniv-roll') like '%|| ''/anniv-roll''%',
  '经 net.http_post 调 <functions_url>/anniv-roll');
select ok((select command from cron.job where jobname = 'anniv-roll') like '%''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''cron_secret'')%',
  'x-cron-secret 的值运行时从 vault.decrypted_secrets 的 cron_secret 读');
select ok((select command from cron.job where jobname = 'anniv-roll') like '%(select decrypted_secret from vault.decrypted_secrets where name = ''functions_url'')%',
  '函数地址运行时从 vault.decrypted_secrets 的 functions_url 读');
select ok((select command from cron.job where jobname = 'anniv-roll') like '%''x-region'', ''ap-northeast-2''%',
  '带 x-region: ap-northeast-2（14.2 第 5 点）');
select ok((select command from cron.job where jobname = 'anniv-roll') like '%timeout_milliseconds := 55000%',
  '超时 55 秒（一轮最多 1000 行）');
select ok(not exists (
    select 1 from regexp_matches((select command from cron.job where jobname = 'anniv-roll'), '[A-Za-z0-9+/=_-]{32,}', 'g') as m(t)
     where m.t[1] ~ '[0-9]' and m.t[1] ~ '[A-Za-z]'),
  '命令里没有写死的长串（迁移不写值）');
select is((select features -> 'anniv' ->> 'on' from public.app_config where id = 1), 'true', '纪念日开关已打开（D17）');

select * from finish();
rollback;
