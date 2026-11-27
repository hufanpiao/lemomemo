# B0 QA 测试报告 · 第四轮（N1：账号不许有密码）

- **测试人**：QA 测试工程师
- **对象**：main `0dfb97e`（“B0 返工第四次：auth.users 不许有密码”），改动范围 `git diff c50065b..0dfb97e`（8 个文件，+133 / −9；代码改动在 `0001_core.sql`、`login-probe.mjs`、`02_triggers.test.sql`、`supabase-stub.psql`、`config.toml` 注释）
- **日期**：2026-10-28
- **范围**：只验这次改动（架构 0.36 第 1 条 ①、TC-B0-121），再按 ci.yml db 任务完整跑一遍真库、跑全套本机检查，确认没有回退。第三轮报告里其他结论不重验
- **依据**：[B0 安全审查·第三轮](B0-安全审查-第三轮-改动.md) N1；架构设计 v4 0.36 第 1 条、15.6 第 1 点；测试用例 v4 TC-B0-121；[返工-后端](返工-后端.md)“第四次”
- **环境**：Windows 11，Node 24，Deno 2.9.8，Docker Desktop，Supabase CLI 2.120.0（`supabase start -x studio`），LocalStack（`node build/objstore.mjs up`）。没有预览环境凭据
- **做法**：主仓库直接跑，开始时 `git status` 干净。改坏抽查每处用 sed 改完就 `git checkout --` 还原，最后再 `db reset` 一次并确认触发器定义和 pgTAP 253 条复原。临时脚本放在会话临时目录。只用 `supabase status` 给的本机测试值，**没有读取或输出任何真实密钥**；复现用的密码由 `randomBytes` 生成、只在进程内用，没有打印密码和令牌。结束时 `supabase stop --no-backup`、`node build/objstore.mjs down` 都已执行，`docker ps` 为 0 个容器

---

## 结论：**维持通过**　评分 **8.7 / 10**（第三轮 8.6）

- **N1 的后门 QA 自己在真库上复现了**：去掉触发器时，A 用自己的令牌 `PUT /auth/v1/user` 设密码 → `grant_type=password` 回 200、拿到 `amr = ["password"]` 的新令牌；service role 改密码、admin 建人带密码两条路同样能密码登录；admin 建人**不传密码**时 GoTrue 自己存了一个 bcrypt 哈希（60 位）。
- **恢复触发器后这三条路全部堵住**：库里 `encrypted_password` 一律为空串，密码登录都回 400 `invalid_credentials`、没有令牌；改 metadata 200、原会话照常、admin 建人和 magiclink / 验证码登录照常。
- **TC-B0-121 原文逐条核对全部符合**（第二节）。
- **ci.yml db 任务完整跑一遍全部通过**：pgTAP 253 条（+2），login-probe **28 项**全部符合（+7），其余各步与第三轮一致；**全套本机检查 0 失败**，没有回退。
- **改坏 4 处全部被 CI 拦住**（第四节）：只管 update 不管 insert、置空改成不处理、只在改 email 时触发、置空串改成置 null。
- 新发现 2 条低（第五节），都不阻断。加 0.1 分是因为一条 P0 级的后门在 B0 根上关掉、并且测试拦得住；第三轮的扣分项还在。

---

## 一、N1 独立复现（不复用 login-probe，QA 自写脚本）

脚本只打 `127.0.0.1`；拿 A 的真会话用 admin `generate_link`（magiclink）+ `/verify`，不经邮件，和探针走的验证码路径不同；库里只看 `encrypted_password` 是 null / 空 / 非空（非空时只看长度和是不是 bcrypt 前缀）。同一个 `db` 容器里先 `drop trigger users_guard_no_password`，跑一遍；再按 0001 原文重建触发器，跑一遍；之后 CI 流程里的 `supabase db reset` 又从迁移重建了一次。

| # | 操作 | 去掉触发器 | 有触发器 |
|---|---|---|---|
| 1 | admin `POST /admin/users`（不传 password） | 200；**库里有密码（bcrypt，60 位）** | 200；空串 |
| 2 | A 用 magiclink 验证拿会话 | 200 / 200，有令牌 | 200 / 200，有令牌 |
| 3 | A 用自己的令牌 `PUT /auth/v1/user {password}` | 200；库里有密码 | 200；**库里仍为空串** |
| 4 | `grant_type=password`（A 的邮箱和这个密码） | **200，有令牌，amr = ["password"]**（后门复现） | **400 `invalid_credentials`，没有令牌** |
| 5 | 同一令牌 `PUT /auth/v1/user {data: {locale: 'ko-KR'}}` | 200，locale 改到 | 200，locale 改到；库里仍空 |
| 6 | 原会话 `GET /auth/v1/user` | 200 | 200（触发器不误伤已有会话） |
| 7 | service role `PUT /admin/users/A {password}` | 200；库里有密码 | 200；库里空串 |
| 8 | 用第 7 步的密码 `grant_type=password` | **200，有令牌** | **400 `invalid_credentials`** |
| 9 | admin 建 B **带** password | 200；库里有密码 | 200；库里空串 |
| 10 | B `grant_type=password` | **200，有令牌** | **400 `invalid_credentials`** |
| 11 | B 用 magiclink 登录 | 200 | 200（admin 建人后正常登录不受影响） |
| 12 | SQL `update auth.users set raw_user_meta_data = …`（不碰密码） | 密码仍在 | 密码为空，update 正常 |
| — | 清理：admin DELETE 两个用户 | 200，库里剩 0 | 200，库里剩 0 |

另外：空密码 `grant_type=password {password: ''}` 回 400。`db reset` 后 `pg_trigger`：`users_guard_no_password`、`tgenabled = 'O'`，定义为 `BEFORE INSERT OR UPDATE ON auth.users FOR EACH ROW WHEN (COALESCE(new.encrypted_password, '') <> '') EXECUTE FUNCTION private.guard_no_password()`；函数 `prosecdef = f`、`proconfig = {search_path=""}`、`proacl = {postgres=X/postgres}`（PUBLIC 没有执行权），函数体只有置空和 `return new`。种子数据里 `auth.users` 为 0 行。

结论：第 7～10 步是 TC-B0-121 没写、QA 多测的两条路（service role 改密码、admin 建人带密码），同样被挡住——这说明 invite-signup 将来即使误传了 password 也存不下（B1 的“调用参数里没有 password”单元测试仍要做）。

---

## 二、TC-B0-121 原文逐条核对

| 原文要求 | 实测 | 结论 |
|---|---|---|
| 前置：`supabase db reset` 后、`supabase start -x studio` | 照此 | — |
| pgTAP（以 postgres）①：update 测试用户 `encrypted_password = '<非空串>'` → 这一行为 `''` | `02_triggers.test.sql` 第 58 条，真库、离线库都通过 | 符合 |
| pgTAP ②：insert 一个 `encrypted_password` 非空的 auth.users 行 → `''` | 第 59 条，真库、离线库都通过 | 符合 |
| 探针 ⑦ a：admin 接口建的用户为空串或 null（GoTrue 自己生成的随机密码也被去掉） | ✔；QA 复现第 1 步证明 GoTrue 确实会自己生成（去掉触发器时库里有 bcrypt） | 符合（检查时机见第五节 L-1） |
| ⑦ b：A 的真 access token `PUT /auth/v1/user {password: <随机 24 位>}` 之后库里仍为空；b 本身回 200 或报错都算过、只打印状态码 | 探针打印“200”，✔ 库里仍为空；密码 `randomBytes(18).toString('base64url')` = 24 位 | 符合 |
| ⑦ c：`grant_type=password` 回 400 `invalid_credentials`，没有 access_token | ✔ 400 invalid_credentials | 符合 |
| ⑦ d：同一令牌改 `user_metadata.locale` 回 200、改到 | ✔ 200 locale = ko-KR | 符合 |
| 探针不打印密码和令牌 | 读了源码和输出：只打印状态码、错误码、locale、“库里有密码”这类字样 | 符合 |
| 方式：自动（CI 的 db 任务）；冒烟 ★；P0 | pgTAP 随 `npm run test:db`、探针随“从头建库”后一步，都在 ci.yml db 任务里 | 符合 |

顺带核对：`config.toml` 第 96～98 行注释已改成“密码登录关不掉……挡它的是 `guard_no_password` 触发器”，`secure_password_change = false` 上加了 0.36 ④ 的说明，和架构 15.6 第 1 点一致；离线桩 `auth.users` 补了 `encrypted_password varchar(255)`（真库也是 varchar(255)）；`shared/db.types.ts` 重新生成无差异；没写 `revoke`，3.3 C、附录 A 不加行与 0.36 原文一致，check_backend 0 错误。

---

## 三、按 ci.yml db 任务完整跑一遍（真库）

| 步骤 | 结果 |
|---|---|
| `supabase start -x studio`（0001～0007） | 通过，39 秒 |
| `node build/objstore.mjs up` | 四个条件全过（替身不校验签名，已知） |
| Vitest 严格模式（4 个文件、4 个必须项） | “54 条全部真跑并通过；必须项 4 个都对上” |
| `seed.mjs` 两遍 + `--check` | 写入 14 / 已存在 0；写入 0 / 已存在 14；四个桶 A、B 各有对象 |
| `supabase db reset` | 通过；触发器在、`tgenabled = 'O'` |
| `node supabase/tests/auth/login-probe.mjs` | **28 项全部符合，退出码 0**（第三轮 21 项 + ⑦ 4 项 + 清理 3 项） |
| gen types 和 `shared/db.types.ts` 比对 | 一致 |
| `npm run test:db`：pgTAP | **5 个文件 253 条全过**（第三轮 251，02 +2） |
| `npm run test:db`：`deno task d1` | D1 通过 |
| `d1_negative.mjs`（真库） | 反例和违规样例全部报出 |
| `deno task test`（带替身变量） | 94 通过 0 失败；“> 跳过”0 处；“条件写回 exists … ok” 1 处 |
| `deno task check` | 通过 |
| 旧版契约基线 | 还没有发布 tag 和 compat-baseline，跳过（和 CI 相同） |
| 兼容样例（每个前 `db reset`） | 2 个样例都和 `expect-old-client` 一致 |
| `supabase stop --no-backup`、`objstore down` | 已执行，`docker ps` 0 个 |

---

## 四、改坏抽查（改 `0001_core.sql`，每处 `db reset` 后跑真库 pgTAP 02、login-probe、离线库，跑完 `git checkout --` 还原）

| # | 改法 | 真库 pgTAP 02 | login-probe | 离线库 | 拦住？ |
|---|---|---|---|---|---|
| M1 | 触发器只管 update：`before update on auth.users` | **Failed 1/59**（第 59 条 insert：have `tc-b0-121-nonempty-2`） | **全部符合**（漏） | 02 失败 | **拦住**（靠 pgTAP） |
| M2 | 置空改成不处理：函数体换成 `null;` | **Failed 2/59**（58、59） | **3 项不符合**（⑦ a、b、c；c 回 200 拿到令牌），退出码 1 | 02 失败 | **拦住** |
| M3 | 只在改 email 时触发：`before insert or update of email` | **Failed 1/59**（第 58 条 update） | **2 项不符合**（⑦ b、c），退出码 1 | 02 失败 | **拦住** |
| M4 | 置空串改成置 null：`new.encrypted_password := null` | **Failed 2/59**（have NULL、want ''） | 全部符合（探针按原文接受 null） | 02 失败 | **拦住**（靠 pgTAP） |

还原后：`git status` 没有代码改动；`db reset` 后触发器定义和原文一致、pgTAP 253 条全过。

M1 探针漏掉的原因：admin 建人时 GoTrue 先 insert（带自生成的密码），之后的验证码登录会整行 update 这一行，`when` 条件成立，update 路径把密码清掉了；⑦ a 是在登录之后才查的，所以看不出 insert 路径漏了。CI 里 pgTAP 第 59 条照样拦得住，所以不算缺陷，记为 L-1。M4 顺带看到：本机这版 GoTrue 对 null 密码的用户也能正常验证码登录（探针 28 项全过），0.36 选空串是照顾旧模型，本地验不出差别，不影响结论。

---

## 五、新发现（都是低，不阻断）

| 编号 | 问题 | 建议 | 给谁 |
|---|---|---|---|
| **L-1（低）** | 探针 ⑦ a 在 A 收码登录**之后**才查库，GoTrue 的登录 update 已经替 insert 路径清过一遍，所以“GoTrue 自己生成的随机密码在 insert 时就被去掉”这一句探针证明不了（改坏 M1 时探针全过）。现在靠 pgTAP 第 59 条兜住，CI 不漏 | 把 ⑦ a 挪到 ③ admin 建人之后、发码之前（或在那里多查一次）；不急，B1 动探针时顺手 | 后端 |
| **L-2（低）** | 触发器只管以后的写入，**不清已有的行**。本地和 CI 每次从空库建，没问题；预览第一次 `db push` 前如果已经有人在控制台建过用户（GoTrue 会自生成密码），那些行的哈希会留着。随机密码没人知道，实际很难利用，但和“账号不许有密码”的说法不完全一致 | 实测清单 P13 加一句：push 后 `select count(*) from auth.users where coalesce(encrypted_password, '') <> ''` 应为 0，不为 0 就 `update auth.users set encrypted_password = '' where …` 一次并记下 | 后端（实测清单）、架构师知悉 |

另：本报告和同时出现的 `B0-安全审查-第四轮-N1.md` 都还没进 `文件登记册.md`（`check_registry` 报“有文件没登记”），QA 不改别人的文件，请登记册维护人补两行。

---

## 六、全套本机检查（Supabase 停之前跑的部分已在第三节）

| 检查 | 结果 |
|---|---|
| `npm run lint` | 0 错误 0 警告，退出码 0 |
| `npm run typecheck`（5 份） | 0 错误 |
| `npx vitest run`（不带替身变量） | 55 个文件通过、1 个跳过；**709 通过、15 跳过、5 todo**（和第三轮相同） |
| `npm run test:tz` | 三个时区都通过（每个 93 通过、1 跳过） |
| `deno task test`（不带替身变量） | 93 通过 0 失败 1 ignored |
| `npm run test:db:offline` | 全过：pgTAP 01 60、**02 59**、03 41、04 34、05 59；D1 正例、反例、违规样例；/files 规则表 |
| `npm run build -- --mode preview`、`npm run size` | 通过；首屏 JS 70.3 KB / 150 KB，全部 139.5 KB（和第三轮相同） |
| `python -I build/check_arch.py` | 0 错误、2 警告（W2 缺 2027 年节假日，原来就有） |
| `python -I build/check_backend.py` | 0 错误 |
| `python -I build/check_registry.py` | “登记了但不存在”无；“没登记”只有新评审报告（见第五节末） |
| `python build/req_index.py --check` | 需求 218 条，问题 0 |
| `python -I build/tokens.py --check` | 179 个，没定义 0，没用到 5（提示） |
| `npm run check:site`、`check:gate`、`check:files-rules` | 都通过 |
| `CI=true npx playwright test` | 44 通过、2 跳过（预览组，要预览地址） |
| `actionlint`（4 个工作流） | 0 问题 |
| `gitleaks git --redact --log-opts="--all" .` | 301 个提交，no leaks found |

---

## 七、仍待预览环境的（不卡 B0，和架构 0.36 一致）

- **P13 / TC-B1-112**：托管版让不让在 `auth.users` 上挂触发器，要第一次预览 `db push` 后查 `pg_trigger`；不让建就走 `access_token_hook` 退路，在 B1 关 N1。建议同时查 L-2 那一句。
- **0.36 第 1 条 ②（B1）**：`is_active`、`files_authorize_impl`、`requireActiveUser` 拒 `amr` 含 password 的会话（TC-B1-111）；invite-signup 不传 password 的单元测试。

---

## 八、分数和结论

| 维度 | 分 | 说明 |
|---|---|---|
| 功能是否做到 | 9 | N1 的三条写密码路径（自己设、service role 设、建人带）都被挡；正常建人、登录、改 metadata 不受影响 |
| 测试拦不拦得住 | 8.5 | 改坏 4 处全拦；探针对 insert 路径看不出（L-1），靠 pgTAP 兜住 |
| 回归 | 9 | ci.yml db 任务全过，本机检查 0 失败，数字只多了这次新增的 2 + 7 条 |
| 文档、注释对齐 | 8.5 | config.toml 注释、实测清单 L20 / P13 到位；P13 可补 L-2 |
| 沿用第三轮的扣分项 | — | D-15 F 规则绕过、D-16、D-09 仍在（低，B1） |

**总分 8.7 / 10，B0 QA 维持“通过”。** 这次改动没有引入新的 P0 / P1，N1 的根本一层在 B0 本地已关闭；托管版是否允许挂触发器按 0.36 在第一次预览 push 时确认，不回头卡 B0。
