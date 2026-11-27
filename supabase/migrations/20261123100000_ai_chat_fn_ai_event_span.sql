-- 20261123100000_ai_chat_fn_ai_event_span.sql：给 fn_ai 补读 events.duration_min（R-492 AI 助手；负责人 11-23 弹窗“跨天日程”）。
-- 为什么：ai-chat 的 find_events（supabase/functions/ai-chat/store.ts 的 EVENTS_SQL）原来只按 date 落在查询范围里筛，
--   前一天（或更早）开始、跨进查询起始日的日程（R-444 跨天日程：结束 = 开始 + duration_min）查不出来；判断重叠要读 duration_min。
-- 做法：只加一列的列级 select；fn_own 策略照旧只放本人的行（app.uid，ai-chat/index.ts 经 _shared/db.ts 的 withAiUser 设好），不加表级 select、不能写。
-- 同步改的地方：build/d1/whitelist.ts 的 COLUMN_GRANTS.fn_ai（public.events:SELECT 加 duration_min）、架构附录 A 末尾逐表清单 0002 events 一行；D1 比对。
-- pgTAP：supabase/tests/rls/72_ai_chat_fn_ai_event_span.test.sql；真 SQL 以 fn_ai 跑：tests/data-manifest/ai-chat-store.test.ts。
-- 回滚：revoke select (duration_min) on public.events from fn_ai;（回滚前先把 EVENTS_SQL 改回只按 date 筛，不然 find_events 读库报错，交回模型 {error: 'store'}）
grant select (duration_min) on public.events to fn_ai;   -- R-492 ai-chat 按 date + time + duration_min 算日程和查询范围重不重叠（跨天日程）
