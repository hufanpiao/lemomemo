# B2 代码审查 · FA-6 ③（zod、account-status、同步那批代码移出首屏）

- 审查人：独立代码审查员（兼看安全；只读，默认不通过，10 分制，8 分及以上才算通过）
- 日期：2026-11-04
- 范围（只看 ③，用 `git diff -- <路径>`）：
  - 新文件：`src/app/after-paint.ts`、`src/app/__tests__/after-paint.test.ts`、`src/core/schema-version.ts`、`src/core/__tests__/schema-version.test.ts`、`src/core/manifests.gen.ts`（生成的）、`src/core/__tests__/manifest-snapshot.test.ts`、`build/gen_manifests_snapshot.mjs`、`tests/build/zod-alias.test.ts`
  - 修改：`vite.config.ts`、`src/platform/zod-jitless.ts`、`src/app/main.tsx`、`src/auth/main.tsx`、`src/core/boot.ts`、`src/core/manifest-source.ts`、`src/core/outbox-logic.ts`、`src/core/outbox.ts`，以及 `outbox-logic.test.ts`、`outbox.test.ts`、`first-paint-wiring.test.ts` 里 ③ 的部分
  - 不在范围：FIRSTPAINT-nofeature、N3（`sync-reload-race.test.ts` 新增那两条）、N4/L9（`main.tsx` 里 `setPushClaimContext` 多出的 `currentUserId`）、P7，前端 B 的设置页、日历、提醒
- 口径：首屏按页面时钟算（执行说明第一节），硬线 150 KB
- 验证方式：探针、变异、构建、浏览器测量都在 scratchpad 的独立副本 `cr-fa6r3` 里做（robocopy 复制，`node_modules` 用联接）。用完先拆联接再删副本。自己起的 8797 服务（inspector 9239，持久化目录 `.wrangler/state-cr8797`）已经连同 workerd 子进程一起停掉，复查过端口没人在听。共享工作区只新建了本文件。

## 结论：不通过，7.0 / 10

- 没有高问题。安全上最要紧的一条站得住：严格校验改成懒加载以后，**加载完成之前、加载失败的时候，都没有路径能让没校验过的行进 outbox**。
  - `validateWrite` 的 rows 参数是必填的，类型系统保证不会跳过校验；
  - 加载失败时 enqueue 直接抛错，不写本机、不入队（探针 P1）；
  - “加载回来再查一次闸”是对的，去掉它会被测试拦住（变异 M1）。
- 首屏自测 **145.7 KB**：chromium、webkit 各量 3 次，6 次一样，和前端 A 的 145.5～145.6 对得上。zod 那块 25.1 KB 在今天页出现以后才开始下载；没有 CSP 违规，控制台也没有报错。
- 不通过的原因是 3 条中问题，都是“出问题时不声不响”一类：
  - **M1**：首屏画完以后那批代码下载失败，这一页从此不启动同步、也不注册 SW，不重试，用户也看不到提示；
  - **M2**：rows.ts 加载失败时，`write.*` 违反自己“不抛错”的约定，编辑页会一直停在“保存中”；
  - **M3**：zod 回到首屏时，没有任何测试或 CI 能发现。实测首屏变成 171.8 KB，超过硬线，构建自带的 check_size 只报 135.9、照样通过。

## 一、重点核对

### 1. 入队严格校验懒加载（安全）

| 情况 | 结果 | 依据 |
|---|---|---|
| 加载完成之前入队 | 在 `await loadRowSchemas()`（`src/core/outbox.ts:73`）上等着；回来以后先查闸，再 `validateWrite`，再开事务。没有“先写、后补校验”的路径 | 读码；`validateWrite(input, rows, …)` 的 rows 必填（`outbox-logic.ts:208`），tsc 通过 |
| 加载失败 | enqueue 抛出普通 Error（不是 `OutboxRejectError`），本机行、outbox 都没写 | 副本探针 P1：`vi.mock` 让 rows.ts 加载时抛错，断言没有本机行、pending 为 0，通过 |
| 失败以后再入队 | 重新加载；成功以后非法行照样被拒（`invalid_row`），合法行正常入队 | 探针 P2 |
| 等加载期间设了闸 | 回来再查一次，拒收 `outbox_suspended` | `outbox.test.ts` 的新用例；去掉第二次查闸（变异 M1）被拦住 |
| 同时来几次入队（第一次加载期间） | 都在同一个 promise 上排队，按调用顺序继续，入队顺序不变 | 读码（`loadOnceRetrying` 一直给同一个 promise，`then` 按注册顺序执行） |
| 上传 | 只上传 outbox 里的项；进 outbox 的都已经过校验。服务器端的授权和 RLS 照旧 | 读码 |

结论：闸是对的，校验没有降级。“加载失败就放行”的写法（变异 M2）现在**不会被任何测试拦住**，因为没有一条测试覆盖“加载失败时拒收”，见 L3。

### 2. after-paint

- **换账号闸**：
  - 第一道闸（`await appPainted()` 之后）和第二道闸（`main.tsx:226` 起）写法相同；
  - 第二道闸之后，到 `wireSync`、`setPushClaimContext` 为止全是同步调用，中间没有 await，所以“查完闸、再被换账号”的空档不存在；
  - 下载期间如果换了账号，`watchAccount` 会设闸，第二道闸能拦住；
  - 变异 M3（去掉第二道闸）、M4（失败时不设 null）、M4b（失败以后不 return）都被 `first-paint-wiring.test.ts` 拦住。
- **失败降级**：
  - 推送认领有 `PUSH_CLAIM_WAIT_MS` 10 秒上限，不会一直挂着；
  - 但整条路径**没有重试**，见 M1。
- **`lazyLogUploader`**：只加载一次，失败回 `retry`，下次再试。变异 M9（失败以后不复位）被拦住。

### 3. zod 别名

- **对别的环境的影响**：
  - 别名只在 `vite.config.ts` 里。functions（Deno import map）、worker（wrangler/esbuild）、SW（`vite.sw.config.ts`，不引 zod）、vitest（`vitest.config.ts`）都不经过它，所以都不受影响；
  - 登录页、预览页和主页面在同一份配置里，一起被别名。
- **产物核对**：
  - zod 和垫片打成了同一块 `zod-jitless-*.js`，块的末尾是 `M({jitless:!0})`，后面紧跟转出；
  - zod 4 在**建 schema 的时候**就读 `jitless`（`schemas.js:1194-1196`：`jit && allowsEval.value` 短路）。业务的 schema 都 import 'zod'，也就是依赖垫片，所以一定在 `M(...)` 之后才建；
  - 6 次浏览器测量都没有 `securitypolicyviolation`。wrangler 实际下发的 CSP 是 `script-src 'self'`，不带 `unsafe-eval`。
- **CSP 和性能**：
  - jitless 本来就开着（③ 以前是入口第一个 import 垫片），这次只是换了实现方式，CSP 和性能都和以前一样；
  - jitless 的代价是对象 schema 不走 JIT 快路径。本应用一次只校验一行，可以忽略。
- **`tests/build/zod-alias.test.ts` 能拦住什么**：
  - 配置里的别名被删（M8）、垫片不关 JIT（M7）都能拦住；
  - 源码绕开别名、直接引 zod 子路径也能拦住；
  - 拦不住的是**产物层面**的失效，比如以后加了别的构建配置。这一层靠 e2e 的 `csp-fixture.ts`（出现 CSP 违规就失败）兜底，可以接受，见 L4。

### 4. manifests.gen.ts 快照

- 源文件改了、忘了重新生成（变异 M6）：`manifest-snapshot.test.ts` 有两条会挂。CI 的 `unit.yml` 跑 `npm test`，`release-build.yml` 发布前也跑 `npm test`，所以正式版拦得住。
- 生成脚本**没有接进 build，也没有接进 `check:*`**：
  - `package.json` 里没有 `check:manifests`；
  - `build_web.mjs` 不生成、也不核对快照；
  - `deploy-preview.yml` 在 push main 时和 unit 并行，不跑测试，所以快照过期的提交仍会部署到预览环境；
  - 见 L5。
- 安全上的影响有限：快照决定客户端的可同步表和“按清单可写列”的兜底校验。即使过期，服务器的授权和 RLS 照样会拦。

### 5. SCHEMA_V 副本

把副本改成 3（变异 M5），`schema-version.test.ts` 会挂。CI 跑的是同一套测试，所以拦得住。

### 6. 首屏自测（页面时钟，gzip -9）

脚本是 scratchpad 的 `cr-r3-measure.mjs`，结果在 `cr-r3-measure.txt`。构建命令 `npm run build -- --mode e2e`，wrangler pages dev 起在 8797，假会话，`serviceWorkers: 'block'`。

| 浏览器 | 次数 | 今天页出现 | 首屏（之前开始下载） | 之后 |
|---|---|---|---|---|
| chromium 390×844 | 3 | 735～785 ms | **145.7 KB**（3 次一样） | 137.6 KB |
| webkit iPhone 15 | 3 | 2005～2024 ms | **145.7 KB**（3 次一样） | 137.6 KB |

- 今天页之后才开始下载的：sync-net 2.5、zod-jitless 25.1、rows 1.2、sync-wiring 8.9、device-reg 1.4。chromium 785 ms，紧跟在今天页出现之后，是 appPainted 触发的，不是巧合；webkit 2041 ms。
- account-status 1.0 仍在首屏，和执行说明一致。
- 构建自带的 check_size 首屏口径是 109.9 KB。
- 首屏离硬线只剩 4.3 KB。

### 7. 跑过的验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（五个 tsconfig） | 退出码 0 |
| `npx eslint` 对 ③ 的 19 个文件 | 退出码 0，没有报错 |
| `python -I -B build/check_arch.py`（共享工作区，只读、不写字节码） | 0 个错误，1 个警告（W2：2027 节假日还没公布，和 ③ 无关） |
| `npx vitest run src/core src/app tests/build/zod-alias.test.ts --exclude tests/build/gen-tauri-key.test.ts` | 89 个文件、769 条，全部通过 |
| `npm run build -- --mode e2e` | 通过；check_size 首屏 109.9 / 150 |
| Playwright 首屏测量 | 见第 6 节 |
| 探针 P1、P2（rows 加载失败、恢复） | 见第 1 节；跑完已删 |

变异（脚本 `cr-r3-mut.py`，结果 `cr-r3-mut.txt`；每条改一处，跑相关测试，再按原字节还原）：

| 编号 | 变异 | 结果 |
|---|---|---|
| M1 | outbox 加载回来以后不再查闸 | 拦住（`outbox.test.ts` 新用例） |
| M2 | rows 加载失败时放行，不校验 | **没拦住**（495 条全过）→ L3 |
| M3 | main 去掉第二道换账号闸 | 拦住 |
| M4 | 下载失败时不设 `setPushClaimContext(null)` | 拦住 |
| M4b | 下载失败以后不 return、继续往下 | 拦住 |
| M5 | SCHEMA_V 副本改成 3 | 拦住 |
| M6 | 改了 `shared/manifests/todos.ts`、不重新生成快照 | 拦住（2 条） |
| M7 | 垫片不调 `z.config` | 拦住 |
| M8 | vite 配置不挂别名 | 拦住 |
| M9 | `lazyLogUploader` 失败以后不复位 | 拦住 |
| M10 | `boot.ts` 改回引 `rows.ts` 的 SCHEMA_V（zod 回到首屏） | **没拦住**：check-arch 那 3 条失败在副本里不改代码时也一样挂（副本没有 .git，扫到了 `.e2e-sb`、`dist`），不算拦住。构建以后 check_size 报 135.9 / 150、通过；页面时钟实测 **171.8 KB**（两个浏览器都是）→ M3 |
| M11 | `manifest-source.ts` 改回读 `shared/manifests` | **没拦住**，原因同 M10 |

## 二、问题清单

### 高

无。

### 中

**M1　首屏画完以后那批代码下载失败，这一页从此不同步、不注册 SW，不重试，也没有提示**

- 位置：`src/app/main.tsx:218-225`（catch 里直接 return）；`src/app/after-paint.ts:19`
- 现象：catch 里 `return` 以后，下面这些在这一页的整个生命周期里都不会再做：
  - `wireSync`：不同步，写入只留在本机 outbox；会话被撤销、账号停用也发现不了，因为这要靠同步引擎；
  - 设备登记、推送认领；
  - `registerServiceWorker()`（`main.tsx:271`）；
  - 日志主页：`logQueue.setLeader` 只由 wireSync 设，所以 `after_paint_load_failed` 这条日志本身在这一页也传不上去。
- 什么时候会碰到：
  - SW 还没装好的时候，比如第一次访问，或者浏览器清过数据。这时还没有 precache，分包要走网络；
  - 而 SW 正好也是在这之后才注册的，所以弱网下第一次打开失败一次，下次打开还是没有 SW。
  - 另外一种是 `import()` 一直挂着（网络卡住，没有超时）：同样永远不启动，连日志都不记。
- 和 ③ 以前比：以前代码是静态 import 的，同步引擎会自己处理离线，在 online 以后重连。现在多了一种“这一页永久不同步”的失败方式。
- 用户感知：只能看到“未同步”标记，不知道为什么，也不知道要重新打开。iOS 的 PWA 可能在后台挂好几天。
- 复现：
  1. 在副本里让 `loadAfterPaint` 里某一个 import 第一次 reject，或者 Playwright 用 `page.route('**/sync-wiring-*.js', r => r.abort())`；
  2. 冷启动，今天页出来以后断开拦截；
  3. 恢复网络、等 online：同步不启动，`navigator.serviceWorker.getRegistration()` 返回 undefined。
- 建议：
  1. 把 `registerServiceWorker` 那一段移到下载之前，或者不管下载成不成功都做。它不依赖这批代码，只受换账号闸约束；
  2. 下载失败时按退避重试（例如 2、4、8 秒……最长 5 分钟），加上 `browserLifecycle.onOnline` 和切回前台时立刻再试一次。每次重试回来都过同一道换账号闸。可以把“闸 + 下载 + 闸 + 启动”抽成一个函数，重试时调用同一个函数；
  3. 给 `import()` 加一个超时（例如 15 秒），超时按失败处理，进入重试；
  4. 连续失败（例如 3 次）以后，顶部出“同步没启动 · 重新打开”。可以沿用 `sync-paused` 横幅；
  5. 补行为测试：mock `loadAfterPaint` 第一次 reject、第二次 resolve，断言 online 以后 wireSync 被调用，而且重试前换了账号时不会调用。

**M2　rows.ts 加载失败时 `write.*` 会抛错，编辑页一直停在“保存中”**

- 位置：`src/core/outbox.ts:73`（加载失败抛普通 Error）→ `src/core/write.ts:60`（不是 `CacheClosedError`、也不是 `outbox_suspended`，原样 `throw e`）→ `src/core/edit-save.ts:18`（不是 `OutboxRejectError`，原样抛）→ `useEditRecord` 的 job 抛错，`setStatus` 没有执行，状态停在 `saving`。
- 问题：
  - `write.ts` 文件头的约定是“没写进去不抛错，返回 `{ ok: false, reason }`”，调用方要提示“没保存上”并保留输入。现在多了一种既不提示、也没写进去的情况；
  - ③ 以前，严格校验是同步的，离线写入一定能写进本机。现在“没有 SW、离线”时，本机写入也会失败，离线优先打了折扣；
  - 和 M1 是同一个场景：after-paint 下载失败时，rows 那块多半也下载失败。
- 复现：
  - 副本探针 P1 已经证明 enqueue 抛的是普通 Error；
  - 在页面上：拦截 `rows-*.js` 和 `zod-jitless-*.js`，冷启动，新建一条待办并输入标题，状态一直是“保存中”。
- 建议：
  1. `write.ts` 的 `enqueue` 把“严格校验加载失败”归成一个原因返回，不抛。可以新增 `'code_unavailable'`，或者先归进 `'local_unavailable'`。界面照现有规则提示“没保存上”，保留输入；
  2. 首屏画完、空闲时预加载一次 `loadRowSchemas()`（`loadAfterPaint` 里加一项，或者单独 `whenIdle`），让第一次写入不再等下载，也可以和 M1 的重试共用；
  3. 补测试：rows 加载失败时 `write.insert` 返回 `{ ok: false }`；enqueue 不写本机、不入队。这条同时补上 L3 说的那个缺口。

**M3　zod 回到首屏时没有任何测试或 CI 能发现（首屏只剩 4.3 KB 余量）**

- 位置：`build/check_size.mjs:9`（预算 150），统计口径是“入口的静态 import 闭包”；没有任何测试守着“首屏不许静态引 zod 或 rows.ts”。
- 复现（变异 M10）：
  1. `src/core/boot.ts:13` 改回 `import { SCHEMA_V } from '../../shared/schema/rows.ts'`；
  2. `npm run build -- --mode e2e`：check_size 报 135.9 / 150，通过；
  3. vitest 全部通过（check-arch 那 3 条在副本里本来就挂）；
  4. 页面时钟实测 171.8 KB，超过硬线 21.8 KB。
  - `manifest-source.ts` 改回读 `shared/manifests`（M11）也一样。
- 风险：只要有人在首屏模块上顺手 import 一个 shared/schema 里的常量，③ 就白做了。执行说明说“check_size 以后按页面时钟改”，但在改之前，这道硬线完全没人守。
- 建议（任选一条，越早越好）：
  1. `first-paint-wiring.test.ts` 或 tests/arch 加一条依赖图检查：从 `src/app/main.tsx` 出发，沿静态 import 走，不许走到 `zod`、`shared/schema/rows.ts`、`shared/schema/manifest.ts` 的运行时导出、`shared/manifests/`（`import type` 除外）；
  2. 或者在 check_size 里，对首屏块的内容查 zod 的特征字样（如 `$ZodObject`、`jitless`），出现就失败；
  3. 长期：check_size 按页面时钟口径改（执行说明已经列了），或者把 `cr-r3-measure.mjs` 这样的测量放进 e2e，断言 ≤ 150。

### 低

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| L1 | `src/core/outbox.ts:73` | 第一次写入要等 zod + rows（约 26 KB）下载完才更新界面。本机 1 ms 以内；第一次访问又遇上弱网时，可能落在首屏画完后的约 1 秒里（参照 ② 的 Fast 3G 数字），打勾、新建会慢这么久才有反应 | 和 M2 的建议 2 一起做：空闲时预加载 |
| L2 | `src/core/outbox-logic.ts:190-205`、`src/app/after-paint.ts` | “失败以后下次再试”只在 vitest 的 mock 下验证过。真实浏览器的模块表可能缓存失败的动态 import，同一个地址要刷新页面才能恢复（同 ② 的 L2） | 在真实浏览器里验证一次；做不到时，M1 的提示改成“重新打开” |
| L3 | `src/core/__tests__/outbox*.test.ts` | 没有测试覆盖“rows 加载失败时拒收、不写本机”。把 enqueue 改成加载失败就放行（变异 M2），495 条测试全过。这是安全上该守住的一条 | 把探针 P1 的写法补进 `outbox.test.ts`：`vi.mock` 让 rows.ts 加载时抛错，断言抛错、没有本机行、pending 为 0 |
| L4 | `tests/build/zod-alias.test.ts` | 只核对配置和源码，不核对产物。vitest 不走这个别名，所以单测跑的是 zod 的 JIT 路径，产物是 jitless（③ 以前也一样，不是退化） | 在构建后的检查里核对 zod 所在的块含 `jitless:!0`，而且首屏块里没有 zod；或者在执行说明里写明“产物层面靠 e2e csp-fixture 兜底” |
| L5 | `package.json`、`build/build_web.mjs`、`.github/workflows/unit.yml` | `gen_manifests_snapshot.mjs --check` 没有接进 `check:*`，也没有接进构建。`deploy-preview` 不跑测试，快照过期的提交会进预览环境（正式发布有 `npm test` 兜底） | 加 `"check:manifests": "node build/gen_manifests_snapshot.mjs --check"`，unit.yml 跟着 `check:files-rules` 跑一步；`build_web.mjs` 开头也跑一次 `--check` |
| L6 | `src/app/__tests__/first-paint-wiring.test.ts` | main.tsx 的接线只用源码正则核对，“下载失败以后怎样”没有行为测试（M1 修好以后尤其需要） | 见 M1 的建议 5 |

## 三、评分

| 项 | 扣分 |
|---|---|
| 安全（入队校验、换账号闸） | 0：失败即关，闸正确，没发现绕过 |
| 失败降级（M1 不同步、不注册 SW、不重试、不提示；M2 写入抛错、卡在保存中） | −1.5 |
| 回归防护（M3 首屏没人守；L3 失败即关没有测试；L5 快照不在 check 里） | −1.0 |
| 体验、验证（L1 第一次写入要等下载；L2 重试只在 mock 下验证；L4、L6） | −0.5 |
| **总分** | **7.0 / 10，不通过** |

M1、M2、M3 修好，并补上 L3 的测试以后，可以只复审改动的部分。

## 四、记录文件（scratchpad）

- 测量：`cr-r3-measure.mjs`、`cr-r3-measure.txt`（③ 原样）、`cr-r3-measure-m10.txt`（M10 版本 171.8 KB）
- 变异：`cr-r3-mut.py`、`cr-r3-mut.txt`
- 其他日志：`r3-tsc.txt`、`r3-vitest.txt`、`r3-eslint.txt`、`r3-build.txt`、`r3-arch.txt`（副本里的 check_arch 基线，扫到了副本自带的 `.e2e-sb`、`dist`，不作数；正式结果以共享工作区跑的 0 个错误为准）

## 登记册（一行）

| FA6-3-CR | 2026-11-04 | FA-6 ③ 首屏瘦身审查 7.0 不通过：入队严格校验失败即关、换账号闸正确，首屏自测 145.7 KB（两个浏览器各 3 次），无 CSP 违规。中：M1 首屏后那批代码下载失败时这一页不同步、不注册 SW、不重试、不提示；M2 rows 加载失败时 write.* 抛错、编辑页卡在保存中；M3 zod 回到首屏没有测试拦（实测 171.8 KB，check_size 135.9 照样通过）。低：L1 第一次写入要等下载、L2 重试只在 mock 下验证、L3 失败即关没有测试、L4 别名只核对配置、L5 快照检查不在 check 里、L6 接线只有正则测试 | 前端 A | 中问题改完复审 |

---

# 第二轮（复审，2026-11-04）

- 审查人：同一位审查员，尺度和第一轮一样，默认不通过
- 范围：只看 ③ 这一轮的修改（执行说明“三之〇”）：
  - `src/app/after-paint.ts`（startAfterPaint）、`src/app/main.tsx`（SW 提前注册、startSync、横幅）
  - `src/core/outbox.ts`、`src/core/outbox-logic.ts`（OutboxCodeUnavailableError）、`src/core/write.ts`
  - `tests/build/first-paint-graph.test.ts`、`src/app/__tests__/after-paint-retry.test.ts`、`src/core/__tests__/outbox-code-unavailable.test.ts`、`first-paint-wiring.test.ts` 里 ③ 的部分
  - `build/build_web.mjs`、`package.json`、`.github/workflows/unit.yml` 里的 check:manifests
- 不在范围：本批首屏判断那几项、`tools/e2e/reuse-servers.mjs`（另有审查员在看）
- 验证方式：
  - 副本 scratchpad 的 `cr-fa6r3b`，`node_modules` 用联接；
  - 自己起的服务：端口 8799、inspector 9241、持久化目录 `.wrangler/state-cr8799`。用完连同 workerd 子进程一起结束，复查过端口没人在听；
  - 副本先拆联接再删除；
  - 共享工作区只改了本文件。eslint、check_arch 在共享工作区只读跑（check_arch 加 -B，不写字节码）。

## 结论：通过，8.5 / 10，但 M3 还剩一个中问题，提交前要补

- M1、M2 解决了，L1、L3、L5 也解决了；L2、L4 记进了执行说明，可以接受。
- **M3 只解决了一半**：
  - 依赖图测试只从 `main.tsx` 出发，不跟 `import()`；
  - 可是今天页、告知页这些懒加载块是在今天页**出现之前**下载的，也算首屏；
  - 我让今天页引一个 `rows.ts` 的常量（变异 R3）：测试全过，check_size 照样 110.6，页面时钟实测 **173.0 KB**，超过硬线。
- 分数按第一轮的同一把尺子算，够 8 分。但还开着的 M3 正是这道硬线的守卫，改动量很小（见下面），**建议补上以后再提交，只复审这一处**。要不要等补完再算通过，由主持人定。

## 一、上一轮问题逐条核对

| 编号 | 上一轮的问题 | 这一轮 | 依据 |
|---|---|---|---|
| M1 | 首屏后那批代码下载失败：这一页从此不同步、不注册 SW、不重试、不提示 | **已解决** | 见第二节 |
| M2 | rows 加载失败时 write.\* 抛错，编辑页卡在“保存中” | **已解决** | `outbox.ts:73-79` 包成 `OutboxCodeUnavailableError`；`write.ts:62` 归成 `local_unavailable`。界面提示“这台设备现在存不了，内容还在这里，稍后再改一次”，和实际情况相符。`drainPendingActions` 遇到非拒收的错误照旧不删、下次再转。变异 R11、R12 都被拦住 |
| M3 | zod 回到首屏没人拦 | **只解决了一半，仍是中** | 见第三节 |
| L1 | 第一次写入要等下载 | 已解决 | `loadAfterPaint` 顺带预加载 rows；变异 R15 被拦住 |
| L2 | 重试只在 mock 下验证过 | 记进执行说明，接受 | 连续失败 3 次出“重新打开”横幅兜底，重新载入正好也绕开模块表缓存 |
| L3 | “加载失败就放行”没有测试拦 | 已解决 | 上一轮的 M2 变异（这次是 R12）挂 3 条 |
| L4 | 别名测试只核对配置 | 记进执行说明，接受 | 产物层面靠 e2e 的 csp-fixture。本轮 6 次测量也没有 CSP 违规 |
| L5 | 快照检查不在 check 里 | 已解决 | `npm run check:manifests` 进了 unit.yml；`build_web.mjs` 在 vite build 之前先跑 `--check`。本轮构建输出了“manifests.gen.ts 一致” |
| L6 | 接线只有源码正则测试 | 大部分解决 | startAfterPaint 有假时钟的行为测试，8 条；main.tsx 照旧用源码核对，留了一个小口子，见新 L-b |

## 二、主持人要我确认的三点

### 1. 上一轮的 M10、M11 现在能不能拦住

**能。** 这次不是在测试里模拟，而是在副本里真改源码：

- R1：`boot.ts` 改回引 `rows.ts`；
- R2：`manifest-source.ts` 改回读 `shared/manifests`。

两条都让 `first-paint-graph.test.ts` 的“走不到 zod……”那条挂了。但同一类问题换到懒加载的首屏块上就拦不住，见第三节。

### 2. 退避重试会不会在离线时一直空转耗电

**不会。**

- 失败以后的退避是 2、4、8、16、32、64、128、256 秒，之后封顶 300 秒（`after-paint.ts:62`）；每次失败只发一轮请求，离线时立刻就失败；
- 能“立刻再试”的只有两种事件（`after-paint.ts:146-152`）：恢复网络（`online`）、切回前台。离线时不会有 online 事件；切回前台一次只试一次，失败照样按退避排下一次；
- 正在下载时不重复发起；一旦成功或者收手，就停掉计时器、退订这两个事件；
- 后台标签页里，浏览器本来就会把 setTimeout 节流。

所以离线一小时，最多十来次请求（前几分钟几次，之后每 5 分钟一次），没有忙等循环。变异 R4（失败后 0 毫秒再试）、R9（成功后不退订）都被拦住。

### 3. 横幅会不会和其他横幅打架

**不会。**

- 顶部只有一个位置，`UpdateBanner.bannerKind` 按优先级挑一条显示：`required` > `closed` > `sync_paused` > `new_version`。不会叠两条，也不会互相覆盖文字；
- 用户在录音、编辑时（`busy`），`sync_paused` 先不出，和别的横幅同一个规矩；
- 这条横幅用单独的 id `after-paint-failed`（`main.tsx:85`），下载成功时只收掉这一条。同步引擎自己的 `sync-paused` 只有在下载成功、wireSync 起来以后才可能出现，所以两条不会同时存在；
- 它压过“有新版本”，这是合理的：两条的按钮都是“重新打开”，点了效果一样；
- 小问题：id 改成和同步暂停共用（变异 R14）没有测试拦，见新 L-c。

## 三、还剩的问题

### 中

**M3（剩下的一半）　懒加载、但在今天页出现之前就下载的块，没人守 zod**

- 位置：`tests/build/first-paint-graph.test.ts:11`（`ENTRY` 只有 `main.tsx`），`reach` 不跟 `import()`。
- 漏掉的块：今天页的块（`features/today/index.ts` 用 `lazy(() => import('./ui/TodayPage.tsx'))`）和告知页的块（ConsentGate、useConsentWiring）。在页面时钟口径下，它们都在今天页出现之前开始下载（chromium 约 160～480 ms、今天页 785 ms），都算首屏。
- 复现（变异 R3）：
  1. 在 `src/features/today/ui/TodayPage.tsx` 加 `import { SCHEMA_V as CR_SV } from '../../../../shared/schema/rows.ts'; export const CR_PROBE = CR_SV;`；
  2. `tests/build/first-paint-graph.test.ts` 和 `src/features/today` 的测试全部通过（35 条）；
  3. `npm run build -- --mode e2e`，check_size 照样 110.6 / 150；
  4. 页面时钟实测 **173.0 KB**（两个浏览器都是）：zod-jitless 25.1、rows 1.2 在 508 ms（chromium）、2831 ms（webkit）开始下载，都早于今天页出现。
- 为什么还是中：今天页是功能代码，在里面引一个 shared/schema 的常量或 schema，比改 boot.ts 更容易发生；首屏离硬线只有约 3.4 KB。
- 建议（任选一条，改动都很小）：
  1. 依赖图测试的入口加上首屏会走到的懒加载页面：`src/features/today/ui/TodayPage.tsx`，以及 onboarding 里告知页关口懒加载的那几个文件。最好再加一条：断言 `features/today/index.ts` 里懒加载的目标就是这个文件，免得以后改名漏掉；
  2. 或者在构建以后的检查里，用 Vite manifest 算“入口的静态闭包 + 今天页、告知页这几个动态入口的静态闭包”，里面不许出现含 zod 的块（`zod-jitless-*`）。这个口径更接近页面时钟，也能兼作 L4 的产物核对。

### 低（新的）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| L-a | `src/app/after-paint.ts:146-151` | 超时以后 `inFlight` 已经复位，旧的那次 import 还挂着；这时来一次 online，会再发起一次。去掉 wake 里的 inFlight 判断（变异 R8）也没有测试拦。浏览器对同一个模块的动态 import 会合并成一次，所以只是多一次调度，不影响结果 | 记一笔就行；想守住的话，补一条“超时以后来 online，load 只多调一次”的测试 |
| L-b | `src/app/__tests__/first-paint-wiring.test.ts:67、74、109` | 只核对 `registerServiceWorker().then(` 这段文字的位置。把 SW 注册改成永远不执行的死代码（`const swReg = Promise.resolve(null)`，原来那段换成一个没人调用的函数），11 条测试全过 | 改成断言 `const swReg … = !import.meta.env.DEV && … ? registerServiceWorker()` 这一整句，并且后面没有被重新赋值；或者把这一段抽成函数做行为测试 |
| L-c | `src/app/main.tsx:85` | 横幅 id 改成 `'sync-paused'`、和同步引擎共用（变异 R14），没有测试拦。现在两条不会同时存在，所以后果很小；但以后要是改成“下载成功前也能出 sync-paused”，`dismissBanner` 会把同步引擎那条一起收掉 | 在 wiring 测试里钉住 `AFTER_PAINT_BANNER_ID !== 'sync-paused'` |

## 四、首屏自测（页面时钟，gzip -9）

脚本和第一轮同一份 `cr-r3-measure.mjs`，结果在 `cr-r3b-measure.txt`；R3 版本在 `cr-r3b-measure-R3.txt`。

| 版本 | chromium（3 次） | webkit iPhone 15（3 次） | check_size |
|---|---|---|---|
| 工作区原样 | **146.6 KB**（今天页 785～789 ms） | **146.6 KB**（今天页 1988～2042 ms） | 110.6 |
| 变异 R3（今天页引 rows.ts） | 173.0 KB | 173.0 KB | 110.6（没变） |

- 和前端 A 报的 146.4 差 0.2 KB。共享工作区里同时还有别的改动，副本是把整个工作区复制过来的，所以差这一点正常；离硬线还有 3.4 KB；
- zod、rows 在今天页之后才开始下载（chromium 791 ms、webkit 2062 ms）；
- 6 次都没有 CSP 违规，控制台也没有报错。

## 五、跑过的验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（副本） | 退出码 0 |
| `npx vitest run src/core src/app src/features/today tests/build/first-paint-graph.test.ts tests/build/zod-alias.test.ts --exclude tests/build/gen-tauri-key.test.ts`（副本） | 100 个文件、826 条，全部通过 |
| `npx eslint` 对本轮改的 10 个文件（共享工作区，只读） | 退出码 0 |
| `python -I -B build/check_arch.py`（共享工作区，只读） | 0 个错误，1 个警告（W2：节假日，和 ③ 无关） |
| `npm run build -- --mode e2e`（副本） | 通过；先输出“manifests.gen.ts 一致”，check_size 110.6 / 150 |
| Playwright 页面时钟测量（副本，8799） | 见第四节 |

变异（脚本 `cr-r3b-mut.py`，结果 `cr-r3b-mut.txt`；每条改一处，跑相关测试，再按原字节还原）：

| 编号 | 变异 | 结果 |
|---|---|---|
| R1 | 上一轮 M10：boot.ts 改回引 rows.ts | 拦住（first-paint-graph） |
| R2 | 上一轮 M11：manifest-source 读 shared/manifests | 拦住 |
| R3 | 今天页（懒加载、但在今天页出现前下载）引 rows.ts | **没拦住**（35 条全过）→ M3 |
| R4 | 失败后 0 毫秒再试（不退避） | 拦住（4 条） |
| R5 | 不设超时 | 拦住 |
| R6 | 下载回来以后不过闸 | 拦住 |
| R7 | 下载前不过闸 | 拦住（2 条） |
| R8 | online 时正在下载也再发起 | **没拦住** → L-a（影响小） |
| R9 | 成功以后不退订 online、前台 | 拦住（2 条） |
| R10 | 超时的那次后来到了也不用 | 拦住 |
| R11 | write 不归类 OutboxCodeUnavailableError | 拦住 |
| R12 | rows 加载失败放行（上一轮的 M2） | 拦住（3 条） |
| R13 | 第 3 次失败不出横幅 | 拦住 |
| R14 | 横幅 id 改成和同步暂停共用 | **没拦住** → L-c（影响小） |
| R15 | loadAfterPaint 不预加载 rows | 拦住 |
| 补充 | SW 注册改成死代码 | **没拦住**（wiring 11 条全过）→ L-b |

## 六、评分（尺子和第一轮一样）

| 项 | 第一轮 | 第二轮 |
|---|---|---|
| 正确性、安全（入队校验、换账号闸、重试过闸） | 0 | 0 |
| 失败降级（M1、M2） | −1.5 | 0：重试、超时、提示、SW 提前注册、写入不抛错都到位，离线不空转 |
| 回归防护（M3、L3、L5） | −1.0 | −0.75：L3、L5 解决了，M3 还剩懒加载首屏块这一半（中） |
| 体验、验证（L1、L2、L4、L6 和这一轮新的 L-a、L-b、L-c） | −0.5 | −0.25：L1 解决，L2、L4 记录在案；L-b、L-c 是测试强度的小口子 |
| **总分** | **7.0，不通过** | **9.0 → 保守取 8.5，通过** |

- 保守多扣 0.5，是因为 M3 这一半已经实测会让首屏超过硬线。
- 建议提交前按第三节补上首屏懒加载块的守卫，只复审这一处。补完以后，同一个 R3 变异要能拦住。

## 登记册（一行）

| FA6-3-CR2 | 2026-11-04 | FA-6 ③ 复审 8.5 通过（M3 余下一半提交前补）：M1（退避 2～300 秒、15 秒超时、online 和切回前台立刻再试、每次过闸、第 3 次出横幅、SW 提前注册）、M2（写入回 local_unavailable 不抛）、L1、L3、L5 解决；M10、M11 真改源码能拦；离线不空转；横幅单一位置按优先级显示，不打架。中：依赖图不跟懒加载的首屏块，今天页引 rows.ts 时首屏 173.0 KB 没人拦。低：L-a online 重复发起、L-b SW 注册的接线测试只核对文字、L-c 横幅 id 没钉住。首屏实测 146.6 KB | 前端 A | 补 M3 后复审一处 |

---

# 第三轮（复审，2026-11-05）

- 审查人：同一位审查员，尺度和前两轮一样，默认不通过
- 范围：
  - M3 剩下那一半的补法：新文件 `build/check_first_paint_chunks.mjs`、`tests/build/first-paint-chunks.test.ts`，以及 `build/build_web.mjs` 的接入；
  - 一并看的几处：上一轮的 L-b、L-c（`first-paint-wiring.test.ts:129-145`），首屏那批审查的新 L1（看门狗命令行入口退出码 125，`e2e-reuse.test.ts:114`），新 L3（`first-paint-fallback.test.tsx:101` 的注释），`main.tsx:175` 的守护测试（`first-paint-wiring.test.ts:120`）；
  - 按页面时钟口径量一次首屏，前端 B 新加了“错过行分包随首屏下载”。
- 验证方式：
  - 副本 scratchpad 的 `cr-fa6r3c`，`node_modules` 用联接；
  - 自己起的服务：端口 8801、inspector 9243、持久化目录 `.wrangler/state-cr8801`。用完连同 workerd 子进程一起结束，复查过端口没人在听；
  - 副本先拆联接再删除，主目录 node_modules 完好；
  - 共享工作区只改了本文件；eslint 在共享工作区只读跑。

## 结论：不通过，7.5 / 10

**最前面先说：首屏硬线 150 KB 现在没达到。** 页面时钟实测 **177.1 KB**，chromium、webkit 各 3 次，6 次一样，超线 27.1 KB。

- 超出来的是前端 B 新加的错过行那一组：今天页一挂上就渲染懒加载的 `MissedReminders`，它带进来下面这些块，合计约 30.4 KB：

  | 块 | 大小 |
  |---|---|
  | MissedReminders | 1.2 |
  | Dialog | 2.3 |
  | es2015 | 11.3 |
  | tslib | 0.5 |
  | useRemindT | 5.1 |
  | useReminders | 5.0 |
  | setting-write、remind-settings、pc-class、Remind.module、remind-view、Bell、RemindButtons、UnsyncedRemind、useUnsynced | 约 4.9 |

  这些块在 chromium 507 ms、webkit 1956 ms 开始下载，都早于今天页出现（chromium 750～769 ms，webkit 2013～2030 ms），所以按口径都算首屏。执行说明第四节早就预告过这个风险：“MissedReminders 以后接进今天页时……约 14 KB”，实际比预告多一倍，因为还带上了 Dialog 和 es2015。
- 构建自带的 check_size 报 110.7、照样通过；新加的首屏块检查只查 zod，也照样通过。所以**现在没有任何一道自动检查能发现首屏超线**。
- ③ 自己的代码：L-b、L-c 修好了，前面几轮的修复都还在。但 M3 的补法只守住了名单里那 3 个动态入口；错过行这个首屏懒加载块不在名单里，引进 zod 时同样拦不住（变异 R3b 实测 203.5 KB）。

## 一、M3 复查

| 变异（副本里真改源码，再真构建） | 构建结果 | 页面时钟首屏 |
|---|---|---|
| R3：`TodayPage.tsx` 引 `rows.ts` 的常量 | **构建失败，退出码 1**。报 `_rows-`、`_zod-jitless-` 两块在首屏闭包里，zod-jitless 块里有 `$ZodType` | （没产物） |
| R3b：`MissedReminders.tsx` 引 `rows.ts` 的常量 | **构建通过**，输出“首屏块里没有 zod：入口 + 3 个动态入口的静态闭包都查过”，check_size 110.7 | **203.5 KB**（两个浏览器都是）。zod-jitless 25.1、rows 1.2 在 chromium 569 ms、webkit 1928 ms 开始下载，早于今天页出现 |

- R3 确实拦住了，前端 A 说的是对的。
- 拦不住 R3b 的原因：
  - `FIRST_PAINT_DYNAMIC`（`build/check_first_paint_chunks.mjs:14`）是手写的名单，只有今天页、告知页关口、告知页三个；
  - 而首屏期间被渲染的懒加载组件不止这三个，比如今天页里的 `MissedReminders`（`features/reminders/index.ts:14` 的 `lazy(() => import('./ui/MissedReminders.tsx'))`）；
  - 名单是靠人记着同步的。前端 B 这次加错过行的时候就没同步，说明这种做法守不住。
- 检查脚本本身的变异：名单去掉告知页（G5）、不看内容特征（G6）、build_web 不看它的退出码（G7），都被 `first-paint-chunks.test.ts` 拦住。

## 二、一并看的几处

| 项 | 变异 | 结果 |
|---|---|---|
| L-b SW 注册的接线测试只核对文字 | G2：SW 注册改成死代码 | **拦住**（`first-paint-wiring.test.ts:129`）→ 已解决 |
| L-c 横幅 id 没钉住 | G3：改成 `'sync-paused'`；G3b：经另一个常量间接写成 `'sync-paused'` | 都**拦住**（`:141`）→ 已解决 |
| 首屏那批的新 L1：看门狗命令行入口不传 checkPorts | G4（就是那边的 U6） | **拦住**（`e2e-reuse.test.ts:114` 真跑命令行入口，期望退出码 125）→ 已解决 |
| 首屏那批的新 L3：fallback 前半段的注释 | 读码 | `first-paint-fallback.test.tsx:101-102` 已改成“横幅和页面在同一个 Suspense 里，分包没到时横幅也不在，这一段测不到横幅里有没有 main” → 已解决 |
| `main.tsx:175` watchAccount 的 `currentUserId` | G1：改成 `() => readSessionUserId() ?? userId` | **拦住**（`first-paint-wiring.test.ts:120`）→ 已有守护 |
| 首屏那批的新 L2（动态标签名能绕过源码扫描） | 没做变异 | 那边已经接受、记录在案，这次不重复 |

## 三、问题清单

### 高（批次层面）

**H1　首屏 177.1 KB，超过 150 KB 硬线**

- 位置：今天页渲染的 `MissedReminders`（`src/features/today/ui/TodayPage.tsx:33、92`；`src/features/reminders/index.ts:14`）。
- 复现：
  1. `npm run build -- --mode e2e`；
  2. wrangler pages dev 起服务；
  3. 用 scratchpad 的 `cr-r3-measure.mjs` 冷启动 `/app/#/today`，按页面时钟计；
  4. chromium、webkit 各 3 次都是 177.1 KB（结果在 `cr-r3c-measure.txt`）。
- 归属：代码是前端 B 这次加的，不是 ③ 的代码；但硬线是 FA-6 的验收线，按任务单是硬线，不放宽口径。
- 可选做法（要动产品表现的，请主持人和负责人定，不由审查员定）：
  1. 错过行等首屏画完再挂（appPainted 或空闲以后）。代价：错过行会晚出现几百毫秒，可能有一次跳动；
  2. 拆一个只算条数的轻量入口：今天页只显示“错过 N 条”，`useReminders`、`useRemindT` 的完整版和 Dialog 等点开再下载。执行说明第四节当时就建议过这么做；
  3. 至少把 Dialog 和它带进来的 es2015（约 13.6 KB）改成点开时才下载：仍超线约 13.5 KB，不够，要和 1 或 2 一起做。

### 中

**M3（第三轮）　首屏守卫靠手写名单，漏掉首屏期间渲染的懒加载组件；也不守体积**

- 位置：`build/check_first_paint_chunks.mjs:14`（`FIRST_PAINT_DYNAMIC`）。
- 复现：
  - R3b：`MissedReminders.tsx` 引 `rows.ts`，构建通过，首屏 203.5 KB；
  - H1 本身：首屏 177.1 KB，所有检查都通过。
- 建议：
  1. **根本做法**：把页面时钟口径的测量放进 e2e，例如在 `tests/e2e/b2-first-screen-supabase.spec.ts` 里加一条断言：今天页出现之前开始下载的 JS 按 gzip -9 合计不超过 150 KB，而且其中没有 zod 的块（`$ZodType`）。两个浏览器都跑。这样不管是哪个懒加载组件、引的是不是 zod，超线都会失败；执行说明第一节也说过 check_size 要按这个口径改；
  2. 构建期这道检查留着，作为便宜的第一道；名单里补上 `features/reminders/ui/MissedReminders.tsx`，再加一条测试：扫 `TodayPage.tsx` 和告知页里直接渲染的 `lazy(...)` 组件，要求它们都在名单里。

### 低

- L2、L4、L-a 照旧，记录在案，不再重复。

## 四、首屏自测（页面时钟，gzip -9）

脚本 `cr-r3-measure.mjs`，结果 `cr-r3c-measure.txt`；R3b 版本在 `cr-r3c-measure-R3b.txt`。

| 版本 | chromium（3 次） | webkit iPhone 15（3 次） | check_size | 首屏块检查 |
|---|---|---|---|---|
| 工作区原样（11-05） | **177.1 KB**（今天页 749～769 ms） | **177.1 KB**（今天页 2013～2030 ms） | 110.7 | 通过 |
| R3b | 203.5 KB | 203.5 KB | 110.7 | 通过（漏了） |

- zod-jitless、rows 仍在今天页之后才开始下载（chromium 750 ms、webkit 2027 ms），③ 的瘦身本身还在起作用；
- 6 次都没有 CSP 违规；
- 上一轮的 146.6 加上错过行那一组约 30.4 KB，基本对得上 177.1。

## 五、跑过的验证

| 命令 / 动作 | 结果 |
|---|---|
| `npm run build -- --mode e2e`（副本，原样） | 通过；“manifests.gen.ts 一致”，check_size 110.7，“首屏块里没有 zod” |
| `npx vitest run` first-paint-wiring、first-paint-fallback、first-paint-chunks、first-paint-graph、e2e-reuse、e2e-ports、after-paint-retry、`src/features/today`、`src/features/reminders`（副本） | 31 个文件、276 条，全部通过 |
| `npx eslint` 对 `check_first_paint_chunks.mjs`、`first-paint-chunks.test.ts`、`build_web.mjs`、`first-paint-wiring.test.ts`（共享工作区，只读） | 退出码 0 |
| 构建变异 R3、R3b（副本） | 见第一节 |
| 单测变异 G1～G7（脚本 `cr-r3c-mut.py`，结果 `cr-r3c-mut.txt`） | 8 条全部拦住 |
| Playwright 页面时钟测量（副本，8801） | 见第四节 |
| 收尾 | 8801、9243 没有残留监听；副本已删 |

## 六、评分（尺子和前两轮一样）

| 项 | 第二轮 | 第三轮 |
|---|---|---|
| 正确性、安全 | 0 | 0 |
| 失败降级 | 0 | 0 |
| 回归防护（M3 守卫） | −0.75 | −1.5：手写名单已经实际漏掉一个首屏懒加载块（R3b 203.5 KB），而且守卫不管体积，177.1 KB 也没人发现 |
| 体验、验证（L2、L4、L-a；L-b、L-c 已解决） | −0.25 | −0.25 |
| 首屏硬线（H1，批次层面） | — | −0.75 |
| **总分** | **8.5，通过（M3 待补）** | **7.5，不通过** |

- ③ 自己这次的补法方向是对的，R3 也确实拦住了。不通过是因为硬线现在实际超了，而守卫的设计让这件事不会被发现。
- 要通过：H1 降回 150 以内（做法请主持人和负责人定），加上 M3 建议 1 的 e2e 页面时钟断言。之后复审这两处即可。

## 登记册（一行）

| FA6-3-CR3 | 2026-11-05 | FA-6 ③ 第三轮复审 7.5 不通过：首屏页面时钟实测 177.1 KB 超硬线（前端 B 的错过行 MissedReminders 一组约 30.4 KB 在今天页之前下载），check_size 110.7、首屏块检查都没发现；M3 的手写名单漏掉首屏懒加载块（MissedReminders 引 rows.ts 构建通过、首屏 203.5 KB）。R3 已拦住；L-b、L-c、看门狗 125、fallback 注释、main.tsx:175 守护都已到位（变异 G1～G7 全拦） | 前端 A、前端 B | H1 做法请主持人和负责人定；加 e2e 页面时钟断言后复审 |

---

# 第四轮（复审，2026-11-05）

- 审查人：同一位审查员，尺度和前三轮一样，默认不通过
- 先查第三轮定的两个通过条件：
  1. 首屏降回 150 KB 以内；
  2. 有按页面时钟口径的自动守护。
- 再看主持人点名的几处：
  - 自己重做 R3b，再做一个“首屏多加约 1 KB 的新静态 import”变异，看 e2e 会不会变红；
  - ExitIncompleteScreen 改成按需下载以后，“分包取不到时显示静态兜底”这处差异是否合理。
- 不在范围：前端 A 正在拆的 `core/manifests.gen.ts`（给 FA-7 底栏腾空间，下一批再审）。
- 验证方式：
  - 副本 scratchpad 的 `cr-fa6r3d`，`node_modules` 用联接；
  - e2e 用临时配置 `cr-r3d.pw.config.mts`：8851、inspector 9251、持久化目录 `.wrangler/state-cr8851`、假后端 9192/9193；web 服务只起 wrangler，构建另外做，这样构建检查失败时也能拿产物跑 e2e；
  - 测量用的服务另起在 8852、inspector 9252；
  - 用完把这些端口的进程树都结束了，复查过端口没人在听；副本先拆联接再删除，主目录 node_modules 完好；
  - 共享工作区只改了本文件。

## 结论：通过，9.0 / 10

- **条件 1 达到了**：首屏 **149.9 KB**，chromium、webkit 各 3 次，6 次一样，和前端 A 的数字一致。精确算是 153 504 字节，离硬线 153 600 字节只剩 **96 字节**。
- **条件 2 达到了**：新的 `tests/e2e/b2-first-screen-budget.spec.ts` 按页面时钟口径守着“≤ 150 KB、没有 zod”，两个浏览器都跑，CI 里的 `npm run e2e` 会跑到它（`ci.yml:368`）。
  - R3b：构建先失败，e2e 两条也都红；
  - 首屏多加约 1 KB：构建照常通过（check_size 本来就管不到），e2e 体积那条两个浏览器都红。
- ExitIncompleteScreen 的兜底差异合理，见第三节。
- 只剩几条低问题，见第四节。
- **提醒**：只有 96 字节余量，首屏路径上再加任何东西都会让 e2e 变红。这是守护在起作用，不是缺陷；但 FA-7 底栏动工前要先腾出空间（前端 A 正在拆 manifests.gen.ts，下一批审）。

## 一、通过条件复查

### 1. 首屏体积（页面时钟，gzip -9）

脚本 `cr-r3-measure.mjs`，结果在 `cr-r3d-measure.txt`。

| 浏览器 | 次数 | 今天页出现 | 首屏 | CSP 违规、控制台报错 |
|---|---|---|---|---|
| chromium 390×844 | 3 | 757～805 ms | **149.9 KB**（3 次一样） | 无 |
| webkit iPhone 15 | 3 | 2043～2220 ms | **149.9 KB**（3 次一样） | 无 |

- 今天页出现之前开始下载的有 37 个块，按 gzip -9 合计 153 504 字节，余量 96 字节；
- 构建自带的 check_size 首屏口径是 107.1；首屏块检查输出“首屏块里没有 zod：入口 + 6 个动态入口的静态闭包都查过”；
- 错过行那一组现在只剩 MissedReminders、remind-list、setting-read、remind-settings、Bell、Remind.module、useRemindRowT、UnsyncedRemind、useUnsynced 这些小块。Dialog、es2015、useReminders、useRemindT 都不在首屏了；
- 前端 A 拆出去的推送认领、断开推送、月历手势、版本横幅、整屏提示，在首屏里都看不到了。

### 2. 自动守护

| 变异（副本里真改源码） | 构建（build_web） | e2e `b2-first-screen-budget`（两个浏览器 × 2 条） | 页面时钟实测 |
|---|---|---|---|
| 原样 | 通过 | **4 条全绿** | 149.9 |
| R3b：`MissedReminders.tsx` 引 `rows.ts` 的常量 | **失败，退出码 1**：报 `_rows-`、`_zod-jitless-` 在首屏闭包里，zod-jitless 块里有 `$ZodType` | **4 条全红**：“首屏下载了带 zod 的块”和“出现之前开始下载 176.3 KB，超过 150 KB”，两个浏览器都报 | 176.3 KB |
| PAD1K：`main.tsx` 静态引一个新模块（约 1 KB gzip 的随机串，挂到全局上，免得被摇掉） | 通过：check_size 108.1、首屏块检查也通过 | **体积那条两个浏览器都红**（150.9 KB）；zod 那条照常绿 | 150.9 KB |

- 两个变异都按原字节还原了，并且和共享工作区逐字节比对过；新建的那个模块文件也删了。
- 日志：`r3d-e2e-base.log`、`r3d-e2e-R3b.log`、`r3d-e2e-PAD1K.log`、`cr-r3d-mut-PAD1K.txt`。
- 依赖图测试（`first-paint-graph.test.ts`）的“每个 import() 都要归类”这一道我看过：
  - 新加一个没归类的懒加载块会报错，单测里有模拟；
  - 我拿实测首屏下载的 37 个块和 `NOT_FIRST_PAINT` 名单对了一遍，名单里说“不在首屏”的模块，确实都没在首屏下载，只有 account-status 一处说法不准，见低问题 L-d。

## 二、上一轮问题核对

| 编号 | 第三轮 | 这一轮 |
|---|---|---|
| H1 首屏 177.1 KB 超线 | 高 | **已解决**：149.9 KB |
| M3 首屏守卫靠手写名单、不守体积 | 中 | **已解决**：e2e 按页面时钟兜底，体积和 zod 都守；名单补到 6 项；依赖图要求每个 import() 都归类 |
| L-b、L-c、看门狗 125、fallback 注释、main.tsx:175 | 第三轮已确认到位 | 这轮只跑了它们所在测试文件的回归，没重做变异 |

## 三、ExitIncompleteScreen 改成按需下载：兜底差异是否合理

做法（`src/app/exit-screen.tsx`）：
- 挂出时马上建宿主、给 `#root` 加 inert，不等下载；
- 下载成功画原来的整屏提示；
- 下载失败画已经在首屏里的 `AppCrashFallback`（“哎呀，卡住了 · 刷新一下”，点了重新载入）；
- 下载期间就被卸掉的，下载好也不再画。

判断：**合理**。理由：
1. **安全不变量没破**：这屏存在的意义是“会话没删掉时，不让人碰账号界面”。
   - 启动路径（`main.tsx:96-108`）：在 render 之前 return，账号界面根本不会画；
   - 运行中的路径（`watchExitIncomplete`）：挂出时同步给 `#root` 加 inert，不等下载。
   - 兜底页和原来的整屏提示用的是同一份样式（`CacheTooNewScreen.module.css` 的 `.screen`：`position: fixed; inset: 0; z-index: 100; background: var(--bg)`），会盖住整个屏幕，不会只显示在页面底部、让人看着一个点不动的界面。
2. **功能上等价**：
   - 启动路径里，“重新载入”会重新走 `settleDropAtStartup()`，再删一次会话，效果就是“重试”；
   - 读不到凭据管理器（unavailable）那种情况，原来的按钮本来就是“重新打开”。
   - 差别只在文案：兜底页说“卡住了”，不说“退出没完成”。这只在“整屏提示本该出现，它的分包又取不到”两件事同时发生时才会看到；exe 里分包是本地文件，几乎不会发生。可以接受。
3. **下载期间**：宿主是空的，底下的界面看得见但点不到。exe 读本地文件只要几毫秒，可以接受。
4. **测试**：`exit-incomplete.test.tsx:77` 覆盖“先加 inert、下载失败画兜底、点了重新载入、卸掉时还原 inert”；`:95` 覆盖“下载期间就卸掉，下载好也不再画”。

## 四、低问题

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| L-d | `tests/build/first-paint-graph.test.ts` 的 `NOT_FIRST_PAINT` | 写着 `src/platform/account-status.ts`“首屏画完以后才下载”。实际上告知页关口的 `consent-exit.ts` 静态引用了它，整个模块（`account-status-*.js`，约 1 KB）在今天页出现之前就下载了（实测约 185 ms）；after-paint 里那次 `import()` 其实不会再发请求。体积已经算进 149.9 里，不影响结论，只是说明写错了 | 改成“告知页关口静态引用，已在首屏；after-paint 的 import() 只是取引用” |
| L-e | `tests/build/first-paint-graph.test.ts:255`（node 项目，默认 5 秒超时） | 单跑 720 ms；我和 typecheck 一起跑时 23.9 秒、超时失败（`first-paint-pages.test.tsx` 两条也在同样负载下超时）。单独重跑全过，是负载问题，不是逻辑问题。但它反复同步读很多文件，满载的机器上可能偶发失败 | 把源码读取缓存起来，同一个文件只读一次；或者登记进 `SLOW_NODE_TESTS` |
| L2、L4、L-a | 同前 | 记录在案 | — |

## 五、跑过的验证

| 命令 / 动作 | 结果 |
|---|---|
| `npm run build -- --mode e2e`（副本，原样） | 通过；manifests 一致；check_size 107.1；首屏块检查 6 个动态入口通过 |
| `cr-r3-measure.mjs` 两个浏览器各 3 次（8852） | 149.9 KB × 6，见第一节 |
| `npx playwright test tests/e2e/b2-first-screen-budget.spec.ts`（临时配置，8851） | 原样 4/4 绿；R3b 4/4 红；PAD1K 体积 2/2 红、zod 2/2 绿 |
| `npm run typecheck`（副本） | 退出码 0 |
| `npx vitest run src/app src/core src/platform src/features/today src/features/reminders` 加 first-paint-graph、first-paint-chunks、zod-alias（副本） | 1606 条里 1603 过；挂的 3 条都是和 typecheck 并跑时的 5 秒超时，单独重跑这两个文件 14/14 过（见 L-e） |
| 读码 | `exit-screen.tsx`、`ExitIncompleteScreen.tsx`、`AppCrashFallback.tsx`、`CacheTooNewScreen.module.css`、`main.tsx:88-112`、`exit-incomplete.test.tsx` |
| 收尾 | 8851、8852、9251、9252、9192、9193 都没有残留监听；副本已删 |

## 六、评分（尺子和前三轮一样）

| 项 | 第三轮 | 第四轮 |
|---|---|---|
| 正确性、安全（含 ExitIncompleteScreen 兜底） | 0 | 0 |
| 失败降级 | 0 | 0 |
| 回归防护 | −1.5 | 0：页面时钟 e2e 加构建期检查加依赖图归类，三道都实测拦得住 |
| 首屏硬线 | −0.75 | −0.25：达到了，但只剩 96 字节，下一批必须先腾空间 |
| 体验、验证（L2、L4、L-a、L-d、L-e） | −0.25 | −0.75 |
| **总分** | **7.5，不通过** | **9.0，通过** |

## 登记册（一行）

| FA6-3-CR4 | 2026-11-05 | FA-6 ③ 第四轮复审 9.0 通过：首屏页面时钟 149.9 KB（两个浏览器各 3 次，余量 96 字节）；e2e 首屏预算用例实测拦得住 R3b（构建也失败，176.3 KB）和首屏加约 1 KB（150.9 KB，构建不拦、e2e 拦）；ExitIncompleteScreen 按需下载以后，分包取不到时画全屏静态兜底，inert 先加，合理。低：L-d account-status 的说明不准、L-e 依赖图测试在负载下会超时。FA-7 动工前先腾首屏空间 | 前端 A、前端 B | 低问题顺手改 |
