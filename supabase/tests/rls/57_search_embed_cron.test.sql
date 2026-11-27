-- B4b-2：ai-embed 的定时任务（迁移 20261115020000，架构第 6 节 ai-embed 行“cron，每 2 分钟一次”）
-- 照 50_anniv_roll_cron.test.sql：只看 cron.job 里登记的那一条（频率、调哪个函数、带哪些请求头、值从哪里读、命令里没有写死的值）。
-- 真的调用要在本机 supabase start 后做，不在这里（离线 PGlite 没有 pg_net）。
begin;
select plan(8);
\ir _target.psql

select is((select count(*)::int from cron.job where jobname = 'ai-embed'), 1, 'cron.job 里有且只有一条 ai-embed');
select is((select schedule from cron.job where jobname = 'ai-embed'), '*/2 * * * *', '每 2 分钟一次');
select ok((select command from cron.job where jobname = 'ai-embed') like '%net.http_post(%'
          and (select command from cron.job where jobname = 'ai-embed') like '%|| ''/ai-embed''%',
  '经 net.http_post 调 <functions_url>/ai-embed');
select ok((select command from cron.job where jobname = 'ai-embed') like '%''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''cron_secret'')%',
  'x-cron-secret 的值运行时从 vault.decrypted_secrets 的 cron_secret 读');
select ok((select command from cron.job where jobname = 'ai-embed') like '%(select decrypted_secret from vault.decrypted_secrets where name = ''functions_url'')%',
  '函数地址运行时从 vault.decrypted_secrets 的 functions_url 读');
select ok((select command from cron.job where jobname = 'ai-embed') like '%''x-region'', ''ap-northeast-2''%',
  '带 x-region: ap-northeast-2（14.2 第 5 点）');
select ok((select command from cron.job where jobname = 'ai-embed') like '%timeout_milliseconds := 55000%',
  '超时 55 秒（一轮最多 20 个人）');
select ok(not exists (
    select 1 from regexp_matches((select command from cron.job where jobname = 'ai-embed'), '[A-Za-z0-9+/=_-]{32,}', 'g') as m(t)
     where m.t[1] ~ '[0-9]' and m.t[1] ~ '[A-Za-z]'),
  '命令里没有写死的长串（迁移不写值）');

select * from finish();
rollback;
