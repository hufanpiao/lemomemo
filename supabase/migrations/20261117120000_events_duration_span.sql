-- 20261117120000_events_duration_span.sql：R-444 跨天日程（负责人 11-17“日程只有开始，没有结束时间，这样的话跨天数的日程怎么办？”“跨时间日程功能做一下”）。
-- 数据做法：不加列，沿用 events.duration_min，上限从 1440（1 天）放宽到 44640（31 天）——
--   有时刻的日程：结束 = 开始 + duration_min（实际经过的分钟），可跨多天；
--   全天日程：按“天数 × 1440”记跨几天（≤ 1440 都算一天，旧行、默认的 60 照旧是一天），客户端 shared/logic/calendar/event-span.ts 的 allDaySpanDays。
--   为什么不加 end_date / end_time 列：开始 + 时长已经能表达任何结束时刻，加列就要多一套“结束不早于开始”“和时长谁说了算”的约束、
--   列级授权、touch() 列名单、apply_patch 白名单、zod、导出和旧版兼容；放宽一个上限只改这一条约束，旧版客户端照样读写（读到超过 1 天的按它自己的规则显示）。
--   上限 31 天：一个月的出差、假期装得下；月历最多 6 周、周视图 7 天，客户端按开始日往前预筛 31 天就够（shared/schema/rows.ts 的 EVENT_DURATION_MAX 同一个数）。
-- 本迁移做的事：events_duration_min_check 从 between 1 and 1440 换成 between 1 and 44640。
-- 不用改的：apply_patch（20261116090000 最新一版）、intake_insert 只按列名白名单放行，数值范围靠表约束，duration_min 早就在白名单里；
--   提醒（remind_at、enqueue_remind）只看 date、time、tz、remind_min、remind_days，和时长无关；touch()、RLS、列级授权都不动。
-- 锁：整个迁移在一个事务里，drop constraint 一开始就拿 events 的 ACCESS EXCLUSIVE 锁、持有到提交，“先 not valid 再 validate”在同一事务里省不了锁，
--   所以直接一步 add check（放宽上限，已有行都合格，扫一遍 events 很快：每人几千行）。5 秒拿不到锁就整个迁移回滚，等长事务结束再推。
-- 上线顺序：本迁移先上，再发前端和 edge function（claude-intake 的 capture-map 会写超过 1440 的全天时长）；反过来新客户端写的跨天日程会被库拒。
-- 旧版客户端（本迁移之后还没升级的）的行为，已知、接受：
--   • 旧版今天页：时长超过 1440 的按 1 小时显示；旧版日历按它自己的规则显示，跨天的那几天不一定都画出来；
--   • 旧版编辑页打开跨天日程、改一下结束时刻，会按“当天结束时刻 − 开始”重算时长写回，跨天日程被截短成一天以内（升级后照常）。
set local lock_timeout = '5s';

alter table public.events drop constraint events_duration_min_check;
alter table public.events add constraint events_duration_min_check check (duration_min between 1 and 44640);
