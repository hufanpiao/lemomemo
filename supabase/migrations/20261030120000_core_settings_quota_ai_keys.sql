-- 20261030120000_core_settings_quota_ai_keys.sql：settings 的行数配额不再拦 ai.enabled、ai.vault 两个键（R-271；接手清单 SEC-210000-sugg ⑧）
-- 只重建 public.settings 上的 settings_quota 触发器，加 WHEN 条件；private.row_quota() 的函数体、别的表的配额触发器一律不动。
--
-- 为什么撤回同意必须不受配额限制：
--   record_consent(ver, true)（撤回 AI 同意）在 record_consent_impl 里 insert … on conflict 写 settings 的 ai.enabled = false。
--   0001 的 settings_quota 是 before insert 触发器，每人 settings 满 2 万行（row_quota，含还没被每日清理的软删行）就抛 quota，
--   整个调用回滚：profiles.consent_ai_at 仍是“已同意”，向量和重算队列也不删（0.29 P-13）。而同意分支不写 settings，满额时照样成功——
--   能同意、不能撤回。个人信息保护法（PIPA）和 GDPR 都要求撤回同意和给出同意一样容易，撤回不能被一个和它无关的行数上限挡住。
--   正常账号离 2 万行差得很远（固定键二十来个，按安装存的 layout.* 有清理），能碰到的是直接调 REST 刷键或客户端 bug 循环写新键；
--   概率小，但撤回属于“必须永远做得到”的操作，不靠概率。10-30 离线 PGlite 实测：改之前满额撤回回 P0001 quota，改之后成功。
--
-- 为什么不按 ai.* 前缀放宽：
--   settings 的 key 在库里没有白名单（命名空间只在客户端约束），authenticated 能 insert 任意 key。写成 key like 'ai.%' 的话，
--   客户端插 ai.x1、ai.x2……就能绕开整张表的配额。只放行这两个精确的键：unique (user_id, key) 保证每人最多多出 2 行，上限仍然有界。
--   ai.vault 一并放行：它和 ai.enabled 一样是“关 AI”要写的开关（客户端只能写 false，settings_guard 照旧拦打开），满额时也要关得掉。
--   大小写不同、带空格的写法（'AI.enabled'、'ai.enabled '）是别的键，照样计配额（和 settings_guard、consent.ts 只认精确 key 同一口径）。
--
-- 为什么“行已经在”也救不了（不能只改 record_consent_impl 先 update）：
--   INSERT … ON CONFLICT DO UPDATE 会先对要插的行触发 BEFORE INSERT 触发器，再判断冲突。所以账号里已经有 ai.enabled 那一行
--   （撤回过一次、或客户端打开过 AI）时，撤回照样先进 row_quota、照样抛 quota。只能让配额触发器本身不对这两个键触发。
--
-- 守门：build/d1/quota-when.ts（D1）核对挂 row_quota() 的触发器只有 settings_quota 带 WHEN，而且条件正好是这两个键，放宽、改前缀、
--   加 or 都报；违规样例 supabase/tests/d1-fixtures/28_settings_quota_when.psql。行为测试：supabase/tests/rls/15_settings_ai_guard.test.sql。
-- 以后再改 settings_quota，在比本文件更晚的迁移里整段照抄本文件的写法，并同步改 build/d1/quota-when.ts。
--
-- lock_timeout（写法同 20261029190000）：drop / create trigger 要拿 settings 的 AccessExclusive 锁。万一有长事务占着表，
--   不设上限就会一直排队，而排队期间后面所有对 settings 的读写都堵在它后面；设 5 秒，拿不到锁就失败，迁移重跑即可。
--   set local 在 CLI 推迁移时是否生效（每个文件是否在事务里跑），等第一次推预览库时按接手清单 K10-locktimeout 一起核实。

set local lock_timeout = '5s';

drop trigger settings_quota on public.settings;
create trigger settings_quota before insert on public.settings for each row
  when (new.key not in ('ai.enabled', 'ai.vault'))
  execute function private.row_quota();
