# CI 第一次在 GitHub 上运行：存档（B1 接手清单 T3）

- 日期：2026-10-28（主持人存档；日志从 GitHub Actions 网页取出，去掉颜色码后摘录）
- 仓库：`github.com/hufanpiao/lemomemo`（私有），分支 main

## 一、第一次（02f416c，ci #1）：失败，原因是检查脚本

- 失败的是 `ci.yml` 里 “shared 在 Deno 下再跑一遍” 那一步的 grep：测试本身 `ok | 94 passed | 0 failed`，objstore 打真替身那一条也是 `ok`。
- 原因：GitHub 上 Deno 的输出带颜色码（`NO_COLOR=1` 没生效），`... ok` 中间夹着 `\x1b[0m\x1b[32m`，正则 `条件写回 exists.* \.\.\. ok` 匹配不上。
- 修法（382eb28）：先用 `sed` 去掉颜色码，再对去色后的日志做两条 grep。本机用 CI 原始那一行复现：改前不匹配、改后匹配、`FAILED` 行不会被当成通过。
- unit #1 通过。deploy-preview #1 失败（仓库变量还没填，负责人B0网页操作清单第 ⑦ 节以后再跑，预期如此）。

## 二、第二次（382eb28，ci #3、unit #4）：全部通过

数据库测试任务（Docker：本地 Supabase）：

| 步骤 | 日志原文（摘） |
|---|---|
| S3 替身 | `替身镜像锁定一致：localstack/localstack:4.14.0@sha256:3ebc3759…` |
| objstore 严格模式（Vitest，4 个文件） | `Test Files 4 passed (4)`；`Tests 51 passed \| 3 todo (54)`；`严格模式通过：54 条全部真跑并通过；必须项 4 个都对上`（3 条 todo 都是 `--allow-todo` 放行的 TC-B0-116 / 117 整条链路） |
| 邮箱验证码登录探针 | `login-probe：全部符合` |
| RLS（pgTAP） | `Files=5, Tests=253`；`All tests successful.`；`Result: PASS` |
| D1 正例 | `D1 通过：数据库和数据清单、授权白名单、/files 规则表一致` |
| D1 反例和违规样例 | 每个样例都 `✔ … 报出“…”` |
| Deno 下 shared（`deno task test`） | `ok \| 94 passed \| 0 failed (1s)`；没有 ignored、没有“> 跳过” |

端到端任务（Playwright，带 CSP）：`44 passed (39.9s)`，`2 skipped`（和本机一致）。

unit #4：通过。

## 三、结论

- T3 完成：严格模式 0 跳过，Deno 0 ignored，日志已存档。
- 遗留：Dependabot 第一次扫描开了 PR #1（app-deps 7 个更新），它的 ci、unit 失败；另两次 Dependabot 更新任务失败。属于 B1 依赖升级的事，交运维看（不合并、不在 B0 处理）。
