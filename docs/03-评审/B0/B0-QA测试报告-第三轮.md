# B0 QA 测试报告 · 第三轮（复验）

- **测试人**：QA 测试工程师
- **对象**：main `d9c1ba6`（“ci.yml：建库后跑邮箱登录探针（D-14）”），改动范围 `git diff e4804ff..d9c1ba6`（20 个文件，+421 / −46）
- **日期**：2026-10-28
- **范围**：只验[第二轮报告](B0-QA测试报告-第二轮.md)没通过的部分（D-12、D-13、D-14、D-15 的 M3 一处、D-09）和这次的改动；再按 ci.yml db 任务完整跑一遍真库、跑全套本机检查，确认没有回退
- **依据**：[返工-后端](返工-后端.md)“第三次（QA 第二轮）”；[返工-架构师](返工-架构师.md)“第三次（0.35）”；架构设计 v4 0.35；测试用例 v4
- **环境**：Windows 11，Node 24.19.0，Deno 2.9.8，Docker Desktop 29.9.2，Supabase CLI 2.120.0，LocalStack 4.14.0。没有预览环境凭据，R2 没开通
- **做法**：在主仓库直接跑，开始时 `git status` 干净。改坏抽查每处改完就 `git checkout --` 还原，改过迁移的还原后再 `db reset` 一次。临时脚本放在系统临时目录，测完已删除。结束时 `supabase stop --no-backup`、`node build/objstore.mjs down` 都已执行，`docker ps` 为空，**`git status` 只多本报告**。只用 `supabase status` 给的本机测试值（CLI 每次随机生成），没有读取或输出任何真实密钥

---

## 结论：**通过**　评分 **8.6 / 10**

- 第二轮两条高级缺陷 **D-12、D-14 都修好了**，而且补的测试**拦得住**：devices 的删、改策略改坏 5 种写法，真库和离线库都报错；`config.toml` 改回旧写法、或者把禁止注册打开，登录探针都报错（退出码 1）。
- **D-13 可以结案**：TC-B0-75 已由架构 0.35 正式挪到 B5（照 0.33 挪 116、117 的做法），计数都对得上。
- **D-15 的 M3 一处拦住了**：第二轮的 12b 原样和 5 种变体都报错，合规写法不报。F 规则的几种绕过按约定留 B1（低）。
- **ci.yml db 任务完整跑一遍全部通过**（含新加的登录探针 21 项），**全套本机检查 0 失败**，没有回退。
- D-09 仍然是部分修好，**不阻断 B0**（理由见第四节）。

没有未解决的 P0 / P1。扣分在：D-15 的 F 规则绕过、D-16 的几处小问题还在（都是低，按约定 B1），文档里几处 TC-B0-75 的引用没跟着改，TC-B7a-25 没写“Email 登录方式开”（见第九节）；另有 17 项要等 R2 或预览环境才能验。

---

## 一、第二轮缺陷复查

| 编号 | 第二轮问题 | 这次做了什么 | QA 复查方法 | 结论 |
|---|---|---|---|---|
| **D-12（高）** | devices 删、改策略里的 session_id 条件删掉后，所有检查照样通过 | `01_client_rls.test.sql` 加 12 条（plan 48 → 60）：A 以会话 1 改、删会话 2 的设备，改、删 session_id 为空的设备，各两条（不报错、行不变）；对照：本机那一行能改、能删 | 改坏 16b～16f 共 5 种（见第三节），真库 pgTAP 和离线库都跑 | **修好**：5 种都被拦住 |
| **D-13（中）** | TC-B0-75 剩下的一半没做，也没正式挪批 | 架构 0.35 第 1 条：整行挪到测试用例 8.1 节（B5），编号不变；CI 越界那一半（F3、F4）并入 TC-B0-35 留在 B0；1.3、15.4 S-B0 / S-B5、任务单、第 18 节都改了 | 核对挪后的用例行和计数（第五节） | **结案**（按正式挪批） |
| **D-14（高）** | `[auth.email] enable_signup = false` 把邮箱登录整个关掉 | `config.toml` 改成 true，注释写清两个开关的区别；新加 `supabase/tests/auth/login-probe.mjs`，主持人接进 ci.yml db 任务（在“从头建库”之后）；架构 15.6、环境清单、负责人清单第 ⑨ 节都写明“Email 登录方式开着，只关 Allow new users to sign up” | 跑探针；QA 自己手动重放第二轮的场景；把配置改回去看探针能不能报出；核对三份文档的口径（第二节） | **修好** |
| **D-15（低）M3 一处** | `alter column features set default` 打开开关不报（改坏 12b） | check_backend M3 认 `alter table [if exists] [only] app_config … alter [column] features set default`；默认值不是 JSON 字面量就直接报 | 12b 原样加 5 种变体（第三节） | **这一处修好**；F 规则绕过（11b）按约定留 B1，仍是低 |
| D-09（低） | pre-commit 钩子要手动启用，没有提示 | 没改 | 见第四节 | **仍部分**，不阻断 |
| D-16（低） | 严格模式的日志措辞、生成器没接真库等 | 没改（不在这次范围） | 严格模式仍打印“54 条全部真跑并通过”（其中 3 条是放行的 todo） | 仍在，低 |

另外复查了两处顺带的改动：

- **0004 `files_authorize_impl` 的 get 也查隐私记**（架构 0.34 第 2 条）：05 文件加 2 条（原图、缩略图 get → `bad_bucket`），真库 59 条全过；生成的类型和仓库逐字一致。
- **`unit.yml` 步骤名**“M1～M3”改“M1～M6”：只改名字，actionlint 0 问题。

---

## 二、D-14 复验

### 1. 探针（`node supabase/tests/auth/login-probe.mjs`）

在 `supabase db reset` 之后跑（和 ci.yml 顺序相同）：**21 项全部符合，退出码 0**。

| 项 | 结果 |
|---|---|
| ① `/auth/v1/settings` | `external.email = true`、`disable_signup = true`、匿名登录关、手机登录关 |
| ② 未知邮箱发码 | 422 `signup_disabled` “Signups not allowed for this instance”，`auth.users` 里没建出行 |
| ③ 已有用户发码 | 200；Mailpit 收到一封；验证码 6 位；没写 locale 的用户收到中文，`ko-KR` 的用户收到韩文 |
| ④ 60 秒内第二次 | 429 `over_email_send_rate_limit` |
| ⑤ 有效期 | 发码时刻往回拨 601 秒后 403 `otp_expired`；拨回 590 秒还能登录 |
| ⑥ 真 JWT | sub 是 A、role 是 authenticated、有 session_id、`auth.sessions` 里有这一行、`exp − iat = 600` |

### 2. QA 自己手动重放第二轮的场景（不经探针）

auth 容器的环境变量（只看开关，不看密钥）：`GOTRUE_EXTERNAL_EMAIL_ENABLED=true`、`GOTRUE_DISABLE_SIGNUP=true`、`GOTRUE_EXTERNAL_PHONE_ENABLED=false`、`GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false`、`GOTRUE_MAILER_OTP_EXP=600`、`GOTRUE_MAILER_OTP_LENGTH=6`、`GOTRUE_JWT_EXP=600`、`GOTRUE_SMTP_MAX_FREQUENCY=1m0s`。

QA 另写一个一次性脚本（测完已删除）：

| 情形 | 第二轮（改前） | 这次 |
|---|---|---|
| 已有用户 A（admin 接口建、邮箱已确认）`/otp`，`create_user: false` | 422 “Email logins are disabled” | **200，Mailpit 收到 1 封** |
| 未知邮箱 `/otp`，`create_user: true` | 422 | 422 `signup_disabled` “Signups not allowed for this instance” |
| 未知邮箱 `/otp`，`create_user: false` | — | 422 `otp_disabled` “Signups not allowed for otp” |
| 未知邮箱 `/signup`（邮箱加密码） | — | 422 `signup_disabled` |
| 匿名登录 `/signup` 空请求体 | — | 422 `anonymous_provider_disabled` |

禁止注册的几个入口都还是拒绝，已有用户能登录，和 15.6 总表一致。

### 3. 探针拦不拦得住（改坏配置）

| # | 改坏 | 探针结果 |
|---|---|---|
| 23 | `[auth.email] enable_signup` 改回 false（第二轮的原样），重启 | **退出码 1，12 项不符合**（①“external.email = false”、③“Email logins are disabled”等） |
| 24 | `[auth] enable_signup` 改 true（把注册打开），重启 | **退出码 1，3 项不符合**（① `disable_signup = false`；② 未知邮箱 200、建出了用户） |

两处测完都用 `git checkout --` 还原、重启，再跑一次探针：全部符合。

小问题（低，不阻断）：改坏 24 时探针建出了未知邮箱的用户，但 `finally` 只删它自己用 admin 接口建的那两个，这个用户留在本地库里。只影响本机测试库，CI 每次都是新库。建议后端顺手在 `finally` 里按 `emailX` 也删一次。

### 4. 控制台口径会不会让人把 Email 登录整个关掉

| 文档 | 位置 | 写法 | 结论 |
|---|---|---|---|
| 架构 15.6 第 1 点总表 | 第 3926～3927、3940 行 | “Allow new users to sign up：关，**只关这一项**”；新加一行“Email 登录方式：**开，不能关**”，写明关了以后已有用户也收不到验证码；表后写了 `config.toml` 两个开关分别对应什么 | 清楚 |
| 环境清单第二节 | 第 35、36 行 | 原来那行加“Email 登录方式保持开、不要关”；关闭公开注册单列一行“只关 Allow new users to sign up，不要用关 Email 登录方式来代替” | 清楚 |
| 负责人 B0 网页操作清单第 ⑨ 节 | 第 226、229 行 | “点开 Email：总开关**保持开，不要关**——关了以后所有人都收不到验证码”；第 2 点写明关公开注册只关哪一个；控制台名称写“以实际为准” | 清楚，负责人照着做不会关错 |
| TC-B1-06（预览项目 Auth 设置） | 测试用例第 272 行 | 加了“Email 登录方式开（已有账号能收到验证码，新邮箱回 Signups not allowed）” | 清楚 |
| `config.toml` 注释 | 第 121～128、158 行 | 写明这一项是“邮箱登录方式”的总开关、必须 true；`[auth.sms]` 同理保持关 | 清楚 |

全仓库搜“关 Email”“Email … 关 / disable”一类写法，没有别的地方会让人把 Email 登录方式关掉。只有一处没跟上：**TC-B7a-25（正式项目上线前核对）**的期望写了“匿名登录关、公开注册关、Secure email change 开”，没写“Email 登录方式开”。它引用的是 15.6 第 1 条，总表里已经有这一行，所以不算漏洞，但建议架构师同步写进去（低，B7a）。

---

## 三、改坏抽查

每处改完立刻还原；改了迁移的，还原后再 `db reset`，之后真库 pgTAP 251 条全过。

| # | 改了哪里、怎么改坏 | 跑什么 | 拦住没 | 谁拦的 |
|---|---|---|---|---|
| 16b | `0001` devices 的 `del` 策略去掉 session_id 条件（**第二轮原样**） | check_backend；test:db:offline；真库 `db reset` + pgTAP | **拦住** | 01 第 18 条“A 以会话 1 删不了会话 2 的设备”、第 20 条“删不了 session_id 为空的设备”（离线、真库都失败）。check_backend 0 错误（不归它管，属正常） |
| 16c | `upd` 策略的 using 去掉 session_id 条件（with check 保留） | 离线；真库 | **拦住** | 01 第 13、15 条（改会话 2 的行时被 with check 报错，不是悄悄过滤） |
| 16d | `upd` 的 using 和 with check 都去掉 session_id 条件 | 离线 | **拦住** | 01 第 14 条“改不了会话 2 的设备”（行真被改了）、第 15 条 |
| 16e | `del` 改成 `session_id is null or session_id = JWT 的会话`（允许删没会话的行） | 离线 | **拦住** | 01 第 20 条 |
| 16f | `upd` 的 using 和 with check 都改成“为空或等于 JWT 的会话” | 离线；真库 | **拦住** | 01 第 15 条：改空会话的行时触发器 `devices_session_guard` 报 `session_revoked`（第二道防线），用例按“不报错”断言，所以失败 |
| 12b | `0005` 末尾 `alter table public.app_config alter column features set default '…note on:true…'`（**第二轮原样**） | check_backend | **拦住** | M3“note 不是 on: false” |
| 12d | 同上，改成大写、省 `column`、带 `::jsonb` | check_backend | **拦住** | M3 |
| 12e | 同上，分成三行写，打开 anniv | check_backend | **拦住** | M3“anniv 不是 on: false”，行号指到 `set default` 那一行 |
| 12f | 默认值用 `$$…$$` 括起来 | check_backend | **拦住** | M3“只准写 JSON 字面量” |
| 12g | `alter table if exists app_config … set default jsonb_set(…)` | check_backend | **拦住** | M3“只准写 JSON 字面量” |
| 12h | 对照：`set default` 只有 event、todo 开着 | check_backend | 0 错误（正确，不误报） | — |
| 23 | `config.toml` `[auth.email] enable_signup = false`（第二轮原样） | 登录探针 | **拦住** | 12 项不符合，退出码 1 |
| 24 | `config.toml` `[auth] enable_signup = true` | 登录探针 | **拦住** | 3 项不符合，退出码 1 |

合计改坏 12 处（不算对照 12h），**12 处全部拦住**。第二轮没拦住的 3 处里，16b、12b 这次拦住了；11b（F 规则绕过）按约定留 B1，没有重测。

---

## 四、D-09 还是“部分”：阻不阻断 B0

现状：README 第 25～28 行写了 `git config core.hooksPath .githooks` 和核对方法；check_arch 没有“钩子没启用”的提示。**这台电脑上 `git config core.hooksPath` 仍然是空的**，所以 TC-B0-58“本机提交被拦”在这台电脑上不成立。

判断：**不阻断 B0。**

1. 钩子本身在（`.githooks/pre-commit`，找不到 gitleaks 也拒绝提交），差的只是每台电脑执行一次启用命令，README 第一步已经写了。
2. 第二道防线在 CI：`unit.yml` 的“密钥扫描（gitleaks，CI 第二道）”每次 PR 都扫全部历史，`--exit-code 1`；QA 本机按同样的参数扫 299 个提交，no leaks found。
3. 漏掉的后果是“推上去以后才被 CI 拦”，不是“漏进仓库没人发现”。

建议（低）：B0 签字前请负责人和每个开发用的电脑执行一次启用命令并核对；“钩子没启用就警告”仍按第二轮建议交前端 A，可以随 B1 做。

---

## 五、D-13：TC-B0-75 挪批核对

| 核对项 | 结果 |
|---|---|
| 测试用例 3.2 节（B0） | TC-B0-75 那行已删 |
| 测试用例 8.1 节（B5） | 第 653 行，编号不变；写明随批累积（B5 两个桶、B4b-1 起五个、B7a 起六个）、静态检查和 vault-image upload 同一个 PR、违规样例两处、Uint8Array 反例；objstore 不带 contentType 抛 `bad_input` 已由 B0 的单测覆盖，不重复 |
| TC-B0-35 | 并入 CI 越界一半（F3、F4），期望写“越界引用 objstore 或读 `R2_*` 的 CI 失败（第二轮改坏 11 已验）” |
| 第 18 节计数 | QA 按“级别”“冒烟”两列重新数了一遍：B0 117 条（第 3 节 163 行减 46 条注销用例）、自动冒烟 100、P0 68；B5 49 / 40 / 24。和表里写的一致，合计不变 |
| 架构 1.3、15.4、任务单 | S-B0 去掉了 TC-B0-75 的要求，S-B5 加上了，任务单的修改记录也写了 |

**可以结案**：理由（B0 一个服务器上传函数都没有，现在写静态检查只能扫出 0 处，证明不了什么）和 0.33 挪 116、117 一样，而且这次是由架构师正式改的批次。

几处引用没跟着改（低，不影响结论）：`build/check_backend.py` 第 13 行、`tests/build/check-backend.test.ts` 第 50 行、`tests/arch-fixtures/check_backend/f3-objstore-scope/.../index.ts` 第 1 行、`unit.yml` check_backend 那一步的名字，都还写“TC-B0-75”。按 0.35 的口径，F3 现在属于 TC-B0-35。建议后端下次改这些文件时顺手改掉。

---

## 六、按 ci.yml db 任务完整跑一遍真库

env 用该文件 db 任务的替身测试值，按文件里的顺序逐步跑：

| 步骤 | 结果 |
|---|---|
| `supabase start -x studio`（0001～0007） | 通过，36 秒 |
| `node build/objstore.mjs up` | 四个条件全过（替身不校验签名，已知） |
| 严格模式（4 个文件） | 通过：54 条，51 条真跑通过，3 条是放行的 todo（116 一条、117 两条） |
| seed.mjs 两遍 + `--check` | 第一遍写入 14 个，第二遍已存在 14 个；四个桶 A、B 都有对象 |
| `supabase db reset` | 通过 |
| **登录探针（新步骤）** | **21 项全部符合** |
| gen types 和 `shared/db.types.ts` 比对 | 逐字一致 |
| `npm run test:db`：pgTAP | **5 个文件 251 条全过**（第二轮 237 条；01 +12、05 +2） |
| `npm run test:db`：`deno task d1` | D1 通过 |
| `d1_negative.mjs`（真库） | 反例和 24 个违规样例全部报出 |
| `deno task test`（带替身变量） | 94 通过 0 失败；“> 跳过”0 处；“条件写回 exists … ok” |
| `deno task check` | 通过 |
| 旧版契约基线 | 没有发布 tag，按设计跳过 |
| 兼容样例 2 个（每个之前都 `db reset`） | add_column 旧版照常；rename_column 旧版 42703 失败，都和预期一致 |
| `supabase stop --no-backup`、`objstore down` | 已执行 |

探针放的位置也核对了：在“从头建库”之后、gen types 之前；探针自己取 `supabase status`，地址不是 127.0.0.1 / localhost 就拒绝运行，不引用任何 secret；每跑一次发 3 封信，在每小时 30 封以内。`db reset` 之后容器重启，探针紧接着跑也没有出现连不上的情况。

---

## 七、全套本机检查

main `d9c1ba6`，`git status` 干净（不设替身变量）：

| 命令 | 结果 |
|---|---|
| `npm run lint` | 0 错误 0 警告 |
| `npm run typecheck`（5 份） | 0 错误 |
| `npx vitest run` | 55 个文件通过、1 个跳过；**709 通过、15 跳过、5 todo**（和第二轮相同，跳过和 todo 都是环境门槛） |
| `npm run test:tz` | 三个时区都通过（每个 93 通过、1 跳过） |
| `deno task test` | 93 通过 0 失败 1 ignored |
| `deno task check` | 通过 |
| `npm run test:db:offline` | 全过：pgTAP 01 60、02 57、03 41、04 34、05 59；D1 正例、反例、违规样例；兼容样例 |
| `npm run build -- --mode preview`、`npm run size` | 通过；首屏 JS 70.3 KB / 150 KB，全部 139.5 KB |
| `python -I build/check_arch.py` | 0 错误、2 警告（W2 缺 2027 年节假日，预期提醒） |
| `python -I build/check_backend.py` | 0 错误 |
| `python -I build/check_registry.py` | 本报告新建后要登记一行（见第九节） |
| `python -I build/req_index.py --check` | 需求 218 条，问题 0 |
| `python -I build/tokens.py --check` | 179 个，没定义 0，没用到 5（提示） |
| `npm run check:site`、`check:gate`、`check:files-rules` | 都通过 |
| `CI=true npx playwright test`（chromium + webkit） | 44 通过、2 跳过（csp.spec 预览组，要预览地址） |
| `actionlint`（4 个工作流） | 0 问题 |
| `gitleaks git --redact --log-opts="--all" .` | 299 个提交，no leaks found |

和第二轮相比没有回退。

---

## 八、仍待 R2 / 预览 / 后面批次的清单

和第二轮第五节相同，这次没有新增也没有减少。第 14 项“韩文模板”本地已由探针验过（admin 接口写 `user_metadata.locale`），只剩 invite-signup 真写 locale 这一半（B1）。

| # | 项 | 需要 |
|---|---|---|
| 1 | row_quota 在 Supavisor、fn_ai 直连下的 session_user（L5 ②③） | 预览项目 |
| 2 | pgvector / halfvec(768) | 预览项目 |
| 3 | private 暴露、pg_graphql 在线上 | 预览项目 |
| 4 | cron 超时、service_role statement_timeout | 预览项目 |
| 5 | Supavisor 事务模式 + `app.uid`、`prepare: false` | 预览项目，fn_ai 密码 |
| 6 | requireActiveUser 线上 | 预览项目 |
| 7 | Security Advisor 0 警告截图 | 预览控制台 |
| 8 | 经 `/sb/*` 的 REST、Auth、函数、Realtime；直连绕过；线上 `%` 编码 | 预览环境 |
| 9 | 免费版保活 | 预览项目 |
| 10 | 预览令牌权限、secrets 名字截图 | 负责人、运维 |
| 11 | R2 第五节 9 项（含签名错误） | **R2 开通（最晚 11-10）** |
| 12 | Tauri 壳上 Turnstile | QA 本机，Rust 工具链 |
| 13 | AI Studio 免费额度 | 负责人 |
| 14 | invite-signup 写 `user_metadata.locale` 后的韩文邮件 | B1 |
| 15 | TC-B0-116 / 117 整条链路 | 已挪 B4b-1 / B1 |
| 16 | 函数一侧伪造头、服务器函数契约、vault-image 上限 | B1、B2、B5 |
| 17 | CI 上 `d9c1ba6` 的实际运行结果（QA 看不到 Actions） | 负责人转告、主持人补 |

要 R2 或预览环境的是第 1～11 项和第 17 项，**共 12 项**（第 12、13 项是本机或负责人的事，第 14～16 项属于后面的批次）。另外，控制台 Email 登录方式开着这一项要等负责人做第 ⑨ 节后截图核对（TC-B1-06 / TC-B7a-25）。

---

## 九、剩下的问题（都是低，不阻断）

| # | 问题 | 建议交给 |
|---|---|---|
| 1 | D-15 F 规则的绕过写法：拼接变量名、`Deno.env.toObject()`、非字面量的动态 import | 后端，B1（已约定） |
| 2 | D-16：严格模式日志写“54 条全部真跑”（其中 3 条是放行的 todo）；授权生成器没接真库；TC-B0-12、27、80 的小缺口 | 运维、前端 B、后端，B1 |
| 3 | D-09：钩子没启用时没有提示；这台电脑还没启用 | 前端 A（提示）；负责人和开发各自执行一次启用命令 |
| 4 | 第五节说的 4 处“TC-B0-75”引用没改成 TC-B0-35 | 后端、运维，顺手 |
| 5 | TC-B7a-25 没写“Email 登录方式开” | 架构师，B7a 之前 |
| 6 | 登录探针在注册被误开时，留下未知邮箱建出的用户（只影响本机库） | 后端，顺手 |

---

## 十、分数和结论

| 维度 | 第二轮 | 第三轮 |
|---|---|---|
| 本机检查 | 全绿 | 全绿，没有回退 |
| P0 冒烟覆盖 | TC-B0-89 devices 反例缺（D-12）；TC-B0-75 一半没做（D-13） | D-12 已补并验过拦得住；TC-B0-75 已正式挪到 B5 |
| 真环境 | 1 项不符合（D-14） | ci.yml db 任务全部通过，含新的登录探针 |
| 改坏抽查 | 20 处拦住 17 | 这轮 12 处全部拦住（第二轮没拦住的 16b、12b 都拦住了） |
| 第二轮缺陷 | — | D-12、D-14 修好；D-13 结案；D-15 的 M3 修好（F 规则留 B1）；D-09 仍部分（不阻断） |

**评分 8.6 / 10，通过。** 没有未解决的 P0 / P1；第九节 6 条都是低，按各自批次处理即可。B0 签字前还要等第八节里要 R2 或预览环境的 12 项。

本报告是新文件，`文件登记册.md` 要加一行（QA 不改别人的文档，请主持人登记）。
