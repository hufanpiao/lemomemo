# B0 第一轮评审 · 前端 A 返工登记

- **返工人**：前端 A　**日期**：2026-10-28
- **起点**：main `14ae558`；分支 `worktree-agent-a1648c8b7f358c572`
- **依据**：本目录下 B0-动效确认-UI4.md、B0-代码审查.md、B0-安全审查.md、B0-QA测试报告.md（按原文编号）
- **范围**：只改 `src/`、前端 A 自己的 `build/check_size.mjs`、`eslint.config.js`、`tests/arch*`、`tests/build/check-size.test.ts`。`shared/`、`functions/`（前端 B）、CI（运维）、过程记录、评审索引、需求记录都没碰
- **说明**：本文件只是登记，**不是签字**。是否通过由各评审复查决定

## 一、逐条

做法：每条先写会失败的测试，跑一遍确认失败，再改代码。“先失败”一栏是改代码之前的实际结果。

| 评审编号 | 改了什么（文件:行） | 怎么验证 | 先失败 |
|---|---|---|---|
| **UI-4 M-1** 减少动态效果两套判断 | 新增 `src/motion/reduced.ts`：唯一的判断 `prefersReducedMotion()`（`<html data-rm="1">` 或系统 `prefers-reduced-motion: reduce`，任一成立）和 `subscribeReducedMotion()`（系统设置的 change + `data-rm` 的 MutationObserver）。新增 `src/motion/useReducedMotionPref.ts`：`useSyncExternalStore` 接上面两者。`src/motion/index.ts:5、12` 改为用并导出 reduced.ts（原来自带的一份删掉）。`src/motion/Appear.tsx:19、23` 不再用 Motion 的 `useReducedMotion()`（只认系统），改用 `useReducedMotionPref()`，外面再包 `MotionConfig reducedMotion`。`src/motion/SharedLayout.tsx:12、14` 同样包 `MotionConfig`，成立时 layoutId 的弹簧位移直接到位。`components.ts` 导出 hook | `src/motion/__tests__/reduced-motion.test.tsx`（6 条）：两条任一成立；hook 在 `data-rm` 增删、系统设置切换时都重新渲染，卸载后监听清零；只开 `data-rm`、系统没开时 `<Appear>` 没有 transform；`<SharedLayout>` 子树里 `useReducedMotionConfig()` 为 true；都没开时两个对照照常 | 3 条失败（hook 不存在、Appear 照样位移、SharedLayout 不认） |
| **UI-4 M-2** navigate 用 flushSync | `src/app/router.ts:43-93`：监听器集中在模块里，`commit()` 在 `motion.transition()` 的回调里同步改地址（`history.pushState`，不触发 hashchange、不会重复切）并 `flushSync(notifyAll)`；浏览器前进 / 后退的 `hashchange` 走同一个 `commit()`；一次切换只起一个 View Transition。`eslint.config.js` 的 `ROUTER_IMPORTS` 另准 `react-dom`（只为 flushSync；react-dom 本来就在首屏），对照样例 `ok-router-imports.ts` 同步加上 | `src/app/__tests__/navigate.test.tsx`（4 条）：用假的 `startViewTransition`，回调一返回就读 DOM，必须已是新路由；hashchange 同样；两个组件订阅时只起一个 transition；不支持 View Transitions 时也同步画完。`tests/e2e`（chromium + webkit）照常通过。**真机录屏（iOS Safari 18、WebView2）按 UI-4 原文是上线前的事，本次没做** | 4 条全部失败（回调返回时 DOM 还是旧页面） |
| **UI-4 L-4** CSP 三条规矩进 lint | `eslint.config.js:188-216` 新增 `CSP_SYNTAX`，`:281` 并进每个作用域的 `no-restricted-syntax`（src/motion、预览沙箱、测试也带）：① `AnimatePresence mode="popLayout"`（字符串、`{'…'}`、模板字符串）；② Radix Dialog / AlertDialog 的 `Overlay`（`X.Overlay` 和具名 import `Overlay` / `DialogOverlay` / `AlertDialogOverlay`）；③ `DropdownMenu.Root` 没写 `modal={false}`（`modal`、`modal={true}`、`modal={变量}` 都算违规），并且 DropdownMenu 只准 `import * as DropdownMenu`（防止具名引 Root 绕过）。`src/app/dev/CspLab.tsx:20` 的对照组（e2e 要证明 Overlay 确实被 CSP 拦）加了带理由的单行豁免 | 违规样例 7 个：`tests/arch-fixtures/eslint/l4-dialog-overlay.tsx`、`l4-alert-dialog-overlay-import.tsx`（count=2）、`l4-poplayout.tsx`、`l4-poplayout-expression.tsx`（count=2）、`l4-dropdown-no-modal.tsx`、`l4-dropdown-modal-true.tsx`（count=3）、`l4-dropdown-named-import.tsx`；对照 2 个：`ok-l4-csp-safe.tsx`、`ok-l4-motion-modes.tsx`。都带 `message=CSP`，只认 CSP 那几条的报错（见下面“代码审查低 11”） | 7 个违规样例全部没拦住 |
| **QA D-06** 规则号核对、T1、W3、TC-B0-10、A13 | ① `tests/arch/fixture-header.ts`：文件头加 `rule=`（架构规则号，违规样例必填）、`message=`、`count=`；eslint / stylelint / tsc 三个目录现有的 74 个违规样例全部补了 `rule=`。② 新增 `tests/arch/coverage.test.ts`：读架构文档 2.3 的规则表（23 条），从三个目录的 `rule=`、check_arch 样例目录名、`supabase/tests/d1-fixtures/*.psql`、`check_size/w3-*` 收集样例，缺一条就报“A13：规则无违规样例”。③ T1：`tests/arch-fixtures/tsc/t1-strict.ts`（五个严格选项各违反一处，五个错误码都要出现）；`tests/arch/tsc.test.ts` 加 5 条：五份 tsconfig 解析后都开着这五个选项。④ W3：`build/check_size.mjs:3、44-46` 加 `--app-dir`；样例 `tests/arch-fixtures/check_size/w3-over-budget/manifest.json`，`tests/build/check-size.test.ts` 在临时目录照它搭构建目录、现做随机字节（不往仓库放几百 KB），超预算退出码 1 报 W3，对照（懒加载页再大也不算首屏）通过。⑤ TC-B0-10：`tests/arch/durations.test.ts` 扫 src 下所有 CSS 的时长令牌和 transition / animation、`motion/tokens.ts` 的 dur，超过 400ms 的只能是 `--dur-drop`；违规样例 `tests/arch-fixtures/durations/tc-b0-10-500ms.css`（500ms 令牌 + 0.5s transition，两处都报） | **重做 QA 改坏抽查 10**：移走三个 `a13-*` 样例 → `coverage.test.ts` 报“A13：规则无违规样例”，失败；移回后通过。T1 样例：编译报 TS7006、TS2532、TS2375、TS4114、TS18046。W3、TC-B0-10 测试见左 | 抽查 10 原来“69 条全过、不报”，现在拦住 |
| **QA D-07** data → data 违规样例 | `tests/arch-fixtures/eslint/a1-data-imports-other-feature-data.ts`（todos 的 data 引 calendar 的 data）、对照 `ok-data-imports-own-data.ts`。仓库里还没有任何功能的 `data/` 文件，引不存在的路径时边界规则认不出类型、根本不报（我先照 QA 原文写，确认没拦住），所以放了一个真的引用目标 `tests/arch-fixtures/eslint-targets/src/features/calendar/data/events.ts`，并在 `tests/arch/eslint.test.ts` 让边界规则多认这一个目录（只在测试里，生产配置不变） | **重做 QA 改坏抽查 4b**：把 feature-data 的 `same('feature-data')` 放宽成 `any('feature-data')` → 这个样例失败；改回后通过 | 抽查 4b 原来“96 条全过” |
| **代码审查低 6** files.ts 读体超时（任务第 5 项） | `src/platform/files.ts:220-255` 原来的 `send()` 换成 `exchange()`：计时器从发请求一直管到 `read` 读完响应体（上传读 JSON、签名读 JSON、取字节读 10 MB 的 blob、各种错误响应读 JSON 都在内），超时先 abort、再经自己持有的 reader 取消响应体（流已上锁时直接 cancel 会被拒，所以 `:180` 的 `relay()` 转一手）。`:171` `readJson()`：不是 JSON 或读不下来回 null（和原来的容错一致）。`upload`（`:263`）、`signBatch`（`:283`）、`fetchBlob`（`:329`）都改走 `exchange`。超时时长不变（`TIMEOUT_MS`）。思路和前端 B 在 objstore 做的一样（AbortController，超时折成 timeout），但客户端这边按审查意见把响应体也计进去 | `files.test.ts`：200 / 409 / 500 三种响应头到了、响应体卡住 → 到点前不结束、到点 `retry/timeout`、响应体被取消；`files-sign.test.ts`：签名和取字节各一条。原有 44 条全过 | 3 条全部超时挂住（5 秒测试超时） |
| **代码审查低 11** 样例只核规则名 | 同 D-06 ①：`message=` 片段。`no-restricted-*` 和自定义 `lemo/*` 规则的 38 个样例都写了（A12、A13、A2、A25、`router.ts`、`motion/index.ts`…），测试只算报错文字里有这一段的 | `tests/arch/eslint.test.ts` 83 条全过；把 `a13-service-worker-in-kit.ts` 的 `message=A13` 故意改成 `A12` → 这条失败（试过后改回） | — |
| **QA TC-B0-18** useCollection 卸载不残留订阅（第二节“部分”） | 新增 `src/kit/hooks/__tests__/useCollection.test.tsx`（代码没改，补测试） | 两条：集合变了重画、useItem 只看那一条；卸载后订阅数为 0，之后写入不报错 | 补覆盖，代码本来就对 |
| **QA TC-B0-13** manifest 没有断言（第二节“部分”） | 新增 `src/app/__tests__/webmanifest.test.ts` | `start_url`、`scope` 都是 `/app/`，`display` 是 standalone | 补覆盖 |

## 二、动效自查（不算 UI-4 签字）

按 animate skill 的顺序过了一遍本次动到动效的两处：

- **没有新增任何动画**：没有新时长、新曲线、新关键帧，令牌一个没加。TC-B0-10 的检查也证明超过 400ms 的仍只有 `--dur-drop`。
- **减少动态效果 = 更少更轻，不是全关**：Appear 成立时只淡入淡出、时长减半（17.2 第 5 点）；SharedLayout 用 Motion 的 `reducedMotion="always"`，关掉的是 transform 和 layout 位移，opacity 照常。系统设置和设置里的开关现在是同一个判断，函数（animateIn / press / transition）和组件一致。
- **页面切换**：只改了时机（回调里 flushSync），没改样式；减少动态效果时 `transition()` 照旧直接切换。View Transitions 还没接令牌（UI-4 L-3，已定挪到 B1）。
- **review-animations**：这个 skill 只能由用户手动调用，我加载不了，所以按它的“Never Ship”表自己对了一遍：没有 `transition: all`、`scale(0)`、ease-in、只动 transform / opacity；本次没有新的可见动画，没有可以按它逐帧审的成品。**真机上的手感（iOS Safari 18、WebView2 录屏）没做**，留给 B1 页面切换真正接上时。

## 三、本机检查结果（最后一次 commit 之后）

各命令都在本 worktree 从 `npm ci --ignore-scripts` 起跑（提交 b675836 的内容）：

| 命令 | 结果 |
|---|---|
| `npm run lint`（ESLint + Stylelint） | 0 错误 0 警告 |
| `npm run typecheck`（五份 tsconfig） | 0 错误 |
| `npx vitest run` | 50 个文件通过、1 个跳过；636 条通过、13 条跳过、2 条 todo（跳过的和第一轮相同，都是待 Docker / 待预览）。第一轮是 592 条 |
| `CI=true npx playwright test`（chromium + webkit，e2e 构建 + wrangler pages dev） | 42 通过、2 跳过（预览环境那两条，同第一轮） |
| `python -I build/check_registry.py` | 没登记 0、登记了不存在 0 |
| `python build/req_index.py --check` | 需求 218 条，问题 0 |
| check_arch（`tests/arch/check-arch.test.ts` 的“真仓库 0 个错误”） | 通过 |

## 四、未改及原因

| 编号 | 原因 |
|---|---|
| UI-4 L-1、L-2、L-3 | 已定挪到 B1 / B2（任务单写明不改） |
| UI-4“另外记一笔”（Pressable 按下也有过冲） | UI-4 原文写 B1 调手感时在 iPhone 上试过再定，不是 B0 的事 |
| 代码审查低 9（附件 file-check 后重传回 not_pending 被当 denied） | 取决于 B4b-1 的调用顺序，要架构 / 前端 B 先定约定；现在改等于替他们定了接口 |
| QA D-10（`tests/e2e/files.spec.ts`“没带版本号 426”实际带了 3.9.0；objstore 占位测试） | 是 `/files` 函数和 `shared/objstore.ts` 那一侧的用例，归前端 B |
| QA D-11 里的 `manifest.webmanifest` 的 `icons` 是空数组 | QA 原文写“B1 主屏幕前要补”，要图标资源，B1 做 |
| 代码审查中 1～3、低 1～5、7、8、10、12；安全审查全部；QA D-01～D-05、D-08、D-09、D-11 其余 | 属于 `shared/`、`functions/`、`supabase/`、CI、文档，归前端 B、后端、运维、架构师 |

## 五、需要别人知道的

- `eslint.config.js` 的 CSP 规则里 `X.Overlay` 是按名字认的：以后如果自己写一个叫 `Something.Overlay` 的组件也会被拦，到时改名或加带理由的单行豁免。
- `tests/arch-fixtures/` 的违规样例从现在起**必须写 `rule=<架构规则号>`**，不写测试直接报错；新增架构规则时，`coverage.test.ts` 会要求它有样例。
- `tests/arch-fixtures/eslint-targets/` 是给边界规则用的假目标文件，等仓库里有了真的功能 `data/` 以后可以改成引真文件、删掉它。

---

# 第二次（架构 0.33）

- **起点**：main `8332dcb`；分支 `worktree-agent-af6fc8ece5038b86d`
- **依据**：架构设计-v4.md“0.33 B0 第一轮评审返工”第 5、9、16 条和“交给谁 · 前端 A”；返工-架构师.md 第三节“前端 A”
- **范围**：只改 `src/platform/files.ts`、`src/platform/__tests__/files.test.ts`、`tests/e2e/csp.spec.ts` 和本文件。没有新文件。B1 / B2 项（第 8 条动效、manifest icons、L-2）不做
- **说明**：本节只是登记，**不是签字**

## 一、逐条

| 清单项 | 做了什么 | 怎么验证 | 先失败 |
|---|---|---|---|
| **代低 9 / 0.33 第 5 条** `not_pending` 单独报出 | `src/platform/files.ts`：`FileErrorKind` 加 `not_pending`；`classify()` 只在 `code = forbidden` 且 `reason = not_pending` 时给它（签名里单项不过时 code 就是 reason，不会误中）。文件头和类别说明写明：这一类**不是上传失败**，客户端不重传、不按出错提示，data 层读这一行的 `check_status`（ok → 当成功、不再调 file-check；rejected → “没能加上”；行已删 → 丢掉），只有 upload 会给出。`denied` 的说明里去掉了 not_pending | `files.test.ts`：错误码表里 `403 forbidden/not_pending` 改成期望 `not_pending`；新增两条：PUT 回 not_pending → `{ok:false, kind:'not_pending', code:'forbidden', reason:'not_pending', status:403}`，只发一次请求；`classify` 只认 403 forbidden 带的 reason，`not_owner`、`no_row`、签名单项的 `not_pending`、404 带这个 reason 都还是 `denied` | 3 条失败（都收到 `denied`） |
| **代低 6** 客户端超时管到读完响应体 | 只核对：main 上已是 `exchange()`（`files.ts:226` 起），上一轮做的 | `files.test.ts`、`files-sign.test.ts` 里“响应头到了、响应体卡住”三条照常通过 | — |
| **TC-B0-59** `/app/` CSP 的 base-uri / form-action | `tests/e2e/csp.spec.ts` 新增一条，分路径断言：`/app/` 和 `/app/preview` 的 CSP 各自有 `base-uri 'none'` 和 `form-action`（主 App `'self'`、预览沙箱 `'none'`）；都不含 `challenges.cloudflare.com`；`script-src` 正好是 `'self'`（没有任何主机、`https:`、`*`、`unsafe-*`）；CSP 里没有逗号（没被 Cloudflare 叠成两条）。`/app/auth/` 入口 B1 才建，按用例原文 B1 起加；`/sb/*` 的 nosniff、sandbox 归前端 B（`sb-forward.preview.test.ts` 已有） | chromium + webkit 都过 | `_headers` 本来就对，所以**故意改坏**验证：去掉 `/app/*` 的 `base-uri` → 失败；改回，再去掉 `/app/preview` 的 `form-action` → 失败；之后 `src/_headers` 已还原，无改动 |
| **check_arch 的 `disabled_at` 规则**（TC-B0-97 ④） | **没在 src/ 加规则**，理由见第三节第 1 条 | src/ 里搜 `disabled_at` 无结果；后端 `build/check_backend.py` F5 管 `supabase/functions/`，样例 `tests/arch-fixtures/check_backend/f5-disabled-at/`，unit.yml 已接 | — |
| `rule=`、T1、W3（超预算）、400 ms、data → data、TC-B0-13、TC-B0-18 | 只核对 main：`tests/arch/fixture-header.ts`、`coverage.test.ts`、`tsc/t1-strict.ts`、`check_size/w3-over-budget/`、`durations/tc-b0-10-500ms.css`、`eslint/a1-data-imports-other-feature-data.ts`、`src/app/__tests__/webmanifest.test.ts`、`src/kit/hooks/__tests__/useCollection.test.tsx` 都在 | 全量 vitest 通过（见第二节） | — |

## 二、本机检查结果

| 命令 | 结果 |
|---|---|
| `npm run lint` | 0 错误 0 警告 |
| `npm run typecheck`（五份 tsconfig） | 0 错误 |
| `npx vitest run` | 54 个文件通过、1 个跳过；695 条通过、12 条跳过、4 条 todo |
| `CI=true npx playwright test`（chromium + webkit） | 44 通过、2 跳过（预览环境那两条）；上一轮 42，多的是 TC-B0-59 两个浏览器各一条 |
| `python -I build/check_arch.py` | 0 个错误，2 个警告（W2：cn、kr 缺 2027 节假日文件，原来就有） |
| `python -I build/check_registry.py` | 没登记 0、登记了不存在 0 |
| `python build/req_index.py --check` | 需求 218 条，问题 0 |

## 三、未改及原因

1. **src/ 侧不加 `disabled_at` 规则**：TC-B0-97 ④ 的期望范围是“`supabase/functions/` 里除 `_shared/auth.ts`、account、account-purge 以外”，后端已在 `check_backend.py` F5 做了（带违规样例、接进 unit.yml），按任务要求不重复。src/ 侧架构没有对应规则：App 不读也不写这一列（写由 `guard_profile_disabled()` 触发器拦，停用后 RLS 的 `is_active()` 直接拒绝，客户端只会收到 `account_disabled`），现在 src/ 里也没有一处出现。若架构师要在 src/ 也禁止（例如防 B1 的设置页直接读 `profiles.disabled_at`），请写进 2.3 规则表，我再补规则和样例。另外 0.33 和 1.3b 写的是“check_arch”，实际在 `check_backend.py`，名字不一致请架构师顺手改
2. **`not_pending` 用 `ok: false` + 单独的 `kind` 表示，没做成 `ok: true`**：任务说“不当失败”，我理解为 data 层不按失败处理（不重传、不弹错），而不是算成上传成功——要读 `check_status` 才知道是成功、“没能加上”还是丢掉，并进 `ok: true` 会让只看 `ok` 的调用方直接去调 file-check。kind 是联合类型，data 层 `switch` 漏了这一类 tsc 会报。若架构师 / 前端 B 要别的形状（例如 upload 返回三态），只动这一处
3. **data 层按 `check_status` 处理 not_pending 没写**：功能的 data 层（照片、附件）是 B4b-1 的事，本次只把类别报出来
4. **TC-B0-59 的 `/app/auth/`**：入口 B1 才有，按用例原文 B1 起加
5. B1 / B2 项按任务不做
