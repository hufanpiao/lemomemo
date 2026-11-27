-- R-495 AI 助手第 3 段：长期记忆（“记住的事”）。负责人 11-22：“长期记忆要一直保留，就算更换了ai记忆依然在”；11-23 弹窗：新表先只上预览库，正式库上线前再问。
-- private.ai_memories：存在柠檬记自己的库里，只有文字，不带任何服务商的字段（换服务商不用重算）。
-- • 放 private：不同步、不进 outbox、不进本机库；前端只经函数 ai-memory 看和删，ai-chat 读和写。两边都经 fn_ai（withAiUser），策略只放 app.uid 本人的行。
-- • 账号注销随 auth.users 级联删。
-- • text ≤ 200 字；norm 是判重键：转小写，去空白和一般标点，保留数字字母之间的 . - / 和紧跟的 + #（_shared/memories.ts 的 normMemory），同一个人没删的行 norm 不重复。
-- • 改写：旧行软删、新内容另插一行（撤销能换回旧文字）；ai_memories_user_deleted 给“记忆版本”读软删的行用。
-- • 每人最多 5000 条，只防滥用（负责人 11-23“基本不限+按问题找”；函数写入时在同一事务里先锁再数，_shared/memories.ts）。
-- • grams：检索词条（_shared/memories.ts 的 memoryTerms），中韩日按字符二元组、其他文字按整词；回答时按这一问在库里找旧记忆，不把整表读进函数。
--   11-23 在 lemo-e2e 实测：pg_trgm、simple 全文对中韩短句都命中不了，二元组都命中，所以不加扩展。
--   不建 GIN：&& 不是 leakproof，fn_ai 过 RLS 时用不上；查询走 user_id 索引收窄到本人（最多 5000 行）再算分、LIMIT。
-- • deleted_at：单条“删除”后留着等撤销；定时任务 ai-memories-expire 每天把删了超过 1 天的真删掉。“全部清空”直接真删。
-- • 隐私记：写入只收用户这一句原话里的内容（_shared/memories.ts 的 checkMemory），ai-chat 又查不到隐私记，这张表不会有隐私记内容。
-- 回滚：select cron.unschedule('ai-memories-expire'); drop table private.ai_memories;
create table private.ai_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 200),
  norm text not null check (char_length(norm) between 1 and 200),
  source text not null default 'chat' check (source = 'chat'),
  grams text[] not null default '{}' check (cardinality(grams) <= 200),
  created_at bigint not null,
  updated_at bigint not null,
  deleted_at bigint
);
create unique index ai_memories_user_norm on private.ai_memories (user_id, norm) where deleted_at is null;
create index ai_memories_user_updated on private.ai_memories (user_id, updated_at desc, id desc) where deleted_at is null;
create index ai_memories_deleted on private.ai_memories (deleted_at) where deleted_at is not null;
create index ai_memories_user_deleted on private.ai_memories (user_id, deleted_at desc) where deleted_at is not null;
revoke all on private.ai_memories from public, anon, authenticated;

alter table private.ai_memories enable row level security;
create policy fn_own on private.ai_memories for all to fn_ai
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select, insert, update, delete on private.ai_memories to fn_ai;   -- R-495  ai-chat 读和记、ai-memory 看和删（策略只放本人的行）
grant select on private.ai_memories to service_role;   -- R-495  只给 account 把本人没删的记忆放进账号导出，不给写

select cron.schedule('ai-memories-expire', '10 19 * * *',
  $$set statement_timeout = '4min'; delete from private.ai_memories where deleted_at < (extract(epoch from now()) * 1000)::bigint - 86400000$$);
