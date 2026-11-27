-- B1 迁移（R-259，安全）：客户端不能往 logs 里写 src = 'account' 的行
-- 漏洞在 0001_core.sql 第 12 节（logs）：ins 策略只要求 user_id = 本人 and private.is_active()，
--   又给 authenticated 授了 src、act、code、t、device 等列的 insert 权限，
--   于是客户端能自己写 src = 'account'、act = 'export' 的行，冒充 account 函数记的“导出”。
--   “设置 › 账号 › 最近的导出”（src/features/settings/data/recent-exports.ts）靠这些行判断是不是本人导出的，伪造的行会让它失效。
-- 做法：以原策略为底、原有条件一条不改，只加 src is distinct from 'account'
--   （is distinct from：src 为 null 的行照常能写；客户端的 LogRow 本来就不带 src，见 shared/core/log-row.ts）。
-- account 函数经 service role 写这两种行（act = export、export_mail_failed），service role 绕过 RLS，不受影响。
-- 只改策略，列级授权不变（不收回 src 列的 insert 权限：别的 src 照常能写）。测试：supabase/tests/rls/19_logs_account_src.test.sql
alter policy ins on public.logs
  with check (user_id = (select auth.uid()) and private.is_active() and src is distinct from 'account');
