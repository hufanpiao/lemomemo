-- 20261115050000_ai_summarize_fn_ai_reads.sql：给 fn_ai 补读 events、todos、notes 的几列（B4b-3 ai-summarize；架构 5.14 第 4 点、6.2 fn_ai 一行）。
-- 为什么：ai-summarize 按 id 读本人的日程、待办、随手记送去总结，要“标题、时间、正文”，还要排除撤销的行；
--   0002、0003 只给了 fn_ai（ai-embed 算向量用的）title、note、location、body、is_private、deleted_at，没有日子、时刻、完成、撤销、创建时间。
-- 做法：只加列级 select；fn_own / fn_own_ai 策略照旧只放本人的行（app.uid，ai-summarize/index.ts 经 _shared/db.ts 的 withAiUser 设好）。
--   events：date、time、tz、undone（tz：日程的日子时刻按记的时区换算到用户时区，评审第 16 条）；todos：due、due_time、done、undone；notes：created_at、undone。
-- 同步改的地方：build/d1/whitelist.ts 的 COLUMN_GRANTS.fn_ai、架构附录 A 末尾的逐表清单（0002 events、todos，0003 notes 三行）；D1 比对。
-- pgTAP：supabase/tests/rls/59_ai_summarize_fn_ai_reads.test.sql。
-- 回滚：revoke select (date, time, tz, undone) on public.events from fn_ai; revoke select (due, due_time, done, undone) on public.todos from fn_ai;
--       revoke select (created_at, undone) on public.notes from fn_ai;（回滚后 ai-summarize 读库报错，一律 503）
grant select (date, time, tz, undone) on public.events to fn_ai;          -- B4b-3  ai-summarize 送日子、时刻（按记的时区换算），排除撤销的
grant select (due, due_time, done, undone) on public.todos to fn_ai;      -- B4b-3  ai-summarize 送截止日子、时刻、做没做完，排除撤销的
grant select (created_at, undone) on public.notes to fn_ai;               -- B4b-3  ai-summarize 送写下的时间，排除撤销的
