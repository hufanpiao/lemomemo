# B2 代码审查：日历 isLiveRow（前端 B）

日期：2026-11-03　审查：代码审查员　被审：前端 B　记录：主持人照审查员回报落盘（审查员只读，没有写文件）

被审：`shared/logic/calendar/cal-items.ts`、`shared/logic/calendar/week-view.ts`、`tests/shared/calendar/month-grid.test.ts`、`tests/shared/calendar/week-view.test.ts`

## 结论：签，9 / 10，没有必改

## 逻辑

- `isLiveRow`：`deleted_at` 为 null 或没有这一列，且 `undone` 不是 true，才算还在。与 `src/features/today/data/today-model.ts:25` 的 `isLive`、`src/features/todos/data/todo-list.ts:52` 的 `live` 逐条对过，结果一致。
- `deleted_at: 0` 算已删（时间戳有值）。本机新建未同步的行没有这两列，照样上日历。
- 筛选处都已改全：日程走 `collectEntries`（cal-items.ts:182）和周视图 `bucket`（week-view.ts:166），待办走 `todoDate`（cal-items.ts:164）。`shared/logic/calendar` 下没有别处直接判断 `deleted_at`。
- 类型把两列改成可选，叠加在原来的 Pick 上，类型检查通过。

## 测试

已删的日程、待办原有覆盖；新补列不存在、undefined、null、0、正数与 undone 真假组合，本机新行进月历格子和单日列表，撤销的条目在月历和周视图（手机、电脑布局）都不出现。边界够。

## 建议（不卡签）

1. “还在不在”现在有三份判断：`isLiveRow`、today-model 的 `isLive`、todo-list 的 `live`。建议后两处改成 import `isLiveRow` 并删本地实现；改不了至少加一条三份对照测试。
2. 周视图新用例（week-view.test.ts:297-299）写法和月历的 `unsynced()` 不一致，建议把 `unsynced()` 挪进 `tests/shared/calendar/fixtures.ts` 共用。

## 跑过

month-grid、week-view 两个测试 54 条全过；`tsc -p tsconfig.shared.json` 0 错误；eslint 4 个文件 0 问题。

## 采纳（主持人，11-03）

- 建议 1：today-model.ts、todo-list.ts 是前端 A 的文件，等前端 A 这批必改做完再转给它。
- 建议 2：交前端 B。

- 【11-03】建议 2 前端 B 已改：`unsynced()` 挪进 `tests/shared/calendar/fixtures.ts`，两个测试共用，并断言两列都不存在；54 条全过，eslint、tsc 0 错误。
