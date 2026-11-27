-- 20261122090000_ai_chat_fn_ai_anniv.sql：AI 助手对话的库对象（R-492 AI 助手第 1 段；实施计划第二节；负责人 11-22“AI 不查隐私记”“能查日程、待办、随手记、纪念日”）。
-- 一、纪念日：ai-chat 的只读工具 list_anniversaries 要按“下一次的日子”查本人的生日、纪念日、倒数日；0005 只给了 authenticated 和 service_role，
--   fn_ai 一列都读不到、也没有策略。只加 ai-chat/store.ts 的 ANNIV_SQL 用到的列级 select，加一条会话变量版策略 fn_own（同 0002 的 events、todos 写法），
--   只放本人的行；不给 insert、update、delete，不给头像、提醒、农历变体、闰月、年份那几列。
-- 二、随手记：ai-chat 不直接读 public.notes，只读视图 private.ai_chat_notes。视图定义里写死 not is_private、没删没撤销、只含 app.uid 本人的行，
--   security_barrier（外面的条件不会先于视图里的条件跑，带副作用的函数也套不出隐私记）；视图属主是迁移的执行者（绕过 notes 的 RLS），
--   所以本人过滤写在视图里，没设 app.uid 一行都读不到。fn_ai 对 notes 原有的列级 select（ai-embed、note-search、ai-summarize 要用）不动；
--   ai-chat 的查询只经这个视图（store.ts 的 NOTES_SQL），隐私记挡在库这一层，不靠函数里的一句 where。
-- 三、功能开关 chat：AI 助手自己的开关（门第 ② 步之后判断，wire.ts 的 chatGateDeps），这里打开（建表文件 0001～0007 不准开开关，check_backend M3）。
-- 同步改的地方：build/d1/whitelist.ts（TABLE_GRANTS.fn_ai 的视图、COLUMN_GRANTS.fn_ai 的纪念日列）、shared/db.types.ts（private 的 Views）、
--   架构附录 A 末尾的逐表清单；D1 比对；tests/data-manifest/grant-matrix.test.ts。
-- 测试：supabase/tests/rls/70_ai_chat_fn_ai_reads.test.sql（授权形状、RLS）；tests/data-manifest/ai-chat-store.test.ts（store.ts 的四句真 SQL 以 fn_ai 跑）。
-- 回滚：drop view private.ai_chat_notes;
--       drop policy fn_own on public.anniversaries;
--       revoke select (id, user_id, kind, name, calendar, month, day, next_date, note, deleted_at, undone, archived_at) on public.anniversaries from fn_ai;
--       update public.app_config set features = features - 'chat' where id = 1;
--       （回滚后 ai-chat 门第 ② 步回 feature_off，前端出“没问到”）
grant select (id, user_id, kind, name, calendar, month, day, next_date, note, deleted_at, undone, archived_at)
  on public.anniversaries to fn_ai;   -- R-492  ai-chat 查接下来要到的生日、纪念日、倒数日
create policy fn_own on public.anniversaries for select to fn_ai using (user_id = nullif(current_setting('app.uid', true), '')::uuid);

create view private.ai_chat_notes with (security_barrier = true) as
  select id, user_id, title, body, created_at from public.notes
   where not is_private and deleted_at is null and not undone
     and user_id = nullif(current_setting('app.uid', true), '')::uuid;
revoke all on private.ai_chat_notes from public, anon, authenticated;
grant select on private.ai_chat_notes to fn_ai;   -- R-492  ai-chat 查随手记只经这个视图（不含隐私记）

update public.app_config set features = jsonb_set(features, '{chat}', '{"on": true}') where id = 1;   -- R-492  AI 助手开关
