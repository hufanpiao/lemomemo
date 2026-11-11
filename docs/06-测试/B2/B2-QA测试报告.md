# B2 QA 测试报告（签字版待签）

- 日期：2026-11-06 草稿；**2026-11-11 QA 改成签字版**　作者：QA
- 状态：**自动化部分已跑完、可签；整份报告暂不能签字**——卡在第五节“未决”的 Q-1、Q-2、Q-3（主持人 11-11 定：这三条没关，B2 不签），以及第五节列的真机项。QA 签字栏在文末。
- 用例来源：[测试用例 v4](../测试用例-v4.md) B2 一节（TC-B2-01～90、TC-DEL-remind_queue）；④ 要交什么见 [B2 任务单](../../09-路线图/B2-任务单.md) 第九节 ④ 行。
- **R-376**（负责人 11-10：UI 外观、动效挪到全部功能做完以后）：外观、动效类用例标“移到最后（R-376）”，**不卡 B2 签字**；功能、推送、底栏位置（R-371）留在 B2。
- 负责人真机部分：[B2 负责人真机单](B2-负责人真机单.md)、[B2 签字剩余 11-10](B2-签字剩余-11-10.md)、[B2 推送实测记录](../B2-推送实测记录.md)。

## 一、这次怎么跑的（11-11）

| 项 | 内容 |
|---|---|
| 代码 | 主仓工作区。开跑时 HEAD `02b290cf`，跑测试期间别的批次提交到 `c3e91675`（10:28）；暂存区有别人的 4 个文档改动（没碰）。下面结果是工作区的结果 |
| vitest 全量 | `npx vitest run --exclude tests/build/gen-tauri-key.test.ts --maxWorkers=4`：673 个文件，**8587 过、1 失败、31 跳过、3 todo**，用时 720 秒（本机同时还有别的 4 组 vitest 在跑）。唯一失败是 `tests/build/splash-html.test.ts:173`，它查的是仓库里**现成的** `dist/web/app`（11-11 00:19 别人构建的旧产物），比启动画面改动（10:14）旧；本次新构建的 `dist/web-qab2/app` 用 `node build/check_splash_css.mjs --app-dir dist/web-qab2/app` 查是通过的。判定：**环境问题，不是 bug**；CI 每次重新构建，不会遇到 |
| Deno | `deno task test`（tests/shared）：**687 过、0 失败、1 忽略**，11 秒 |
| pgTAP 离线 | `node supabase/tests/offline/run.mjs`（PGlite）：rls 44 个文件 **1696 条全过**，D1、清单违规样例、兼容样例全过，13 秒 |
| pgTAP 真库 | `npm run e2e:real:up` 起 lemo-e2e（先查 55321/55322/55324 没被占），`npx supabase test db --db-url …127.0.0.1:55322… supabase/tests/rls`：**Files=44，Tests=1696，PASS**，14 秒 |
| 真库集成（store-it） | `node supabase/tests/store-it/run.mjs --e2e-sb`：四组 **18、4、6、5 条全过**（含 D3 第 6 点三条、TC-DEL-remind_queue 函数一侧），61 秒 |
| e2e 真后端组 | `npm run e2e:real -- --workers=3`：**17 条全过**，26 秒；跑完 `npm run e2e:real:down`，lemo-e2e 已停，lemomemo 没碰 |
| e2e 无后端组 | `LEMO_WEB_OUT=dist/web-qab2 npm run e2e -- --workers=4`（chromium＋webkit 共 370 条）：**332 过、0 失败、38 跳过**，4.5 分钟（含构建；8788 先被别的会话占着，等空了才跑，HEAD `c3e91675`） |
| 后端检查 | `python build/check_backend.py`：0 个错误 |
| 构建、首屏 | `LEMO_WEB_OUT=dist/web-qab2 npm run build -- --mode e2e`（e2e 模式的 Vite 模式就是 preview，体积口径相同；没写 dist/web，不碰别人在用的产物）：见第三节 |
| 没跑 | CI（本机没有 gh，看不到 main 最近一次 CI）；真机 |

结果口径：**通过（本机）**＝11-11 在本机跑过、全过；**部分**＝自动化覆盖了一部分，缺的列进第四节缺口清单；**移到最后（R-376）**＝外观、动效，不卡签字；**真机**＝靠负责人真机；**不再适用 / 不执行**＝功能删了或做法换了。

## 二、逐条结果

“自动化在哪”按测试内容逐条核过（测试里没写编号的也按步骤和期望对上），行号是 11-11 工作区的。

| 用例 | 简述 | 自动化在哪 | 结果 |
|---|---|---|---|
| TC-B2-01 | 新建、编辑、完成、删除日程和待办 | 组件：`src/features/todos/__tests__/TodoEditPage.test.tsx`（文件头“TC-B2-01 前半”）；E2E 零散：`tests/e2e/b2-vt-taps.spec.ts:89`（删除、撤销）、`b2-tabbar.spec.ts:49`（自动保存换 id）；`b1-sync.spec.ts:20、24` 仍是 `test.fixme` | 部分：组件、零散 E2E 通过（本机）；**缺口 G-01** |
| TC-B2-02 | 地点、链接只认 https | `src/features/calendar/__tests__/EventEditPage.test.tsx` | 通过（本机） |
| TC-B2-03 | 删除撤销、最近删除恢复、30 天 | 撤销 `b2-vt-taps.spec.ts:89`、`b2-motion-list.spec.ts:318`；恢复 `src/features/today/__tests__/trash-readonly.test.tsx:81`、`trash-notes.test.tsx:46`；30 天 `supabase/tests/rls/04_config_constraints.test.sql:102`、`src/core/__tests__/boot.test.ts:70`；永久删除、全部清空 `trash-purge.test.tsx:100、184、198` | 通过（本机） |
| TC-B2-04 | REST 直接 DELETE 被拦 | pgTAP `03_roles_grants.test.sql:119-121`（客户端表级 DELETE 只有 devices）、`01_client_rls.test.sql:50、52、55-84` | 通过（本机，按权限断言，不是真发 REST） |
| TC-B2-05 | 今天页四套皮肤截图比对 | 没有 | 移到最后（R-376，外观） |
| TC-B2-06 | 字重计算样式 | 没有 | 移到最后（R-376，外观） |
| TC-B2-07 | 截图和计算样式 | 没有 | 移到最后（R-376，外观） |
| TC-B2-08 | buildMonth 单元 | `tests/shared/calendar/month-grid.test.ts` | 通过（本机） |
| TC-B2-09 | buildWeek 单元 | `tests/shared/calendar/week-view.test.ts` | 通过（本机） |
| TC-B2-10 | itemShort / projectShort | `tests/shared/short.test.ts` | 通过（本机） |
| TC-B2-11 | short_by 改标题 | `tests/shared/short.test.ts` | 通过（本机） |
| TC-B2-12 | holidayCountries | `tests/shared/calendar/holidays.test.ts` | 通过（本机） |
| TC-B2-13 | 日历路由、年月选择器跳转 | `cal-route.test.ts`、`CalendarPage.test.tsx`、`tests/shared/calendar/cal-nav.test.ts` | 通过（本机） |
| TC-B2-14 | 节假日切换 | `CalendarPage.test.tsx:252`（只拉选中国家）、`CalendarSettings.test.tsx:52、64` | 部分：通过（本机）；**缺口 G-02** |
| TC-B2-15 | 翻月翻周、返回 | `CalendarPage.test.tsx:185、78`、`CalendarReview.test.tsx:241`、`CalendarWeek.test.tsx:282`、`src/motion/__tests__/swipe-pager.test.ts:28、61`；E2E `r372-back-levels.spec.ts:30`、`r381-avatar.spec.ts:74` | 通过（本机）。**用例期望要改**：用例写“返回一页页退回”，R-372 已定“后退一步回今天”，测试按 R-372 |
| TC-B2-16 | 年月选择器键盘 | `CalendarWeek.test.tsx:316、336` | 通过（本机） |
| TC-B2-17 | 输入框焦点时方向键、推送链接返回 | `CalendarWeek.test.tsx:302` | 部分：方向键通过（本机）；**缺口 G-03** |
| TC-B2-18 | 周视图截图 | `CalendarWeek.test.tsx:78`、`week-view.test.ts`（minBlockPx） | 截图部分移到最后（R-376）；简称逻辑通过（本机） |
| TC-B2-19 | 周视图计算样式 | 没有 | 移到最后（R-376，外观） |
| TC-B2-87 | 农历 2026～2100 各月 | `tests/shared/anniv/lunar.test.ts` | 通过（本机，单元；Deno 同跑） |
| TC-B2-20 | 固定、浮动跨时区 | `src/features/calendar/__tests__/event-edit.test.ts:55`、`src/features/today/__tests__/today-model.test.ts:127`、`tests/shared/remind-all-day.test.ts:33`、`tests/shared/remind.test.ts:165` | 通过（本机）；真机 P2-04（3-1） |
| TC-B2-21 | 待办提醒时刻、免打扰 | `tests/shared/remind-actions.test.ts` | 通过（本机） |
| TC-B2-22 | 录音中、键盘弹起时提醒排队 | `RemindHost.test.tsx`、`src/kit/state/__tests__/remind-queue.test.tsx` | 通过（本机） |
| TC-B2-23 | 推送到点、410、重复、免打扰 | `tests/edge/push-dispatch-round.test.ts:46、156、170、211`；pgTAP `37_system_col_sync.test.sql:24-38` | 通过（本机） |
| TC-B2-24 | 日志不写标题 | `push-dispatch-round.test.ts:46`、`push-dispatch-d3-full.test.ts:147` | 通过（本机） |
| TC-B2-25 | 两台设备 resolve 收起 | `RemindHost.test.tsx:251`、`remind-data.test.ts:92`、`tests/build/sw-push.test.ts:279` | 自动部分通过（本机）；Edge 人工冒烟 10 分钟（17.2）待做；iPhone 真机 P2-05（3-2） |
| TC-B2-70 | 通知上“推迟”、点通知本身 | `sw-push.test.ts:322、358、372`、`tests/build/sw-pending.test.ts:87、95`、`src/core/__tests__/outbox-boot.test.ts:75、110` | 通过（本机） |
| TC-B2-71 | 重新登录、推送提示、移除 | `remind-data.test.ts`、`RemindSettings.test.tsx`；E2E `b2-settings-remind.spec.ts` | 通过（本机） |
| TC-B2-72 | due_time 提前量 | `tests/shared/remind.test.ts` | 通过（本机） |
| TC-B2-73 | REST 写 todos 约束 | `tests/shared/rows.test.ts:149-150`、pgTAP `02_triggers.test.sql:10`、`32_allday_remind_enqueue.test.sql:95` | 部分：通过（本机）；**缺口 G-04** |
| TC-B2-74 | 编辑页截止时刻、提前提醒 | `todo-edit.test.ts`、`TodoEditPage.test.tsx` | 通过（本机） |
| TC-B2-75 | 旧版读写 due_time | `src/core/__tests__/read-ingest.test.ts:40`、`read-lenient.test.ts:112`（通用新列） | 部分：通过（本机）；**缺口 G-05** |
| TC-B2-76 | 旧版清截止日期 | pgTAP `02_triggers.test.sql:20-25`、`TodoEditPage.test.tsx:149` | 通过（本机） |
| TC-B2-77 | 永久删除后不推 | `tests/edge/push-dispatch-step0.test.ts:76` | 部分：服务端不推通过（本机）；**缺口 G-06** |
| TC-B2-78 | 服务器推送和本机通知文案 | `remind-data.test.ts` | 部分：本机通知文案通过（本机）；Edge、exe 各看一次并入 17.2 人工冒烟；iPhone 已在推送实测 P2-17 两行看过（锁屏显示 / 不显示标题） |
| TC-B2-79 | claim_endpoint 权限（P0） | pgTAP `28_claim_endpoint.test.sql` | 通过（本机：离线 PGlite 和 lemo-e2e 真库 pgTAP 都过） |
| TC-B2-80 | 端点规范串、替身重定向 | vitest `tests/shared/push/push-endpoint.test.ts`、`tests/build/push-*`、`tests/edge/push-dispatch.test.ts`、`push-test.test.ts`；pgTAP `28_claim_endpoint`、`29_push_endpoint_vectors` | 通过（本机：vitest 部分＋两边 pgTAP 都过；两边同一组向量，`push-vectors-sync.test.ts` 核一致） |
| TC-B2-81 | 300 条、预算（D3 第 6 点①） | vitest `tests/edge/push-dispatch-budget.test.ts`、`push-dispatch-d3-full.test.ts`；真库 `supabase/tests/store-it/push-dispatch-d3.it.ts` | 通过（本机：vitest 替身＋lemo-e2e 真库 store-it，数字见第三节） |
| TC-B2-82 | 两轮重叠只发一次（D3 第 6 点②） | `push-dispatch-d3-full.test.ts`、`push-dispatch-round-d3.test.ts`；真库同上 | 通过（本机：vitest 替身＋lemo-e2e 真库 store-it，数字见第三节） |
| TC-B2-83 | 认领后抛错（D3 第 6 点③） | `push-dispatch-d3-full.test.ts:147`、`push-dispatch-round-d3.test.ts:21`；真库 `push-dispatch-d3.it.ts:186`（218-219 行调前端 `missed()`）；`reminder-model.test.ts:69、77` | 通过（本机：vitest 替身＋lemo-e2e 真库 store-it，数字见第三节）；“A 打开 App 看到它”没有 E2E，见**缺口 G-07** |
| TC-B2-84 | 会话吊销后认领 | pgTAP `28_claim_endpoint.test.sql:137-147、180-199、215-218` | 通过（本机：离线 PGlite 和 lemo-e2e 真库 pgTAP 都过） |
| TC-B2-85 | push-test 限次、只回枚举 | `tests/edge/push-test.test.ts:63、79、113、132`；426 由 `tests/functions/fn-version-gate.test.ts:102` 通用规则管 | 通过（本机）；真机冒烟（真机单 1-2）11-10 已过 |
| TC-B2-86 | usage-report 只认 x-ops-secret | `tests/functions/usage-report.test.ts:45、51`、`lemo-ops-usage-call.test.ts:14`、`lemo-ops-b2.test.ts:116、125`、`tests/build/check-backend-f9-server.test.ts:22、56`；`check_backend.py` | 通过（本机） |
| TC-B2-88 | Web Push 自实现 C-1～C-10 | `tests/edge/push-dispatch.test.ts`；Deno `tests/shared` | 通过（本机，vitest＋Deno） |
| TC-B2-89 | 队列租约崩溃回收 | `tests/edge/push-dispatch-lease.test.ts:28-132`、`tests/functions/push-dispatch-store.test.ts:37-51`、`tests/build/remind-queue-2conn-guard.test.ts`；pgTAP `30_remind_queue_pop.test.sql` | 通过（本机：离线 PGlite 和 lemo-e2e 真库 pgTAP 都过）；⑤ 真库冒烟用例写明手工跑 |
| TC-B2-90 | fn_ai 队列权限 | pgTAP `35_heartbeat_fnai_policy.test.sql`、`40_push_heartbeat_atomic.test.sql`；D1 反例 `build/d1` | 通过（本机：离线 PGlite 和 lemo-e2e 真库 pgTAP 都过） |
| TC-B2-26 | 错过提醒 | `reminder-model.test.ts`、`RemindHost.test.tsx` | 通过（本机）；“列表跳不跳”观感移到最后（R-376，P2-20） |
| TC-B2-27 | 低版本免查两条（P0） | `tests/functions/version-gate-b2.test.ts` | 通过（本机）。进冒烟：它在 vitest 全量里，CI 每次跑，按第 2 节规则算进冒烟自动部分 |
| TC-B2-28 | 首屏 JS ≤ 150 KB | `tests/e2e/b2-first-screen-budget.spec.ts:76`、`tests/build/check-size.test.ts:47、55`、`build/check_size.mjs` | 通过（本机）：首屏 112.2 KB gzip / 150 KB；冷启动 5 次待真机（P2-08） |
| TC-B2-29 | 新建后本机、同步 patch | `reminder-model.test.ts` | 通过（本机） |
| TC-B2-64 | 推送文案按来源 | `remind-data.test.ts` | 通过（本机） |
| TC-B2-65 | 跟随系统、浅色、深色 | 只有 `src/app/__tests__/color-scheme.test.ts:19` | 移到最后（R-376，外观）；另：源码里搜不到“跟随系统”设置项，功能是否在 B2 要主持人确认 |
| TC-B2-66 | 未来 7 天提醒 | `remind-all-day.test.ts`、`reminder-model.test.ts` | 通过（本机） |
| TC-B2-67 | 图标、待办、月历截图 | `CalendarPage.test.tsx:224、288`、`lunar.test.ts:97` | 截图和图标外观移到最后（R-376）；纪念日菱形读屏、节气逻辑通过（本机） |
| TC-B2-68 | ops 密钥头（P0） | `tests/edge/push-dispatch.test.ts:61`、`tests/functions/account-purge.test.ts:16`、`tests/edge/ai-classify.test.ts:14`、`fn-version-gate.test.ts:236、243`、`tests/build/check-backend-migrations.test.ts:79、92` | 部分：通过（本机）；**缺口 G-08**（P0，签字前要补或安全审查员认可） |
| TC-B2-69 | 离线新建“未同步”标记 | `cal-unsynced.test.tsx`、`todos-remind-mark.test.tsx`、`RemindHost.test.tsx` | 通过（本机）；真机 P2-06（3-3） |
| TC-B2-63 | 全天、固定时区提醒时刻 | `tests/shared/remind-all-day.test.ts` | 通过（本机） |
| TC-B2-30 | iPhone 推送 | — | 真机：P2-01、02、17、18 已过（见推送实测记录）；P2-04～07 待真机 |
| TC-B2-31 | 只读行：行尾、点击、打勾、左滑、多选 | `tests/e2e/b2-readonly-rows.spec.ts:84、109、127` | 通过（本机，chromium＋webkit） |
| TC-B2-32 | 重复事项横幅 | `b2-readonly-rows.spec.ts:86、130`、`today-readonly.test.tsx:51、71` | 部分：横幅和只读通过（本机）；“每条只显示第一次”**缺口 G-09** |
| TC-B2-33 | 横幅“更新” | `today-readonly.test.tsx:51`、`src/app/__tests__/update-banner.test.tsx:78` | 通过（本机，到入口为止；后续流程归 TC-B1-44） |
| TC-B2-34～39 | 液态玻璃副本（6 条） | `src/motion/__tests__/glass-ghost.test.ts:36`（11-06 起不建副本层）、`GlassBar.test.tsx:37、88`、`tests/e2e/visual/g-bottom-top.spec.ts:87` | 移到最后（R-376，外观）。另：11-06 改直接模糊后 36～38 已无测试对象，用例要改写 |
| TC-B2-40～44 | 液态玻璃停止、遮挡、页签、液滴（5 条） | `glass-ghost.test.ts:51、61、77`、`GlassBar.test.tsx:111、269`、`tests/arch/durations.test.ts:69` | 移到最后（R-376，动效 / 外观）。另：TC-B2-44 期望“放大 1.16 倍”，测试钉的是 1.12 且断言不是 1.16（`GlassBar.test.tsx:299`），用例和实现不一致，要定以哪个为准；41 自动深浅 11-06 已取消 |
| TC-B2-45 | 倾斜做法 ① | — | 不执行（P1-05 实测“记不住”） |
| TC-B2-46 | 倾斜做法 ② | 只剩清旧开关 `glass-ghost.test.ts:138`、`GlassBar-wide.test.tsx:65` | 不再适用（R-373 整功能删除） |
| TC-B2-47 | 倾斜拒绝、读不到 | 同上 | 不再适用（R-373） |
| TC-B2-48 | 对比度：柔光当底色 | `build/contrast-pairs.json` 的 `g-halo`；`tests/build/check-contrast-accepted.test.ts:99`（failed: 0） | 移到最后（R-376）；对比度数字部分通过（本机） |
| TC-B2-60 | 对比度：--g-fg 对叠色 | `tests/build/check-contrast.test.ts` | 移到最后（R-376）；脚本通过（本机），8 项例外按负责人 11-06 决定 |
| TC-B2-61 | 三种最坏背景截图 | `g-bottom-top.spec.ts:87`、`tests/e2e/visual/tabbar-lock.spec.ts:62` | 移到最后（R-376） |
| TC-B2-49 | 减少透明效果 | `GlassBar.test.tsx:269`（实色带） | 移到最后（R-376，外观） |
| TC-B2-50 | 弹层遮罩、切页名字 | `src/motion/__tests__/view-transition-css.test.ts:284、298`、`GlassBar.test.tsx:269` | 移到最后（R-376，动效） |
| TC-B2-51 | 流畅度 | — | 移到最后（R-376，P2-09） |
| TC-B2-62 | 左滑按钮对比度 | `contrast-pairs.json` 的 `swipe-btn-*`、`swipe-delete` | 移到最后（R-376） |
| TC-B2-52 | 四套皮肤截图 | 没有 | 移到最后（R-376） |
| TC-B2-53 | 提示条对比度 | `contrast-pairs.json` toast 两对 | 移到最后（R-376）；对比度数字通过（本机） |
| TC-B2-54 | 最差背景对比度 | `contrast-pairs.json` toast、abar | 移到最后（R-376）；对比度数字通过（本机） |
| TC-B2-55 | 动效 | `CalendarFold.test.tsx:219`、`swipe-pager.test.ts:61`、`TodayPage-motion.test.tsx:64`、`b2-motion-list.spec.ts:260、318`、`remind-exit-click.test.tsx:132` | 移到最后（R-376，动效；②b） |
| TC-B2-56 | 键盘、axe | `tests/e2e/b2-motion-focus-retry.spec.ts:49、104` | 部分：焦点归还通过；**缺口 G-10**（全仓没有 axe） |
| TC-B2-57 | 主屏幕版更新 | `src/platform/__tests__/sw-register.test.ts:80-268`、`update-banner.test.tsx:78` | 通过（本机，前端检测部分）；真机 P2-12（3-9） |
| TC-B2-58 | 重新打开、断网从 SW 打开 | `tests/build/inject-sw.test.ts:33`、`tests/e2e/b2-ui-b-update-fallback.spec.ts:34、47` | 部分：通过（本机）；**缺口 G-11** |
| TC-B2-59 | 各档布局、键盘 visualViewport | `tests/e2e/b2-sidebar.spec.ts:37、161`、`src/app/__tests__/tabbar-app.test.tsx:46` | 部分：通过（本机）；**缺口 G-12** |
| TC-DEL-remind_queue | 注销清单、孤儿删除（P0） | `tests/data-manifest/generate.test.ts`；pgTAP `30_remind_queue_pop.test.sql`；真库 `push-dispatch-d3.it.ts`、`purge-remind.it.ts`；`push-dispatch-step0.test.ts:76` | 通过（本机：清单生成、pgTAP 30、lemo-e2e 真库 D3-real-DEL） |

小计（91 条，34～39、40～44 按条数算）：通过（本机）45 条；部分 13 条（缺的列进第四节）；移到最后（R-376）29 条；真机 1 条（TC-B2-30，另有各行附带的真机项见第五节）；不再适用 2 条（TC-B2-46、47，R-373）；不执行 1 条（TC-B2-45）。**没有失败的用例。**

## 三、④ 要交的数字

### 3.1 D3 第 6 点三条（任务单 BE-2 验收）

两层都跑了：vitest 替身（`tests/edge/push-dispatch-d3-full.test.ts`、`push-dispatch-budget.test.ts`、`push-dispatch-round-d3.test.ts`，在 vitest 全量里，全过）；lemo-e2e 真库（`supabase/tests/store-it/push-dispatch-d3.it.ts`，11-11 跑，下面数字是它打出的原文摘要）。

| 条 | 要求 | 真库结果（11-11） | 结论 |
|---|---|---|---|
| ① 替身每个请求拖 3 秒、造 300 条 | 一轮 25 秒内返回、`budget_hit` 对、剩下的下一轮发完 | 预热后第一轮 21305 ms 返回（最后一次认领 18234 ms，最后一次发送结束 21252 ms，收尾 53 ms）；claimed=70、sent=70、left=230、budget_hit=true；并发峰值 10；真库心跳和回包一致（含 left）；之后两轮 200/true、30/false；300 条各发 1 次，库里 300 行 `pushed_for = remind_at` | 通过 |
| ② 两轮人为重叠 | 每条只发一次 | 两轮共 9123 ms；第一轮 claimed=30、第二轮 claimed=20，各有 20 次认领落空（对方已认领），交集 0；替身收到 50、去重 50 | 通过 |
| ③ 认领后抛错 | 这一条不再推、“错过的提醒”里有它 | 第一轮 claimed=2、sent=1、failed=1，心跳 claimed−sent=1，logs `code=build_failed`，不含标题和端点；第二轮 claimed=0；读回 `pushed_for=remind_at`、`notified_for=null`，前端 `missed()` 返回它 | 通过（函数＋前端函数级；界面 E2E 见缺口 G-07） |

附：同一组里 TC-DEL-remind_queue 真库一侧也过——冷静期 3 项一轮后仍在队列、remind_at 不变；deleteUser 后孤儿 3 项，下一轮 push-dispatch 清为 0、没有推送。按任务单第六节末尾，这些结果只能给 B1-left-pgnet-timeout 作旁证，不替它关单。

### 3.2 冒烟回归和实际用时

冒烟回归集的自动部分＝所有标 ★ 的用例，都落在下面这几组里，本机 11-11 整组跑（比冒烟集多，不少）：

| 组 | 结果 | 实际用时 |
|---|---|---|
| vitest 全量 | 8587 过、1 失败（旧产物，见第一节）、31 跳过 | 720 秒（12 分钟，本机同时有别的测试在跑） |
| Deno tests/shared | 687 过 | 11 秒 |
| pgTAP 离线 ＋ 真库 | 各 1696 条全过 | 13 秒 ＋ 14 秒 |
| store-it 真库 | 33 条全过 | 61 秒 |
| e2e 真后端组 | 17 条全过 | 26 秒（另 e2e:real:up 41 秒） |
| e2e 无后端组 | 332 过、0 失败、38 跳过（两浏览器 370 条） | 4.5 分钟（含构建） |
| check_backend | 0 错误 | 几秒 |
| **合计（机器时间）** | | 约 20 分钟（vitest 占 12 分钟） |

人工冒烟（17.2 节 B2 起的两项）：TC-B2-25 Edge 安装版 resolve（10 分钟）、人工复核 CI 截图差异（20～40 分钟）——前者没做，列第五节；后者属外观，移到最后（R-376）。

### 3.3 首屏体积和冷启动

| 项 | 数字 | 出处 |
|---|---|---|
| 首屏 JS（gzip） | **112.2 KB / 预算 150 KB**（7 个文件） | 11-11 本机 `npm run build -- --mode e2e` 内置的 `build/check_size.mjs` |
| 首屏净增（当前批次 B4 额度） | 247 B / 1024 B（基线 112922 B） | 同上 |
| 全部 JS（gzip） | 512.7 KB（参考 250 KB，只提示；DISABLED-probe-later ③ 定 B2 起按真实页面验收，硬线只有首屏 150 KB） | 同上 |
| 冷启动 5 次（2.6 硬验收） | **待真机**（P2-08，真机单 3-5）。本机 Chromium 量出来的数不代表 iPhone 主屏幕版，不填 | — |

## 四、缺口清单（确实没有自动化测试的，只列不补）

| 编号 | 用例 | 缺什么 | 卡不卡签字 |
|---|---|---|---|
| G-01 | TC-B2-01 | 四种类型（全天、有时刻、有截止日、无日期）新建 / 编辑 / 完成 / 删除、刷新后保持、另一端同步的 E2E；`b1-sync.spec.ts:20、24` 还是 `test.fixme`（接手清单 K8-e2e） | 卡（★ 冒烟、功能主路径） |
| G-02 | TC-B2-14 | 设置里切换节假日国家后月历立即变化 | 不卡（组件已测拉取） |
| G-03 | TC-B2-17 | 从推送链接打开某天、再按返回回到原页（R-372 后期望也要按层级返回重写） | 卡（★） |
| G-04 | TC-B2-73 | 库约束 24:00、17:60、-1 被拒（`22_text_constraints` 只测了 remind_time）；remind_queue 按新时刻重写；各白名单逐项 | 卡（★） |
| G-05 | TC-B2-75 | 真旧版本客户端对 due_time 的端到端读写（现在只有通用新列测试） | 不卡（通用规则已测），建议补 |
| G-06 | TC-B2-77 | Y 端收到墓碑后取消本机通知（`remind-data.test.ts:151` 断言的是 false，不是关掉通知） | 卡（★） |
| G-07 | TC-B2-83 | “A 打开 App 看到错过的提醒”E2E（函数级和前端 `missed()` 已测） | 不卡 |
| G-08 | TC-B2-68（P0） | 带别的密钥（OPS_SECRET、BACKUP_PULL_TOKEN）当 cron 密钥被拒的单测；`/sb` 日志里没有头的值；前三种头时第 0 步不跑 | **卡（P0）**，或由安全审查员在 S-B2 里认可现有覆盖 |
| G-09 | TC-B2-32 | 重复事项横幅“每条只显示第一次” | 不卡 |
| G-10 | TC-B2-56 | axe 扫描（全仓没有 axe / AxeBuilder） | 卡（★）；或主持人定挪到 B7a 无障碍全检 |
| G-11 | TC-B2-58 | 懒加载 chunk 全在预缓存里、旧 chunk 不 404 的直接断言 | 卡（★） |
| G-12 | TC-B2-59 | 键盘弹起时输入框不被挡（visualViewport） | 不卡（真机 P2 系列顺带看） |

用例本身要改的（不是缺测试）：TC-B2-15（返回改按 R-372）、TC-B2-34～39（副本层 11-06 取消，36～38 无测试对象）、TC-B2-41（自动深浅已取消）、TC-B2-44（期望 1.16 倍，实现和测试是 1.12，要定以哪个为准）、TC-B2-46、47（R-373 删除）、TC-B2-65（源码里搜不到“跟随系统”设置项，要确认功能在哪批）。都属外观或已删功能，不卡签字，交 QA 改用例表。

## 五、真机 / 未决（负责人和主持人）

### 5.1 问题台账（[问题台账](../../00-团队/问题台账.md)，11-11 状态）

| 编号 | 问题 | 台账状态 | 对签字 |
|---|---|---|---|
| Q-1 | 缩放（负责人要禁掉 App 内页面缩放） | 修复中，preview.256 里没有，未验证 | **卡：没关前 B2 不签** |
| Q-2 | 启动时底部灰条 | 定根因中（02b290cf 按猜测修，真机无效） | **卡：没关前 B2 不签** |
| Q-3 | 日历翻月整页上下跳 | 定根因中 | **卡：没关前 B2 不签** |
| Q-4 | 键盘收起后底栏升高 | 定根因中 | 未决，等主持人定归不归 B2 |
| Q-5 | 语音识别慢、句首被吃 | 句首根因已定 / 慢定根因中 | B3 的事，不卡 B2 |
| Q-6 | 录音时被踢出登录（R-382） | 修复中（控制台容忍已改 60 秒，客户端未做） | 未决，等主持人定；登录会话属功能 |

### 5.2 要负责人真机做的（只算功能项，移到最后的不列）

| 编号 | 内容 | 约用时 |
|---|---|---|
| 2-1 | R-371 Gap fix 改默认开后冷启动复测底栏位置 | 5 分钟 |
| 2-5 | 输入框不放大（G11 前半） | 2 分钟 |
| 2-6 | 月历左右滑翻页、上拖收起、选年月（和 Q-3 一起看） | 3 分钟 |
| 2-8 | 切页时点按被吞（UI4-B1-C2）、键盘会不会弹 | 3 分钟 |
| 2-10 | P2-19 免打扰时刻框能点、≥ 44pt | 2 分钟 |
| 2-12 | 编辑页下拉、没有 CSP 报错（电脑） | 2 分钟 |
| 2-13 | 被系统收回后点“‹ 返回”不退出 App | 3 分钟 |
| 2-14 | 冷启动后出“有新版本 · 重新打开”横幅（下次部署顺带） | 2 分钟 |
| P2-04 | 时区（3-1） | 5 分钟 |
| P2-05 | 已送到的通知能收回（3-2） | 5 分钟 |
| P2-06 | 没网时新建提醒（3-3） | 5 分钟 |
| P2-07 | 手机时间不准（3-4） | 5 分钟 |
| P2-08 | 冷启动 5 次（3-5，2.6 硬验收，填 3.3 节） | 5 分钟 |
| P2-12 | 主屏幕版更新流程（3-9，要主持人配合部署一版） | 5 分钟 |
| P2-13 | 月历、周视图滑动和边缘返回不打架（3-10） | 5 分钟 |
| P2-14 | VoiceOver 抽查（3-11） | 10 分钟 |
| P2-15 | B1 真机项再看一眼（3-12） | 5 分钟 |
| 3-13 | 说一句“这批可以” | 1 分钟 |
| **合计** | | **约 73 分钟** |

另：TC-B2-25 Edge 安装版 resolve 人工冒烟 10 分钟、TC-B2-78 Edge / exe 文案各看一次、TC-B6X-11 exe 通知点开整页提醒（随批补测，结果写 `docs/03-评审/B6-exe/B6-exe-随批补测.md`）——电脑上做，QA 可以做，没在本次做。

已过的真机项（不用再做）：P2-01、P2-02（11-10，按明早待确认原话 11-11 补记进推送实测记录）、P2-17、P2-18、真机单 1-1、1-2、G10 launch 那一行。

### 5.3 ④ 这一环还没交的

- `B2-预览环境验收清单.md`：文件不存在，没做。
- 任务单第六节（B1 接手清单）各行的关闭情况：本次没逐行核，签字前要补。
- CI：本机没有 gh，main 最新一次 CI 结果没核；签字前主持人贴一次 CI 链接或截图。

## 六、结论

- 自动化：除 1 条旧产物环境失败外全过；D3 第 6 点三条、首屏体积都有数字。
- **现在不能签**。签字前要：① Q-1、Q-2、Q-3 关闭；② 第五节 5.2 真机项做完（约 73 分钟）、P2-08 冷启动数字填进 3.3；③ 缺口里标“卡”的 G-01、G-03、G-04、G-06、G-08、G-10、G-11 补测试，或主持人逐条定挪批；④ 5.3 三件补齐。

## 签字

| 角色 | 签字 | 日期 |
|---|---|---|
| QA | （待：第六节条件满足后签） | |

## 修改记录

- 2026-11-06：QA 第一版草稿，回填本机能跑的自动化部分（vitest 1023 条、check_backend）；e2e、pgTAP、Deno、CI、真机都标待测。
- 2026-11-11：QA 改成签字版待签：TC-B2-01～90 逐条按内容对上测试（不靠编号）；跑 vitest 全量、Deno、pgTAP（离线＋lemo-e2e 真库）、store-it、e2e 真后端组和无后端组；填 D3 第 6 点三条、冒烟用时、首屏体积；按 R-376 把外观、动效项标“移到最后”；列缺口清单 G-01～G-12；列问题台账 Q-1～Q-6，Q-1～Q-3 没关前不签。
