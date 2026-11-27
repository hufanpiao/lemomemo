# B0 QA 测试报告 · 第二轮（返工验收）

- **测试人**：QA 测试工程师
- **对象**：main `8c07819`（“B0 第二次返工合并后真库复测；严格模式纳入三组替身测试并加 --allow-todo”），返工范围 `git diff 14ae558..8c07819`（245 个文件，+5753 / −895）
- **日期**：2026-10-28
- **依据**：[第一轮报告](B0-QA测试报告.md)（6.5 分，不通过，缺陷 D-01～D-11）；[测试用例 v4](../../06-测试/测试用例-v4.md)（0.33 起 TC-B0-116 挪 B4b-1、117 挪 B1）；[后端 B0 实测清单](后端-B0实测清单.md) L1～L19；返工回报：[后端](返工-后端.md)、[前端 A](返工-前端A.md)、[前端 B](返工-前端B.md)、[运维](返工-运维.md)、[架构师](返工-架构师.md)、[主持人-真库实测](主持人-真库实测.md)
- **环境**：Windows 11，Node 24.19.0，Deno 2.9.8，Playwright 1.64.1，**Docker Desktop 29.9.2**，Supabase CLI 2.120.0（`%LOCALAPPDATA%\lemo-tools\`），本地 Postgres 17.11、PostgREST 16.4、GoTrue 2.197.0、LocalStack 4.14.0。没有预览环境凭据，R2 未开通
- **做法**：在主仓库直接跑（开始时 `git status` 干净）；改坏抽查每处改完立刻 `git checkout --` 还原；临时探针函数、临时改的 `config.toml` 都已删除 / 还原。结束时 `supabase stop --no-backup`、`node build/objstore.mjs down` 已执行，`docker ps` 为空，**`git status` 干净**（本报告除外）。全程只用了 `supabase status` 给的本机测试值（CLI 每次随机生成），没有读取或输出任何真实密钥

---

## 结论：**不通过**　评分 **7.5 / 10**

和第一轮比，进步很大：

- D-01～D-11 共 11 条，**9 条修好**、2 条部分修好（D-01 第 5 点 TC-B0-75 的 contentType 静态检查和“六个桶各传一次”没做；D-09 只写了文档、没加提示）。
- 第一轮“待 Docker”的 14 项**全部跑完**：按 ci.yml db 任务逐步跑一遍全过（pgTAP 237 条、D1 真库正例和 25 个反例 / 违规样例、严格模式 54 条、seed 两遍、db reset 两遍、gen types 逐字一致、Deno 94 条、兼容样例 2 个）；L5～L10、L13、L16～L18、P7 本地版也做了。
- 改坏抽查 20 处，18 处被拦住；第一轮没拦住的 3 处（4b、9、10）这次全部拦住。
- 全套本机检查 0 失败。

不通过的原因是两条**新发现的高级缺陷**（都是小改动就能修）：

1. **D-12（高，TC-B0-89 P0 必含反例没有测试）**：“authenticated 删、改 devices 只能动 session_id 等于 JWT 的那一行”没有任何测试。QA 把 devices 删除策略里的 session_id 条件删掉，check_backend、离线库、真库 pgTAP、表 × 角色 × 操作生成器**全部照样通过**。
2. **D-14（高）`supabase/config.toml` 把邮箱登录整个关掉了**：`[auth.email] enable_signup = false` 在 CLI 里对应 `GOTRUE_EXTERNAL_EMAIL_ENABLED=false`，本地连**已有用户**都收不到验证码（“Email logins are disabled”）。实测清单 L14“Mailpit 收一封 A 的登录验证码”、L17“A 的真登录令牌”照原样做不了；B1 的登录流程本地和 CI 都跑不起来。QA 临时把这一项改成 true 验证：未知邮箱仍被拒（“Signups not allowed”），已有用户能登录，其余 L14 预期都符合。

8 分以上需要：D-12 补 pgTAP（同用户另一会话的设备、session_id 为空的行，删和改各一条），D-14 改 config.toml 一行并补一条本地登录的自动测试；TC-B0-75 剩下的部分由架构师像 116、117 那样正式挪到 B1，或者现在补检查（见 D-13）。

---

## 一、D-01～D-11 复查

| 编号 | 第一轮问题 | 返工做了什么 | QA 复查方法 | 结论 |
|---|---|---|---|---|
| D-01 ① TC-B0-35 | 没有检查 `SUPABASE_DB_URL`、db.ts 的引用方 | `build/check_backend.py` F1、F2（含间接 import），接进 unit.yml | 改坏 11：新建 `push-dispatch` 读 `SUPABASE_DB_URL`、import db.ts、读 `FN_VAULT_DB_URL` → F1、F2 都报 | **修好**（绕过写法见 D-15，低） |
| D-01 ② TC-B0-92 | security definer 漏 search_path 拦不住 | 静态 M1 + D1 查 `pg_proc.proconfig`，样例 22 | 改坏 9（第一轮原句）→ M1、M4、D1 都报；真库查询：public、private 里没设 `search_path=""` 的 definer 函数 0 个 | **修好** |
| D-01 ③ TC-B0-97 ④ | `disabled_at` 规则、cron 带 account_usable | F5（主持人定放在 check_backend，不另加 check_arch 规则）；D1 cron 检查 + 样例 24 | 改坏 11：`note-search/helper.ts` 出现 disabled_at → F5 报；样例 24 离线、真库都报出；真库 cron 2 个，cleanup-batch 在 `CRON_WITHOUT_USABLE` 留痕 | **修好** |
| D-01 ④ TC-B0-73 | grant 紧跟、授权汇总比对、0001 先后、索引位置 | M2（收紧到“紧跟”）、M4（和架构 3.3 C、附录 A 逐行比）、M5、M6 | 改坏 13：grant 挪到建触发器之后 → M2 报；改坏 14：0005 加一句 3.3 C 没有的 grant → M4 报 | **修好** |
| D-01 ⑤ TC-B0-75 | CI 越界检查、服务器上传带 contentType 的静态检查 | F3、F4 做了；**contentType 静态检查、六个桶各传一次没做**（后端：B0 还没有任何上传函数） | 改坏 11：push-dispatch import objstore、读 `R2_FN_SECRET_ACCESS_KEY` → F3 报 | **部分**，见 D-13 |
| D-01 ⑥ TC-B0-89 / 93 | 生成器不存在；11 张表 export 必须 none | 生成器 `tests/data-manifest/grant-matrix.ts` + runner（PGlite 上 780 格）；D1 查 export | 改坏 15、16：多给 authenticated `DELETE todos`、多给 `disabled_at` 列 update 权限 → 生成器都报；export 反例离线报出 | **修好**；但 TC-B0-89 必含反例里的 devices 会话行没覆盖，见 D-12 |
| D-02 | `/sb` 拒绝名单能用 `%` 编码绕过 | 按架构 0.33 第 10 条：路径里出现 `%` 一律本地 404 | 原来 4 个复现路径 + 大小写变体都 404（`sb-encoded-path.test.ts` 31 条）；改坏 17：字符表放回 `%` → 12 条失败 | **修好**（线上 Cloudflare 规整仍待预览） |
| D-03 | TC-B0-116、117 空壳 | 架构 0.33 第 1 条正式挪到 B4b-1、B1；空 `it` 改 `it.todo`，测试用例同步 | 测试用例修改记录、1.3 已改；三个 todo 都写明要等的函数；严格模式只放行这两条 | **修好**（按挪批次处理） |
| D-04 | CI 不跑打真替身的 Vitest | ci.yml db 任务加严格模式（4 个文件、4 个 `--must`、2 个 `--allow-todo`）、seed 两遍 + `--check`、Deno 侧 grep 跳过 | 本机按 ci.yml 原样跑：54 条，51 真跑通过、3 条是放行的 todo；改坏 18～20（见第三节）都失败 | **修好** |
| D-05 | actionlint 没进 CI | unit.yml 新任务 workflow-lint（带 shellcheck，版本锁在 ci-tools.lock） | 本机 actionlint 0 问题 | **修好** |
| D-06 | 违规样例不按规则号核；缺 T1、W3、400 ms 样例 | 样例头 `rule=`；`tests/arch/coverage.test.ts` 按架构 2.3 规则表核；补 T1、W3、TC-B0-10 样例 | 改坏 10（第一轮原样：移走 a13 三个样例）→ “A13：规则无违规样例” | **修好** |
| D-07 | data 引别的功能 data 没样例 | `a1-data-imports-other-feature-data.ts` + 真引用目标 | 改坏 4b（第一轮原样）→ 1 条失败 | **修好** |
| D-08 | 样例 01 的 expect 不含表名 | expect 改成带 `public.qa_probe` | 离线、真库都按新 expect 报出 | **修好** |
| D-09 | pre-commit 钩子要手动启用 | README 第一步写 `git config core.hooksPath .githooks` 和核对办法 | README 第 25～28 行有；**check_arch 没有“钩子没启用”的提示**（运维建议只警告，归前端 A，未做） | **部分**（低，不阻断） |
| D-10 | E2E“没带版本号”实际带 3.9.0；占位测试显示通过 | files.spec 真不带头；占位统一 `describe.skipIf`；严格模式把“跳过”开头的通过用例当失败 | 改坏 6（第一轮原样）→ E2E chromium 1 条失败（expected 426, received 200） | **修好** |
| D-11 | 过时测试、八个 RPC、`.dev.vars.example`、icons | 删过时一条；测试用例改九个；交 `.dev.vars.example`、`.gitignore` 加例外；icons 归 B1 | 文件在、`git check-ignore` 不忽略；测试用例 TC-B0-89 写九个 | **修好**（icons 按约定 B1） |

---

## 二、第一轮“待 Docker”项结果

按 `.github/workflows/ci.yml` 的 db 任务逐步跑（env 用该文件的替身测试值；`--must` 不带开头的 `/`）：

| 步骤（ci.yml 顺序） | 结果 |
|---|---|
| `supabase start -x studio`（0001～0007） | 通过，36 秒 |
| `node build/objstore.mjs up` | 通过：四个条件（SigV4 path-style、If-None-Match 412、ListObjectsV2 分页、DeleteObjects）全过；信息：替身不校验签名（已知，签名错误要在 R2 上验） |
| 替身变量都在 | 通过 |
| 严格模式（4 个文件） | **通过**：54 条，51 真跑通过，3 条 todo（116 一条、117 两条，被两个 `--allow-todo` 放行） |
| seed.mjs 两遍 + `--check` | 第一遍写入 14、第二遍已存在 14；images A3/B3、files A2/B2、vault-images A1/B1、vault-files A1/B1 |
| `supabase db reset` | 通过（QA 连跑两次，都没有报错、没有“角色已存在”） |
| gen types 和 `shared/db.types.ts` | **逐字一致** |
| `npm run test:db`：pgTAP | **5 个文件 237 条全过** |
| `npm run test:db`：`deno task d1` | **D1 通过** |
| `d1_negative.mjs`（真库） | 反例 1 个 + 违规样例 24 个**全部报出** |
| `deno task test`（带替身变量） | 94 通过 0 失败；“> 跳过”0 处；“条件写回 exists … ok” |
| `deno task check` | 通过 |
| 旧版契约基线 | 没有发布 tag，按设计跳过 |
| 兼容样例 2 个（每个前 db reset） | sample_add_column 旧版照常；sample_rename_column 旧版 42703 失败，都和预期一致 |
| `supabase stop --no-backup`、`objstore down` | 已执行 |

第一轮待实测总表中要 Docker 的各项：

| # | 项（清单号） | 结果 | 对应 TC |
|---|---|---|---|
| 1 | db reset 连跑两次（L1）；remind_queue 的 check；没有 legacy_id | **通过**：两次 0 报错；`remind_queue_table_name_check` 在；legacy_id 列 0 个 | TC-B0-20、77 |
| 1 | Realtime publication（L13） | **通过**：10 张（9 张同步表 + tombstones） | TC-B0-21 |
| 2 | pgTAP（L2）、`\ir _helpers.psql`（L3） | **通过**：237 条；`\ir` 能找到 | TC-B0-32～38、53～55、67、69～81、86～88、94～97、99～105 |
| 3 | D1 真库正例 + 违规样例（L4） | **通过** | TC-B0-21～28、74、78、81、92～95、118 |
| 4 | row_quota 四种连接（L5） | **部分**：④ 迁移连接 `session_user = postgres`、role `none`（满足豁免）；①（经 PostgREST 时请求角色是 authenticated / service_role，L6、L17 印证）。**② Supavisor 本地没有（CLI 不起 pooler）、③ fn_ai 直连要密码**，仍待预览（P6） | TC-B0-37、71 |
| 5 | L6 触发器看请求角色 | **通过（第一道就挡了）**：A 经 PostgREST 改自己的 `disabled_at` → 403 / 42501（列级授权先拦，触发器那道没走到，pgTAP 02 另有触发器断言）；改 display_name 204；service_role 改 disabled_at 200 | TC-B0-72、97 |
| 5 | L7 auth.users 插入、级联删除 | **通过**：QA 经 admin 接口建用户、`delete from auth.users` 级联删掉 profile、notes、note_images | — |
| 5 | L8 service_role 在 public 上的默认授权 | **通过**：15 张表都有全部 7 种权限 | TC-B0-85、92 |
| 5 | L9 成员关系、版本 | **通过**：fn_vault、fn_ai 只有 postgres 一个成员（admin t、inherit f、set f）；server_version 17.11，和 config.toml `major_version = 17` 一致 | TC-B0-33、77、83 |
| 5 | L10 `with set true` | **通过**（pgTAP 全过即证明能授） | TC-B0-34、86、87 |
| 6 | L14 config 生效、private 暴露、GraphQL、Mailpit | **不通过 → 见 D-14**。照原样：`/auth/v1/settings` 里 `external.email = false`，A 发码 422 “Email logins are disabled”。QA 临时把 `[auth.email] enable_signup` 改 true 后复测：`disable_signup: true`、匿名登录关；未知邮箱 422 “Signups not allowed”；A 的验证码 6 位、正文提到 10 分钟有效；60 秒内第二次发码 429；private 24 张表 anon 401 / authenticated 403，全是 42501；`/graphql/v1` 406 PGRST106（graphql_public 不暴露）、库里没装 pg_graphql。**韩文模板没验到**：A 是 admin 接口建的，没有 `user_metadata.locale`，邮件显示中文（这一半要 invite-signup，B1） | TC-B0-81、82；15.6 |
| 6 | private 函数经 REST（P2 本地版） | **通过**：anon 调任何 private 函数都 401 / 42501（schema 没授 usage）；authenticated 调 account_usable、session_alive、admin_set_disabled、purge_vault_impl、cleanup_batch、long_transactions 都 403 / 42501；只有白名单里给 authenticated 的（is_active、table_meta_of、record_consent_impl、purge_deleted_impl、files_authorize_impl）能调。`files_authorize_impl` 经 `/sb` 走不到（拒绝名单按前缀 `/rest/v1/rpc/files_authorize` 一并挡住） | TC-B0-81、82 |
| 7 | gen types（L15） | **通过**：逐字一致；离线脚本已删 | 架构 2.5 |
| 8 | Auth 连不上回 try_later（L16） | **通过**：QA 临时建一个只调 `requireActiveUser` 的函数（测完删掉），`supabase functions serve`：① 正常 200；② admin_set_disabled 后 403 account_disabled；③ 冷静期 403 account_pending_deletion + purge_after；④ 会话吊销 401 session_revoked；⑤ 解除后 200；⑥ `docker stop` auth 容器后 **503 try_later**；⑦ 恢复后 200。这也是 P8 的本地版 | 第 6 节；0.29 续第 110 条 |
| 9 | files_authorize 经 PostgREST + 真 JWT（L17） | **通过**（在 D-14 的临时配置下登录）：真 JWT 里**有 session_id**；put 自己的图 `{ok:true}`；put B 的图 `not_owner`；只带 anon key 401 / 42501；过期令牌 401 PGRST303；get 101 项 400 / 22023 `too_many_items`；put 2 项 400 `put_one_item`；清计数后**第 31 次** put `rate_limited`（HTTP 200）；停用后 `account_disabled`；会话吊销后 `session_revoked`。状态码：入参错 400、业务拒绝 200 带 error，前端 B 的 `/files` 照此对应 | TC-B0-99～105 |
| 10 | storage.buckets、存储策略（L18） | **通过**：只有 backups、vault-preview；storage 下 0 条策略（Supabase 本地没带默认策略） | TC-B0-74、118 |
| 11 | S3 替身（L19） | **通过**（见上表） | 任务单 O-1 |
| 12 | 签 `role: fn_ai` 的 JWT 打 REST（P7 本地版） | **通过**：fn_ai、fn_vault 都 403 “permission denied to set role”；authenticator 不是两个角色的成员；用的是本地 CLI 的 JWT 密钥，没碰预览项目 | TC-B0-83 |
| — | halfvec（P1 本地版） | 本地 `'[1,2]'::extensions.halfvec(2)` 能用；预览项目仍待测 | TC-B0-61 |
| 13、14 | TC-B0-116、117 整条链路 | 按架构 0.33 挪到 B4b-1、B1，不再算 B0 | — |

---

## 三、改坏抽查

每处改完立刻 `git checkout --`（或移回 / 删除）还原，跑完 `git status` 干净。

| # | 改了哪里、怎么改坏 | 跑什么 | 拦住没 | 谁拦的 |
|---|---|---|---|---|
| 4b | `eslint.config.js` 第 54 行 feature-data 的 `same('feature-data')` 改 `...any('feature-data')`（第一轮没拦住） | `vitest tests/arch` | **拦住** | eslint.test.ts › a1-data-imports-other-feature-data.ts |
| 9 | `0007_search.sql` 末尾加不带 search_path 的 definer 函数（第一轮原句，第一轮没拦住） | check_backend；test:db:offline | **拦住** | check_backend M1 + M4；D1 “没设 search_path = ''” |
| 10 | 移走 `tests/arch-fixtures/eslint/a13-*`（第一轮没拦住） | `vitest tests/arch` | **拦住** | coverage.test.ts “A13：规则无违规样例” |
| 6 | `version-gate.ts` 没带版本头也放行（`!client \|\|` → `client &&`） | Playwright files.spec（chromium） | **拦住** | E2E “没带版本号 426”：received 200（第一轮 E2E 没拦住，D-10） |
| 11 | 新建 `supabase/functions/push-dispatch/index.ts`：import `_shared/gen/objstore.ts`、`_shared/db.ts`，读 `SUPABASE_DB_URL`、`R2_FN_SECRET_ACCESS_KEY`、`FN_VAULT_DB_URL`；`note-search/helper.ts` 出现 `disabled_at` | check_backend | **拦住**（6 处） | F1、F2 ×2、F3 ×2、F5 |
| 11b | 同一函数改成**拼字符串读变量**（`['SUPABASE','DB','URL'].join('_')`）、`Deno.env.toObject()`、`import('../_shared/' + 'db.ts')` | check_backend | **没拦住**（只报出字面量的 objstore 动态 import） | — 见 D-15 |
| 12 | `0001_core.sql` 第 400 行 features 默认值 note 改 `on: true` | check_backend；offline | **拦住** | M3；pgTAP 04 两条 |
| 12b | `0005_anniv.sql` 末尾 `alter table public.app_config alter column features set default '…note on:true…'` | check_backend；offline | **没拦住**（0 错误、全过） | — 见 D-15（已有那一行不受影响，实际开关没打开，影响小） |
| 12c | `0005_anniv.sql` 末尾 `update "public"."app_config" set features = …`（带引号的名字） | check_backend；offline | **拦住** | M3；pgTAP 04 |
| 13 | `0003_notes.sql` guard_note_image 的 grant 挪到建触发器之后 | check_backend | **拦住** | M2“要紧跟建函数” |
| 14 | `0005_anniv.sql` 加 `grant select on private.counters to authenticated` | check_backend | **拦住** | M4“不在 3.3 C 汇总里” |
| 15 | `0002` 加 `grant delete on public.todos to authenticated` | `vitest grant-matrix.test.ts` | **拦住** | 生成器 TC-GRANT-public.todos-authenticated-DELETE |
| 16 | `0001` 第 138 行 profiles 的 update 列授权加 `disabled_at` | 同上 | **拦住** | 生成器 2 条失败 |
| 16b | `0001` devices 的 `del` 策略去掉 `session_id = JWT 的会话` | check_backend；offline；`vitest tests/data-manifest` | **没拦住**（0 错误、全过、47 通过） | — 见 D-12 |
| 17 | `functions/sb/[[path]].ts` 的 `PATH_CHARS_RE` 放回 `%` | `vitest tests/functions` | **拦住**（12 条失败） | sb-encoded-path.test.ts、sb-proxy.test.ts |
| 18 | 严格模式少放一个：只 `--allow-todo 'TC-B0-116 整条链路'` | vitest_strict.mjs | **拦住**（退出码 1） | “没真跑（todo）”×2 |
| 19 | 严格模式多放一个对不上的 `--allow-todo 'TC-B0-999'` | 同上 | **拦住** | “没有对上任何 todo” |
| 20 | 严格模式不设替身变量 | 同上 | **拦住** | “没真跑（skipped）”×4 |
| 21 | 第一轮原 D-02 的 4 条复现路径（未改代码，直接核） | sb-encoded-path.test.ts | 都回 404 | — |
| 22 | 临时把 `config.toml` 的 `[auth.email] enable_signup` 改 true（验证 D-14 的修法，不是改坏） | 本地登录探针 | — | 已有用户能登录、新邮箱仍拒；测完已还原 |

合计改坏 20 处（第 4b～20 项，不含 21、22），**17 处拦住、3 处没拦住**（11b、12b、16b）。第一轮没拦住的 3 处全部拦住；新加的检查每类都抽了：F 规则（11、11b）、M 规则（9、12～14）、生成器（15、16、16b）、`/sb` 的 `%`（17）、严格模式 `--allow-todo`（18～20）。

---

## 四、全套本机检查

`git status` 干净的 main `8c07819` 上（不设替身变量）：

| 命令 | 结果 |
|---|---|
| `npm run lint` | 0 错误 0 警告 |
| `npm run typecheck`（5 份） | 0 错误 |
| `npx vitest run` | 55 个文件通过、1 个跳过；**709 通过、15 跳过、5 todo**。跳过、todo 全是环境门槛：sb-forward.preview 8 + 2 todo（待预览）、compat/headers 2（要本地 Supabase）、objstore / objstore-cases / purge-runner / files-get 共 5（要替身，CI 严格模式里真跑）、116 一条、117 两条 todo |
| `npm run test:tz` | 三个时区全过（每个 93 通过 1 跳过） |
| `deno task test` | 93 通过 0 失败 1 ignored（带替身变量时 94 通过） |
| `deno task check` | 通过 |
| `npm run test:db:offline` | 全过：pgTAP 01 48、02 57、03 41、04 34、05 57；D1 正例；24 个违规样例；清单反例；兼容样例 2 个；requireActiveUser 16 个分支 |
| `npm run build -- --mode preview`、`npm run size` | 通过；首屏 JS 70.2 KB / 150 KB，全部 139.5 KB |
| `python -I build/check_arch.py` | 0 错误、2 警告（W2 缺 2027 年 cn、kr 节假日，预期提醒） |
| `python -I build/check_backend.py` | 0 错误 |
| `python -I build/check_registry.py` | 都对上（本报告新建后要登记一行，见第七节） |
| `python -I build/req_index.py --check` | 需求 218 条，问题 0 |
| `python -I build/tokens.py --check` | 179 个，没定义 0，没用到 5（提示） |
| `npm run check:site`、`check:gate`、`check:files-rules` | 都通过 |
| `CI=true npx playwright test`（chromium + webkit） | **44 通过、2 跳过**（csp.spec 预览组，要 `LEMO_E2E_PREVIEW_URL`） |
| `actionlint`（4 个工作流） | 0 问题 |
| `gitleaks git --redact --log-opts="--all" .` | 293 个提交，no leaks found |
| 真库（第二节） | 全部通过，D-14 那一项除外 |

---

## 五、仍待 R2 / 预览 / 后面批次的清单

| # | 项 | 需要 | 对应 TC / 清单 |
|---|---|---|---|
| 1 | row_quota 在 Supavisor、fn_ai 直连下的 session_user（L5 ②③） | 预览项目 | TC-B0-37、71 |
| 2 | pgvector / halfvec(768)（本地已能用） | 预览项目 | TC-B0-61；P1 |
| 3 | private 暴露、pg_graphql 在线上（本地已通过） | 预览项目 | TC-B0-81、82、84；P2、P3 |
| 4 | cron 超时、service_role statement_timeout | 预览项目 | TC-B0-98；P4、P5 |
| 5 | Supavisor 事务模式 + `app.uid`、`prepare: false` | 预览项目，负责人设 fn_ai 密码 | TC-B0-64、69、34；P6 |
| 6 | requireActiveUser 线上（本地版已通过） | 预览项目 | P8 |
| 7 | Security Advisor 0 警告（截图） | 预览控制台 | TC-B0-41；P9、P11 |
| 8 | 经 `/sb/*`：REST、Auth、函数在首尔、Realtime；直连绕过；**线上 `%` 编码有没有被 Cloudflare 先规整** | 预览环境 + `LEMO_E2E_PREVIEW_URL` | TC-B0-39、42～44、119 |
| 9 | 免费版保活 | 预览项目 | TC-B0-45 |
| 10 | 预览令牌权限、secrets 名字截图 | 负责人、运维 | TC-B0-60、66 |
| 11 | R2 第五节 9 项（412、10 MB CPU、查看器、桶设置、令牌范围、cf-cache-status、日志、首尔连 R2、预览 E2E）；替身不校验签名，签名错误也在这里验 | **R2 开通（最晚 11-10）** | TC-B0-120、62；P12 |
| 12 | Tauri 壳上 Turnstile | QA 本机，Rust 工具链 | TC-B0-65 |
| 13 | AI Studio 免费额度 | 负责人 | TC-B0-63 |
| 14 | 验证码邮件按 `.Data.locale` 显示韩文 | invite-signup 写 user_metadata（B1） | 15.6；5.6 |
| 15 | TC-B0-116 / 117 整条链路 | B4b-1 / B1 | 已挪批次 |
| 16 | 函数一侧伪造头、服务器函数契约、vault-image 上限 | B1、B2、B5 | TC-B0-91、85、36 |
| 17 | CI 上 8c07819 的实际运行链接（QA 没有权限看） | 负责人转告、主持人补 | 第一轮第一节 |

---

## 六、新缺陷

分级同第一轮：**高**＝阻断 B0 签字；**中**＝本批要修或要正式定批次；**低**＝记录。

### D-12（高）TC-B0-89 的 devices 会话行反例没有测试，策略改坏拦不住

- **涉及**：TC-B0-89（P0、★）必含反例“authenticated 删、改 devices 都只能动 session_id 等于 JWT 的本机那一行（session_id 为空的行也不能改）”，架构 0.29 续第 98 条②、第 99 条①。
- **复现**：`supabase/migrations/0001_core.sql` 的 `create policy del on public.devices` 去掉 `and session_id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid` → `check_backend` 0 错误、`test:db:offline` 全部通过、`vitest tests/data-manifest` 47 通过（生成器只看授权表，管不到策略里的行条件）。pgTAP 里只有“B 删 A 的设备”（跨用户），没有“A 用会话 1 删 / 改 A 会话 2 的设备”和“session_id 为空的行”。
- **背景**：前端 B 返工第二次第 132 行已指出这条不归生成器、请 QA 判断；QA 判断：要立用例，归后端的 `supabase/tests/rls/`。
- **建议**：01 或 02 文件加 4 条：A 以会话 1 删、改会话 2 的设备都影响 0 行；session_id 为空的 A 的设备删、改都影响 0 行；对照：删、改本机那一行成功。`update` 策略同样口径。`report_tz_impl` 那条随 B1 迁移补。

### D-13（中）TC-B0-75 剩下的部分没做，也没正式挪批次

- 没做：“静态检查所有服务器上传调用都显式传 contentType”“六个桶由写它的服务器函数各上传一次”。后端理由是 B0 还没有任何上传函数、检查写法取决于 B1 的包装层签名，理由成立；但测试用例里 TC-B0-75 仍是 B0 的 P0 冒烟项，没像 116、117 那样由架构师在 1.3 和测试用例里改批次。
- 已做的部分：越界检查 F3、F4（改坏 11 拦住）；objstore 不传 contentType 抛 bad_input（单测）。
- **建议**：架构师在 0.34 把这两半正式挪到 B1（第一个上传函数落地时一起加进 check_backend，带违规样例），测试用例同步；或现在就按“`supabase/functions/` 里 objstore 的 put 调用必须带 contentType 字面参数”写检查（现在 0 处调用，样例证明有效即可）。

### D-14（高）`config.toml` 关掉了邮箱登录，本地已有用户也登录不了

- **位置**：`supabase/config.toml` 第 117～119 行 `[auth.email]` 的 `enable_signup = false`，注释写“不允许自己注册（同上面的 enable_signup）”。
- **原因**：Supabase CLI 把 `[auth.email] enable_signup` 映射成 `GOTRUE_EXTERNAL_EMAIL_ENABLED`（整个邮箱登录方式的开关），不是“禁止注册”。QA 看了本地 auth 容器的环境变量：`GOTRUE_EXTERNAL_EMAIL_ENABLED=false`、`GOTRUE_DISABLE_SIGNUP=true`。“禁止注册”已经由 `[auth] enable_signup = false` 做到了。
- **现象**：`/auth/v1/settings` 的 `external.email` 为 false；已有用户 A 调 `/auth/v1/otp`（create_user: false）回 422 “Email logins are disabled”，Mailpit 收不到信。L14、L17 照清单原样做不了；B1 起本地和 CI 的登录 E2E 都会挂。注释里“【线上】运维把同一份……贴进控制台”，如果线上也照这个口径把 Email provider 关掉，正式环境就没人能登录。
- **QA 验证过的修法**：只把这一行改成 `true`（`[auth] enable_signup = false` 不动），重启后：未知邮箱发码 422 “Signups not allowed for this instance”（仍然禁止注册）；已有用户 6 位验证码、60 秒限频、600 秒有效都符合 15.6；真 JWT 带 session_id。
- **建议**：后端改这一行并改注释（写明它是“邮箱登录方式开关”）；加一条打本地 Supabase 的自动测试（已有用户能收码登录、未知邮箱被拒），接进 ci.yml db 任务；运维核对线上控制台 Email provider 是开着的、“Allow new users to sign up”是关着的。为什么前两轮没发现：离线桩没有 Auth；主持人真库实测没有走登录。

### D-15（低）静态检查的几种绕过写法

- check_backend F 规则：变量名用拼接得到（`['SUPABASE','DB','URL'].join('_')`）、`Deno.env.toObject()`、`import('../_shared/' + 'db.ts')` 都不报（改坏 11b）。要故意绕才会出现，代码审查能看到，记一笔。建议：`supabase/functions/` 里禁止 `Deno.env.toObject()` 和非字面量的动态 import，`Deno.env.get` 的参数必须是字面量。
- M3：0001～0007 里 `alter table … alter column features set default` 打开开关不报（改坏 12b）；已有那一行不受影响，实际开关没打开，影响小。建议 M3 把 `alter column features set default` 也算进去。

### D-16（低）其余小问题

- `vitest_strict.mjs` 通过时打印“54 条全部真跑并通过”，其中 3 条是放行的 todo。建议写成“51 条真跑通过、3 条已放行的 todo”，避免读日志的人以为 116、117 真测了。
- “表 × 角色 × 操作”生成器只在 PGlite 上跑（grant-runner.ts 注释写“CI 可以接本地 Supabase”），ci.yml db 任务没接。授权在真库和 PGlite 上可能不同（Supabase 自带的默认授权），建议接上，用同一个 `{exec, query}` 接口。
- D-09 后一半：`core.hooksPath` 为空时没有提示（运维建议 check_arch 只警告，归前端 A）。
- 第一轮第二节的“部分”低级项仍在：TC-B0-12（锁文件改动理由、精确版本没有检查）、TC-B0-27（“删掉一个 kind 的外键”“features 多一个 qa_flag”两个样例；后者现在由 23 号样例覆盖了一半）、TC-B0-80（只改 updated_at 两台设备同改 rev 不变）。不阻断，建议随 B1 补。
- 文档：架构 2.3 A28、任务单 O-7 写的是 `build/check_fn_scope.mjs`（归运维），实际是后端的 `build/check_backend.py`（主持人已在过程记录里留给架构师）。

---

## 七、分数和结论

| 维度 | 第一轮 | 第二轮 | 说明 |
|---|---|---|---|
| 本机检查 | 全绿 | 全绿 | 第四节 |
| P0 冒烟覆盖 | 8 条 P0 缺检查 | 剩 TC-B0-89 的 devices 反例（D-12）、TC-B0-75 的一半（D-13） | |
| 真环境 | 待 Docker 14 项全没做 | 全部做完，1 项不符合（D-14） | 第二节 |
| 改坏抽查 | 15 处拦住 12 | 20 处拦住 17 | 第三节 |
| 第一轮缺陷 | — | 11 条：9 修好、2 部分 | 第一节 |

**评分 7.5 / 10，不通过。** 未解决的阻断项：**D-12（P0 用例反例缺测试）、D-14（本地邮箱登录被关，B0 实测 L14 不符合）**；D-13 要么补检查、要么由架构师正式改批次。三条都是小改动，修完后 QA 只需复查这三处（加 D-14 的新测试），不必整轮重来。

本报告是新文件，`文件登记册.md` 要加一行（QA 不改别人的文档，请主持人登记）。
