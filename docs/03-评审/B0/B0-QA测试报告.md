# B0 QA 测试报告（第④环）

- **测试人**：QA 测试工程师
- **对象**：main `da310335c8d81b433da45d57f948500ab2217da1`（“R2 方案：样例文件名同步为 .psql”），在独立 worktree 里从头安装、构建、测试
- **日期**：2026-10-28
- **依据**：[测试用例 v4](../../06-测试/测试用例-v4.md) 第 3 节（3.1～3.5，含 3.2b TC-B0-99～120、3.3 落在 B0 的 TC-DEL）；[架构设计 v4](../../10-架构/架构设计-v4.md) 1.3 B0 验收标准；[B0 R2 任务单](../../09-路线图/B0-R2任务单.md)；[后端 B0 实测清单](后端-B0实测清单.md)；[人员名单](../../00-团队/人员名单.md) 第一、二节 QA 职责
- **环境**：Windows 11，Node 24.19.0，npm 11.17.0，Deno 2.9.8，Playwright 1.64.1（chromium + webkit），actionlint 1.7.12（带 ShellCheck），gitleaks 8.30.1。**本机没有 Docker**，没有预览环境凭据，R2 未开通

---

## 结论：**不通过**　评分 **6.5 / 10**

本机能跑的检查**全部是绿的**（第一节 25 项 0 失败），改坏抽查 15 处里 12 处被测试拦住，测试质量总体扎实。不通过的原因有两类：

1. **阻断**：有 P0、进冒烟的 B0 自动用例**没有任何自动检查**，改坏也拦不住（见缺陷 D-01）：TC-B0-35、TC-B0-92 的“security definer 都带 search_path”（QA 实测加一个违规函数，全部检查照样通过）、TC-B0-97 ④、TC-B0-73、TC-B0-89 的生成器、TC-B0-75 的 CI 越界检查。按测试用例第 2 节，P0 冒烟项没有覆盖不能签。
2. **B0 验收标准里大量项还没在真环境做**：要 Docker 的（真库 db reset、pgTAP 226 条、D1 真库、files_authorize 经 PostgREST、S3 替身）、要预览环境的、要 R2 的都还没跑；其中 TC-B0-116 连测试都还是空壳（file-check 函数不存在）。这些不算开发缺陷，但 1.3 写明“全部满足才算过”，B0 签字前必须补齐（见“待实测总表”）。

8 分以上需要：补齐 D-01 的六处自动检查并各带违规样例；D-02 修掉并补用例；在有 Docker 的机器或 CI 上把待 Docker 项跑完、结果补进本报告。

---

## 一、命令结果表

全部在 worktree 里从零开始（`npm ci` 前没有 node_modules、dist）。

| # | 命令 | 结果 | 摘要 |
|---|---|---|---|
| 1 | `npm ci --ignore-scripts` | 通过 | 564 个包，0 个漏洞；只有 eslint 9.39.5 的弃用提示 |
| 2 | `npm run typecheck`（5 份 tsconfig） | 通过 | 0 错误 |
| 3 | `npm run lint`（ESLint + Stylelint） | 通过 | 0 错误 0 警告 |
| 4 | `npm test`（Vitest） | 通过 | 44 个文件；592 通过、13 跳过、2 todo。跳过的全是“待 Docker / 待预览”（见下） |
| 5 | `npm run test:tz` | 通过 | UTC、Asia/Seoul、America/Los_Angeles 各 8 个文件 85 条全过 |
| 6 | `deno task test` | 通过 | 85 通过 0 失败（tests/shared，和 Node 同一批） |
| 7 | `deno task check` | 通过 | shared/、supabase/functions/_shared/、build/check_data_manifest.ts 全过 |
| 8 | `npm run test:db:offline`（PGlite） | 通过 | 7 个迁移；pgTAP 01～05 共 226 条全过（47/53/41/34/51）；D1 正例；21 个 D1 违规样例全部报出；6 个清单反例；/files 规则表核对；兼容样例 2 个；requireActiveUser 16 个分支 |
| 9 | `npm run build -- --mode preview` | 通过 | 预缓存 18 个文件；首屏 JS 69.9 KB / 150 KB |
| 10 | `npm run build -- --mode e2e` | 通过 | 同上 |
| 11 | `npm run build:site` | 通过 | 官网检查通过，带哈希资源 5 个 |
| 12 | `npm run size` | 通过 | 首屏 69.9 KB（预算 150）、全部 139.1 KB（参考 250） |
| 13 | `python -I build/check_arch.py`（构建后） | 通过 | 0 错误、2 警告（W2：缺 2027 年 cn、kr 节假日文件，属预期提醒） |
| 14 | `npm run check:site` | 通过 | |
| 15 | `npm run check:gate` | 通过 | “免查名单检查通过（0 个函数）”——supabase/functions 里还只有 `_shared` |
| 16 | `npm run check:files-rules` | 通过 | 规则表和清单一致 |
| 17 | `python -I build/check_registry.py` | 通过 | 没登记的文件 0、登记了不存在的 0 |
| 18 | `python -I build/req_index.py --check` | 通过 | 需求 218 条，问题 0 |
| 19 | `python -I build/tokens.py --check` | 通过 | 令牌 179 个，没定义 0；5 个“定义了没用到”的提示 |
| 20 | `npx playwright install chromium webkit` | 通过 | |
| 21 | `npx playwright test`（`CI=true`，不复用别人的服务） | 通过 | chromium + webkit 共 44 条：42 通过、2 跳过（csp.spec “预览环境 › 经 /sb/* 读写”两个项目，各 1 条，要 `LEMO_E2E_PREVIEW_URL`） |
| 22 | `actionlint`（4 个工作流，带 ShellCheck） | 通过 | 0 问题 |
| 23 | `gitleaks git --redact --log-opts="--all" .` | 通过 | 273 个提交、33.78 MB，no leaks found |
| 24 | pre-commit 钩子实测（TC-B0-58） | 通过 | 脚本现做一个假 `ghp_` 令牌、暂存后直接跑 `.githooks/pre-commit`：退出码 1，“发现疑似密钥，提交已取消”；随后取消暂存、删除，未提交 |
| 25 | 体积超预算实测（TC-B0-11） | 通过 | 往 dist 的首屏 JS 追加约 400 KB 随机数据：`check_size` 报 “首屏 462.2 KB / 预算 150 KB”“W3：首屏 JS 超出预算”，退出码 1；之后重新构建复原 |

**Vitest 跳过的 13 条**（都是有意的环境门槛，不是失败）：sb-forward.preview.test 8 条 + 2 todo（待预览）；compat/headers.test 2 条（没有本地 Supabase）；files-get “TC-B0-116” 1 条、objstore-cases “TC-B0-117 整条链路” 1 条、purge-runner “真替身” 1 条（待 Docker；其中 116、117 两条的测试体是空的，见 D-03）。

**没做的命令**：`npm run test:db`（= `supabase test db` + `deno task d1`，要 Docker）、`node build/ci/d1_negative.mjs`（真库）、`node build/objstore.mjs up`（S3 替身，要 Docker）、`npm audit` 和 OSV-Scanner 的 CI 版（本机 `npm ci` 已报 0 漏洞）。CI 上 da31033 的实际运行结果 QA 没有权限查看，**请运维把 unit、ci 两个工作流的运行链接贴进本报告**。

---

## 二、TC 对照表

状态：**通过**＝本机自动测试跑过且通过；**离线通过**＝在 PGlite + 桩上通过，真库还要按实测清单再跑；**部分**＝一部分有自动测试，另一部分没有（写明缺什么）；**没有覆盖**；**待 Docker / 待预览 / 待 R2 / 待 B1 …**＝要等环境或后面批次的函数。

### 3.1 工程、架构规则、CSP、首页骨架

| TC | 对应自动测试 | 状态 | 说明 |
|---|---|---|---|
| B0-01 | CI unit.yml：typecheck、lint、check_arch | 通过 | 本机 0 错误 |
| B0-02 | tests/arch/eslint.test.ts（72）、stylelint.test.ts（8）、tsc.test.ts（5）、check-arch.test.ts（11）；D1 违规样例 21 个 | **部分** | 有样例的规则都拦得住。缺：**T1、W3 没有违规样例**（W3 只有 QA 手动验证，见命令 25）；“少一条规则的样例时 CI 报规则无违规样例”只按 ESLint 规则名（19 个）核，不按架构规则号核——例如删掉全部 A13 样例，`no-restricted-imports` 还有 A1、A19 的样例，检查照样通过 |
| B0-03 | eslint.test.ts › a1-plus-imports-notes-ui.tsx、a1-shared-imports-src.ts、a1-data-imports-other-feature.ts | 通过 | 改坏抽查 4a 拦住；但 4b（让 data 能引别的功能的 data）没被拦住，见 D-07 |
| B0-04 | stylelint.test.ts › a11-*、a24-*、ok-tokens | 通过 | |
| B0-05 | tests/shared/golden.test.ts（三个时区 + Deno 都等于 golden.json）；`test:tz`；`deno task test` | 通过 | |
| B0-06 | tsc.test.ts › i18n-missing-ko-key（TS1360）、i18n-missing-param（TS2345）；tests/shared/i18n.test.ts | 通过 | |
| B0-07 | tests/e2e/csp.spec.ts › Radix Dialog、Popover、Motion、对照组 | 通过（自动部分） | 架构 2.0 写结论那一半是人工看文档，不在本报告范围 |
| B0-08 | csp.spec.ts › “App 首页（今天页）没有 CSP 报错”（wrangler pages dev） | 通过 | |
| B0-09 | src/motion/__tests__/tokens.test.ts（16）；`tokens.py --check` | 通过 | |
| B0-10 | — | **没有覆盖** | 没有任何检查“只有 --dur-drop 超过 400ms”，也没有 500ms 的违规样例 |
| B0-11 | `build/check_size.mjs` | **部分** | 正常构建通过；超预算会报错（QA 手动验证），但仓库里**没有超预算的自动违规样例** |
| B0-12 | unit.yml supply-chain：npm audit、OSV-Scanner | **部分** | 审计在 CI；“锁文件被改而没写理由时失败”、“精确版本”**没有任何检查** |
| B0-13 | csp.spec.ts › “Service Worker › 作用域是 /app/” | **部分** | SW scope 有测试；`manifest.webmanifest` 的 `start_url`、`scope` 现在是 `/app/`，但**没有测试断言**（另：`icons` 是空数组） |
| B0-14 | tests/e2e/site.spec.ts › 16.3 ② | 通过 | |
| B0-15 | site.spec.ts › 16.3 ③ | 通过 | |
| B0-16 | site.spec.ts › 16.3 ④ | 通过 | |
| B0-17 | tests/functions/root-locale.test.ts（24）；site.spec.ts › 16.4 第 7、8 条 | 通过 | |
| B0-18 | src/app/__tests__/router.test.ts、App.test.tsx；src/core/__tests__/store.test.ts | **部分** | 路由、store 退订有；**`useCollection`（src/kit/hooks/useCollection.ts）卸载后不残留订阅没有组件测试** |
| B0-19 | golden.test.ts；tests/shared/rows.test.ts 在 Vitest 和 Deno 各跑 | 通过 | |

### 3.2 数据库、RLS、转发、D1 和数据清单

| TC | 对应自动测试 | 状态 | 说明 |
|---|---|---|---|
| B0-20 | test:db:offline “7 个迁移在 PGlite 上依次执行成功” | 离线通过；**待 Docker** | 真 `supabase db reset` 连跑两次（L1） |
| B0-21 | test:db:offline “D1 比对：清单和数据库一致” | 离线通过；**待 Docker** | L4 |
| B0-22 | d1-fixtures/01_unregistered_table.psql | 通过 | 改坏抽查 5a、5b 都拦住；样例的 expect 只写“没登记进任何清单”、不含 `qa_probe`，见 D-08 |
| B0-23 | d1-fixtures/02_unregistered_bucket.psql | 通过 | |
| B0-24 | d1-fixtures/11_table_meta.psql；清单反例“systemCols 和 clientWritable 重叠”“noConflict 放了不可写的列” | 通过 | |
| B0-25 | d1-fixtures/08_vault_column.psql；build/d1/checks.ts 第 9 节 | 通过 | |
| B0-67 | rls/02_triggers.test.sql › “移进隐私记加 rev”“ai_desc 是系统列：rev 不变” | 离线通过 | 用 note_images.ai_desc 代替 ai_meta，含义相同 |
| B0-26 | 清单反例“userLookup 和 noUserData 同时写 / 都没写” | 通过 | |
| B0-27 | d1-fixtures/13_embed_trigger.psql；checks.ts 第 10 节 | **部分** | “删掉一个 kind 的外键”“features 默认值多一个 qa_flag”两个违规样例**没有** |
| B0-68 | — | **没有覆盖** | 没有任何检查拦“改 0001～0007 建表文件来打开开关” |
| B0-28 | rls/02 › TC-B0-28 两条 | 离线通过 | |
| B0-29 | tests/data-manifest/generate.test.ts › 系统列用例（3 条） | 通过 | |
| B0-30 | generate.test.ts › 注销用例（9 条）、后端的真清单（3 条） | 通过 | |
| B0-31 | generate.test.ts（TC-DEL-app_config、table_meta、tombstones 能生成） | **待 B1** | 真正“注销前后不变”要 account / account-purge（B1） |
| B0-32 | rls/01_client_rls.test.sql（47） | 离线通过；**待 Docker** | L2 |
| B0-33 | rls/03 › TC-B0-33；checks.ts 第 5 节 | 离线通过 | |
| B0-69 | rls/03 › TC-B0-69 | 离线通过 | 真 Supavisor 事务模式待预览（P6） |
| B0-70 | rls/03 › TC-B0-70 | 离线通过 | |
| B0-34 | rls/03 › TC-B0-34 | 离线通过 | |
| B0-35 | — | **没有覆盖（P0）** | db.ts 注释写“由 CI 管”，但 check_arch、D1、CI 里**都没有**搜 `SUPABASE_DB_URL`、列 `_shared/db.ts` 引用方的检查 |
| B0-36 | tests/functions/files.test.ts › TC-B0-36、TC-B0-106、107；tests/e2e/files.spec.ts | **部分** | `/files` 一半通过；vault-image `{action: upload}` 一半**待 B5**（函数还不存在） |
| B0-37 | rls/02 › row_quota（settings 5 KB、第 20001 行、第 2001 条日志） | 离线通过 | 豁免条件见 B0-71 |
| B0-71 | — | **待 Docker**（人工） | L5 |
| B0-72 | rls/02 › TC-B0-72 | 离线通过（部分组合） | 测了 service_role 4 张表、fn_vault、fn_ai，没把 16 种组合逐一列出；L6 待 Docker |
| B0-73 | checks.ts 第 6 节（private 函数属主 postgres、PUBLIC 不能执行） | **部分（P0）** | 只有 ④。①“grant 紧跟建函数、7 个文件的授权汇总和 3.3 C 逐行比对”、②“0001 第一句”、③先后顺序、⑤索引写在建表文件里，**都没有自动检查**；三个违规样例都没有 |
| B0-74 | rls/04 › TC-B0-74；d1-fixtures/03_bucket_limit.psql、19_r2_bucket_in_storage.psql | 离线通过；**待 Docker** | L18 |
| B0-75 | tests/build/objstore-fake.test.ts › “不传 contentType 抛 bad_input” | **部分（P0）** | 6 个桶由服务器函数各传一次（函数不存在）；“九个规定函数以外 import objstore 或读 `R2_FN_*` 时 CI 失败”**没有检查**（check_arch 的 R2 规则只管 src/）；静态检查服务器上传都带 contentType **没有** |
| B0-76 | rls/04 › TC-B0-76 | 离线通过 | “每个写键的地方各一条单元测试”随各批函数补 |
| B0-77 | rls/03 › TC-B0-77；d1-fixtures/09_fn_member.psql | 离线通过；**待 Docker** | 第二次 db reset、`show server_version`（L1、L9） |
| B0-78 | rls/03 › TC-B0-78；d1-fixtures/07 | 离线通过 | |
| B0-79 | rls/01 › TC-B0-79；d1-fixtures/06 | 离线通过 | |
| B0-80 | rls/02 › “updated_at 不进 fv” | **部分** | 没有“只改 updated_at、两台设备同改，rev 不变不冲突”的直接断言 |
| B0-81 | rls/03 › TC-B0-81；d1-fixtures/04、10 | 离线通过 | “给 service_role 授 scan_embed_queue”的违规样例没有（04 用的是 vault） |
| B0-82 | — | **待 Docker** | 要真 PostgREST（L14、P2） |
| B0-83 | rls/03 第 16～19 行（authenticator 不是成员） | 离线通过一半；**待 Docker** | 签 `role: fn_ai` 的 JWT 打本地 REST |
| B0-84 | — | **待预览**（人工） | P3 |
| B0-85 | — | **待 B1 / B2** | push-dispatch、invite-signup、ai-parse、account 都还没建 |
| B0-86 | rls/03 › TC-B0-86 | 离线通过 | |
| B0-87 | rls/03 › TC-B0-87 | 离线通过 | |
| B0-88 | rls/04 › TC-B0-88 | 离线通过 | |
| B0-89 | checks.ts 第 4、5 节（授权和白名单双向比）；rls/01、03 的若干反例 | **部分（P0）** | **“表 × 角色 × 操作”的正反用例生成器不存在**（tests/data-manifest 里没有）；静态授权比对有，行为矩阵没有 |
| B0-90 | unit.yml secrets-scan（gitleaks 扫全部历史，没有路径放行） | **部分** | gitleaks 一半通过；AI 回放录制器 B3 才有，“存盘前去掉请求头”**待 B3** |
| B0-38 | rls/01 › TC-B0-38 | 离线通过 | |
| B0-39 | tests/functions/sb-proxy.test.ts › upstreamPath（24）、handleSb TC-B0-39（6） | 通过；线上**待预览** | 发现百分号编码能绕过拒绝名单，见 D-02 |
| B0-91 | sb-proxy.test.ts › 请求头重写（6） | **部分**；**待 B1** | 转发层“先删后写”通过（改坏 3a、3b 都拦住）；函数一侧（account 导出、“未知地区”）要 account 函数 |
| B0-92 | checks.ts 第 5、6 节；rls/05 只核 files_authorize_impl 的 search_path | **部分（P0）** | **D1 不查 `pg_proc.proconfig`**：QA 在 0007 末尾加一个不带 search_path 的 security definer 函数，`test:db:offline`、check_arch 全部照样通过（改坏抽查 9） |
| B0-93 | shared/schema/manifest.ts（`export` 必填，少写 zod 报错） | **部分（P0）** | “这 11 张表、两个 vault 桶必须是 none”**没有检查** |
| B0-94 | rls/01 › TC-B0-94 | 离线通过 | |
| B0-95 | rls/02、03 › TC-B0-95；d1-fixtures/05 | 离线通过 | |
| B0-96 | rls/02 › purge_deleted（bad_table、too_many_items 等） | 离线通过 | |
| B0-97 | check_arch P142（current_user）+ check-arch.test.ts；rls/02、03（执行权） | **部分（P0）** | ④ 里“`supabase/functions/` 除三处以外出现 `disabled_at` 就失败”**check_arch 没有这条规则**；“D1 核对 cron 挑用户的命令都带 account_usable”**D1 没有**（第 12 节只查 statement_timeout） |
| B0-98 | d1-fixtures/12_cron_timeout.psql | **部分**；**待预览** | ④ 通过；①②③⑤⑥⑦ 要真库 / 预览（P4、P5） |
| B0-40 | csp.spec.ts › TC-B0-40；src/sw/__tests__/routes.test.ts；check_arch A19 | 通过 | 改坏抽查 8 拦住 |
| B0-41 | — | **待预览**（人工） | P9、P11 |
| B0-42 | — | **待预览** | |
| B0-43 | tests/e2e/sb-forward.preview.test.ts（全跳过） | **待预览** | 其中“Storage 签名链接是相对路径”一条已被架构 0.32 删去，测试还留着，见 D-11 |
| B0-44 | sb-forward.preview.test.ts；csp.spec.ts › 预览环境 | **待预览** | |
| B0-45 | — | **待预览**（人工，运维） | |

### 3.2b R2 和 `/files/v1/*`

| TC | 对应自动测试 | 状态 | 说明 |
|---|---|---|---|
| B0-99 | rls/05 › TC-B0-99 | 离线通过；**待 Docker** | 改坏 1a、1b 都拦住；真 JWT 经 PostgREST 见 L17 |
| B0-100 | rls/05 › TC-B0-100 | 离线通过；待 Docker | |
| B0-101 | rls/05 › TC-B0-101 | 离线通过；待 Docker | |
| B0-102 | rls/05 › TC-B0-102；files.test.ts › 规则表和路由 | 离线通过 | |
| B0-103 | rls/05 › TC-B0-103 | 离线通过 | |
| B0-104 | rls/05 › TC-B0-104 | 离线通过；**待 Docker** | 真 JWT 里有没有 `session_id`（L17） |
| B0-105 | rls/05 › TC-B0-105 | 离线通过 | |
| B0-106 | files.test.ts › TC-B0-106（含流式 true/false） | 通过 | 改坏 7 拦住 |
| B0-107 | files.test.ts › TC-B0-107 | 通过 | |
| B0-108 | files.test.ts、objstore-fake.test.ts（条件写）、src/platform/__tests__/files.test.ts（409 当成功）；files.spec.ts | 通过 | 真 R2 的 412 待 R2（第五节第 1 项） |
| B0-109 | files.test.ts › TC-B0-109 | 通过 | 改坏 6 拦住 |
| B0-110 | files-get.test.ts › TC-B0-110 | 通过 | 改坏 2a、2b（含 5 秒宽限）都拦住 |
| B0-111 | files-get.test.ts › TC-B0-111（2 条）、HMAC（2 条）；files.spec.ts | 通过 | |
| B0-112 | files.test.ts › POST sign | 通过 | |
| B0-113 | files-get.test.ts › TC-B0-113（2 条） | 通过 | |
| B0-114 | files.test.ts；src/platform/__tests__/files-sign.test.ts；rls/05 | 通过 | |
| B0-115 | files.test.ts › TC-B0-115 | 通过 | |
| B0-116 | files-get.test.ts › `describe.skip` 空壳 | **没有覆盖** | file-check 函数不存在（supabase/functions 只有 `_shared`），测试体是空的；files.spec.ts 只证明了 `/files` 一侧。见 D-03 |
| B0-117 | purge-runner.test.ts（离线内存替身 6 条）、objstore-cases.test.ts（替身 runner 4 条） | **部分**；**待 Docker、待 B1** | 生成器和探针在内存 S3 上通过；真链路要 LocalStack + account-purge（B1），测试体同样是空壳 |
| B0-118 | manifest-store.test.ts、d1-fixtures/19、d1-files-rules.test.ts、gen-files-rules.test.ts | 通过 | |
| B0-119 | sb-storage.test.ts（16） | 通过 | 百分号编码绕过见 D-02 |
| B0-120 | — | **待 R2** | 任务单第五节 9 项 |

### 3.3 落在 B0 的注销用例

| TC | 对应自动测试 | 状态 |
|---|---|---|
| TC-DEL-app_config | generate.test.ts › “noUserData 生成注销前后不变的快照” | 生成通过；执行**待 B1** |
| TC-DEL-table_meta | 同上 | 生成通过；执行**待 B1** |
| TC-DEL-tombstones | generate.test.ts（编号在列） | 生成通过；执行**待 B1** |

### 3.4 版本兼容和功能开关

| TC | 对应自动测试 | 状态 |
|---|---|---|
| B0-46 | version-gate.test.ts、sb-proxy.test.ts › TC-B0-46 | 通过（改坏 6 拦住）；线上待预览 |
| B0-47 | 同上 › TC-B0-47 | 通过 |
| B0-48 | 同上 › TC-B0-48 | 通过 |
| B0-49 | version-gate.test.ts › TC-B0-49 | 通过 |
| B0-50 | version-gate.test.ts › TC-B0-50 | 通过 |
| B0-51 | sb-proxy.test.ts、files.test.ts、version-gate.test.ts › TC-B0-51 | 通过 |
| B0-52 | tests/build/check-version-gate.test.ts | 通过 |
| B0-53 | rls/04 › TC-B0-53 | 离线通过 |
| B0-54 | rls/01 › TC-B0-54 | 离线通过 |
| B0-55 | rls/01 › TC-B0-55 | 离线通过 |
| B0-56 | tests/shared/flags.test.ts › featureOn（4 条） | 通过 |
| B0-57 | test:db:offline 兼容样例 2 个；ci.yml 旧版契约（上线前只报告） | 通过（离线）；真库待 Docker |

### 3.5 安全杂项和小验证

| TC | 对应自动测试 | 状态 | 说明 |
|---|---|---|---|
| B0-58 | .githooks/pre-commit（QA 实测）；`.gitignore` 有 `.env*` | 通过 | 钩子要每台电脑手动 `git config core.hooksPath .githooks`，见 D-09 |
| B0-59 | sb-proxy.test.ts › 响应头（8 条）；csp.spec.ts › 响应头；tests/build/assemble-web.test.ts | **部分** | `_headers` 里确实有 base-uri、form-action；但**没有测试断言** `/app/` 的 CSP 有 base-uri / form-action、不含 challenges.cloudflare.com；`/app/auth/` B1 起 |
| B0-60 | — | **人工**（负责人、运维） | QA 已核工作流一侧：只有 deploy-preview 引用 secrets，且只有 `PREVIEW_*` 三个；release-build 不读 secrets；没有 deploy-prod |
| B0-61 | — | **待预览**（人工） | P1 |
| B0-62 | — | **待 R2**（并入 B0-120 第 3 项） | |
| B0-63 | — | 人工（负责人） | |
| B0-64 | — | **待预览**（人工） | P6 |
| B0-65 | desktop/turnstile-probe/ | 人工（QA 本机 Windows） | 本轮没做，B0 签字前做 |
| B0-66 | — | 人工 | |

### 没有覆盖的 TC（重点）

**完全没有自动测试（4 条）**：TC-B0-10、TC-B0-35（P0）、TC-B0-68、TC-B0-116（P0 冒烟）。

**部分没有覆盖（15 条）**：TC-B0-02（T1、W3 无样例，覆盖检查不按规则号）、11（无超预算样例）、12（锁文件理由、精确版本）、13（manifest 无断言）、18（useCollection）、27（两个违规样例）、59（CSP 分路径断言）、73（P0：①②③⑤）、75（P0：CI 越界检查、静态 contentType）、80、89（P0：生成器）、90（录制器待 B3）、92（P0：search_path）、93（P0：11 张 none）、97（P0：disabled_at、cron account_usable）。

其中 **P0 的 8 条**（35、73、75、89、92、93、97、116）是本轮不通过的主因。

---

## 三、改坏抽查（看完立刻 `git restore`，最后 `git status` 干净）

| # | 改了哪里、怎么改坏 | 跑什么 | 结果 |
|---|---|---|---|
| 1a | `0004_attachments.sql` files_authorize_impl：去掉“路径第一段必须是本人”的判断（`elsif split_part(p,'/',1) <> uid::text` 改成 `elsif false`） | test:db:offline | **拦住**：05 文件 4 条失败（A 传 B 的插图、取 B 的插图、往 B 目录传附件、批量里混 B 的项：have no_row / want not_owner） |
| 1b | 在 1a 上再去掉 note_images 查询的 `ni.user_id = uid`（真正放行别人的图） | test:db:offline | **拦住**：同 4 条，have `ok` |
| 2a | `functions/files/[[path]].ts`：过期判断 `nowS > e` 改成 `nowS > e + 86400` | vitest tests/functions | **拦住**：TC-B0-110 “expected 200 to be 403” |
| 2b | 同处改成只宽限 5 秒 `nowS > e + 5` | 同上 | **拦住**（测试按边界拨钟） |
| 3a | `functions/sb/[[path]].ts`：先删那一步整个失效（`if (false) headers.delete(name)`） | vitest tests/functions | **拦住**：“伪造的 IP、secret、geo、region 先删后写”“没有 CF-Connecting-IP 时客户端传的照样删掉” |
| 3b | 删除名单里拿掉 `x-forwarded-for` | 同上 | **拦住**：同上第一条 + “删除名单覆盖架构列出的几个头” |
| 4a | `eslint.config.js`：feature-ui 的 `same('feature-ui')` 改成 `...any('feature-ui')`（功能 ui 能引别的功能的 ui） | vitest tests/arch | **拦住**：a1-plus-imports-notes-ui.tsx → boundaries/dependencies 没有拦住 |
| 4b | `eslint.config.js`：feature-data 的 `same('feature-data')` 改成 `any('feature-data')`（data 能引别的功能的 data） | vitest tests/arch | **没拦住**：96 条全过。现有 a1-data-imports-other-feature.ts 引的是别的功能的 index.ts，不是 data。见 D-07 |
| 5a | `shared/manifests/core.ts` 删掉 `applied_ops` 的登记 | test:db:offline；vitest；typecheck | **拦住**（D1）：“数据库有表 public.applied_ops，没登记进任何清单”。Vitest 和 typecheck 都不报（预期内，靠 D1） |
| 5b | `build/d1/checks.ts`：“没登记的表”只查 private（`k.startsWith('private.') && …`） | test:db:offline | **拦住**：01_unregistered_table.psql “没报出（实际：无）” |
| 6 | `functions/sb/version-gate.ts`：没带版本头也放行（`!client \|\| …` 改成 `client && …`） | vitest；Playwright files.spec | **拦住**：单测 4 条失败。E2E 的“没带版本号 426”没失败——它实际发的是 `3.9.0`，标题和内容不符，见 D-10 |
| 7 | `functions/_lib/files-upload.ts`：谎报长度的上限放宽 4 MB（两处 `count > declared`） | vitest tests/functions | **拦住**：TC-B0-106 流式 true / false 两条 |
| 8 | `src/sw/routes.ts`：只走网络的前缀表去掉 `/files` | vitest src/sw；check_arch | **拦住**：routes.test.ts 1 条 + check_arch A19 报错 |
| 9 | `0007` 末尾加一个不带 `search_path` 的 `security definer` 函数（只收回 PUBLIC） | test:db:offline；check_arch | **没拦住**：“全部通过”，check_arch 0 错误。TC-B0-92（续第 117 条）要求 CI 失败。见 D-01 |

| 10 | 移走 `tests/arch-fixtures/eslint/a13-*` 三个文件（A13 一条规则的全部违规样例） | vitest tests/arch/eslint.test.ts | **没拦住**：69 条全过，“样例齐全”不报。见 D-06 |

合计 15 处（必选 5 类全做），12 处拦住、3 处没拦住（4b、9、10）。

---

## 四、CI 核对（`.github/workflows/`）

| 检查 | 在哪个工作流 | 结果 |
|---|---|---|
| 类型检查（tsc，5 份） | unit.yml check | 有 |
| ESLint + Stylelint | unit.yml | 有 |
| check_arch（构建前、构建后各一次） | unit.yml | 有 |
| Vitest（三个时区） | unit.yml（循环 TZ 跑 `npm test`，等价于 test:tz 且范围更大） | 有 |
| test:db:offline（PGlite） | unit.yml | 有 |
| 构建 preview、体积 | unit.yml | 有 |
| build:site / check:site | unit.yml（`npm run build` 含官网；`check:site`） | 有 |
| check_registry、req_index --check、tokens --check | unit.yml | 有 |
| check:gate、check:files-rules | unit.yml | 有 |
| npm audit、OSV-Scanner | unit.yml supply-chain | 有 |
| gitleaks 扫全部历史 | unit.yml secrets-scan | 有 |
| supabase start、S3 替身、db reset、db.types 比对 | ci.yml db | 有 |
| pgTAP + D1 正例（`npm run test:db`） | ci.yml db | 有 |
| D1 违规样例真库版（`d1_negative.mjs`） | ci.yml db | 有 |
| deno task test、deno task check | ci.yml db | 有 |
| 旧版契约、兼容样例 | ci.yml db | 有 |
| Playwright chromium + webkit（e2e 模式构建 + wrangler pages dev） | ci.yml e2e | 有 |
| **actionlint** | — | **没有**（只在本机装了） |
| **打 S3 替身的 Vitest**（objstore.test.ts 的真替身组、TC-B0-116、117 整条链路）、`supabase/tests/objstore/seed.mjs`（L19） | — | **没有**：db 任务起了替身、设了 `OBJSTORE_ENDPOINT`，但**不跑任何 Vitest**；e2e 任务跑 Vitest 吗？也不跑。这几组在 CI 里永远不执行 |
| `supabase functions serve` + 函数测试 | — | 没有（函数还没建，B1 起要加） |
| check_fonts、check_contrast（测试用例第 1 节环境表列了） | — | 没有（B1 / B6 的事，记一笔） |
| TC-B0-35、73、75、92、93、97 的静态 / D1 检查 | — | 没有（检查本身不存在，见 D-01） |

结论：CI 把现有检查都接上了，**漏的是 actionlint 和“打真替身的 Vitest”两项**，以及 D-01 那批检查本身不存在。

---

## 五、待实测总表

| # | 项 | 谁做 | 需要什么 | 对应 TC / 清单项 |
|---|---|---|---|---|
| 1 | `supabase db reset` 连跑两次、无报错、不报角色已存在；Realtime 10 张表 | 后端（有 Docker 的机器）或看 CI ci.yml db | Docker、Supabase CLI 2.120.0 | TC-B0-20、77；L1、L13 |
| 2 | `npm run test:db`：pgTAP 5 个文件 226 条、`\ir _helpers.psql` | 后端；QA 收结果 | 同上 | TC-B0-32～38、53～55、67、69～81、86～88、94～97、99～105；L2、L3 |
| 3 | `deno task d1` 真库正例 + 21 个违规样例（`d1_negative.mjs`） | 后端 | 同上 | TC-B0-21～28、74、78、81、92～95、118；L4 |
| 4 | row_quota 四种连接的 session_user / role | 后端，代码审查员见证 | 同上 + Supavisor | TC-B0-37、71；L5 |
| 5 | 触发器里 `current_setting('role')`、auth.users 级联、service_role 默认授权、成员关系和 server_version、`with set true` | 后端 | 同上 | TC-B0-72、97、85、92、33、77、83、34；L6～L10 |
| 6 | PostgREST 真行为：private 暴露后 42501 / 404、GraphQL 不暴露、Mailpit 验证码 | 后端；QA 收结果 | 同上 | TC-B0-81、82；L14 |
| 7 | `supabase gen types` 替换 db.types.ts，CI 比对通过 | 后端 | 同上 | 架构 2.5；L15 |
| 8 | Auth 连不上回 try_later | 后端 | 同上 + `functions serve` | 第 6 节；L16 |
| 9 | files_authorize 经 PostgREST + 真 JWT（含 `session_id`）、状态码 | 后端、前端 B | 同上 | TC-B0-99～105；L17 |
| 10 | `storage.buckets` 只剩 2 个、storage.objects 0 条策略 | 后端 | 同上 | TC-B0-74、118；L18 |
| 11 | S3 替身（LocalStack 4.14.0 按 digest）起来、四个条件、seed.mjs 两遍 | 运维；后端 | Docker | TC-B0-116、117；L19；任务单 O-1 |
| 12 | 签 `role: fn_ai` 的本地 JWT 打 REST，切换不过去 | 后端，安全审查员见证 | Docker（本地 JWT 密钥；**不用预览项目的**） | TC-B0-83；P7 |
| 13 | TC-B0-116 整条链路（/files → file-check → sign） | 前端 B、后端 | Docker + **file-check 函数（现在没有）** | TC-B0-116 |
| 14 | TC-B0-117 整条链路（四个 R2 桶注销后为 0） | 前端 B、后端 | Docker + account / account-purge（B1） | TC-B0-117、31、TC-DEL 三条 |
| 15 | pgvector / halfvec(768) | 后端，代码审查员见证 | 预览项目 | TC-B0-61；P1 |
| 16 | private 暴露、pg_graphql | 后端，安全审查员见证 | 预览项目 | TC-B0-81、82、84；P2、P3 |
| 17 | cron 超时、service_role statement_timeout、PG 版本、长事务、transaction_timeout | 后端 | 预览项目 | TC-B0-98；P4、P5 |
| 18 | Supavisor 事务模式 + `app.uid`、`prepare: false` | 后端，代码审查员见证；负责人设 fn_ai 密码 | 预览项目 | TC-B0-64、69、34；P6 |
| 19 | requireActiveUser 真实路径 | 后端 | 预览项目 | 第 6 节；P8 |
| 20 | Security Advisor 0 警告（截图进本报告），含 files_authorize | 后端 + QA 截图 | 预览项目控制台 | TC-B0-41；P9、P11 |
| 21 | 经 `/sb/*`：REST 读写、Auth 发码校验、函数在首尔、Realtime；绕过 Worker 直连 supabase.co | 前端 B 牵头，运维，QA | 预览环境 + `LEMO_E2E_PREVIEW_URL` 等变量 | TC-B0-42、43、44；sb-forward.preview.test.ts、csp.spec 预览组 |
| 22 | 免费版“活动”判定、保活跑一天 | 运维 | 预览项目 | TC-B0-45 |
| 23 | 预览令牌权限、仓库 secrets 名字截图 | 负责人、运维；QA 收截图 | GitHub、Cloudflare 控制台 | TC-B0-60、66 |
| 24 | D-02 的百分号编码在线上会不会被 Cloudflare 先规整掉、上游会不会解码 | 前端 B | 预览环境 | TC-B0-39、119 |
| 25 | R2 第五节 9 项（条件写 412、10 MB CPU、微软查看器、桶设置、令牌范围、cf-cache-status、日志查询串、首尔函数连 R2、预览 E2E） | 前端 B 牵头；后端（3、8）；运维（4、5、7）；安全审查员见证 ④⑤ | **R2 开通（最晚 11-10，R-218）** | TC-B0-120、62；P12 |
| 26 | 最小 Tauri 壳上 Turnstile | QA（本机 Windows） | desktop/turnstile-probe、Rust 工具链 | TC-B0-65 |
| 27 | AI Studio 免费额度 | 负责人 | — | TC-B0-63 |
| 28 | 函数一侧：伪造 x-lemo-geo、x-proxy-secret 不对时“未知地区” | 后端 | account 函数（B1） | TC-B0-91 |
| 29 | 服务器函数契约（push-dispatch、invite-signup、ai-parse、cron、account 经 service_role） | 后端 | 函数（B1、B2） | TC-B0-85 |
| 30 | vault-image `{action: upload}` 的大小、类型上限 | 后端 | vault-image（B5） | TC-B0-36 后一半 |

---

## 六、发现的缺陷

分级：**高**＝阻断 B0 签字；**中**＝本批要修，不单独阻断；**低**＝记录，随手修或下批修。

### D-01（高）P0 冒烟用例要求的六处自动检查不存在，改坏拦不住

- **涉及**：TC-B0-35、73、75、89、92、93、97（均 P0、★）。
- **现象**：
  1. TC-B0-35：没有任何检查在 `supabase/functions/` 搜 `SUPABASE_DB_URL`、列出 import `_shared/db.ts` 的函数（db.ts 注释写“由 CI 管”）。
  2. TC-B0-92：D1 不查 `pg_proc.proconfig`；security definer 函数漏写 `search_path` 拦不住。
  3. TC-B0-97 ④：check_arch 没有“`disabled_at` 只许出现在 `_shared/auth.ts`、account、account-purge”的规则；D1 不核 `cron.job` 挑用户的命令带 `account_usable`。
  4. TC-B0-73：没有“每个函数的 grant 紧跟建函数、在同一文件”“7 个文件的授权汇总和 3.3 C 逐行比对”“0001 第一句是 alter default privileges”的检查。
  5. TC-B0-75：没有“九个规定函数以外 import objstore 或读 `R2_FN_*` 时 CI 失败”的检查；没有服务器上传带 contentType 的静态检查。
  6. TC-B0-89：没有“表 × 角色 × 操作”正反用例生成器；TC-B0-93：没有“11 张表、两个 vault 桶的 export 必须是 none”的检查。
- **复现（以第 2 条为例）**：在 `supabase/migrations/0007_*.sql` 末尾追加
  `create function private.qa_probe_definer() returns int language sql security definer as 'select 1';`
  `revoke execute on function private.qa_probe_definer() from public;`
  → `npm run test:db:offline` 输出“全部通过”，`python -I build/check_arch.py` 0 错误。期望：CI 失败。
- **建议**：后端在 `build/d1/checks.ts` 补 2、3（cron）、6（93）；check_arch 补 1、3（disabled_at）、5；授权汇总（4）和生成器（6 的 89）按测试用例原文实现；每条带一个违规样例进 `supabase/tests/d1-fixtures/` 或 `tests/arch-fixtures/`。

### D-02（中，待预览核实后定级）`/sb` 的拒绝名单能用百分号编码绕过

- **涉及**：TC-B0-39（P1）、TC-B0-119（P0）；架构 14.2 第 1 点。
- **复现**：在 worktree 里用 Node 直接调 `functions/sb/[[path]].ts` 的 `upstreamPath`：
  - `/sb/rest/v1/rpc/files_authorize` → `null`（拒绝，正确）
  - `/sb/rest/v1/rpc/files%5Fauthorize` → `/rest/v1/rpc/files%5Fauthorize`（**放行**）
  - `/sb/rest/v1/rpc/%66iles_authorize` → 放行
  - `/sb/auth/v1/%61dmin/users` → `/auth/v1/%61dmin/users`（**放行**，拒绝名单是 `/auth/v1/admin`）
- **原因**：`SUSPICIOUS_PATH_RE` 只拦 `%2e %2f %5c %00`，拒绝名单按原始字符串前缀比；`%5F`、`%61` 这类编码过的非保留字符原样通过。上游（Kong / PostgREST / GoTrue）按 RFC 3986 解码后就是被拒的路径。
- **影响**：/sb 的纵深防御失效：客户端能经 /sb 调 `files_authorize`（自己账号的限流计数、授权结果）；admin 接口还要 service key，所以不是越权，但拒绝名单形同虚设。Cloudflare 边缘的 URL 规整可能会先把 `%61` 解码，线上是否可利用要在预览环境核实（待实测总表第 24 项）。
- **建议**：先把路径里的百分号编码统一解码（或只允许极少数必要的编码、其余一律 404）再比拒绝名单；sb-proxy.test.ts、sb-storage.test.ts 补上述 4 个用例。

### D-03（中）TC-B0-116、117 的测试是空壳，file-check 函数不存在，B0 验收里这两条做不到

- **现象**：`tests/functions/files-get.test.ts` 的 TC-B0-116、`tests/data-manifest/objstore-cases.test.ts` 的 TC-B0-117 都是 `describe.skip` 里一个空的 `it(…, () => {})`；`supabase/functions/` 只有 `_shared`，没有 file-check、account-purge。
- **影响**：架构 1.3 B0 验收写“TC-B0-99～120 本机打 S3 替身全过”“注销后四个 R2 桶里这个人的前缀为 0”，任务单第四节把 116 列为“本机能测完”。按现在的代码，116 要等 B4b-1 的 file-check、117 要等 B1 的 account-purge。
- **建议**：主持人和架构师定：B0 是先建 file-check 的最小版本，还是把 116、117 的真链路正式改为“随 B1 / B4b-1 补测”并写进 1.3；无论哪种，测试文件里写清楚、不要留空的 `it`。

### D-04（中）CI 不跑任何“打真替身”的 Vitest

- **现象**：ci.yml db 任务起了 LocalStack、设了 `OBJSTORE_ENDPOINT`，但只跑 `test:db`、`d1_negative`、deno、compat，**不跑 Vitest**；`tests/shared/objstore.test.ts` 的真替身组、`supabase/tests/objstore/seed.mjs`（实测清单 L19）在 CI 里永远不执行。
- **建议**：运维在 db 任务里加 `npx vitest run tests/shared/objstore.test.ts` 和 `node supabase/tests/objstore/seed.mjs && … --check`，TC-B0-116、117 落地后一并接上。

### D-05（低）actionlint 没进 CI

- 本机 actionlint 0 问题，但 4 个工作流都没跑它。建议 unit.yml 加一步（按 ci-tools.lock 锁版本和 SHA-256）。

### D-06（低）架构规则“每条都有违规样例”的核对不完整

- T1、W3 没有违规样例；TC-B0-10（400 ms）、TC-B0-11（超预算）没有自动样例；eslint.test.ts 的“样例齐全”按 ESLint 规则名核，不按架构规则号（A1～W3）核，删掉某个架构规则的全部样例不一定报。
- **复现**（QA 实测，改坏抽查 10）：把 `tests/arch-fixtures/eslint/a13-*` 三个文件（A13 的全部样例）移走 → `npx vitest run tests/arch/eslint.test.ts` 69 条全过，“样例齐全：每条规则至少一个”不报（`no-restricted-imports/globals/syntax` 还有别的样例）。之后已移回。
- **建议**：样例文件头加 `rule=A13` 之类的规则号，按架构 2.3 的规则表核对；补 T1、W3、400 ms 的样例。

### D-07（低）没有“功能的 data 引别的功能的 data”的违规样例

- 改坏抽查 4b：把 feature-data 的策略放宽成能引任何功能的 data，96 条架构测试全过。现有 `a1-data-imports-other-feature.ts` 引的是 `calendar/index.ts`。
- **建议**：加一个 `path=src/features/todos/data/bad.ts`、`import … from '../../calendar/data/x.ts'` 的样例。

### D-08（低）D1 违规样例 01 的 expect 太宽

- `01_unregistered_table.psql` 的 `-- expect: 没登记进任何清单` 不含表名。改坏抽查 5a 时它报的是 `public.applied_ops`，照样算“通过”。TC-B0-22 要求“报出 qa_probe”。
- **建议**：改成 `-- expect: 数据库有表 public.qa_probe，没登记进任何清单`。

### D-09（低）pre-commit 钩子要每台电脑手动启用

- 本 worktree 的 `git config core.hooksPath` 为空，钩子不生效；TC-B0-58 的“本机提交被拦”只对手动启用过的电脑成立（钩子本身 QA 实测有效）。
- **建议**：在 README / 开发环境文档的第一步写明，并让 `npm ci` 之后的检查（或 check_arch）提示未启用。

### D-10（低）测试名和内容不符、占位测试显示为“通过”

- `tests/e2e/files.spec.ts` “…没带版本号 426”实际发的是 `X-App-Version: 3.9.0`（改坏抽查 6 时它没失败）。
- `tests/shared/objstore.test.ts` 没设 `OBJSTORE_ENDPOINT` 时，真替身组用一条 `expect(LIVE).toBe(undefined)` 的测试代替，报告里显示为“通过”而不是“跳过”。
- **建议**：E2E 补一个真不带版本头的请求；占位改成 `it.skip` / `describe.skipIf`。

### D-11（低）文档和测试的过时之处

- `tests/e2e/sb-forward.preview.test.ts` 还有“Storage：签名链接是相对路径，拼上 /sb/storage/v1 后能取到”一条，架构 0.32 已把这一项从 TC-B0-43 划掉。
- 测试用例 TC-B0-89 写 3.3 D “八个” public RPC；0.32 加了 `files_authorize`，D1 和 14_public_rpc 样例按“九个”核。测试用例要改成九个（QA 下次改用例时一并改）。
- 任务单 FB-3 要交 `.dev.vars.example`，仓库里没有；而且 `.gitignore` 的 `.dev.vars.*` 会把它也忽略掉（需加 `!.dev.vars.example`）。任务单第四节第 4 步“从 .dev.vars.example 复制”现在照做不了。
- `src/public/manifest.webmanifest` 的 `icons` 是空数组（B1 主屏幕前要补；TC-B0-13 只核 start_url、scope）。

---

## 七、附：本轮的执行记录

- 日志在 QA 本机临时目录（不进仓库）：typecheck、lint、vitest（JSON 和 607 条用例名）、test:tz、deno test / check、test:db:offline、两次构建、size、check_arch、check:site / gate / files-rules、registry、req_index、tokens、build:site、Playwright（e2e.log）、actionlint、gitleaks，以及 15 处改坏抽查各自的输出。
- 改坏抽查和 pre-commit 实测的改动都已 `git restore` / 删除；交付前 `git status --short` 只剩本报告。
- 本轮没有做：任何要 Docker、预览环境、R2 的项；TC-B0-65 的 Tauri 壳；人工项。B0 签字前按“待实测总表”补做，结果补进本报告第二节。
