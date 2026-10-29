-- B1 K3：account-purge 的定时任务（迁移 20261029171000，架构第 6 节“pg_cron 怎么带 CRON_SECRET 调函数”，0.38 第 46 条）
-- 只看 cron.job 里登记的那一条：时刻、调哪个函数、带哪些请求头、值从哪里读、命令里没有写死的值。
-- 真的调用（pg_net 发出请求、函数回 200 写心跳）要在本机 supabase start 加 seed.sql 后做，不在这里（离线 PGlite 没有 pg_net）。
begin;
select plan(7);

select is((select count(*)::int from cron.job where jobname = 'account-purge'), 1, 'cron.job 里有且只有一条 account-purge');
select is((select schedule from cron.job where jobname = 'account-purge'), '30 18 * * *', '每天 18:30 UTC = 03:30 首尔');
select ok((select command from cron.job where jobname = 'account-purge') like '%net.http_post(%'
          and (select command from cron.job where jobname = 'account-purge') like '%|| ''/account-purge''%',
  '经 net.http_post 调 <functions_url>/account-purge');
select ok((select command from cron.job where jobname = 'account-purge') like '%''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''cron_secret'')%',
  'x-cron-secret 的值运行时从 vault.decrypted_secrets 的 cron_secret 读');
select ok((select command from cron.job where jobname = 'account-purge') like '%(select decrypted_secret from vault.decrypted_secrets where name = ''functions_url'')%',
  '函数地址运行时从 vault.decrypted_secrets 的 functions_url 读');
select ok((select command from cron.job where jobname = 'account-purge') like '%''x-region'', ''ap-northeast-2''%',
  '带 x-region: ap-northeast-2（14.2 第 5 点）');
-- 命令里没有像密钥的长串（连续 32 个以上的 base64 / 十六进制字符、同时有字母和数字；D1 有同一条核对）
select ok(not exists (
    select 1 from regexp_matches((select command from cron.job where jobname = 'account-purge'), '[A-Za-z0-9+/=_-]{32,}', 'g') as m(t)
     where m.t[1] ~ '[0-9]' and m.t[1] ~ '[A-Za-z]'),
  '命令里没有写死的长串（迁移不写值）');

select * from finish();
rollback;
