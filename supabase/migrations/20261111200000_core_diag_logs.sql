-- 诊断日志一键发送（R-398，架构 0.63；负责人 11-11：“日志要一键发送，不要贴来贴去”；批了 diag_logs 表）
-- • 非正式版设置页“Send run log”把全局运行日志（src/platform/run-log.ts，不含用户输入的文字）整段写进来，主持人在 SQL 编辑器里读
-- • 每人一行（主键 user_id），新发的覆盖旧的：不要额度触发器、不建 private 函数，不归架构 3.3 C 管
-- • 不复用 public.logs：那是用户看得到、会进账号导出的操作记录，每格 ≤ 640 字，放不下 30 万字的整段日志
-- • 覆盖用 insert … on conflict (user_id) do update，PostgreSQL 要求能读到旧行，所以本人可以读自己这一行
-- • 7 天前的每天 19:00 UTC 删掉（纯 SQL，不调函数、不带密钥）
create table public.diag_logs (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  sent_at timestamptz not null default now(),
  app_version text check (char_length(app_version) <= 64),
  body text not null check (char_length(body) <= 300000));

alter table public.diag_logs enable row level security;
create policy sel on public.diag_logs for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.diag_logs for insert to authenticated with check (user_id = (select auth.uid()) and private.is_active());
create policy upd on public.diag_logs for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active()) with check (user_id = (select auth.uid()));
revoke all on public.diag_logs from anon, authenticated;
grant select on public.diag_logs to authenticated;
grant insert (sent_at, app_version, body) on public.diag_logs to authenticated;
grant update (sent_at, app_version, body) on public.diag_logs to authenticated;

select cron.schedule('diag-logs-expire', '0 19 * * *',
  $$set statement_timeout = '4min'; delete from public.diag_logs where sent_at < now() - interval '7 days'$$);
