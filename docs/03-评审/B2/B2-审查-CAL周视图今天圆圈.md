# B2 审查：CAL-week-today-circle 手机周视图今天的日期圆圈

- 日期：2026-11-05
- 审查员：独立审查子 agent（代码 + 设计，只读，默认不通过，10 分制 8 分及以上通过）
- 实现：前端 A
- 结论：**8/10，通过，没有必改项**（审查员结论落盘：前端 A；审查员按样式静态算的，没自己跑 e2e，e2e 由前端 A 跑）

## 审查对象

- 接手清单 CAL-week-today-circle（提醒接线设计复审 L4，FA-3 原有问题）：手机周视图今天那一行，日期圆圈上下贴着“周三”和“廿六”两行小字。
- 改动：`src/features/calendar/ui/CalendarPage.module.css` 的 `.laneWd b` 加 `height: 22px`、`margin: 2px 0`、`line-height: 22px`，每行都这样排，不只今天。
- 测试：`tests/e2e/b2-cal-week-today.spec.ts`（新，已登记）。

## 审查意见

1. 修法正确：日期数字定 22px 高、上下各 2px，圆圈和上下两行小字各空出 2px；只命中 `.laneWd b`，作用范围对。
2. 行高：小字一行 12px（10px × 1.2）。没有全天标签的行内容从 50px 变 58px，正好等于 `.laneBtn` 的 `min-height` 58px，行高不变；带“全天”标签的行长高 8px（66 → 74），和普通行的差从 8px 变 16px。休息日底色、选中描边跟着 li 和按钮走，不会错位；时间轴 `.trk` 44px 垂直居中，不受影响。（交给审查时说的“每行高 4～8px”不准，以这条为准。）
3. 电脑版 DeskWeek 没被误伤：表头用的是 `.dHeadBtn b`，不在 `.laneWd` 下面；`.laneToday` 只管颜色和圈线。
4. 测试口径够用，样式改回原样能拦住；缺口是原来 7 行全是空白天，没测带全天标签、休息日、选中的行，也没测深色和玻璃皮肤。

## 建议和处理结果

| 建议 | 内容 | 处理 |
| --- | --- | --- |
| 建议一 | e2e 加一天全天日程和一个休息日，断言没有全天标签的各行等高，全天那行和它们的差不超过 16px | **采纳（主持人定）**，已做：用例改到 2026-09-28～10-04 这一周（10-01 起国庆休息日），本机库写一条 9-29 的全天日程；断言有国庆、只有 9-29 带全天标签、其余 6 行（含今天、休息日）等高、全天行多出的高度不超过 16px。chromium、webkit 都过；变异“只让今天那行的日期数字上下各 6px”报“2026-09-30 和别的行一样高 Expected 59 Received 67”，拦住 |
| 建议二 | margin 改成 1px，全天行只长 6px | 不采纳（主持人定）：保留 2px 空隙 |
| 建议三 | 月视图 `.dayNum` 也写死 22px，可以提一个共用尺寸令牌 | 不采纳（主持人定）：tokens.css 现在没有尺寸令牌，不为这一处新开 |

## 证据

- 截图（修后，chromium 390×844）：`C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\mut-calweek\week.png`（scratchpad，不进仓库）
- 变异：在 scratchpad 的独立用例里用脚本把样式改回原样，报“2026-11-02 日期和周几之间 Received 0”；补用例后再加上面那条“今天那行长高”的变异，同样拦住。
- `src/features/calendar` 单元测试 15 个文件、152 条全过；`tsc -p tsconfig.node.json` 这个文件 0 错误、eslint 0 警告。
