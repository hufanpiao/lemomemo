-- B1 PURGE-cpu-budget 返工：account-purge 的补跑任务（迁移 20261104120000）。
-- 只看 cron.job 里登记的三条补跑：三条的时刻（合起来是 03:45～05:30 首尔每 15 分钟）、命令和 03:30 那一条一字不差、命令里没有写死的值。
-- 03:30 那一条本身在 rls/12；真的调用（pg_net 发出请求、函数回 200 写心跳）在本机 supabase start 后做（PURGE-cpu-budget 执行记录）。
begin;
select plan(4);
\ir _target.psql

select is((select count(*)::int from cron.job where jobname like 'account-purge-catchup-%'), 3, 'cron.job 里有三条 account-purge 补跑');
select is((select array_agg(schedule order by jobname) from cron.job where jobname like 'account-purge-catchup-%'),
  array['45 18 * * *', '*/15 19 * * *', '0,15,30 20 * * *'], '补跑时刻：UTC 18:45；19:00～19:45 每 15 分钟；20:00、20:15、20:30');
select is((select count(distinct command)::int from cron.job where jobname like 'account-purge%'), 1,
  '三条补跑的命令和 03:30 那一条 account-purge 一字不差');
select ok(not exists (
    select 1 from cron.job j, regexp_matches(j.command, '[A-Za-z0-9+/=_-]{32,}', 'g') as m(t)
     where j.jobname like 'account-purge-catchup-%' and m.t[1] ~ '[0-9]' and m.t[1] ~ '[A-Za-z]'),
  '命令里没有写死的长串（迁移不写值）');

select * from finish();
rollback;
