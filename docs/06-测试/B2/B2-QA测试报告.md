# B2 QA 测试报告（草稿）

- 日期：2026-11-06　作者：QA
- 状态：**草稿，未签字**。本版只回填已经自动化、本机能跑的部分；e2e、pgTAP、真机都还没跑。功能收尾后出签字版。
- 用例来源：[测试用例 v4](../测试用例-v4.md) 第 18 节 B2（TC-B2-01～90、TC-DEL-remind_queue）。
- 负责人真机部分：见 [B2-负责人真机单](B2-负责人真机单.md)，结果回来后填第四节。

## 一、这次怎么跑的

| 项 | 内容 |
|---|---|
| 代码 | 主仓工作区：HEAD 7e197ea，**另有约 46 个未提交改动**（底栏恢复透明、表单三修、G10 那一批，以及 `tests/edge/push-dispatch-d3-full.test.ts` 等未跟踪文件）。下面结果是工作区的结果，不等于 7e197ea 的结果 |
| 跑了什么 | ① vitest 单元、组件、node 组：29 个文件（按用例编号能找到的测试文件），796 条全过；② vitest 推送函数组（`tests/edge/push*`、`tests/build/push-service-fake`、`push-vectors-sync`，假数据库加本机替身）：22 个文件，227 条全过；③ `python build/check_backend.py`：0 个错误 |
| 没跑 | Playwright e2e（本批规则不跑、不起服务）；pgTAP（`supabase test db`，要本机数据库）；Deno 测试（`deno task test`）；CI（本机没有 gh，看不到 main 最近一次 CI 结果） |
| 冒烟回归实际用时、首屏体积 | **待测**（要跑全量冒烟和构建；剩余清单 FA-6 说 FA-7 之后首屏余量只剩约 96 字节～2 KB，要重新量） |

结果口径：**通过（本机）**＝本次在本机跑过、全过；**部分**＝用例里一部分自动化跑过，其余待测；**待测**＝这次没跑，或没找到带编号的自动化测试（可能有没标编号的 e2e，签字版前逐条核对）；**真机**＝靠负责人真机单。

## 二、逐条结果

| 用例 | 简述 | 自动化在哪（最近提交） | 结果 |
|---|---|---|---|
| TC-B2-01 | 新建、编辑、完成、删除日程和待办 | `src/features/todos/__tests__/TodoEditPage.test.tsx`（017a13d，工作区有改动） | 部分：组件测试通过（本机）；E2E 待测 |
| TC-B2-02 | 地点、链接只认 https | `src/features/calendar/__tests__/EventEditPage.test.tsx`（d87b1d5） | 通过（本机） |
| TC-B2-03 | 删除撤销、最近删除恢复、30 天 | 只在源码注释里找到编号 | 待测 |
| TC-B2-04 | REST 直接 DELETE 被拦 | 没找到 | 待测 |
| TC-B2-05 | 今天页四套皮肤截图比对 | 没找到 | 待测（含人工复核） |
| TC-B2-06 | 字重计算样式 | 只在源码注释里找到编号 | 待测 |
| TC-B2-07 | 截图和计算样式 | 没找到 | 待测 |
| TC-B2-08 | buildMonth 单元 | `tests/shared/calendar/month-grid.test.ts`（a2ad59c） | 通过（本机） |
| TC-B2-09 | buildWeek 单元 | `tests/shared/calendar/week-view.test.ts`（a2ad59c） | 通过（本机） |
| TC-B2-10 | itemShort / projectShort | `tests/shared/short.test.ts`（4548a9c） | 通过（本机） |
| TC-B2-11 | short_by 改标题 | `tests/shared/short.test.ts`（4548a9c） | 通过（本机） |
| TC-B2-12 | holidayCountries | `tests/shared/calendar/holidays.test.ts`（4548a9c） | 通过（本机） |
| TC-B2-13 | 日历路由、年月选择器跳转 | `cal-route.test.ts`、`CalendarPage.test.tsx`、`tests/shared/calendar/cal-nav.test.ts`（5e0eaf2） | 通过（本机） |
| TC-B2-14 | 节假日切换（E2E） | 没找到 | 待测 |
| TC-B2-15 | 翻月翻周、返回（E2E） | 没找到带编号的；疑似 `b2-cal-*.spec.ts` | 待测 |
| TC-B2-16 | 年月选择器键盘 | 没找到 | 待测 |
| TC-B2-17 | 输入框焦点时方向键、推送链接返回 | 没找到 | 待测 |
| TC-B2-18 | 周视图截图 | 没找到 | 待测 |
| TC-B2-19 | 周视图计算样式 | 没找到 | 待测 |
| TC-B2-87 | 农历 2026～2100 各月 | `tests/shared/anniv/lunar.test.ts`（b13882b） | 部分：单元通过（本机）；组件部分待核对 |
| TC-B2-20 | 固定、浮动跨时区 | 没找到 | 待测（真机部分见真机单 3-1） |
| TC-B2-21 | 待办提醒时刻、免打扰 | `tests/shared/remind-actions.test.ts`（5e0eaf2） | 通过（本机） |
| TC-B2-22 | 录音中、键盘弹起时提醒排队 | `RemindHost.test.tsx`（3fc3379）、`remind-queue.test.tsx`（5e0eaf2） | 通过（本机） |
| TC-B2-23 | 推送到点、410、重复、免打扰 | 没找到带编号的；`tests/edge/push-dispatch*` 可能覆盖 | 待测（待核对） |
| TC-B2-24 | 日志不写标题 | 没找到带编号的 | 待测 |
| TC-B2-25 | 两台设备 resolve 收起 | — | 待测（Win 人工 10 分钟；iPhone 部分见真机单 3-2） |
| TC-B2-70 | 通知上“推迟”、点通知本身 | 没找到 | 待测 |
| TC-B2-71 | 重新登录、推送提示、移除 | `remind-data.test.ts`（3fc3379）、`RemindSettings.test.tsx`（29efd32） | 通过（本机） |
| TC-B2-72 | due_time 提前量 | `tests/shared/remind.test.ts`（54eb424） | 通过（本机） |
| TC-B2-73 | REST 写 todos 约束 | 没找到 | 待测（pgTAP） |
| TC-B2-74 | 编辑页截止时刻、提前提醒 | `todo-edit.test.ts`（017a13d）、`TodoEditPage.test.tsx` | 通过（本机） |
| TC-B2-75 | 旧版读写 due_time | 没找到 | 待测 |
| TC-B2-76 | 旧版清截止日期 | 没找到 | 待测 |
| TC-B2-77 | 永久删除后不推 | 没找到 | 待测 |
| TC-B2-78 | 服务器推送和本机通知文案 | `remind-data.test.ts`（3fc3379） | 部分：本机通知部分通过（本机）；Edge、exe、iPhone 各一次待测 |
| TC-B2-79 | claim_endpoint 权限 | `supabase/tests/rls/28_claim_endpoint.test.sql`（12ba238） | 待测（pgTAP 没跑） |
| TC-B2-80 | 端点规范串、替身重定向 | vitest：`tests/shared/push/push-endpoint.test.ts`、`tests/build/push-*`、`tests/edge/push-dispatch.test.ts`、`push-test.test.ts`；pgTAP：`28_claim_endpoint`、`29_push_endpoint_vectors` | 部分：vitest 部分通过（本机）；pgTAP 待测 |
| TC-B2-81 | 300 条、预算 | `tests/edge/push-dispatch-budget.test.ts`、`push-dispatch-d3-full.test.ts`（**未提交**） | 通过（本机，含未提交文件）；提交后以 CI 为准 |
| TC-B2-82 | 两轮重叠只发一次 | `tests/edge/push-dispatch-d3-full.test.ts`（**未提交**）、`push-dispatch-round-d3.test.ts` | 通过（本机，含未提交文件）；提交后以 CI 为准 |
| TC-B2-83 | 认领后抛错 | `tests/edge/push-dispatch-d3-full.test.ts`（**未提交**） | 部分：函数部分通过（本机，含未提交文件）；组件部分待核对 |
| TC-B2-84 | 会话吊销后认领 | 没找到带编号的 | 待测（pgTAP） |
| TC-B2-85 | push-test 限次、只回枚举 | `tests/edge/push-test.test.ts` 可能覆盖，没有编号 | 待测（待核对）；真机冒烟见真机单 1-2 |
| TC-B2-86 | usage-report 只认 x-ops-secret | `build/check_backend.py` 样例 | 部分：check_backend 0 错误（本机）；函数测试待测 |
| TC-B2-88 | Web Push 自实现 C-1～C-10 | `tests/edge/push-dispatch.test.ts`（3ff0410） | 部分：函数测试通过（本机）；Deno 单测待测 |
| TC-B2-89 | 队列租约崩溃回收 | 没找到带编号的；`push-dispatch-lease*.test.ts` 可能覆盖 | 待测（待核对；pgTAP 没跑） |
| TC-B2-90 | fn_ai 队列权限 | 没找到带编号的 | 待测（pgTAP、D1） |
| TC-B2-26 | 错过提醒 | `reminder-model.test.ts`、`RemindHost.test.tsx`（3fc3379） | 通过（本机）；真机见真机单 2-11 |
| TC-B2-27 | 低版本免查两条（P0） | `tests/functions/version-gate-b2.test.ts`（12ba238） | 通过（本机）；剩余清单要求进冒烟集，待核对 |
| TC-B2-28 | 首屏 JS ≤ 150 KB | `tests/e2e/b2-first-screen-budget.spec.ts`（没跑） | 待测（FA-7 之后要重新量） |
| TC-B2-29 | 新建后本机、同步 patch | `reminder-model.test.ts`（3fc3379） | 通过（本机） |
| TC-B2-64 | 推送文案按来源 | `remind-data.test.ts`（3fc3379） | 通过（本机） |
| TC-B2-65 | 跟随系统、浅色、深色 | 没找到 | 待测 |
| TC-B2-66 | 未来 7 天提醒 | `remind-all-day.test.ts`、`reminder-model.test.ts`（3fc3379） | 通过（本机） |
| TC-B2-67 | 图标、待办、月历截图 | 没找到 | 待测（含人工复核） |
| TC-B2-68 | ops 密钥头（P0） | 没找到带编号的 | 待测 |
| TC-B2-69 | 离线新建“未同步”标记 | `cal-unsynced.test.tsx`、`todos-remind-mark.test.tsx`、`RemindHost.test.tsx`（3fc3379） | 通过（本机）；真机见真机单 3-3 |
| TC-B2-63 | 全天、固定时区提醒时刻 | `tests/shared/remind-all-day.test.ts`（54eb424） | 通过（本机） |
| TC-B2-30 | iPhone 推送 | — | 真机（真机单第一段、3-1～3-4） |
| TC-B2-31 | 只读行：行尾、点击、打勾、左滑、多选 | 没找到 | 待测（剩余清单：功能还没做完） |
| TC-B2-32 | 重复事项横幅 | 没找到 | 待测（同上） |
| TC-B2-33 | 横幅“更新” | 没找到 | 待测 |
| TC-B2-34～39 | 液态玻璃副本（6 条） | 没找到带编号的 | 待测（副本层 11-06 已改为直接模糊，期望要先和 QA 用例表核对） |
| TC-B2-40～44 | 液态玻璃停止、遮挡、页签、液滴（5 条） | 没找到带编号的；疑似 `b2-tabbar*.spec.ts` | 待测 |
| TC-B2-45 | 倾斜做法 ① | — | 不执行（P1-05 实测“记不住”，用做法 ②） |
| TC-B2-46 | 倾斜做法 ② | 疑似 `b2-tilt.spec.ts`，没编号 | 待测；真机见真机单 2-9、3-8 |
| TC-B2-47 | 倾斜拒绝、读不到 | 没找到 | 待测 |
| TC-B2-48 | 对比度：柔光当底色 | `build/contrast-pairs.json` 配对 | 待测（这次没单跑 check_contrast） |
| TC-B2-60 | 对比度：--g-fg 对叠色 | `tests/build/check-contrast.test.ts`（69659c1） | 通过（本机）；8 项不达标按负责人 11-06 决定列为例外 |
| TC-B2-61 | 三种最坏背景截图 | — | 待测（自动截图）；负责人观感部分 11-06 挪到 B2-UI-b，不在这次真机单 |
| TC-B2-49 | 减少透明效果 | 没找到 | 待测（排查记录说设置里的开关还没做） |
| TC-B2-50 | 弹层遮罩、切页名字 | 没找到 | 待测 |
| TC-B2-51 | 流畅度 | — | 真机（真机单 3-6） |
| TC-B2-62 | 左滑按钮对比度 | `build/contrast-pairs.json` 配对 | 待测 |
| TC-B2-52 | 四套皮肤截图 | 没找到 | 待测（含人工复核） |
| TC-B2-53 | 提示条对比度 | `build/contrast-pairs.json` 配对 | 待测 |
| TC-B2-54 | 最差背景对比度 | `build/contrast-pairs.json` 配对 | 待测 |
| TC-B2-55 | 动效（勾选、弹层、列表、按钮条、翻页） | 疑似 `b2-motion-list.spec.ts`，没编号 | 待测；录屏给 ②b，真机见真机单 2-6、2-7 |
| TC-B2-56 | 键盘、axe | 没找到 | 待测 |
| TC-B2-57 | 主屏幕版更新 | `src/platform/__tests__/sw-register.test.ts`（用例表记载，这次没跑） | 待测；真机见真机单 3-9 |
| TC-B2-58 | 重新打开、断网从 SW 打开 | 没找到 | 待测 |
| TC-B2-59 | 各档布局、键盘 visualViewport | 没找到 | 待测 |
| TC-DEL-remind_queue | 注销清单、孤儿删除（P0） | `tests/data-manifest/generate.test.ts`（0fe531a）；pgTAP `30_remind_queue_pop.test.sql`（2b65b43） | 部分：清单生成部分通过（本机）；pgTAP 待测 |

小计（91 条）：通过（本机）22 条；部分 8 条；真机 2 条（TC-B2-30、51）；不执行 1 条（TC-B2-45）；其余 58 条待测。

## 三、已知要跟进的

1. `tests/edge/push-dispatch-d3-full.test.ts` 还没提交，TC-B2-81～83 的结果要等它进 main、CI 绿了再算正式。
2. TC-B2-31～33（只读行界面）剩余清单说代码里还没找到，功能做完后再测。
3. TC-B2-34～39 是按“副本层”写的期望；11-06 排查记录第 0 节改成了直接模糊背后画面，用例期望要先核对再执行。
4. 带“没找到”的，签字版前逐条对一遍 `tests/e2e/b2-*.spec.ts`，补上编号或补测试。
5. 冒烟回归实际用时、首屏体积、冷启动 5 次（P2-08）还没有数字。

## 四、真机结果（负责人真机单回来后填）

| 段 | 日期 | 结果 | 备注 |
|---|---|---|---|
| 第一段：推送（1 小时） | | 待测 | 记录表同步到 `../B2-推送实测记录.md` |
| 第二段：FA-7 之后的真机项（20～30 分钟） | | 待测 | G10 的 `launch:` 两张截图交前端 B |
| 第三段：最后验收（1.5 小时） | | 待测 | 负责人说“这批可以”后填 |

## 修改记录

- 2026-11-06：QA 第一版草稿，回填本机能跑的自动化部分（vitest 1023 条、check_backend）；e2e、pgTAP、Deno、CI、真机都标待测。
