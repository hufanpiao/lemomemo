# B2 安全审查 · 前端 A 的 FA-3（月历、周视图、农历、设置 › 日历二级页）

- 审查人：安全审查员（只读；除本文件外没有改仓库里的任何文件，没有做 git 操作）
- 日期：2026-11-04
- 审查对象（工作区未提交的改动，以 `git status`、`git diff` 为准）：
  - `src/features/calendar/` 下新增和改动的文件（data/cal-route.ts、cal-settings.ts、cal-data.ts；hooks/useCalendar.ts、useHolidays.ts、useLunar.ts、useCalSettings.ts、useCalViewT.ts；ui/CalendarPage.tsx、MonthGrid.tsx、WeekView.tsx、MonthPicker.tsx、CalendarSettings.tsx、CalendarSettingsEntry.tsx 及两份 CSS；index.ts；i18n）
  - `src/features/settings/ui/SettingsPage.tsx`（#/settings/calendar 二级页）
  - `src/app/router.ts`（加路由名 `cal`）
  - `src/motion/swipe-pager.ts`（新文件）
  - `src/platform/app-static.ts`（新文件，拉 App 自带的静态 JSON）
  - 附带两项：节假日 JSON 的拉取链路；接手清单 PUSH-getsub-hang
- 依据：架构 2.3（A1/A8、A12、A13、A22、A26、A27、A31、T2、W2）、5.4“节假日”、5.12；需求 R-318～R-321；`B2-安全审查-S-B2签字.md` 的 FE-1、FE-2；`B2-安全审查-前端A的FA-2第一段与推送重订.md`
- 跑过的检查：
  - `npm run lint`（ESLint + Stylelint）：0 错误、9 个警告，警告都在测试文件里（非空断言、文件过长），和本批无关
  - `python build/check_arch.py`：0 错误、1 个警告（W2：`src/public/holidays/cn/2027.json` 还是 pending，符合 5.12 的预期）
  - `npx vitest run --exclude tests/build/gen-tauri-key.test.ts`：结果见文末“测试”一节

---

## 结论：通过（附 4 条低级别意见，不挡签）

本批没有发现高、中级别的问题。节假日拉取的路径不可能被注入、只拉同源；解析是白名单式的，任何一条不对整份丢弃；渲染全是 React 文本节点，没有 HTML 注入面；SW 策略、CSP 都没有被改动，现有配置满足 5.4、5.12。设置写入只写白名单值，走 `core/write` 的守门。

PUSH-getsub-hang：**可以接受，有条件**（见第三节，6 条条件），推送订阅残留的风险和 FE-2 当初已经接受的残留是同一级别，没有扩大。

---

## 一、问题清单

| 编号 | 级别 | 问题 | 位置 | 建议 |
|---|---|---|---|---|
| FA3-1 | 低 | **节假日 JSON 没有显式写 `Cache-Control: no-cache`。** 架构 5.4 写明“响应头 `no-cache`”，`src/_headers` 里没有 `/app/holidays/*` 这一条。Cloudflare Pages 对静态文件默认是 `public, max-age=0, must-revalidate`，效果相当，所以现在不会出问题；但这是靠平台默认值，不是我们写下的约定，以后有人给 `/app/*` 加缓存头时不会有测试拦住 | `src/_headers:8-27`（没有 holidays 的条目） | 加一条 `/app/holidays/*` → `Cache-Control: no-cache`，并在现有的 _headers 测试里断言它 |
| FA3-2 | 低 | **settings 的“恢复”写法绕开了 A31 的静态检查。** `settingWrite` 用成员赋值写 `data['deleted_at'] = null`、`data['undone'] = false`，A31 只查对象字面量里的键，所以这里查不到。值只可能是 null / false（恢复），`core/write.ts:80-82` 的守门也明确把“恢复”算作允许，服务器 `settings_guard` 只管 ai.* 两个键，因此没有实际危害。问题在于 A31 的豁免名单只有 `core/ai-settings.ts`，现在多了一处没登记的同类写法 | `src/features/calendar/data/cal-settings.ts:128-130` | 二选一：① 在 A31 的说明里写明“只写 null / false 的恢复不算违规”，并把这个文件列进说明；② 把恢复逻辑收进 `core/write` 提供的一个公共函数，两处共用。文件头已经注明“和 core/ai-settings.ts 同一写法”，所以不急 |
| FA3-3 | 低 | **客户端解析对多余字段、条数、长度不设上限。** `parseHolidayFile` 不拒绝未知字段（`pending`、`sub` 及其他）、不限 `days` 条数；`fetchAppJson` 不限响应体大小；名字只限 40 个 UTF-16 码元，不查控制字符、双向控制字符。文件是同源、经 CI `check:holidays` 严格校验后才部署的（16 KB、无控制字符、无多余字段），渲染又只走 React 文本节点，所以没有可利用的路径，只是纵深防御不足 | `shared/logic/calendar/holidays.ts:81-118`；`src/platform/app-static.ts:23-33` | 可选：`parseHolidayFile` 加 `days.length <= 400`；名字复用 check.mjs 的控制字符判断。不挡签 |
| FA3-4 | 低（功能，转代码审查） | **离线拉取失败被永久记成“没有”，5.12 要的离线提示没有做。** `useHolidays` 把拉取失败（含离线）的 `null` 写进模块缓存，联网后不重试，直到整页重新载入；5.12 第 1 点要求“离线时切到一个从没拉过的国家，月历上方提示‘联网后显示节假日’”，calendar 的 i18n 和界面里都没有这句。不是安全问题 | `src/features/calendar/hooks/useHolidays.ts:36-48` | 转代码审查：区分“404 / 格式不对”（可以记死）和“网络失败”（不记、`online` 事件后重拉），并补提示 |

---

## 二、逐项核对

### 1. 节假日 JSON 的拉取（附带第 1 项）

| 核对点 | 结果 | 依据 |
|---|---|---|
| 路径能不能被注入 | **不能** ✓ | 路径由 `holidayFetchPaths` 拼：国家只来自 `holidayCountries` 的白名单（`'cn' \| 'kr'`，设置里存的任何值都先过它，`holidays.ts:58-63`）；年份来自 `headerMonth(view)`，view 由 `resolveMonthParam` / `resolveWeekParam` 校验过、`shiftView` 限 1900～2100（`cal-route.ts:40-63`）。地址栏的参数不会原样进入路径。另有两层兜底：`app-static.ts:8` 的 `PATH_RE` 只许 `[A-Za-z0-9/_.-]`、以 `.json` 结尾，拒 `..`、`//`、开头的 `/`、反斜杠、`?`、`#`、`%`；`app-static.ts:11-20` 用 `new URL` 拼完再比 origin，不同源返回 null、不发请求。测试 `app-static.test.ts` 覆盖了绝对地址、`//evil`、`..`、反斜杠、问号、非 .json |
| 基准地址能不能被改 | 不能 ✓ | 按 `document.baseURI` 拼；CSP 有 `base-uri 'none'`，页面里插不进 `<base>` |
| 请求带什么 | ✓ | 只发 `GET`，没有令牌、没有自定义头；`credentials` 用默认的 same-origin。A12：`fetch` 只出现在 platform（lint 通过） |
| 解析是否严格 | 严格 ✓（FA3-3 是纵深建议） | `parseHolidayFile`：country、year 必须和请求的文件一致（防止串国、串年）；每一天的 date 过 `parseDate`（正则 + 回算，拒 2 月 30 日等）且必须在当年；kind 只许 off，work 只许中国；name 至少一种语言、每种 1～40 字、非空白；任何一条不对整份返回 null（`holidays.ts:86-118`）。不用 `as` 硬转外部数据（`res.json()` 先当 `unknown`），符合 T2 的意图 |
| 404、HTML、坏 JSON | ✓ | `fetchAppJson` 对非 2xx、解析失败、网络错误一律返回 null 不抛；根目录有 `404.html`，缺文件时是 404，不会被 SPA 回退成 200 的 index.html |
| 渲染有没有注入面 | 没有 ✓ | 名字只在 `MonthGrid.tsx:18、33`、`WeekView.tsx:78` 作为 JSX 文本和 aria 文字使用；本批没有 `dangerouslySetInnerHTML`、`innerHTML`，`href` / `src` 没有用到节假日数据（A22、A26，lint 通过） |
| SW 缓存策略（5.4、5.12） | 符合 ✓（本批未改 SW） | `src/sw/routes.ts:40` 把 `/app/holidays/` 归到 `holidays` 路由；`src/sw/sw.ts:85-88` 用 `NetworkFirst({ cacheName: 'lemo-holidays' })`（先联网、失败用缓存）；`excludedFromPrecache` 排除 `holidays/`（`routes.ts:54`），构建脚本 `inject_sw_manifest.mjs:13` 同口径，不进预缓存；文件名不带哈希（`src/public/holidays/<国>/<年>.json`，vite `publicDir` 原样拷贝）。Workbox 默认只缓存 200，不会把 404 存进去。退出时 `session.ts:368` 清掉预缓存以外的运行时缓存（含 lemo-holidays），这份数据本来也不含用户信息 |
| 响应头 no-cache | 靠平台默认值 | 见 FA3-1 |
| CSP 是否受影响 | **不受影响** ✓ | 同源请求由 `/app/*` 的 `connect-src 'self'` 覆盖（`src/_headers:9`），本批没有改 `_headers`，没有新增外部源 |
| W2 | ✓ | check_arch 对 pending 的 cn/2027 报警告，符合 5.12 |

### 2. 路由、翻页、设置

| 核对点 | 结果 | 依据 |
|---|---|---|
| `router.ts` 加 `cal` | ✓ | 只在 `ROUTE_NAMES` 加一个名字，router 的 import 没变（A1 0.31 的限制照旧） |
| 地址参数处理 | ✓ | `#/cal/...` 的参数交给 cal-nav 校验，非法回到本月 / 本周，再用 `replaceRoute` 写回规整后的参数（`useCalendar.ts:83-89`）；写回的参数来自 `paramsOf(view)`（`'month'`/`'week'` + 校验过的日期），不是地址原文 |
| 设置写入 | ✓（FA3-2 是写法意见） | 节假日只写 `'cn' \| 'kr' \| 'both'`，周起始只写 `WeekStart`（`useCalSettings.ts:184-185`，单选框的值是常量）；读出时再过 `holidayChoice` / `holidayCountries` / `resolveWeekStart` 白名单，存进去的怪值不会影响拉取路径。写入经 `core/write`，不碰 ai.* 两个键（A31 lint 通过） |
| 设置二级页 | ✓ | `#/settings/calendar` 只认 `delete`、`calendar` 两个子页名，其余回首页（`SettingsPage.tsx` 的 `view` 判断）；返回逻辑和注销页共用，直接打开时 `replaceRoute`，不多压历史 |
| `swipe-pager.ts` | ✓ | 只读 pointer 坐标、调回调，不碰数据、不碰 DOM 以外的接口；边缘 24 px 让给系统返回手势 |
| A27（功能 index 只导出懒加载） | ✓ | `calendar/index.ts` 新增的 `cal` 路由、`CalendarSettings`、`CalendarSettingsEntry` 都是 `lazy(() => import(...))`；settings 只经 `calendar/index.ts` 引用（lint 通过） |
| 农历数据加载 | ✓ | `useLunar` 动态 import，check_arch 的 lunar-static-import 样例拦静态 import；数据是打进包里的常量，不联网 |
| R-318～R-321 | ✓ | 韩文界面按 `kr` 版本取农历（`useLunar.ts:37`），本批韩国阴历没有数据，不显示农历行（R-318/R-321；显示与否属于功能核对，本审查没有逐格验证）；没有 `cal.lunar` 开关（R-321）；设置首页一行摘要、点进二级页（R-320）。这几条不涉及安全，只核对了没有引入额外的数据流 |

---

## 三、PUSH-getsub-hang 的结论

**问题**：Playwright 自带的 WebKit（Windows、Linux 构建）没有推送服务，`pushManager.getSubscription()` 一调就把主线程卡死；`disconnectBrowserPush` 用的 `withinMs` 靠 `setTimeout`，主线程卡住时计时器也跑不了，2 秒上限兜不住。真 Safari、Chrome 不会这样。现在 e2e 在 webkit 下把 `getSubscription` 桩成返回 null。
**可选改法**：`Notification.permission !== 'granted'` 时跳过 `getSubscription`（也就跳过退订）。

### 结论：可以接受，有条件

理由——FE-2 要防的是“退出以后，旧账号的推送还能在这台设备上显示出来”。通知权限不是 granted 时：

1. **推送到了也显示不出来。** SW 的 `showNotification` 在没有通知权限时直接失败，系统通知中心里不会出现任何内容（连 App 名都不会有），比 FE-1 已经接受的“只显示 App 名”更严。
2. **主流浏览器撤权时会作废订阅。** Chrome、Firefox 在用户撤回或重置通知权限时会清掉这个源的推送订阅，Safari 撤权后订阅同样失效（这一点本仓库没有实机核实，按各浏览器的公开说明）。也就是说，“权限不是 granted、订阅却还在”本来就很少见。
3. **就算订阅残留，后面三层照旧兜住**：① 退出流程第 ① 步按会话删 devices 行（服务器一侧，这是主防线，不受这个改法影响）；② 以后有人在这台设备上重新给了权限、`ensurePushSubscription` 拿到这个旧订阅去认领时，`claim_endpoint` 第 d 步删掉别的账号同一 endpoint 的行；③ 在认领之前推送到达的，SW 的 FE-1 核对 owner 不一致，只显示 App 名。这正是 FA-2 审查第 82 行已经接受的残留，范围没有扩大。
4. 同账号重登跳过认领的问题（FA2-2）已经按会话算摘要修过，残留订阅不会导致新会话收不到推送。

所以这个改法**不会让推送内容泄露给下一个人**，残留风险和 FE-2 当初接受的一样。但改的时候必须满足下面 6 条，否则不接受：

| 条件 | 内容 |
|---|---|
| P-1 | **只跳过退订这一步。** `forgetPushClaim`（FA2-1）和 `getNotifications()` 关通知照常先做、不受权限判断影响（权限被撤之前弹出的通知可能还在通知中心里）。exe 分支不动 |
| P-2 | **判断要“拿不准就照常退订”。** 只有 `Notification` 存在、且 `Notification.permission` 明确是 `'denied'` 或 `'default'` 时才跳过；`Notification` 不存在、读取抛错时照旧调 `getSubscription` 退订。**不能直接复用 `push.ts:97` 的 `defaultPermission`**——它在没有 `Notification` 时返回 `'default'`，照搬就会变成“没有 Notification 接口就不退订”，把不确定的情况放过去了 |
| P-3 | 权限判断经 `disconnectBrowserPush` 的 `env` 注入（和 `PushEnv.permission` 同一写法），只写在 `platform/push.ts` 里（A13） |
| P-4 | 单测补齐：`denied`、`default` → 不调 `getSubscription`，但 `getNotifications` 仍被调用、认领记录仍被删掉；`granted` → 照常退订；`Notification` 不存在或读取抛错 → 照常退订。`account-push.test.ts`、`sign-out-push.test.ts` 里“退出路径调用了断开”的断言保持不变 |
| P-5 | e2e：改完以后 `tests/e2e/b1-signout-two-tabs.spec.ts` 在 webkit 下**去掉** `getSubscription` 的桩（Playwright 的 WebKit 默认是 `default` 权限，正好走跳过分支），这样能真正证明退出不卡；如果 webkit 下另有用例授予了通知权限，那个用例保留桩并写明原因 |
| P-6 | 同步文档：架构 4.1“退出登录或换账号”下 0.53 那条、5.3 的 FE-2 一句、`disconnectBrowserPush` 的文件注释，都写上“通知权限不是 granted 时不退订：此时推送显示不出来，残留订阅由删 devices 行、claim 第 d 步和 FE-1 兜”；接手清单 PUSH-getsub-hang 一行改为“已定，按本审查 P-1～P-6” |

不建议的替代做法：改用 `pushManager.permissionState({ userVisibleOnly: true })` 做判断——它和 `getSubscription` 同属 PushManager，在同一个 WebKit 构建里可能一样会卡，而 `Notification.permission` 是同步属性，不走推送服务。

---

## 四、测试

- 全量：`npx vitest run --exclude tests/build/gen-tauri-key.test.ts` → 392 个文件中 389 个通过、3 个跳过；5757 条中 5725 条通过、29 条跳过、3 条 todo，0 失败。
- 本批相关的单独再跑一遍（calendar、settings、router、app-static、push、swipe-pager、sw、shared/calendar、holidays-check）：43 个文件、525 条全部通过。

---

## 五、复核（2026-11-04，PUSH-getsub-hang 的 P-1～P-6 和 FA3-1）

复核对象：`src/platform/push.ts`（`disconnectBrowserPush`、新增 `strictPermission`、`skipUnsubscribe`）、`src/platform/__tests__/push-permission.test.ts`（新建）、`tests/e2e/b1-signout-two-tabs.spec.ts`、`src/_headers`、`tests/build/auth-headers.test.ts`、架构第 2598、2898 行、接手清单第 231 行（以 `git diff` 为准）。
跑过：`npx vitest run` 推送权限、push、sign-out-push、account-push、auth-headers 五个文件，共 112 条全部通过；对改动的四个 TS 文件跑 ESLint，0 问题。e2e 没有重跑（只读复核），采用前端 A 报告的“本机 chromium、webkit 都过”。

| 条件 | 结论 | 核对 |
|---|---|---|
| P-1 只跳过退订 | ✓ 满足 | `forgetPushClaim` 仍在函数最前面；`getNotifications()` 关通知在权限判断之前；`skipUnsubscribe` 只挡住 `unsubscribePush`。exe 分支在判断之前就 return，不读权限。测试：denied、default 时关通知、删认领记录都发生；exe 分支 `permission` 没被调用 |
| P-2 拿不准就退订 | ✓ 满足 | 新写了 `strictPermission`，没有 Notification 时返回 null，没有复用 `defaultPermission`；`skipUnsubscribe` 只在值严格等于 `'denied'` / `'default'` 时返回 true，读取抛错返回 false。测试覆盖 null、抛错、意外值（`'prompt'`），以及默认读取路径下 Notification 不存在、getter 抛 SecurityError 两种，都照常退订 |
| P-3 经 env 注入、只在 platform | ✓ 满足 | `env.permission` 可注入，默认 `strictPermission`；只写在 `src/platform/push.ts`（A13，lint 通过） |
| P-4 单测 | ✓ 满足 | `push-permission.test.ts` 覆盖 denied、default、granted、不确定的三种和默认读取路径；原来的 `account-push.test.ts`、`sign-out-push.test.ts` 没有改，退出路径调用断开的断言仍在且通过 |
| P-5 去掉 webkit 桩 | ✓ 满足 | `noPushServiceInWebkit` 和 `addInitScript` 都删掉了，用例两个浏览器都走真的退出流程。`tests/e2e/` 下没有别的用例授予通知权限或桩 `getSubscription` |
| P-6 文档同步 | ✓ 满足（附一条低级别补充） | 架构 4.1 的 0.53 那条（第 2598 行）、5.3 的 FE-2 一句（第 2898 行）、`disconnectBrowserPush` 注释、接手清单 PUSH-getsub-hang 一行（改为“已定，按 P-1～P-6”）都写上了新口径。**补充（低，不挡签）**：架构第 1752 行的安全清单表第 5 项仍写“退出、换账号先关掉所有通知、再尽力退订（FE-2）”，没有提权限例外；建议下次改架构时顺手加一句“（通知权限不是 granted 时不退订，见 4.1 的 0.53）” |
| FA3-1 holidays no-cache | ✓ 满足 | `src/_headers` 新增 `/app/holidays/*` → `Cache-Control: no-cache`；`auth-headers.test.ts` 对四种构建模式断言 cn、kr 两个路径的 cache-control 只有一条 no-cache，nosniff 和 CSP（只有一条）照样从 /app/* 继承 |

**复核结论：通过。** PUSH-getsub-hang 的 P-1～P-6 和 FA3-1 都已满足。剩下的低级别意见：FA3-2、FA3-3 可以不改；FA3-4 转代码审查；架构第 1752 行补一句。都不挡签。
