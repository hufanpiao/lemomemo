# B2 代码审查：前端 B 的 FA-4 提醒界面（第一轮，含安全）

- 日期：2026-11-04
- 审查人：代码审查（只读）
- 范围：`src/features/reminders/` 全部，`shared/logic/remind-actions.ts`，`src/kit/state/remind-queue.ts`，`src/platform/viewport.ts`、`push-status.ts`、`notifications.ts`、`perm.ts`，`src/app/main.tsx` 一处。
- 运行：三个时区（Asia/Seoul、America/Los_Angeles、Pacific/Kiritimati）各 37 个文件 326 条，结果一致，每次 1 条失败（中 1）；tsc 0 错误；eslint 0 错误、16 条警告；stylelint 0 错误；check_arch 0 错误、1 条 W2 警告（中国 2027 节假日 pending，属后端）。

## 结论：7.5 / 10，不通过

主体逻辑、时区处理、锁屏隐私都对：判断“现在”一律用 `clock.now()`；写入不带 `remind_at`；`push_show_title` 和设置为假时本机通知不带标题和截止时刻；整页提醒地址只认一种写法。

## 问题

| 级别 | 编号 | 位置 | 问题 | 处理 |
|---|---|---|---|---|
| 中 | 1 | `ui/Remind.module.css:8,257` | 直接写 `env(safe-area-inset-top)`，`safe-top-css.test.ts` 失败，CI 会红 | 改用 base.css 的变量或类（主持人已核实） |
| 中 | 2 | `data/push-setup.ts` `claimNow` | 比启动认领（`main.tsx:231`）少了 `lock`、`ensureDevice`、`invalidateDevice` | 抽成 platform 共用函数（主持人已核实） |
| 中 | 3 | `ui/RemindSettings.tsx:71-94` | 再认领失败后没有出路，“移除它”会对已删记录再调 `remove_device` | 换成“重新接上” |
| 中 | 4 | `kit/state/remind-queue.ts` | `holdReminders` 靠调用方释放，出错或卸载会永久压住横幅 | `useHoldReminders(active)` 加 10 分钟上限 |
| 低 | 1 | `RemindHost.tsx:78`、`FullReminderPage.tsx:145` | 按钮时刻在渲染时算，最多旧近 1 分钟 | 点按时重算 |
| 低 | 2 | `hooks/useReminders.ts:195-199` | “全部知道了”把写失败的也移出队列 | 只移成功的 |
| 低 | 3 | `RemindHost.tsx:43` | 横幅没有 `aria-live` | 加 `role="status"` |
| 低 | 4 | 设置 › 提醒 | “移除它”没有二次确认 | 和设计 M7 合并 |
| 低 | 5 | `useRemindEngine` | 退出登录不撤回 exe 已弹出的本机通知；`push-status` 不随账号重置 | 卸载时撤回、重置 |
| 低 | 6 | `platform/viewport.ts:18-21` | 双指缩放会误判为键盘弹起；回到前台不重查 | 加 scale≈1 条件，`visibilitychange` 时重查 |
| 低 | 7 | `data/remind-settings.ts` | 设置读写和 calendar 重复 | 这一段不改，后面并进 core |
| 低 | 8 | `remind-queue` | `collapsed` 只增不减 | 按 7 天修剪 |

漏测：录音压住期间卸载；`claimNow` 带锁和设备登记；再认领失败后重试；往上滑收起；回到前台关掉已处理通知；跨分钟、跨午夜刷新；免打扰跨午夜时本机推迟。TC-B2-25 另一半是人工测试。

接线注意：`FullReminderPage` 自己读 `location.hash`，路由接上 `'remind'` 后要确认 `hrefOf` 不会把 `?due=` 转义掉。

通过条件：改完中 1～4 并补测试，复审改动部分；低问题同批改或写进交付说明。

---

## 第二轮（2026-11-04，增量复审）

### 结论：8.5 / 10，通过

中 1～4 全部解决，低 1～8 中 1、2、3、4、6、8 已解决，5 大部分解决，7 按约定延后。新发现 1 条低问题，不影响通过。

### 检查结果

- vitest（提醒、kit/state、platform、app、remind-actions，83 个文件、874 条）：Asia/Seoul、America/Los_Angeles、Pacific/Kiritimati 三个时区全部通过。
- `tsc -p tsconfig.app.json`、`tsc -p tsconfig.shared.json`：0 错误。
- eslint：0 错误；16 条警告都是测试文件里的非空断言（`remind-data.test.ts`、`reminder-model.test.ts`），源码没有。
- stylelint（提醒的 CSS）：0 问题。上轮 `safe-top-css` 失败已消失。
- `check_arch`：0 错误，1 条警告（W2，中国 2027 年节假日文件 pending，属后端，和本段无关）。

### 上轮问题逐条复查

| 级别 | # | 结果 | 依据 |
|---|---|---|---|
| 中 | 1 | 已解决 | `Remind.module.css:40` 改用 `var(--inset-top)`，`:394` 改用 `var(--safe-top)`；顶部不再直接写 `env()`，相关测试通过 |
| 中 | 2 | 已解决 | 新增 `platform/push-claim-run.ts`；`push-setup.ts:57` 的 `claimNow` 只调 `runPushClaim()`，和启动用同一份参数（锁、设备登记）；有 `push-claim-run.test.ts` |
| 中 | 3 | 已解决 | `RemindNotice.tsx` 的 `InUse`：移除成功但再认领失败（`reclaim_failed`、`reclaiming`）时换成“重新接上”，只再认领，不再调 `remove_device` |
| 中 | 4 | 已解决 | `holdReminders` 默认 10 分钟（`HOLD_MAX_MS`）自动放开，放开函数只生效一次；新增 `useHoldReminders(active)`，卸载时自动放开 |
| 低 | 1 | 已解决 | `act` 按点按那一刻用 `actionsOf(r, now, …)` 重算，按 key 找到对应按钮；找不到时用渲染时的值 |
| 低 | 2 | 已解决 | `ackAll` 返回写成功的 tag，只移出这些，并返回失败条数 |
| 低 | 3 | 已解决 | `RemindHost.tsx:43` 加了 `aria-live="polite"` |
| 低 | 4 | 已解决 | “移除它…”先弹 `Dialog`，写清移除哪台、最后使用日期 |
| 低 | 5 | 大部分解决 | `useRemindEngine` 卸载时撤回本次弹出的本机通知，退出流程另有 `closeAllLocalReminders` 兜底；`push-status` 没有随账号重置，理由见下文 |
| 低 | 6 | 已解决 | `viewport.ts`：`visualViewport.scale` 不是 1 时不算键盘弹起；`visibilitychange` 时重算 |
| 低 | 7 | 延后（同意） | 和上轮约定一致，后面并进 core |
| 低 | 8 | 已解决 | `pruneCollapsed(now - 7 天)` 每分钟随 `now` 修剪 |

### 三个专项判断

**1. L5（退出不重置 `push-status`）的理由：基本成立。**

- 网页版：`goToAuth` 走 `openAuth()`，整页跳到 `/app/auth/`，内存里的 `ctx` 和 `push-status` 随页面一起没了。成立。
- exe：会话删干净时 `reloadPage()`，整页重新载入。成立。
- 例外：exe 删会话失败时 `showExitIncomplete()`，不重新载入，主窗口还留着旧的 `ctx` 和认领结果。不过这时本机会话也还在，账号没有真正切换，界面上盖着“退出没完成，点重试”，重试成功后仍会重新载入。风险低，可以接受。建议在交付说明里写一句这个例外。

**2. 抽出 `push-claim-run` 后，`main.tsx` 的启动认领和原来是否等价：等价。**

- 锁名：原来是 `withLock(\`lemo-push-claim:${userId}\`, fn)`，现在 `claimDeps` 拼的是同一个名字，默认也用 `withLock`。相同。
- 设备登记：仍然把 `device.ensure`、`device.invalidate` 作为 `ensureDevice`、`invalidateDevice` 传进去，先登记再认领的顺序在 `ensurePushSubscription` 里，没变。设备行自己的锁 `lemo-device-reg:<userId>` 也没动（`main.tsx` 仍 import `withLock`，是这里在用，不是残留）。
- SW 注册前后：`runPushClaim()` 仍然在 `registerServiceWorker().then(reg => …)` 里、`reg` 不为空之后调用，时机相同；DEV 模式和 `version_too_new` 时照旧不认领。
- 两处小差别，都不算问题：
  - `setPushClaimContext` 放在 SW 注册之前，设置页的点按认领在 SW 还没注册好时也能走；这正是设置页需要的（点按里要马上订阅）。
  - 现在多做了一件事：认领结果写进 `push-status`（原来启动认领的结果直接丢掉），这是本段新增的需求，不是行为倒退。

**3. `showLocalTest` 的约定够不够 B6-exe 照着实现：够。**

`native-bridge.ts:52-59` 写清了：和 `showLocalReminder` 走同一路（WebView2 网页通知）；tag 固定 `lemo-local-test`，再点替换旧的；权限是 default 时在这次点按里请求；返回值只有 `shown`、`denied`、`failed`；点通知只把主窗口拉到前台，不打开整页提醒；网页版不实现。包装函数 `showLocalTestNotification` 对没实现、抛错、返回其他值都回 `failed`，B6-exe 没接上之前不会出错。小建议：B6-exe 的接手清单里注明“`denied` 包括用户在请求框里点了拒绝”，免得只判断请求前的状态。

### 新发现

| 级别 | # | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| 低 | N1 | `kit/state/remind-queue.ts:43-48` | `setRemindHoldLog` 的注释说“由入口（main.tsx）接上”，但全仓库只有测试在调，`main.tsx` 没接。压住超时会自动放开，只是不记日志，上轮中 4 要求的“记日志”实际没生效 | `main.tsx` 里接一行 `setRemindHoldLog((r) => logs.log(…))`，或把注释改成“待接” |

### 通过条件

已通过。N1 和 L5 的 exe 例外同批改或写进交付说明即可，不用再审。
