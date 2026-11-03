# B2 代码审查：前端 A 的 FA-2 第一段（编辑页）和 X-5、启动重订推送、M3

日期：2026-11-03　审查：代码审查员　被审：前端 A　版本：工作区 15:30 前后（未 git add，以 git status、git diff 为准）

依据：B2 任务单 FA-1、FA-2、第三节第 8～10 行、“接口先定”第 1、2 条；架构设计-v4 4.6、5.3（推送负载 v1、platform 函数）、0.53、0.54、D7；测试用例-v4 TC-B2-02、TC-B2-74、TC-B2-76（架构 0.29 续第 136 条）；上一轮 [B2-代码审查-前端A第8、9行](B2-代码审查-前端A第8、9行.md) 的 M3、M4。

被审文件：
- X-5：`src/platform/native-bridge.ts`（`closeAllLocalReminders`）、`src/platform/push.ts`（`disconnectBrowserPush`、`withinMs`）、`src/platform/sign-out.ts`、`src/core/account.ts`；测试 `native-bridge.test.ts`、`push.test.ts`、`sign-out-push.test.ts`、`account-push.test.ts`
- 启动重订推送：`src/platform/push-claim.ts`、`src/platform/__tests__/push-claim.test.ts`、`src/app/main.tsx`、`src/platform/supabase/sync-transport.ts`（`claimEndpoint`）
- M3：`src/sw/push.ts`、`tests/build/sw-push.test.ts`
- FA-2 第一段：`src/features/todos/`（data、hooks、ui、i18n、测试）、`src/features/calendar/`（同上）、`src/kit/components/Form.tsx`、`EditShell.tsx`（含 `.module.css`）、`LocationText.tsx`、`src/kit/hooks/useEditRecord.ts`（含测试）、`src/core/edit-save.ts`、`current-tz.ts`、`src/app/router.ts`、两个功能的 `index.ts`、`src/kit/components/__tests__/safe-link.test.tsx`

已知、不算本批问题：后端 `vapid.ts:21` 的 lint 错误；`remindAtOf` 的 `prevRemindAt` 没接（`TODO(prevRemindAt)`）。

## 结论：有条件通过，7.5 / 10

M1～M3 改完即签。

做得好的地方：
- 上一轮的 M3、M4 都改到位了（见“上一轮意见核对”）。
- `patchOf` 只放变了的列，外加 `updated_at`；改标题时 AI 起的简称同一个 patch 清掉（5.12 L3）；日程改了 `time` 自动带上 `tz`，满足库的 `check (time is null or tz is not null)`。
- **清截止日期**：`normalize` ① 把 `due_time`、`remind_before_min` 一起置 null，`patchOf` 比对后三列在同一个 patch 里（`todo-edit.test.ts:55`、`TodoEditPage.test.tsx:111` 都有断言），满足第 136 条和库的 `check (due_time is null or due is not null)`。第一次设截止时刻默认 60、同时选了提前量用选的、清时刻连带清提前量，都和 TC-B2-74 一致，选项表和库的约束一致。
- `useEditRecord` 用序号只认最后一次的结果；新建页在 insert 还在路上时把后来的改动排到 insert 之后、按 patch 写，不会 insert 两行。`write.*` 在事务结束后先 `notify` 集合、再 resolve，所以“保存成功 → 清掉 local → 表单改读集合”这一步不会闪回旧值（`outbox.ts` 的 `enqueueImpl` 末尾）。
- `LocationText` 只在 `safeHref` 通过时渲染 `<a>`，`rel="noopener noreferrer"`，不用 innerHTML；`safe-link.test.tsx` 改成测正式组件，还多核了 `target`。A26 的 ESLint 规则通过。
- `withinMs` 超时就 resolve、出错也 resolve，`fn` 同步抛错也兜住；退出流程（`wipeThisDevice`、`ensureAccount`）外面再包一层 try，超时后接着往下删库、清 Cache Storage、signOut，不会卡住。exe 走 `closeAllLocalReminders`，网页走“关通知、退订”。
- 词典：todos 中韩各 40 个键、calendar 各 38 个，逐个比对一致；`ko` 用 `satisfies Record<keyof typeof zh, string>` 编译期兜底；动态拼的 `todo.edit.before.*`、`event.edit.min.*` 和选项表一一对上。韩文都标了 REVIEW(ko)。
- 去掉 `EditShell.module.css` 里的 `view-transition-name: page-head` 是对的：`settings-jump-css.test.ts:35` 要求整个 src 只有设置页一处起这个名字（同一屏不能有两个同名元素）。

## 上一轮意见核对

| # | 结果 | 核对依据 |
|---|---|---|
| M3（remind 不带标题被当成解不开） | **已改** | `parsePushPayload` 里 remind 的 `title`、`body` 可省，null 也当没带，带了必须是字符串；`notificationOf` 缺标题时用 `app.name`，正文、推迟按键、tag、data 照常。用例：`sw-push.test.ts:164`、`:197`；和后端对拍一组（`:391` 起），直接 import `supabase/functions/_shared/push/payload.ts` 的 `buildPayload`，覆盖“不带标题”“标题、正文都不带”“不带标题的 remind 之后来 resolve 按同一个 tag 替换” |
| M4（`desktop.ts` 没实现 `closeAllLocalReminders`，app 的 tsc 不过） | **已解决** | `desktop.ts:120` 已有实现（前端 B），`desktop.test.ts:138`、`:166` 两条 X-5 用例；`tsc -p tsconfig.app.json` 0 错误 |

## 必改

| # | 问题 | 位置 | 改法 |
|---|---|---|---|
| M1 | **离开页面时，还在输入框里、没失焦的字会丢**。`TextInput`、`TextArea` 只在 `onBlur`（或回车）时 `onCommit`，卸载时不提交。点页面上的“‹ 返回”没问题（按下时先失焦），但下面几种离开方式不会先失焦：浏览器或系统的后退（Alt+←、鼠标侧键、Android 返回）、点通知跳到整页提醒（`openReminder` 改 hash）、关标签页、iOS 把 PWA 切到后台后被系统回收。**实测**：渲染 `TextInput`，聚焦、输入，然后卸载，`onCommit` 调用 0 次（脚本 `cr-fa2/exp-race.test.tsx` 第 2 条）。任务单问的“离开页面时还没写完的写入怎么处理”：已经发出去的写入不受影响（`update` 不依赖组件还在，写的是本机库），丢的是还没提交的草稿。定稿是“改了就自动保存”，用户会以为写进去了 | `src/kit/components/Form.tsx:39-100` | ① `TextInput`、`TextArea` 用 ref 记最新的 draft 和 onCommit，在 `useEffect` 的清理函数里，如果 `draft !== value` 就提交一次；② 再监听 `pagehide` 和 `visibilitychange`（变成 hidden 时），有没提交的草稿就提交（iOS 被回收前不会触发卸载）。`useEditRecord.update` 在卸载后照样能写完，不需要别的改动。补用例：聚焦输入后卸载 → onCommit 收到草稿；触发 `visibilitychange` 为 hidden → 也提交；草稿和外面的值一样时不提交 |
| M2 | **同一账号换了会话以后不再认领，这台设备收不到推送**。认领记录只按“账号 + endpoint”记（`mark`，`push-claim.ts:124`），可服务器的 `claim_endpoint` 是把 endpoint 写到**本会话**那一行 devices 上（迁移 `20261103110000` 第 c 步：`session_id = sid`）。同一个账号换了新会话、浏览器订阅又没变时，`before === mark(...)` 且 `changed` 为假，直接返回 `already`，新会话那一行一直没有 endpoint。会出现这种情况的路径：会话过期或被吊销后重新登录同一个账号（owner 相同，`ensureAccount` 返回 `same`，不走 `disconnectPush`，订阅原样留着）；退出时退订超过 2 秒被 `withinMs` 放过、或者失败，再登录同一个账号。上一次认领到的是旧会话那一行，旧会话失效后那一行不再被投递，或者在下一次有人认领时被第 e 步删掉。现有用例 `push-claim.test.ts:70` 只覆盖了“换账号且订阅没退掉”，没有覆盖“同账号、新会话” | `src/platform/push-claim.ts:124`、`:150-152`；`src/app/main.tsx:205` | 记录里加上会话：`mark` 用“账号 + session_id + endpoint”（session_id 用 `readSessionId()`，读不到就不记、每次都认领）；或者改用 devices 行 id（device-reg 存在 meta 里的那个）。补用例：同账号、同 endpoint、session_id 变了 → 再认领一次 |
| M3 | **第一次登录时认领得太早，会被拒成 `device_not_found`，要到下一次启动才再试**。`claim_endpoint` 要求本会话的 devices 行已经存在，不在就 raise `device_not_found`（迁移注释写明“客户端先建 devices 行再认领”）。devices 行由 `core/device-reg.ts` 的 `ensure` 建，它只在 `wireSync` 拿到同步锁以后、经 `tz()` 异步调用。`main.tsx` 却在 SW 注册好以后马上调 `ensurePushSubscription`，和登记设备行是并行的两个网络请求，谁先到不确定。第一次登录（换账号、重装以后同样）认领很可能先到，`parseClaimResult` 把它归成 `failed`，这一次启动不再重试。iPhone 上 PWA 常驻后台，“下一次启动”可能隔很久，这段时间新账号收不到任何推送 | `src/app/main.tsx:198-206`；`src/platform/push-claim.ts:153-165` | 认领放到设备行登记好以后：`ensurePushSubscription` 的 deps 加一个 `ensureDevice`（main.tsx 传 `device.ensure`，没有 device 时跳过认领），先 `await` 它拿到 id 再调 claim；或者 claim 回 `device_not_found` 时先 `ensureDevice()`、再认领一次。补用例：claim 先回 `device_not_found`，`ensureDevice` 之后第二次成功 → 结果 `claimed`，并记下认领 |

## 建议

- S1 **新建页 insert 失败、后面又排着两次以上改动时，排队的改动没有重新等**。`update` 里 `if (inserting.current) await inserting.current;` 只等一次。第一次 insert 失败后，排着的第 2 次接着发新的 insert（新 id），第 3 次已经过了等待那一行，读到第 2 次刚设的 `pendingId`，**在第 2 次的 insert 回来以前就发了 patch**。实测输出：`insert new-1`（失败）→ `insert new-2` → `patch new-2`（这时 new-2 的 insert 还没回来；脚本 `cr-fa2/exp-race.test.tsx` 第 1 条）。现在靠 IndexedDB 按开事务的顺序执行，patch 碰巧排在 insert 后面；第 2 次的 insert 如果被拒，第 3 次会报 `row_missing`，状态显示“格式不对”。改法：改成 `while (inserting.current) await inserting.current;`，或者把所有写入串成一条 promise 链（前一次回来才开始下一次），顺序就不靠 IDB 的实现细节了。补一条“insert 失败后排着两次改动”的用例。
- S2 **写入的 `remind` 标记只看改完以后**（`hasRemind(next, …)`）。把一条 5 分钟后要响的待办清掉截止日期、打勾完成，或者日程改成“不提醒”，这次写入的标记是 false，outbox 不会提前发，服务器可能照旧按旧的 remind_at 推一条。建议改成 `hasRemind(prev) || hasRemind(next)`：撤掉提醒的写入也算和提醒有关，要尽快上服务器。需要先和 outbox 的 `remind` 语义对一下（write.ts 文件头只写了“带提醒”）。
- S3 **全天 ↔ 有时刻来回切换会丢原来的时刻和时区**。切成全天时立刻写 `time: null, tz: null`；切回来是 `09:00` 加本机时区，原来的“纽约 15:00”找不回来，误点一下就改了数据。另外：切成全天以后 `remind_days` 还是 null，全天日程默认不提醒；`remind_min` 留在库里（`eventRemindAt` 在 time 为 null 时不看它，暂时没有害处）。建议：同一页里记住切换前的 time、tz、remind_min，切回来时恢复；切成全天时 `remind_days` 给一个默认值（等产品定，比如“当天”）。语义上还有一点要写清楚：固定时刻的日程如果记录时的时区和现在不同，切成全天时保留的是**日程时区里的日期**，不是“在你这里”的日期，两者可能差一天（`localOf` 跨日的那种情况）。
- S4 **“在你这里是几点”比的是 `currentTz()`，新建日程的时区用的是 `deviceTz()`**。电脑在首尔、手机在上海时，`current_tz` 是上海（手机优先），电脑上新建的日程 tz 是首尔，刚建好就提示“在你这里是 …”。4.6 写的是“换算成**设备当前时区**显示”。建议 `localOf` 用 `deviceTz()`，或者请架构师把“当前时区”指哪一个写明。同样，`emptyForm` 的默认日期用 `currentTz` 算“今天”、时区却用 `deviceTz`，半夜前后两边可能差一天，建议用同一个时区。
- S5 **时区不被允许时 `change` 静默返回**（`useEventEdit.ts:194`），文件头注释却写“状态报 rejected”，两者不一致。还有一种边角：`Intl.supportedValuesOf` 不可用时（Safari 15.4 以前）列表为空，从全天切回有时刻时 `deviceTz()` 过不了 `tzAllowed`，勾选框点了没反应、也没有提示。建议：列表为空时退回只用 `isValidTz` 判断；被拦时把状态设成 `rejected`，和注释一致。
- S6 **日期、时刻输入框每次 change 都提交**（`Form.tsx:70`）。桌面 Chrome 里逐位敲年份时，`0002-11-03`、`0020-11-03`、`0202-11-03` 这些中间值都是合法日期，会各写一次。outbox 里没发出的 patch 会合并，但赶上同步发出去，服务器上会出现几次中间值，提醒也会跟着重算。建议 date 类型只在年份 ≥ 1900（或失焦）时提交。
- S7 **新建保存以后地址还停在 `#/todo/new`**。刷新页面会看到一张空表，用户会以为刚才写的没了；从这里再点“新建”也不会换一张新表（key 没变）。注意不能直接 `replaceRoute` 到新 id：`key={id}` 一变整个编辑器重挂，焦点中的草稿会丢（和 M1 同一个问题）。建议 `history.replaceState` 只改地址、不触发路由重画，或者 key 用“第一次挂载时的 id”。
- S8 **`LocationText` 在 exe 里点开会怎样没核实**。`target="_blank"` 在 iPhone PWA、浏览器里没问题；在 Tauri 的 WebView2 里，新窗口请求的处理要看 Rust 那边怎么配，按 5.10 外链应该经 `open_external`。建议前端 B 在 exe 里实测一次；不行就在 exe 里拦下点击，改走 platform 的打开外链。
- S9 `setDeleted` 没有加入 `seq` 排队。正在保存的一次修改晚回来时，会把“已删除”之后的状态改成 `saved`。影响只是状态文字，建议一起纳入序号。
- S10 `lemo.push.claimed` 退出时不清，上一个账号的 user_id 和 endpoint 会留在 localStorage 里。建议在 `wipeThisDevice` 里一起删（和 `lemo.logq.*` 同样处理）。另外 `push-claim.ts:13` 的注释说“退出、换账号整个 localStorage 键会被换掉”，实际只是下次认领时覆盖，注释要改。
- S11 `back()` 用 `window.history.length > 1` 判断有没有上一页不可靠：从别的网站跳进来、或者同一个标签页之前开过别的页面，length 都大于 1，会退出 App。建议用路由自己记的“进 App 以后的第一页”，或者看 `history.state` 里有没有路由打的标记。
- S12 本地有没保存上的修改（local 非空，比如上次写入报了 `closing`）时，另一台设备同步过来的改动不显示；这时用户再改一个字段，`patchOf(row, formOf(row), next)` 会把 local 里**别的字段的旧值**也当成“变了”一起写回去，盖掉对方刚改的列。概率低（要先写失败、再遇上同步），记一笔；以后做冲突界面（K8-conflict-ui）时可以改成按“用户这一次改了哪几个字段”记差异，而不是记整张表单。

## 补审：prevRemindAt 怎么接（主持人 11-03 追加，后端 BE-1 复核 R1）

依据：B2 任务单“接口先定”第 4 条、架构 0.54 第 2 条、`shared/logic/remind.ts` 文件头 ①②。签名 `remindAtOf(kind, row, tz, now, prevRemindAt?)`：只有**新建、改了截止日期、截止时刻或提前量**时不传；其余保存都传这一行现在的 `remind_at`（可以是 null）。日程是固定时刻，`eventRemindAt` 不看这个参数，传不传结果一样。

先说清影响范围：客户端不写 `remind_at`（manifest 里它是 systemCols，只读），编辑页算 `remindAtOf` 只用来定这次写入的 `remind` 标记（outbox 据此提前发）。所以客户端漏传，坏的是标记：“提醒时刻已过、截止也过了”时，不传会得到 null，标记成 false，传了会得到非 null。“稍后”被吞掉是服务器重算时的问题，由 push-dispatch 第 0 步一律传来保证。客户端照规则接，是为了两边口径一致，以后有人拿编辑页的结果做别的用途（比如“未来 7 天的提醒”清单）也不会出错。客户端读得到 `remind_at`：`rows-read.ts:95`、`:101` 有这一列，集合里的行带着服务器的值；本机新建、还没同步回来的行没有这一列，按 null 传。

### 待办的每条保存路径

| 路径（界面操作） | patch 里的列 | 将来传不传 |
|---|---|---|
| 新建（第一次写上标题，`saveInsert`） | 整行 | **不传** |
| 改标题 | title（＋ AI 简称时 short、short_by） | 传 |
| 打勾 / 取消打勾 | done、done_at | 传（任务单点名） |
| 标重要 | important | 传 |
| 改项目 | project | 传 |
| 改备注 | note | 传 |
| 设截止日期 / 改截止日期 | due | **不传** |
| 清掉截止日期（① 连带清时刻和提前量） | due、due_time、remind_before_min | **不传** |
| 第一次设截止时刻（② 提前量默认 60） | due_time、remind_before_min | **不传** |
| 改截止时刻 | due_time | **不传** |
| 清掉截止时刻（③ 连带清提前量） | due_time、remind_before_min | **不传** |
| 改提前提醒 | remind_before_min | **不传** |
| 改“当天 / 前一天 / 不提醒” | remind_days | 传（属于“改别的触发列”；这两列只在没有截止时刻时起作用，那一支不回落，传不传结果一样） |
| 改提醒时刻（当天 9:00 那个） | remind_time | 传（同上） |
| 删除 / 撤销删除（`saveDeleted`） | deleted_at、updated_at | 传。注意现在这条路径**根本不算标记**（`saveDeleted` 不带 remind），撤销删除会让提醒恢复，应该带上，见下面改法 ④ |
| 新建页 insert 之后、行还没从集合读回来时的后续修改（`useEditRecord` 的 `pendingId` 分支） | 按上面各行 | 同上面各行；要传时传 null（本机行没有 remind_at） |
| 一个 patch 里同时有“不传”列和“传”列（比如 outbox 合并、或以后一次改几个字段） | — | 只要含 due、due_time、remind_before_min 之一就**不传** |

### 日程的每条保存路径

新建、改标题、改日期、改开始时刻、改结束时刻（duration_min）、改时区、改提醒（remind_min）、改全天提醒（remind_days）、全天 ↔ 有时刻、改地点、改项目、改备注、删除 / 撤销删除：`eventRemindAt` 不看 prevRemindAt，**传不传一样**。为了和待办同一个写法，建议按同一条规则处理：新建，以及改了 date、time、tz、remind_min 的不传，其余传。删除 / 撤销删除同样要补算标记。

### 现在的结构接得上吗：不方便，要改一处接口

`EditRecordSpec.hasRemind(form, tz, now)` 只拿到改完以后的表单。要按规则传，需要知道两件事：这次 patch 改了哪些列，以及这一行现在的 `remind_at`。这两样它都拿不到。`todo-edit.ts`、`event-edit.ts` 的 `hasRemind` 也是同样的签名。只在这两个文件里补参数接不对。

改法：
1. `EditRecordSpec` 的 `hasRemind` 改成 `hasRemind(c: { row: Readonly<Record<string, unknown>> | undefined; data: Record<string, unknown> | null; next: F; tz: Tz; now: number }): boolean`。`data` 就是这次 `patchOf` 的结果，insert 时传 null。按**实际写出去的列**判断，不按表单前后对比判断，这样和 `normalize` 连带清掉的列也一致。
2. data 层各写一个纯函数，放在 `todo-edit.ts`、`event-edit.ts`，单测好写：
   `prevRemindAtOf(row, data): number | null | undefined`——`data === null`（新建）返回 undefined；`data` 里有 `TIMING_COLS`（待办是 due、due_time、remind_before_min；日程是 date、time、tz、remind_min）任何一个，返回 undefined；否则返回 `typeof row?.['remind_at'] === 'number' ? row['remind_at'] : null`。
3. `hasRemind` 里调 `remindAtOf(kind, next, tz, now, prevRemindAtOf(row, data))`。和建议 S2 一起做：撤掉提醒的写入也要带标记，用 `remindAtOf(…next…) !== null || remindAtOf(…formOf(row)…, row.remind_at) !== null`（改之前那一份按“其余重算”传它自己的 remind_at）。
4. `useEditRecord.setDeleted` 也调 `hasRemind`（`data = { deleted_at }`，按规则传 remind_at），把结果交给 `saveDeleted`（`saveDeleted` 加一个 remind 参数）。
5. 补用例（待办）：提前时刻已过、截止也过了的一行，`remind_at` 等于截止时刻：改备注、打勾都传，标记为 true；改截止时刻不传，标记为 false；清截止日期不传。另加一条“TIMING_COLS 和 `TodoRemindRow` 里决定回落的字段一致”的断言，以后 shared 加字段时能发现。

## 逐项核对

| 项 | 结果 | 依据 |
|---|---|---|
| X-5：`closeAllLocalReminders` 加进桥，网页版空操作 | **符合** | `native-bridge.ts:39-40`、`:78-80`、`:124-127`；exe 实现在 `desktop.ts:120`，并处理了“还在等权限的那次弹出赶上全关就不弹” |
| `disconnectBrowserPush` 在 exe 里调它，外面用 `withinMs` 包着 | **符合** | `push.ts:186`；超时、抛错（含同步抛错）都 resolve |
| `withinMs` 超时后退出流程是否继续往下走 | **继续** | `wipeThisDevice` 里 `await steps.disconnectPush?.()` 外面还有 try；之后照样 `deleteDb`、清 Cache Storage、signOut；`ensureAccount` 同样。超时后后台那次退订还会接着跑，但随后页面会重新载入或跳登录页，不影响新账号 |
| 启动重订：只在权限已是 granted 时订阅，不弹权限框 | **符合** | `push-claim.ts:146`；exe 直接返回 `tauri` |
| 按“账号 + endpoint”记认领，22023 记为不支持 | **实现和自报一致，但键少了会话**，见 M2；`device_not_found` 的时序见 M3 |
| 换账号时的竞态 | **基本没问题**。换账号由 `ensureAccount` 发现，`boot.switching` 时 `start` 直接返回、页面重新载入，走不到注册 SW 和认领。别的标签页换了账号时，本页 claim 用的是共享的 supabase 会话，服务器按 JWT 认领到当前账号；本地记录写的是本页的旧 userId，下次新账号启动时对不上，会再认领一次，不会混用 |
| `claimEndpoint` 入参、错误码映射 | **符合**。RPC 参数名 `endpoint, p256dh, auth, label, platform` 和 `public.claim_endpoint` 的签名一致；`toFailure` 在消息是单个标识符时把它当 code，所以 `endpoint_not_allowed`、`bad_push_keys` 能被认出来（`raise exception '…' using errcode = '22023'`） |
| M3：remind 可省标题、和 `buildPayload` 对拍 | **已改**，见上表 |
| `#/todo/<id\|new>`、`#/event/<id\|new>` | **符合**。router 加了 `event`、`todo`；功能 index 懒加载页面；不是 UUID 也不是 new 的 id 按“找不到”处理，控件不可用；`key={id}` 换记录时重挂 |
| 自动保存只写变了的列 | **符合**。两张表的 `patchOf` 都只放变了的字段加 `updated_at`；没变返回 null、不入队 |
| `useEditRecord` 晚回来的写入 | **符合**，不会清掉后一次的本地表单、不闪回（用例 `useEditRecord.test.tsx:46`） |
| `useEditRecord` 新建页 insert 还在路上又改 | **单次排队符合**（`:71`），insert 失败后排了两次以上的情况见 S1 |
| 会不会丢改动、重复插入 | 不会重复插入；丢改动见 M1（没失焦的草稿） |
| 清截止日期时同一个 patch 清时刻和提前量 | **符合**（第 136 条、TC-B2-76 新版那一半） |
| 全天 ↔ 有时刻的时区、时间语义 | 存法符合 4.6（全天不存 tz，有时刻必带 tz），切换时丢原值见 S3，比较用的时区见 S4 |
| D7：时区只让选 Intl 支持的 | **符合**。`tzChoices` 用 `Intl.supportedValuesOf('timeZone')`，原来存的值不在表里也列出、不强改；边角见 S5 |
| `LocationText` 与 `safeHref` | **符合** TC-B2-02（`EventEditPage.test.tsx:62`、`:72`）；exe 的打开方式见 S8 |
| i18n 中韩齐全 | **齐全**，见“做得好的地方” |
| 架构规则（A1、A11、A26 等） | **符合**。`check_arch.py` 0 错误（只有两个节假日文件的 W2 警告）；`edit-save.ts`、`current-tz.ts`、两个 data 文件都不引 React；CSS 只用令牌；ESLint 0 错误 |
| 删除 `view-transition-name: page-head` | **合理**，见“做得好的地方” |

## 跑过的测试

- vitest：`src/features/todos`、`src/features/calendar`、`src/kit`、`src/app`，`src/core/__tests__/account.test.ts`、`account-push.test.ts`，`src/platform/__tests__/push-claim`、`push`、`native-bridge`、`sign-out-push`、`desktop`，`src/features/settings/__tests__/exit.test.tsx`，`tests/build/sw-push.test.ts`，共 46 个文件、434 条，全过。另跑 `settings-jump-css`、`view-transition-css` 和 `tests/arch` 整个目录：9 个文件 263 条，1 条失败——`check-arch.test.ts` 的“真仓库：0 个错误”报 BIDI：`desktop/src-tauri/scripts/stage-web.test.mjs:190` 原样出现 U+FEFF。这个文件是前端 B 的，不在本批范围，已转主持人。（命令行直接跑 `python -I build/check_arch.py` 时是 0 错误，两者结果不同，可能是那个文件在审查期间被改过，请前端 B 复跑确认）
- tsc：`tsconfig.app.json`、`tsconfig.sw.json`、`tsconfig.node.json` 都是 0 错误。
- eslint（本批文件）：0 错误，2 个 `max-lines` 警告（`sync-transport.ts` 304 行、`sw-push.test.ts` 396 行）。
- `python -I build/check_arch.py`：0 个错误，2 个警告（缺 2027 年节假日文件，和本批无关）。
- 草稿实验（会话临时目录 `cr-fa2/`，用单独的 vitest 配置跑，不碰仓库）：`exp-race.test.tsx`——① insert 失败后排着两次改动：出现“insert new-2 还没回来就 patch new-2”（S1）；② 聚焦输入后卸载：`onCommit` 0 次（M1）。

## 采纳情况（主持人，11-03）

和同一批的安全审查（B2-安全审查-前端A的FA-2第一段与推送重订.md）合在一起交前端 A：
- M1：交前端 A 必改。卸载时，以及 pagehide、visibilitychange 变成 hidden 时，有没提交的草稿就提交一次。
- M2：和安全审查 FA2-2 是同一件事，合并处理：认领记录里加上 session_id。
- M3：和安全审查 S1 合并，并接上后端新增的 `device_not_found`。先 await 设备行登记好再认领；收到 device_not_found 后补登记、再认领一次；仍失败就记为“稍后重试”。
- S12（盖掉另一台设备刚改的列）：**提为必改**。这会丢数据，违背“数据不丢”。patch 只带用户这一次真正改了的列，本地没保存上的旧修改不许顺带写回。
- S1（新建页 insert 失败后又排了几次修改）：**提为必改**。把写入串成一条链，不靠 IDB 碰巧的执行顺序。
- S10：和安全审查 FA2-1 合并：只存摘要，退出时删掉这个键。
- prevRemindAt：按本记录“补审”一节的改法做。hasRemind 改成接收 row 和这次 patch 的 data，data 层加 prevRemindAtOf(row, data)，setDeleted 也要算 remind 标记。各条保存路径传不传，照本记录列的表。
- S2～S9、S11：本批一起改；不改的写明理由。S8（exe 里 target=_blank 会怎样）交前端 B 实测。
- 范围外：check-arch.test 报 stage-web.test.mjs:190 出现 U+FEFF，交前端 B 复跑确认。

## 复核（11-03 晚）

复核对象：前端 A 按本记录改完的工作区（必改 1～7、S2～S7、S9、S11、prevRemindAt 接线），连带看了后面几段新写的今天页（`src/features/today/`）、待办列表（`todos/data/todo-list.ts`、`todo-actions.ts`、`hooks/useTodoList.ts`）、最近删除（`RecentlyDeletedPage.tsx`、`hooks/useTrash.ts`）、`kit/components/UndoToast.tsx`、`app/router.ts` 的深度标记。只读，没有 git add。

### 结论：有条件通过，8 / 10

M1～M3、S1 和 prevRemindAt 接线都到位。复核中新发现两条必改：N1 是 S12 改法带出来的“状态显示已保存，其实还有字段没写进去”；N2 是 S7 带出来的“保存后再点新建，还是刚才那一条”。两条都在草稿实验里复现了。改完即签。

### 原意见逐条核对

| # | 结果 | 核对依据 |
|---|---|---|
| M1 没失焦的草稿离开页面会丢 | **已改** | `Form.tsx` 的 `useCommitDraft`：失焦、回车、卸载（effect 清理）、`pagehide`、`visibilitychange` 变 hidden 都补交；用 `dirty` 标记保证同一份草稿只交一次、和外面的值一样不交；日期框没定下来（`dateReady` 不过）时不交。卸载时交给的是旧编辑器的 `change`，写的仍是原来那一条，对。`Form.test.tsx` 有卸载、pagehide、hidden、重复不交几条 |
| M2 同账号新会话不再认领 | **已改** | 记录改成 `ok\n` + SHA-256（user_id、session_id、endpoint）摘要；读不到 session_id 时照常认领、不写“已认领”；`disconnectBrowserPush` 一开头清掉记录（顺带完成 S10）。本机不再存明文 user_id 和 endpoint |
| M3 认领早于设备行登记 | **主路径已改** | `claimOnce` 先 `await ensureDevice()`，拿不到 id 返回 `device_pending`、不认领；main.tsx 传了 `device.ensure`，并用 `lemo-push-claim:<userId>` 锁串起各标签页（和 device-reg 的锁不同名，不会互锁）。**补登记重试那一支实际不起作用**：`device-reg.ts` 的 `register` 在 meta 里有同会话、`ok` 的记录时直接返回缓存的 id，不会重新登记，所以“设备行被服务器删了、本机还记着”时第二次认领还是 `device_not_found`。前端 A 自己也指出了，见新建议 S13 |
| S1 写入排队 | **已改** | `update`、`setDeleted` 串成一条 promise 链（`enqueue`），前一个回来才开始下一个；任务里读 `live.current.row`，用的是当时最新的行。我上一轮的实验（insert 失败后排着两次改动）不再复现 |
| S2 撤掉提醒的写入也带标记 | **已改**，口径见下面“两处和补审原文不一致” |
| S3 全天 ↔ 有时刻丢原值 | **已改（同一页内恢复）** | `setAllDay` 切走前记住 time、tz、remind_min，切回来恢复。没做的部分：切成全天时 `remind_days` 仍是 null（我写的是“等产品定”，可以留）。小边角：原来存的 tz 不在 Intl 表里时，切成全天后 `original` 变成 null，切回来恢复这个 tz 会被 `tzAllowed` 拦下、报 rejected。概率很低，记一笔 |
| S4 比较用的时区 | **已改** | 默认日期、默认时区、“在你这里是几点”都用 `deviceTz()` |
| S5 时区被拦静默返回 | **已改** | 被拦时 `markRejected()`，状态显示 rejected；`Intl.supportedValuesOf` 不可用时退回只看 `isValidTz` |
| S6 日期逐位提交 | **已改** | `dateReady`：年份 ≥ 1900 才交 |
| S7 新建后地址停在 new | **已改，但带出 N2** | `replaceAddress` 只改地址、不重画，编辑器不重挂（用例 `TodoEditPage.test.tsx:87`） |
| S8 exe 里的 `target="_blank"` | 未改 | 这一条本来就是请前端 B 在 exe 里实测，不在前端 A 的改动范围，仍挂着 |
| S9 setDeleted 不在序号里 | **已改** | `setDeleted` 也 `++seq` 并进同一条链 |
| S10 退出不清认领记录 | **已改** | 随 M2 一起改了 |
| S11 `history.length` 判断不可靠 | **已改** | router 给 `navigate` 压的历史打深度标记，`canGoBack()` 看深度是否大于 0 |
| S12 写回旧值盖掉别人的列 | **已改，但带出 N1** | 每次只写“这一次和改之前显示的表单相比变了的列”，没保存上的旧修改不再顺带写回 |
| prevRemindAt 接线 | **已改** | `hasRemind(RemindCtx)` 能拿到行、这次的 data、改前和改后的表单；`prevRemindAtOf(row, data)` 按 `TODO_TIMING_COLS`（due、due_time、remind_before_min）、`EVENT_TIMING_COLS`（date、time、tz、remind_min）判断：新建或含其中一列就不传，其余传 `row.remind_at`（没有时传 null），和补审表一致。删除、恢复、打勾都算标记；今天页、待办列表、最近删除上的打勾、删除、恢复也照同一条规则算（`today-actions.ts`、`todo-actions.ts`） |

### 前端 A 提的两处和补审原文不一致

- **“打勾的标记是 false”：前端 A 对，补审原文写错了**。待办 `done = true` 时 `todoRemindAt` 直接返回 null，“改之后”一侧永远不会响。我在补审改法第 5 条里举的例子是“提前时刻已过、截止也过了的一行，打勾标记为 true”，这是错的。在这个例子里，改之前那一份的提醒也已经过了（不满足 ≥ now），所以标记就是 false。正确的说法是：打勾的标记等于“改之前的提醒还没到”。取消打勾时，看改之后算不算得出提醒时刻。现在的实现就是这样，用例按这个口径写即可。
- **S2 改成“改之前的提醒时刻 ≥ now 才算会响”：同意**。已经过了的提醒不用撤，不这样限定的话，改一下很久以前的日程也会整条提前发。留一个小口子，记为建议 S14：这一行如果按过“稍后”，服务器上的 `remind_at` 会是一个还没到的稍后时刻，可本机按字段重算出来的“改之前”是原来那个已经过了的时刻，于是判成不会响。这时清掉截止日期、打勾，标记都是 false，稍后的那一条可能照样推出来。

### 新的必改

| # | 问题 | 位置 | 改法 |
|---|---|---|---|
| N1 | **状态显示“已自动保存”，其实还有字段没写进去，离开页面就丢**。S12 的改法是“只写这一次改的列”。上一次没写进去的字段（比如 `closing`）留在 `dirty` 里照常显示，之后改别的字段，这次写入只带新字段，状态变成 `saved`。这时用户看到“已自动保存”，可上一次那个字段一直没写进库，除非再改它一次。**实测**（`cr-fa2/exp-r2a.test.tsx`）：改标题 → 写入回 `closing`；再改备注 → 发出的 patch 只有 `{note}`，状态 `saved`，表单里标题还显示新值。我上一轮 S12 的本意是“按用户改过、还没保存上的那些字段写”，不是“只写这一次的字段” | `src/kit/hooks/useEditRecord.ts:117`、`:131-133`、`:160-161` | 每次写入带上 **dirty 里全部字段**，和当前行比：这样既不会盖掉别的设备改的、用户没碰过的列（S12 原意），又能补上之前没写进去的。担心的情况是：被拒（rejected、readonly）的字段每次都带上，以后每次写入都会被拒。处理办法：这类字段单独记下，下次不带，状态常驻“有一项没保存上”，直到用户改它或离开。不管怎么改，只要 dirty 里还有没写进去的字段，状态就不能显示 `saved`。补用例：上面的复现顺序 → 第二次 patch 带上 title，或者状态不是 saved |
| N2 | **新建保存以后再点“新建”，打开的还是刚才那一条**。`TodoEditPage`、`EventEditPage` 里，`slot` 只在 `id !== slot.id && id !== slot.created` 时换一张新表。新建保存后 slot 是 `{id: 'new', created: <新 id>}`，地址被 `replaceAddress` 换成了新 id。这时再 `navigate('todo', 'new')`，路由给的 id 是 `'new'`，等于 `slot.id`，不换 key，编辑器还是刚才那一条。**实测**（`cr-fa2/exp-r2b.test.tsx`）：新建“买收纳盒”保存后 `navigate('todo','new')`，地址是 `#/todo/new`，标题框里还是“买收纳盒”，再改就改到上一条上去了。文件里的注释写的是“再点‘新建’才换一张”，行为和注释不符 | `src/features/todos/ui/TodoEditPage.tsx:45-55`、`src/features/calendar/ui/EventEditPage.tsx:48-58` | `onCreated` 里把 `slot.current.id` 改成新 id（只保留 key 不变），这样之后路由回到 `'new'` 时 `id !== slot.id`，就会换一张新表；或者 router 给每次 `navigate` 带一个序号，编辑页按序号换 key。补用例：新建保存 → 再 navigate 到 new → 标题框为空，再写是新的一行 insert |

### 新的建议

- S13 （转主持人，归 core 的 device-reg 维护者）`createDeviceRegistrar` 加一个 `invalidate()`，把 meta 里本会话那条 `ok` 记录作废。push-claim 收到 `device_not_found` 时先 `invalidate()`，再 `ensureDevice()`，补登记重试才真的会重新登记。
- S14 “改之前会不会响”除了按字段重算，再看一下这一行的 `remind_at`、`snooze_at`，任何一个还没到就算会响，补上“按过稍后”的情况（见上文）。
- S15 待办的提醒标记逻辑现在有三份几乎一样的代码：编辑页的 `todo-edit.ts` `hasRemind`、`today/data/today-actions.ts`、`todos/data/todo-actions.ts`（后两份 `todoRemindRow`、`todoPendingBefore`、`remindAfterDone`、`remindAfterDelete` 逐行相同）。A27 不准功能之间互相 import，建议把“这一行写之前和写之后的提醒标记”挪到 `shared/logic/remind.ts`，或者 core 里放一个纯函数，三处都调它。以后规则再改（比如 S14），只改一处。
- S16 改之后那一侧没有限定 ≥ now：传了 prevRemindAt 以后，`todoRemindAt` 可能返回一个已经过了的时刻（返回 remind 或 dueAt），这时给“很久以前的逾期待办”改个备注，标记也是 true，整条提前发。影响只是多发几次，可以和“改之前”一样加上 ≥ now。
- `sync-transport.ts` 按 ESLint 的口径是 305 行，超过 300 行上限（只是警告）。可以把 `claimEndpoint` 和 `reportTz` 这类单个 RPC 的包装挪到一个小文件，比如 `supabase/device-rpc.ts`。

### 跑过的测试（复核）

- 全量 vitest（`--exclude tests/build/gen-tauri-key.test.ts`，没跑会清剪贴板的那个）：365 个文件，5477 条，**5438 过、7 失败**、29 跳过、3 todo。7 条失败都不在前端 A 的范围，转主持人：
  - `tests/arch/coverage.test.ts`：`tests/build/desktop-scan.test.ts`、`workflow-permissions.test.ts` 没登记进 SLOW_NODE_TESTS（前端 B、运维）；
  - `tests/build/ai-consent-gate.test.ts`、`d1-fn-lock-timeout.test.ts` 两条，`tests/edge/push-dispatch-round.test.ts` 两条，`tests/shared/notify-text.test.ts` 一条：都是后端 BE-2 正在写的 push-dispatch、notify-text 和迁移。
  - 上一轮 `stage-web.test.mjs` 的 BIDI 这次没有再报。
- 前端 A 范围内（kit、todos、calendar、today、platform 的 push、push-claim、desktop、native-bridge，core 的 account，app 的 router、sync-wiring，sw-push）都过。
- tsc：app、sw、node、shared 四个配置 0 错误。
- eslint（kit、todos、calendar、today、push-claim、push、router、main、edit-save、sync-transport）：0 错误，1 个警告（`sync-transport.ts` max-lines 305）。
- `python -I build/check_arch.py`：0 错误，2 个警告（缺 2027 年节假日文件）。
- 草稿实验（会话临时目录 `cr-fa2/`，单独的 vitest 配置，不碰仓库）：`exp-r2a.test.tsx` 复现 N1，`exp-r2b.test.tsx` 复现 N2；上一轮的 `exp-race.test.tsx` 第 1 条（S1）已不再复现。
