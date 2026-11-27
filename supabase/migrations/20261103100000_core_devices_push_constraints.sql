-- 20261103100000_core_devices_push_constraints.sql：devices 推送三列补约束（架构 0.49 第 1 条、5.3“推送端点校验”；B2 任务单 BE-1 ①；TC-B2-80）
-- 不改 0001～0007（3.5 第 3 点：部署过就只增不改）。
--   push_endpoint：为空，或 char_length ≤ 2048；
--   p256dh：为空，或 ^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]=?$（安全审查 1.5 D1-7 定稿：65 字节 base64url，首字节 0x04 → 首两字符 B[A-P]，末字符只能是低位为 0 的那 16 个；末尾最多一个 =）；
--   auth：为空，或 ^[A-Za-z0-9_-]{21}[AQgw](==)?$（16 字节，末字符只能是低 4 位为 0 的 A Q g w）。
--   按 B2 安全审查 D1-S1 收紧（原写“86～88 个 [A-Za-z0-9_=-]”会放过 = 在中间、首字节不是 0x04 的写法），和 claim_endpoint_impl 的格式检查同一条正则。
-- 主机白名单、https、端口、用户名密码这些不写进约束：claim_endpoint_impl 写入前经 private.push_endpoint_ok() 查
--   （20261103110000_core_claim_endpoint.sql），push-dispatch 发送前再查一次（supabase/functions/_shared/push/endpoint.ts）。
--   约束只兜“长度和格式”这一层：service role 或别的路径写进来的值也越不过。
-- 这三列 authenticated 没有 insert / update 列授权（0001），只能经 claim_endpoint 写，所以不进 D1 第 11c 节的“客户端可写文本列”检查。
--
-- 写法照 20261031110000：先 add … not valid，再 validate；整个文件在一个事务里，库里已有违规旧行时 validate 失败、整个迁移回滚。
-- 预览库 devices 的推送三列 B2 之前没有代码写过（claim_endpoint 是本批才有），validate 很快。

alter table public.devices add constraint devices_push_endpoint_len
  check (push_endpoint is null or char_length(push_endpoint) <= 2048) not valid;
alter table public.devices add constraint devices_p256dh_fmt
  check (p256dh is null or p256dh ~ '^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]=?$') not valid;
alter table public.devices add constraint devices_auth_fmt
  check (auth is null or auth ~ '^[A-Za-z0-9_-]{21}[AQgw](==)?$') not valid;

alter table public.devices validate constraint devices_push_endpoint_len;
alter table public.devices validate constraint devices_p256dh_fmt;
alter table public.devices validate constraint devices_auth_fmt;
