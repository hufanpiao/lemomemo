# B2 代码审查：前端 A 的 FA-3（月历、周视图、接入农历、设置 › 日历二级页）

- 日期：2026-11-04
- 审查人：独立代码审查员（只读，默认不通过）
- 对象：工作区未提交改动——`src/features/calendar/` 新文件（data/cal-data.ts、cal-route.ts、cal-settings.ts；hooks/useCalendar.ts、useCalViewT.ts、useHolidays.ts、useLunar.ts、useCalSettings.ts；i18n/view-zh.ts、view-ko.ts；ui/MonthGrid.tsx、WeekView.tsx、MonthPicker.tsx、cal-ui.ts、CalendarPage.module.css、CalendarSettings.tsx/.module.css、CalendarSettingsEntry.tsx；对应 __tests__）；改动的 calendar/index.ts、ui/CalendarPage.tsx、app/router.ts（及测试）、motion/index.ts、swipe-pager.ts（及测试）、platform/app-static.ts（及测试）、settings/ui/SettingsPage.tsx、i18n/zh.ts、ko.ts（及测试）
- 对照：需求 R-97、R-318～R-321；架构 5.4、5.12、2.3 规则表；B2 任务单 FA-3 行（第 162 行）

## 结论：不通过，7 / 10

代码质量本身不错：分层清楚（data 纯 TS、hooks 接 React 和数据层、ui 只画），农历只经 `import()` 懒加载（check_arch 的 LUNAR 规则通过，`import type` 编译后擦掉），设置读写和 `core/ai-settings.ts` 同一写法，节假日三选一的推导（没存过跟界面语言、存过固定）正确，路由规整用 replace、翻页用 push，跨月跨年和周起始日的边界有测试。三时区单测全绿、tsc / eslint / stylelint / check_arch 0 错误。

不通过的原因是**架构 5.12 写明的几项没做或做法不一样，且没有在代码或交付说明里标成“下一段”或报负责人**（键盘翻页、年月选择器、离线提示、两国节日第二行、R-104 的 9.5 px），另有两个实际 bug（周视图量宽在翻周后失效、节假日拉失败后整个会话不再重拉）。

### 运行结果
- `npx vitest run src/features/calendar src/motion src/platform/__tests__/app-static.test.ts src/app/__tests__/router.test.ts src/features/settings`：Asia/Seoul、America/Los_Angeles、Pacific/Kiritimati 三个时区（PowerShell `$env:TZ`）各 42 个文件、465 条全部通过
- `tsc -p tsconfig.app.json`：0 错误；`eslint`（相关目录）：0；`stylelint`（calendar css）：0
- `check_arch`：0 错误、1 警告（W2：cn/2027.json 还是 pending，属后端，预期内）

## 和需求、架构不一致的地方（放最前面）

1. **键盘 ← → 翻页没做**（架构 5.12 第 3 点“电脑版：键盘 ← → 翻页……停下 500 ms 后才记一条历史”）：`CalendarPage.tsx` 没有任何 keydown 处理。
2. **年月选择器不是架构定的做法**（5.12 第 3 点：Radix Popover、年左右切换 + 12 个月格子、方向键移动、回车选中、Esc 关闭、当前年月高亮、今天所在月加小点）：`MonthPicker.tsx` 第 11～45 行是两个原生下拉框 + 确定 / 取消；没有 Esc、打开时焦点不进选择器、关掉后焦点不回标题，标题按钮（`CalendarPage.tsx` 第 28 行）有 `aria-expanded` 但没有 `aria-controls`。
3. **离线时“联网后显示节假日”的提示没做**（5.12 第 1 点）。
4. **两国都显示时只显示一个节日名**（5.12 第 1 点要求另一国用小号第二行）：`MonthGrid.tsx` 第 33、40～43 行只取 `holidays[0]`。读屏里两个都有。
5. **事件标签字号是 10.5 px，不是 R-104 定的 9.5 px**：`CalendarPage.module.css` 第 196、204 行（`.mark`、`.more`）用 `--fs-10-5`；架构 5.12 第 2 点写明 9.5 px 是负责人的有意例外、“不要改”。没找到改成 10.5 的依据（若是视觉稿定的，要在代码注释里写出处）。
6. **电脑排布的周视图、跟手滑动没做**：`WeekView.tsx` 第 6 行、`swipe-pager.ts` 第 6 行自己写了“放下一段”。FA-3 的任务单和 5.12 都包含这两项（电脑纵向时间轴并排分列；“滑动时格子跟手移动”）。可以分段做，但要在任务单 / 交付说明里登记，不然这一段会被当成 FA-3 已完成。
7. **滑动阈值和架构数字不一致**：架构是“横向位移超过 60 px；左边缘 20 px 内不处理”；`swipe-pager.ts` 第 9～12 行是两侧边缘 24 px、`min(56 px, 宽度 20%)`。数字可以按手感改，但要回填架构或注明理由。
8. 周视图细节和 5.12 / 0.51 不一致（低）：全天事项应是一个“全天 N”小标签（N=1 写简称），实现是每件一个小签；没有“当天共几项 / 逾”；待办没按 `due_time` 画在时刻上（`cal-data.ts` 的 `todoOf` 没取 `due_time`，`CalTodo` 类型也没有，需前端 B 的纯逻辑一起补）；纪念日在月格里是圆点（`.anniv` 用 `--r-pill`），架构 / R-77 是菱形。

## 问题清单

### 高
无。

### 中

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| M1 | `ui/WeekView.tsx` 第 23～37 行 `useTrackWidth`、第 171 行 | `useEffect(..., [])` 只在第一次挂载时给第一行的轨道挂 ResizeObserver。翻到上一周 / 下一周时七行的 key（日期）全变，第一行是新的 DOM 元素，但观察器还挂在已经卸掉的旧元素上：**翻过周以后再转屏、改窗口宽度，色块不会重排**（位置、宽度按旧宽度算）。 | 用回调 ref（ref 变了就重新 observe），或者把量宽放到不随周变化的外层容器（`<ol>`）上；补一条测试：翻周后触发 resize，`dayPx` 跟着变。 |
| M2 | `hooks/useHolidays.ts` 第 36～48 行 | `fetchAppJson` 失败（离线、超时）返回 null，`parseHolidayFile(null)` 也是 null，**被当成“这一年没有节假日”写进模块缓存**，整个会话不再重拉。iPhone 上 PWA 常驻几天不重载，开机那一下离线，节假日就一直不显示。同时 5.12 要求的“联网后显示节假日”提示也没有（见上文第 3 条）。 | 区分“拿到了、确实没有 / pending”和“没拿到”：后者不写缓存（或带过期时间），`online` 事件或下次进页面再拉；没拿到时给页面一个状态，显示提示。`fetchAppJson` 要能区分 404 和网络错误。 |
| M3 | `ui/CalendarPage.tsx` 全文 | 键盘 ← → 翻页没做（见上文第 1 条），且电脑上只有 ‹ › 两个按钮。 | 按 5.12 补：焦点在输入框、弹层、选择器打开时不生效；连按合并成一次 push（500 ms）；登记到“?”说明。 |
| M4 | `ui/MonthPicker.tsx` 第 11～45 行、`ui/CalendarPage.tsx` 第 28、53～62 行 | 年月选择器做法和无障碍（见上文第 2 条）：没有 Esc、焦点不进不回；弹出不是 Popover（不浮在上面，把正文往下推）。 | 按 5.12 改成 Radix Popover（`<Appear kind="popover">`）+ 年切换 + 12 月格子；或者先报负责人同意“下拉框版本”再保留，同时至少补 Esc 关闭、焦点进出、`aria-controls`。 |
| M5 | `ui/CalendarPage.module.css` 第 196、204 行 | 标签字号 10.5 px，和 R-104 的 9.5 px 不一致（见上文第 5 条）。 | 改回 `--fs-9-5`；或拿出视觉稿依据、报负责人。 |
| M6 | `ui/MonthGrid.tsx` 第 33、40～43 行 | “两国都显示”只画第一个节日名（见上文第 4 条）。 | 有第二个时用小号第二行（放不下省略），补测试。 |
| M7 | `app/App.tsx` 第 54 行（既有）× `features/calendar/index.ts` 新增的 `cal` 路由 | 底栏的 `#/calendar` 和 `#/cal/...` 是两个路由名、两个 `lazy()`，`ErrorBoundary key={route.name}`：**从 `#/calendar` 第一次点 ‹ / › / 今天 / 切周，整页卸载重挂**，键盘焦点掉到 body（读屏用户点完“下个月”不知道焦点去哪了），也会起一次整页 View Transition。之后在 `cal` 里翻页不会。 | `#/calendar` 进来时直接 `replaceRoute('cal','month',本月)`，或者两个路由共用同一个 lazy 组件并让 ErrorBoundary 对这两个名字用同一个 key；补一条测试：从 `#/calendar` 点“下个月”后焦点仍在按钮上。 |

### 低

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| L1 | `ui/CalendarPage.tsx` 第 45 行 | “今天”按钮在本月 / 本周时用 `disabled`：键盘用户按了“今天”，按钮立刻变成 disabled，焦点丢失；读屏按 Tab 也找不到它。 | 用 `aria-disabled="true"` + 点击无动作，样式照灰。 |
| L2 | `data/cal-route.ts` 第 84～87 行、`shared/logic/calendar/cal-nav.ts` `resolveWeekParam` | 周起始设周日时，周视图选 1900 年 1 月：`weekOfPickedMonth` 给 1899-12-31，地址写成 `#/cal/week/1899-12-31`，再解析时年份超范围，被规整回**本周**。同理 1900-01-01 所在那周到不了。 | 年份校验按“这一周有没有一天在范围内”判断，或者把 1900 年第一周钳到范围内；补边界测试。 |
| L3 | `ui/CalendarPage.tsx` 第 42、48 行 | 到了 1900-01 / 2100-12，‹ › 仍可点但没反应（`shiftView` 返回 null）。 | 到边界时 `aria-disabled`。 |
| L4 | `hooks/useCalendar.ts` 第 80、84～89 行 | “今天”所在周和地址规整依赖 `cal.week_start`。新设备首次登录、settings 还没同步下来时按默认周起始规整了地址（replace），同步下来以后再按新值规整一次——推送 / 搜索带来的 `#/cal/week/<周日>` 可能被规整到错的那一周（周一起始先规整到上一周的周一，再规整到那个周一前的周日）。 | 规整只在“参数非法”时 replace，合法但不是第一天的保持原样、只在内部换算；或等 settings 首次同步完再规整。 |
| L5 | `ui/CalendarSettings.tsx` 第 39 行 | 没选过时，亮着的那个单选（跟界面语言）再点一次不会触发 onChange，**无法把“只显示中国”固定下来**；而“每周第一天”点亮着的那个会写入。两项行为不一致，R-97“选过一次就固定”对节假日只能先选别的再选回来。 | 用 onClick 也触发保存，或在说明里讲清楚。 |
| L6 | `hooks/useCalSettings.ts` 第 32～40 行 | 连点两下不同选项（本机还没出现第一条 insert 的行），第二下仍按“没有这一行”再 insert，撞 `(user_id,key)` 唯一约束进“发送失败”。文件头只写了“服务器已有行”的情况。 | 保存进行中时禁用或排队，或按 key 记住刚 insert 的 id。 |
| L7 | `hooks/useLunar.ts` 第 47～61 行 | 韩文界面也会下载农历 chunk（R-318：韩文不显示农历、节气），白下载。现在靠 `'kr'` 没有数据返回空来“不显示”，B5 韩国数据进来后韩文界面会自动显示，和 R-321“韩文界面不显示”是否一致要提前定。 | 韩文界面不加载、不传 dayInfo；或在注释里写明“韩国数据进来后自动显示”是有意的。 |
| L8 | `motion/swipe-pager.ts` | 只测了纯函数，`useSwipePager` 的状态机（pointerId 不一致、竖向锁定后不翻、cancel、mouse 忽略）没测；滑动结束是否会同时触发格子的 click（翻页 + 跳周视图）要真机确认。 | 补 hook 测试（fireEvent.pointerDown/Move/Up）；真机试一次。 |
| L9 | `hooks/useHolidays.ts` 第 29～34 行 | `wantsOf` 靠“`holidayFetchPaths` 先国家后年份”的下标对齐，纯逻辑改顺序或去重就会错位。 | 直接自己拼 `{country, year}` 再调一个按单对生成路径的函数，或让纯逻辑返回带 country/year 的对象。 |
| L10 | `i18n/view-zh.ts`、`view-ko.ts` | `cal.allDayCount` 没用到；`satisfies` 只保证键一致，占位符一致没有测试（架构第 2 节“占位符也要一致”）；韩文 `holNote`、`saveFailed` 是 합쇼체，设置页其余文案是 해요체，语气不统一（REVIEW(ko) 时一并改）；`cal.weekGrid` 读屏会读出“2026-11-02 起的一周”（ISO 日期）。 | 删未用键；补一条两本词典逐键比对占位符的测试；读屏日期用 `cal.a11y.date` 的写法。 |
| L11 | `ui/MonthGrid.tsx` 第 14～27 行 | 读屏名字没有星期几（表头是 aria-hidden），也没有总件数和“另有 N 件未显示”（5.12 无障碍的示例句）。 | 加星期几和总数。 |
| L12 | `ui/WeekView.tsx` 第 86～94 行 | 全天日程小签没有项目色（待办小签有）。 | 加 `colorClass`。 |

## 测试覆盖
已覆盖：月格 42 格与周起始、标签上限与 +N、读屏按项目汇总、删除不算、节假日拉不到不报错、补班、上一页 / 下一页与非法参数 replace、年月选择（月视图）、点格进周视图、周日起始、三选一只拉需要的国家、周视图规整与色块、月 ↔ 周切换（cal-route 单测）、跨年翻页、1900～2100 边界（月）、农历加载前后 / 失败 / 韩文 / 范围外、初一和节气、设置二级页的进出与返回（push / 直接打开 replace / history.back）、韩文摘要不写음력、无农历开关。

缺：周视图翻周后改宽度（M1）；节假日失败后恢复（M2）；从 `#/calendar` 翻页后的焦点（M7）；周视图下的年月选择（R-101，cal-route 有单测、页面没有）；跨午夜“今天”变化（`useMinuteNow`）；两国都显示时格子里的两个名字；闰月在格子和读屏里的写法；1900 年第一周（L2）；`useSwipePager` 状态机（L8）；词典占位符一致（L10）。

## 和既有写法一致性
- 设置读写、软删恢复和 `core/ai-settings.ts` 一致；二级页的 push / replace 返回和注销页共用一套（`pushedSub`），顶栏共用 `.top`，焦点进标题，好。
- 跨功能只经 `calendar/index.ts`（A1），index 只导出 lazy（A27）；`fetch` 只在 platform（A12）；滑动放在 `src/motion/`（A25）；颜色只用变量（A11）；查表用 switch（F7）。都符合。

## 通过条件
M1～M7 修完（M3～M6 若负责人同意分段或改做法，需在任务单 FA-3 和交付说明里登记，并回填架构 5.12），补上“测试覆盖”里列的缺口中 M1、M2、M7 三条对应的测试，再审一次。

---

# 第二轮复审（2026-11-04）

- 审查人：同一位代码审查员（只读，默认不通过，同一尺度）
- 对象：前端 A 按第一轮记录返工后的工作区（新文件 ui/DeskWeek.tsx、DayList.tsx、week-axis.ts，src/core/setting-patch.ts 及测试，CalendarWeek.test.tsx、week-axis.test.ts、cal-i18n.test.ts、src/app/__tests__/cal-same-page.test.tsx；改动 app/App.tsx、app/features.ts、kit/components/Popover.*、motion/swipe-pager.ts、motion/presets.ts、platform/app-static.ts、core/ai-settings.ts 等）。`src/features/reminders/`（FA-4）不在范围

## 结论：不通过，7.5 / 10（第一轮 7）

第一轮 M1～M7 都已解决，低问题除了 L2、L4（在前端 B 的 cal-nav 里）也都改了，测试补得扎实。还剩两处没过：**所有翻页都套着 380 ms 的整页 View Transition（N1，和 5.12 动效写法冲突，滑动时和跟手位移叠在一起）**；**`npm run lint` 有 1 个 stylelint 错误（N2，CI 会红）**。这两处改完就可以过。

### 运行结果
- vitest（calendar、motion、app、kit、settings、app-static、setting-patch、ai-settings；`--exclude tests/build/gen-tauri-key.test.ts`）：Asia/Seoul、America/Los_Angeles、Pacific/Kiritimati 三个时区（PowerShell `$env:TZ`）各 83 个文件、802 条，只有 1 条失败：`src/app/__tests__/safe-top-css.test.ts`“src 下除了 base.css，没有 CSS 直接写 env(safe-area-inset-top)”，是 `src/features/reminders/ui/Remind.module.css` 引起的（FA-4，不算 FA-3）
- `tsc -p tsconfig.app.json`：0；`eslint`（相关目录）：0；check_arch：0 错误、1 警告（W2，后端，预期内）
- **stylelint：1 个错误**——`src/features/calendar/ui/CalendarPage.module.css:560:3 Expected empty line before comment (comment-empty-line-before)`（见 N2）

## 第一轮问题逐条复查

| 编号 | 结论 | 核实 |
|---|---|---|
| M1 量宽观察器 | 已解决 | `WeekView.tsx` 第 32～46 行改成回调 ref + `[el]` 依赖；`CalendarWeek.test.tsx` 第 136 行测了翻周后观察新轨道、不再观察旧的 |
| M2 节假日失败记死 | 已解决 | `app-static.ts` 的 `fetchAppJsonStatus` 分 ok / missing（4xx、不是 JSON）/ failed（断网、5xx）；`useHolidays.ts` 第 223～242 行 failed 不写缓存，第 280 行 `online` 事件重拉；页面 `cal-offline` 提示；有“离线提示 + online 重拉”和“404 不提示不重拉”两条测试 |
| M3 键盘翻页 | 已解决（动效见 N1） | `CalendarPage.tsx` 第 145～157 行 ← → 和 T；输入框、修饰键、浮层（`[role="dialog"]`）、选择器打开时不生效；`useCalendar.ts` 第 136～148 行连按第一下 push、500 ms 内的 replace；测试“→ 连按三次只新增一条历史” |
| M4 年月选择器 | 已解决 | 改成 Radix Popover（kit/Popover 支持受控、`<Appear kind="popover">`），年列 + 月份 3 列，打开时焦点在正在看的月份，方向键移动，Esc 收起后焦点回胶囊；做法已由 R-327 回填架构 5.12 第 3 点（第 3461 行），和架构一致。剩余小问题见 N3 |
| M5 标签字号 | 已解决 | `.mark`、`.more`、`.hol2` 用 `--fs-9-5` |
| M6 两国第二行 | 已解决 | `MonthGrid.tsx` 第 212、224～228 行；有测试 |
| M7 两条路由重挂 | 已解决 | `features.ts` 加 `samePageAs`，`App.tsx` 按它挂同一个组件、错误边界用同一个 key；`cal-same-page.test.tsx` 测了“#/calendar 点下个月后焦点还在按钮上” |
| L1 今天按钮 disabled | 已解决 | `aria-disabled` |
| L2 1900 年第一周 | 未改 | 在前端 B 的 `cal-nav`，转给前端 B（不计入本次） |
| L3 边界 ‹ › | 已解决 | `canPrev / canNext` + `aria-disabled`，有测试 |
| L4 settings 同步前规整周参数 | 未改 | 同 L2，转前端 B（不计入本次） |
| L5 点亮着的单选不保存 | 已解决 | radio 改 onClick 保存 |
| L6 连点重复 insert | 已解决 | `useCalSettings.ts` 写入排队 + 记住刚 insert 的 id |
| L7 韩文白下农历 chunk | 已解决 | `useLunar` 韩文不加载，测试断言“不下农历 chunk” |
| L8 滑动 hook 没测 | 已解决 | `swipe-pager.test.ts` 加了状态机 6 条（含吞 click、减少动态效果） |
| L9 下标对齐 | 已解决 | `wantsOf` 按单对拼路径 |
| L10 词典 | 已解决 | `cal-i18n.test.ts` 逐键比对占位符、韩文不混汉字；`cal.weekGrid` 改读“11月2日” |
| L11 读屏星期、总数、未显示 | 已解决 | `cellLabel` 加星期、共几件、另有几件未显示 |
| L12 全天小签颜色 | 已解决 | 改成“全天 N”小标签，带第一件的项目色 |
| 第一轮“和架构不一致”第 6～8 条 | 已解决 | 电脑周视图（DeskWeek）、跟手滑动、阈值改回 60 px / 左边缘 20 px、全天 N、当天共几项和“逾”、待办按 `due_time` 画、纪念日菱形都做了 |

测试缺口复查：翻周改宽度、节假日恢复、焦点、周视图选年月、两国名字、滑动 hook 都补了。**仍缺**：跨午夜“今天”变化（`useMinuteNow`）、闰月在格子和读屏里的写法、1900 年第一周（随 L2）。都是低。

## 新发现的问题

### 中

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| N1 | `hooks/useCalendar.ts` 第 131～133、147 行 → `app/router.ts` 第 130～145 行 `navigate` / `replaceRoute` → `motion/index.ts` 第 77 行 `transition` | 月历的**所有**翻页（‹ ›、键盘 ← →、滑动、今天、年月选择、地址规整）都走 `navigate` / `replaceRoute`，每次都起一次整页 View Transition（`base.css` 第 74～79 行：`--dur-sheet` 380 ms 交叉淡化）。和架构 5.12“动效”冲突：按钮翻页应是“和滑动同样的滑动、不回弹”；**键盘“不加位移动画，只做 ≤ `--dur-press`（120 ms）的淡入或直接切换”**；“今天”和年月选择“直接切换”。滑动时更明显：`swipe-pager.ts` 第 122～129 行在 `cb.current(r)` 之后立刻把内容放到入场位置、下一帧滑回 0，而 View Transition 是异步截“旧画面 / 新画面”的，旧画面、新画面可能截到正在横移的状态，**看起来是“交叉淡化 + 横滑”叠在一起，或新页先闪到一侧**（jsdom 测不出来，要真机看）。380 ms 的过渡期间页面也不能点，键盘连按时每一下都重起一次。前端 A 自报“键盘翻页走路由页面过渡”，但没有报负责人、也没回填架构。 | 给 router 加一个不带动画的跳转（例如 `navigate(name, …params)` 外再提供 `navigateQuiet` / 选项 `{ animate: false }`，`commit(change, false)` 已有现成分支），月历同一页内的翻页、规整都用它；按钮、滑动只用 swipe-pager 的横滑，键盘、今天、年月选择直接切换。补一条测试：同一页内翻页不调用 `document.startViewTransition`。若负责人要保留整页淡化，就回填 5.12 并改成 ≤ `--dur-press`。 |
| N2 | `ui/CalendarPage.module.css` 第 560 行 | stylelint `comment-empty-line-before` 报错，`npm run lint` 会失败（CI 红）。 | 注释前空一行（`stylelint --fix` 可修）。 |

### 低

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| N3 | `ui/MonthPicker.tsx` 第 95～108 行 | 年列 201 个按钮都是 Tab 停留点：从月份 Shift+Tab 会落到 2100 年，不是正在看的那一年；用 Tab 穿过年列要按 201 下。 | 年列用 roving tabindex（只有选中那一年 `tabIndex=0`，其余 `-1`，方向键移动已经有了）。 |
| N4 | `ui/DeskWeek.tsx` 第 29 行 | 电脑周视图表头只取 `hol[0].name`：**补班的周六会显示节日名（如“国庆节”），不带“班”**，看着像放假；表头也没有放假灰底。手机泳道（`WeekView.tsx` 第 132 行）是对的。 | 和泳道同一写法（work 加“·班”），放假加灰底；补一条两种排布一致的测试。 |
| N5 | `ui/WeekView.tsx` 第 76～79 行 | 算时间轴范围时，待办截止时刻取的是 `items.todos` 全部行，**已完成、已删除、已撤销的待办也会把时间轴撑开**（例如一个早就做完的 6:00 待办让整周从 6 点开始）。 | 先用 `isLiveRow` 过滤，并且排除 `done`（和 buildWeek 同一口径）。 |
| N6 | `ui/DayList.tsx` 第 145 行 | 跨午夜的日程在第二天的清单里显示的是前一天的开始时刻（如 23:30），容易看成当天 23:30。 | 接续段写“00:00”或“接上”，或者写起止时刻加“前一天”字样。 |
| N7 | `ui/CalendarPage.tsx` | 页面没有 h1（标题是胶囊按钮），读屏按标题跳读只有清单那个 h2。设置页、注销页都有 h1。 | 加一个视觉隐藏的 h1（“日历”或当前年月）。 |
| N8 | `ui/CalendarPage.tsx` 第 151 行 | “T 回今天”和“← →”没有登记到“?”快捷键说明（5.12 第 3 点要求和 5.9 一起登记）；现在 src 里还没有这个说明页，需要在任务单里挂上，等 5.9 做的时候一起登记。 | 在 FA-3 交付说明或 5.9 的任务里写一笔。 |
| N9 | `ui/DayList.tsx` 第 105 行 | “往上拖列表、月历收成一周一行”（线框 s3）没做，代码注释写了“交付说明登记”，但 B2 任务单 FA-3 行没有登记。 | 在任务单 FA-3 行或交付说明里登记，避免被当成已完成。 |

## 和既有写法一致性（新增部分）
- `core/setting-patch.ts` 把 A31 的恢复写法收成一处，ai-settings 和 calendar 共用，好。
- `samePageAs` 只在 App 层解析，index.ts 仍只导出 lazy（A27），注释写清了“这里的 Page 只是占位”。
- 跟手的 rAF 在 `src/motion/`（A25）；定位用的 `style` 只有位置和尺寸，没有颜色（A11）。

## 通过条件
改完 N1、N2（N1 若负责人决定保留整页淡化，就回填架构 5.12 并把时长降到 ≤ `--dur-press`，键盘、今天、年月选择改成直接切换），真机（iPhone）看一次滑动翻页没有叠两种动画，再审改动部分。N3～N9 不阻塞，建议同批改掉或登记。

---

# 第三轮复审（2026-11-04）

- 审查人：同一位代码审查员（只读，默认不通过，同一尺度）
- 对象：前端 A 按第二轮 N1～N9 返工的部分、cal-route / cal-nav 合入（L2、L4），以及新增的 R-326 上拖收起（`src/motion/drag-collapse.ts`、`hooks/useMonthFold.ts`、`ui/CalNav.tsx`，测试 `CalendarFold.test.tsx`、`CalendarReview.test.tsx`），改动的 `motion/swipe-pager.ts`、`app/router.ts`、`build/check_contrast.py`、`build/contrast-pairs.json`；复审期间又补的 `useMonthFold.ts` 的 `layoutTop`（设计 H1）、`cal-ui.ts` 的 `narrowHolName`（R-332）、e2e `tests/e2e/b2-cal-fold.spec.ts`

## 结论：通过，8.5 / 10（第一轮 7，第二轮 7.5）

N1、N2 都已解决，N3～N7 已改，N8、N9 处理得当；cal-route、cal-nav 的通过条件都满足了。新增的上拖收起结构清楚、测试和 e2e 都有。新发现 4 条低问题，其中 R1（取消时状态和画面对不上）建议这批顺手改掉，不阻塞通过。

### 运行结果
- vitest 三个时区（PowerShell `$env:TZ`）：
  - 宽范围（calendar、motion、app、kit、settings、platform、core、tests/shared、tests/build，排除 gen-tauri-key）：Asia/Seoul、America/Los_Angeles、Pacific/Kiritimati 各 298 个文件、4136 条通过（7 条 skip）。
  - 补充改动（layoutTop、narrowHolName）以后又跑了一次（calendar、motion、app、shared、tests/shared）：三个时区各 74 个文件、820 条通过。
- `tsc -p tsconfig.app.json`、`tsc -p tsconfig.shared.json`：0；eslint（calendar、motion、app、shared/logic/calendar）：0；stylelint（`src/**/*.css`）：0（第二轮的 N2 已消失）；check_arch：0 错误、1 警告（W2，后端，预期内）。
- e2e `tests/e2e/b2-cal-fold.spec.ts`：webkit、chromium 2 条通过。
- 协调者说的 `event-edit.test.ts(157)` 的 `remind_days` 类型错误属 FA-4，不计入本次（`tsconfig.app.json` 也没报）。

## 第二轮问题逐条复查

| 编号 | 结论 | 核实 |
|---|---|---|
| N1 整页 View Transition | 已解决 | `router.ts` 新增 `navigateInPage` / `replaceInPage`，走 `commit(change, false)`；月历里的翻页、今天、年月选择、规整、切周 / 月都改用它（`useCalendar.ts` 第 101、132、147、175、183 行）。‹ › 用 `swipe.slideIn` 横滑，键盘、今天、年月选择直接切换。`CalendarFold.test.tsx` 第 173 行测了同一页内都不调 `startViewTransition`、换页面才调。剩下一个小尾巴见 R2 |
| N2 stylelint | 已解决 | `stylelint src/**/*.css` 0 问题 |
| N3 年列 Tab | 已解决 | `MonthPicker.tsx` 第 104 行 roving tabindex，有测试 |
| N4 电脑表头补班 | 已解决 | `DeskWeek.tsx` 第 32 行改用 `holText`，补班写“班·名字”，放假有灰底；`CalendarReview.test.tsx` 测了几种名字 |
| N5 已完成待办撑宽 | 已解决 | `WeekView.tsx` 第 76～78 行：删掉的、已完成的待办 `todoDate` 给 null，不进范围 |
| N6 跨午夜续段 | 已解决 | `DayList.tsx` 的 `carryOver`：第二天单独列接续段，不再显示前一天的开始时刻 |
| N7 h1 | 已解决 | `CalendarPage.tsx` 第 145 行，视觉隐藏的 h1 |
| N8 “?” 快捷键登记 | 可以接受 | 仓库里确实还没有“?”说明页，等 5.9 做的时候一起登记；请在交付说明里写一笔 |
| N9 上拖收起 | 已做 | 就是本轮新增的 R-326，见下文 |
| cal-route 通过条件 | 已满足 | 提议已合入；头注释改了；补了 1900/2100 两头、怪年份（0050 这类）、多余段的测试；架构 5.12 第 3470 行已回填“合法参数不改地址、`weekInRange`、只认周日 / 周一”。只剩一处注释过期，见 R4 |
| cal-nav 两处改动 | 成立 | `resolveWeekStart` 只认 0、1，和界面一致，还避免了标题月份算到 1899-12 / 2101-01；`parseWeekParam` 先挡 `y < 1899 \|\| y > 2101`，再算 `startOfWeek` 和 `+6` 天，`9999-12-31` 不会再走到 `parseDate('10000-…')` 抛 `bad_date` |

## 协调者点名的五个问题

**1. `navigateInPage` 会不会绕开路由的其他逻辑：不会。**
- 它和 `navigate` 走的是同一个 `hrefOf`（地址规整一样）、同一个“地址没变就直接返回”、同一个深度标记 `DEPTH`、同一个 `commit`，唯一的区别是 `animate=false`。
- 路由里本来就没有“未保存离开拦截”。编辑页的未保存保护在页面自己那里，而且月历页内翻页根本不会离开编辑页，所以没有被绕开的东西。
- 第二轮那条 `replaceAddress` 的写法也没受影响。

**2. drag-collapse 的可中断、指针捕获和取消：主体正确，有一处边界问题（R1）。**
- 可中断：补间途中按下，会先 `stop()`，再用当前的 `pRef` 当起点接着拖，有测试（第 90 行）。
- 指针捕获：`FoldHandle` 在按下时 `setPointerCapture`，拖出按钮以后照样能收到 move / up。`.fold` 是 `touch-action: none`，不会和页面滚动抢。
- `pointercancel` 已接。没有单独处理 `lostpointercapture` 和窗口失焦：失焦时浏览器一般会派 `pointercancel`，有捕获时 up 也能收到，可以接受。
- 补间帧用 `performance.now()`，起点和每一帧是同一个时钟，没问题。rAF 在 `src/motion/`（A25）。

**3. 收起后按周翻的跨月、1900/2100 行为：正确。**
- `stepWeek` 从锚点挪 ±7 天，年份出了 1900–2100 就返回 null，‹ › 跟着 `aria-disabled`。
- 跨月时先 `setPicked(d)`，再 `cal.pick(新年月)`，走的是 `navigateInPage`，不起过渡；换月后锚点所在行会重新计算、重新量位置。
- `layoutTop` 沿 offsetParent 链往上累加，横滑时 `.pager` 带 transform、成了 offsetParent 也不影响结果；e2e 在 webkit、chromium 都验证了每一步锚点行的下沿正好贴着清单块的上沿。
- 1900-01 第一行、2100-12 最后一行：锚点只取本月的日子，前后跨出范围的那一周翻不过去，符合 5.12。

**4. `parseDate` 在别的调用点会不会也抛 `bad_date`：地址进来的路径都安全。**
- 地址参数只经过 `cal-route` 交给 `cal-nav`：`parseMonthKey` 用正则加范围判断，不调 `parseDate`；`parseWeekParam` 有 try，也先挡了离谱年份。`EventEditPage` 的参数是 id，不是日期。
- 其余调用点（`cal-items` 的 `isDateStr` 有 try；`dayEntries`、`month-grid`、`holidays`、`lunar`、`fmt`、`remind-format`）拿到的都是程序自己算出来的或者 schema 校验过的日期，不接地址输入。
- `0000`～`0099` 年在 `Date.UTC` 里会被当成 1900+ 年，`parseDate` 的回读比对会让它抛错，`parseWeekParam` 能接住并当成非法处理。

**5. `check_contrast` 改动有没有让原有项少算：没有。**
- 用 HEAD 版的清单分别跑 HEAD 版脚本和现在的脚本，结果一样：54 项、208 次、不达标 8 次。
- 新清单是 72 项、271 次，多出来的是新加的 18 项（18 × 4 = 72 次，减去 3 项只查 `simple-light`、跳过的 3 × 3 = 9 次，正好 63 次）。
- `themes` 字段只出现在新加的 3 条 `today-ring-*` 上，原有项一条都没加。
- 8 次不达标都是原来就有的底栏玻璃（`g-tint-floor`、`g-ad-*`），和这次无关。
- 小缺口见 R3。

## 新增部分的新问题

### 低

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| R1 | `motion/drag-collapse.ts` 的 `onPointerCancel`，以及 `onPointerUp` 里“没锁成竖向”的分支 | 这两条路径都按按下时的 `t.from` 就近吸附，**不调 `onChange`**。在补间途中按下（比如刚点了收起，`collapsed` 已经是 true、p 才走到 0.3），这时如果来一个 `pointercancel`（系统手势、来电、通知下拉），画面会回到展开（p=0），但页面状态还是收起：别的行仍然 `inert` 点不到，`aria-expanded=false`，‹ › 按周翻。横向拖的分支靠随后的那一下 click 走 `toggle` 才碰巧对上，不可靠。 | 这两条路径改成 `animateTo(collapsedRef.current ? 1 : 0)`（回到页面记的状态）；或者就近吸附的同时调 `cb.current(...)`。补一条测试：补间途中 `pointercancel` 以后，`progress` 和 `collapsed` 一致。 |
| R2 | `app/router.ts` 的 `onHashChange` | 浏览器后退 / 前进，从 `#/cal/month/2026-11` 回到 `2026-10`，仍然会起一次 380 ms 的整页交叉淡化（iPhone 侧滑因为有 UA 动画会跳过，电脑上的后退键不会跳过）。同一页内的历史跳转和按钮翻页的动效口径不一致。 | `onHashChange` 里，新旧地址解析出来是同一个页面（`samePageAs`）时用 `animate=false`；或者在 5.12 里写明“后退走整页过渡”属预期。 |
| R3 | `build/check_contrast.py` 的 `load_pairs` | `themes` 只检查了“非空字符串数组”，没检查名字是不是真有这套皮肤：写错一个字（如 `simple_light`），这一项在 4 套皮肤里都会被跳过，而且不报错，等于静默少算。 | 在 `check()` 里拿 `themes` 和实际皮肤名对一次，不认识的名字报 ConfigError；补一条测试。 |
| R4 | `data/cal-route.ts` 第 4 行；`i18n/view-zh.ts` 第 45～46 行 | 头注释还写着“页面经 hooks 调 navigate / replaceRoute”，实际已经改成 `navigateInPage` / `replaceInPage`。`cal.subHolFull` / `cal.subHolShort` 是数据语言（韩文），却放在中文词典里，以后翻译或者校对词条的人容易把它当成漏翻改掉。 | 改注释；这两个值放进 `cal-ui.ts` 当常量（注释写明对应韩国节假日文件），或者在词典里加注释“不要翻译”。 |

### 新增部分的其他核实（没有问题）
- `useMonthFold` 只动 transform、opacity，停稳以后才用一次负的下边距收掉空白，符合 17.2 第 6 点；收起状态下换锚点会重新量位置。
- `FoldHandle` 本身是按钮，有 `aria-expanded`、`aria-controls`，键盘和读屏可以切换；拖动以后的那一下 click 会被吞掉。
- `narrowHolName` 只在手机月格、手机泳道（以及月格的第二国那一行）用短写，日清单、电脑表头、读屏照旧用全称，和 R-332 一致，有测试。
- 新代码里颜色都在皮肤里（A11），rAF 都在 `src/motion`（A25）。

## 通过条件
已通过。R1 建议这批顺手改掉并补测试；R2～R4 同批改掉或写进交付说明，不用再审。N8 在交付说明里登记。
