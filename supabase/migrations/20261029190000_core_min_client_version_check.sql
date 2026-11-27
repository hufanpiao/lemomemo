-- B1 K10（接手清单 K10-min-db，K10 安全审查低优先级 ②）：收紧 app_config.min_client_version 的格式约束。
-- • 0001_core.sql 建表时写的是 check (min_client_version ~ '^\d+\.\d+\.\d+$')，允许每段 7 位以上；
--   两道版本门（functions/sb/version-gate.ts、supabase/functions/_shared/version-gate-core.ts）只认每段 1～6 位的 ASCII 数字，
--   超长的值会被当成“格式不对”而放行所有人（0.27 第 1 点：读失败或格式不对放行）。这里把约束收紧到和版本门一致。
-- • 用 [0-9] 不用 \d（K10-min-db 复审）：Postgres 正则的 \d 在 ICU 排序规则下可能认全角等非 ASCII 数字，JS 版本门的 \d 只认 0～9。
-- • 负责人在控制台手改 min_client_version（架构 8.3）也受这条约束管，写错直接报 23514，不会悄悄放行所有人。
-- • 先确认现有值能通过：不通过就带着原因停下（add constraint 本身也会校验现有行，这里先报一个看得懂的错）。
--   这段 DO 块的失败路径在 supabase/tests/rls/13_min_client_version.test.sql 里照抄一份测（改这里要同步改那里）。
-- • app_config 只有一行，锁很短；仍设 lock_timeout，万一有长事务占着表就 5 秒内失败，不把后面的请求排成长队。
-- • 约束名沿用建表时 Postgres 起的默认名 app_config_min_client_version_check；新约束同名。

set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.app_config
             where min_client_version is not null and min_client_version !~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$') then
    raise exception 'app_config.min_client_version 现有的值不是每段 1～6 位的三段数字，先改对再跑这条迁移';
  end if;
end $$;

alter table public.app_config drop constraint app_config_min_client_version_check;
alter table public.app_config add constraint app_config_min_client_version_check
  check (min_client_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$');
