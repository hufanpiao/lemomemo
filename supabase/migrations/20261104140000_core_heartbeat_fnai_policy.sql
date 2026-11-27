-- 20261104140000_core_heartbeat_fnai_policy.sql：private.heartbeat 给 fn_ai 的策略从 using (true) 收窄到 fn_ai 自己的心跳名（HEARTBEAT-fnai-policy，S2，B7a 前）。
-- 为什么：0001 的 fn_all（for all to fn_ai using (true) with check (true)）让 fn_ai 能改写任何一行心跳，
--   包括 push-dispatch、ai-classify、backup-daily、account-purge 等 service_role 函数的心跳。lemo-ops 按心跳判断“服务停了”，
--   fn_ai 那几个函数（ai-embed、ai-media、file-check）一旦被利用或写错名字，就能把别的服务的心跳刷新，掩盖它们已经停了。
-- 做法：删掉 fn_all，换成 fn_ai_own：using 和 with check 都只认三个名字（fn_ai 的三个定时函数，架构 6.2）：
--   'ai-embed'（每 2 分钟）、'ai-media'（每 5 分钟）、'file-check'（cron 补扫每 10 分钟）。
--   不放 ai-classify：它用 service_role，不是 fn_ai 的函数，而且 lemo-ops 监控它的心跳（15 分钟）；放进来 fn_ai 就能伪造它。
--   with check 同样限名单，所以也不能把自己那一行改名成别的名字。
-- 授权（11-04 负责人定 HEARTBEAT 选项 A）：再给 fn_ai 列级 select (name, at, detail)。原来只有 insert、update，没有 select，
--   正常写心跳的 upsert（insert … on conflict (name) do update）和 update … where name = … 都要读列，在 lemo-b2push 上实测都回
--   permission denied，fn_ai 只能首次 insert 或不带 where 地整表 update——等 B7a 的 ai-embed 等函数写出来，第二次写心跳就会失败。
--   select 也受同一条策略管：fn_ai 只看得到自己那三行（实测只返回 ai-embed），写别人的照样被 with check 拒。
--   表级授权照旧只有 insert、update；service_role 绕过 RLS，照旧读写全部心跳。
-- 加新心跳名时三处一起改：这里的策略（新迁移）、build/d1/whitelist.ts 的 FN_AI_HEARTBEATS、架构附录 A 的逐表清单；D1 比对。
-- 回滚：revoke select (name, at, detail) on private.heartbeat from fn_ai; drop policy fn_ai_own on private.heartbeat; create policy fn_all on private.heartbeat for all to fn_ai using (true) with check (true);
--   （回滚会重新打开这个口子，只在 fn_ai 的函数因策略写不进心跳、又来不及加名字时临时用）

drop policy fn_all on private.heartbeat;
create policy fn_ai_own on private.heartbeat for all to fn_ai
  using (name in ('ai-embed', 'ai-media', 'file-check'))
  with check (name in ('ai-embed', 'ai-media', 'file-check'));   -- noUserData
grant select (name, at, detail) on private.heartbeat to fn_ai;   -- upsert 心跳要读；策略只放自己三个名字（附录 A、D1 COLUMN_GRANTS）
