-- 20261124140000_notice_web_naver.sql：同意版本升到 2026-11-25，所有人重新看一遍“隐私说明更新了”那一屏再继续。
-- 为什么：联网搜索改成几家同时搜（DeepSeek + Brave + Naver，不行时 Tavily），搜索词多交给一家新的第三方 Naver（迁移 20261124130000）；
--   负责人 11-25 选“改，让用户重新同意一次”。同意页 consent.update.lead、官网隐私说明（中韩）同一次提交改。
-- 做法：照 20261123090000 第 ④ 条（R-494）的合并写法，只换 notice 的 policy_ver、min_consent_ver 两个键，notice 里别的键照留；notice 为 null 时当空对象。
--   重新同意之前 AI 一条都不送（_shared/consent.ts 第 ② 条，前端 notice-seen.ts 显示更新那一屏）。不建表、不动别的。
-- pgTAP：supabase/tests/rls/15_settings_ai_guard.test.sql、20_notice_ver_order.test.sql 的期望值同步改成 2026-11-25。
-- 回滚：两个键改回 2026-11-23（已经按 2026-11-25 同意的人不受影响：版本只比大小）。
update public.app_config
   set notice = coalesce(notice, '{}'::jsonb) || jsonb_build_object('policy_ver', '2026-11-25', 'min_consent_ver', '2026-11-25')
 where id = 1;
