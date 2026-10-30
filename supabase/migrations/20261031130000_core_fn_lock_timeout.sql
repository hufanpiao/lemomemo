-- 20261031130000_core_fn_lock_timeout.sql：服务器函数用的四个写计数 / 写账号状态的函数加函数级 lock_timeout = 5s
-- （安全审查第 22 条建议 ②，接手清单 LOCK-timeout-fn）。
-- 为什么：account 的 store 调用有 10 秒超时（架构 0.47 第 22 条），但超时中止的只是 HTTP 请求，库里那条语句还在等锁，
--   锁放开后可能晚到提交（例如 take_rate 晚到扣上一次、export_job_start 晚到建出任务行）。函数里等锁超过 5 秒就报
--   55P03 lock_not_available、整个语句回滚，什么都不写——等于“没扣、没建”，和调用方“超时按没扣处理”（T1）的口径一致，
--   也比函数侧 10 秒先结束，回应里拿到的是明确的报错而不是超时。
-- lock_timeout 是每次等锁各算 5 秒，不是整个函数合计：account_request_deletion 一个事务里要锁好几处（profiles、
--   pending_deletions、revoked_sessions、auth.sessions），每处各等最多 5 秒，最坏累计可能超过 Edge 侧 10 秒的超时而晚到提交；
--   这种情况由前端 T4（收到 try_later 后查 status，看注销是否已生效）兜住，函数这里不再另设整体超时。
-- 只管等锁，不管语句跑多久（不设 statement_timeout，见 23_export_fn_attrs 的 Q2）；没有锁争用时没有任何影响。
-- 各调用方遇到 55P03（supabase-js 回 error）一律落到临时性失败，已逐个核对（lock-timeout-callers.test.ts）：
--   take_rate：account（account、export-size、export-part、export-refund、restore 各键）、invite-signup（ip、mail、global、verify-ip）、
--     invite-admin（create）——都回 503 try_later；语句回滚所以没扣上，不调退回；export-refund 那一下报错按“不退”记 export_refund_failed。
--   export_job_start：account start 走 fail() 退回当天这一次、删任务行（本来就没建出来），回 try_later。
--   export_job_take：account part 回 try_later，分片数没加上。
--   account_request_deletion：account delete 回 try_later，当天次数不退（0.47 第 22 条同口径），注销没生效（整个事务回滚）。
-- 用 alter function … set，不改原迁移；proconfig 变成 {search_path="",lock_timeout=5s}。
-- lemo-e2e 实测（10-31）：会话一 begin 后调 take_rate 占住 counters 那一行、睡 9 秒；会话二调同一个键，5001 ms 后报
--   ERROR 55P03: canceling statement due to lock timeout，计数只加了会话一那一次（失败那次没扣上）；调用后本连接的 lock_timeout 仍是 0。
-- D1 第 6 节核对这四个函数都带 lock_timeout=5s（build/d1/fn-lock-timeout.ts）；pgTAP 25_fn_lock_timeout.test.sql。
alter function private.take_rate(text, int, int) set lock_timeout = '5s';
alter function private.export_job_start(uuid, uuid, text, uuid) set lock_timeout = '5s';
alter function private.export_job_take(uuid, uuid, text, uuid, int, int) set lock_timeout = '5s';
alter function private.account_request_deletion(uuid) set lock_timeout = '5s';
