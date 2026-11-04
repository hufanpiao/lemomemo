# B1-left-pgnet-timeout 执行记录：pg_net 超时以后 account-purge 照样跑完（2026-11-04）

- 条目：接手清单 B1-left-pgnet-timeout（B1 QA 报告第五版遗留观察 ③；TC-B0-117 C4 那次只跑了 4298 ms，比 cron 的 `timeout_milliseconds := 5000` 短，没测到超时）。
- 执行：后端（B2 后端子 agent），2026-11-04 14:58～15:07（首尔）。
- 环境：本机 lemo-b2push（scratchpad 里的 supabase/ 副本，`project_id = "lemo-b2push"`，端口整体错开到 554xx）。**没碰 lemomemo、lemo-purgeit，没连预览库、正式库。** 开始前、结束后各记一次 `docker ps`（名字和端口），两份逐行相同；lemo-b2push 跑完已 `supabase stop`。
- 脚本：`tools/e2e/pgnet-timeout-purge.mjs`（只认 lemo-b2push、API 只认 127.0.0.1；service role key 运行时从 `supabase status -o env` 读，R2 假凭据从函数用的本机假值 env 文件读，脚本里不写任何密钥、邮箱；容器里访问本机的主机名由 `--container-host` 传，用 Docker Desktop 给容器的那个本机主机名，脚本里不写死，check_backend F10）。

## 做法

- **放慢只靠造数据，不改函数代码、没有延时开关**：每个待删账号在 backups 桶里造 N 个日期目录（每个 1 个小文件）。purgeOne 先列出全部日期，每个日期列两次、删一次，所以日期越多越慢。备选的 fake-s3-slow 没用上。
- **R2**：脚本在本机 127.0.0.1:4599 起 S3 替身（`tests/shared/fake-s3.ts`），再用同一个 edge-runtime 镜像在函数容器的网络里起一个转发容器（`--network container:supabase_edge_runtime_lemo-b2push`）。函数照 `R2_ENDPOINT=http://127.0.0.1:4599` 连上，不改代码。
- **邮件**：测试邮箱是随机的 `@lemomemo.test`，account-purge 的 skipTestRecipients 不真发（日志里的 `mail_skipped_test`、`done_mail_failed:<前 8 位>` 就是这个，预期内）。
- **触发**：照 TC-B1-154 的口径，把 `cron.job` 里 account-purge 那条 command 原样跑一次（脚本先核对它含 `net.http_post` 和 `timeout_milliseconds := 5000`）。
- 每次都另造一个对照账号 B（同样多的备份、四个 R2 桶各 2 个对象，不在注销流程里）。

## 判据

- ① 那条 `net._http_response`：超时场景要 `timed_out = true`（或 error_msg 是超时）、`status_code` 为空；反证要 200、没超时。
- ② `private.heartbeat` 的 account-purge 行 `at` 晚于触发时刻（超时场景要晚于 t0 + 5 秒），`detail` 里 `purged` = 本次待删账号数、`failed = 0`（超时场景 `ms > 5000`）。
- ③ 每个待删账号都删干净、没有删到一半：`auth.users`、`profiles`、`pending_deletions` 里都没了，`deleted_accounts` 有一行，backups 桶所有日期下 0 个文件，四个 R2 桶前缀下都是 0。
- ④ 对照账号 B：profiles 行还在，备份个数、R2 对象个数和触发前一样。
- ⑤ 函数日志里没有 `step_error`、`verify_failed`、`r2_not_empty`、`backups_not_empty`、`heartbeat_failed`。

## 结果

| 次 | 数据 | ① pg_net | ② 心跳 | ③ | ④ | ⑤ | 结论 |
|---|---|---|---|---|---|---|---|
| 正式（15:06:35 触发，request_id 22） | 3 个待删账号 × 120 个日期 | `timed_out = true`、status 空，`Timeout of 5000 ms reached` | `at` 15:06:54.116，`{"purged":3,"failed":0,"ms":17835}` | 3 个全部删干净 | 不变（备份 120、R2 各 2） | 无 | **通过** |
| 反证（15:07:16 触发，request_id 24） | 1 个待删账号 × 2 个日期 | 200、`timed_out = false` | `at` 15:07:20.616，`{"purged":1,"failed":0,"ms":3831}` | 删干净 | 不变 | 无 | **通过**（判据 ① 认得出两种情况） |

时间都是首尔时间，JSON 原文在 scratchpad（`b2push/final-timeout.json`、`final-ok.json`），没进仓库。

结论：pg_net 在 5 秒时断开，函数在断开以后又跑了约 13 秒，三个账号全部删完、心跳照写，没有半截删除。**“pg_net 超时后函数照样跑完”成立（本机）。**

## 另外发现：CPU 时间上限会把一次运行掐在半截（不是 pg_net 引起的）

第一次正式跑用的是 3 个账号 × 400 个日期（14:59:31 首尔触发，request_id 11）：

- pg_net 照样 5 秒超时；第 1、2 个账号分别在触发后约 12 秒、22 秒删完（都在 pg_net 断开之后，说明断开本身不影响）。
- 处理第 3 个账号时，edge-runtime 日志先 `CPU time soft limit reached`，再 `CPU time hard limit reached`、`request has been cancelled by supervisor`，worker 被掐掉。
- 第 3 个账号停在半截：R2 四个桶已删光，backups 删了 331 / 400，`auth.users`、`profiles` 还在，`deleted_accounts` 没写，`pending_deletions.purge_started_at` 留着认领时刻；**这一轮没有心跳**（lemo-ops 的“26 小时没心跳”会报警，不会静默）。
- **补跑能删完**：把它的 `purge_started_at` 改到 2 小时前（模拟过了 `CLAIM_STALE_MS` 1 小时），再触发一次（R2 替身起着），这个账号剩下的 69 个备份删完，`deleted_accounts` 写上，auth、profiles 删掉，心跳 `failed 0`。代码按“可重做”写的这一点成立。
- 本机 edge-runtime 的 CPU 上限和线上同口径（架构 0.47：每次调用 CPU 硬上限 2 秒，TC-B1-73 实测）。线上服务器备份按 7 天轮换，一个账号大约 7 个日期目录，单个账号远到不了这个量；但**一轮里待删账号很多时，总 CPU 可能超过 2 秒**，被掐的那个账号要等认领过期（1 小时）以后的下一次运行（第二天 03:30）才删完。是否要给一轮加“最多处理几个账号”或按 CPU 预算停手，交主持人定（我没改代码）。

## 局限

- 本机 edge-runtime 和托管的 Supabase 在“客户端断开以后还继续执行”这一点上不一定完全一样。本机能证明的是：我们的函数不依赖这条连接，断开以后照样跑完。
- 托管环境上要证明同一件事，只能在预览上用同样的造数据办法再跑一次，这要负责人和 QA 来做，后端不连预览。

## 预览复跑（交主持人放进明早清单）

- **预览复跑 B1-left-pgnet-timeout 要负责人和 QA 来做**：在预览上照本记录的办法（给待删测试账号造够多的备份日期目录，让一次 account-purge 超过 5 秒，再把 cron 的 command 原样跑一次），按判据 ①～⑤ 核对；注意线上每次调用 CPU 上限 2 秒，日期目录别造到被 CPU 掐断（本机 3 × 120 约 18 秒没掐，3 × 400 掐了）。
