# B2 代码审查：push-dispatch 的 round.ts 拆分复审（只看搬动）

- 日期：2026-11-04
- 审查人：代码审查员（只读，默认不签）
- 对象：提交 b13882b 里 `supabase/functions/push-dispatch/` 的改动，只看 `git show b13882b` 的 diff——`round.ts`（658 行变动：删 651、增 7）、新文件 `round-types.ts`（174 行）、`round-util.ts`（115 行）、`round-step0.ts`（98 行）、`round-dispatch.ts`（278 行）。同一提交里的农历、节假日、推送替身、文档不在本记录范围
- 对照：`B2-代码审查-BE-2推送调度.md` 第一次复审“round.ts 先不拆”一条和第二次复审“round.ts 先不拆”一条（拆分条件：记进接手清单、只搬家不改行为、用例不改照样过、拆完只看搬动部分复审、再夹带行为改动就不接受推迟）；接手清单 REMIND-round-split

## 结论：通过，9.5 / 10

被删掉的 651 行，除 5 行函数声明加了 `export` 外，原样出现在新文件里，没有夹带行为改动；拆分前从 `round.ts` 导出的 37 个名字，拆分后全部仍能从 `round.ts` 导入。第二次复审定的几个条件都满足。没有必改，只有 3 条低级别的建议。

扣 0.5 分的原因：这次“只搬家”的保证全靠人工对照，仓库里没有一条测试专门盯着 `round.ts` 的转发名单（见 L2）。

**做法**（可复现）
1. 取 `b13882b^:…/round.ts`（720 行）和 `b13882b:` 下的 `round.ts` 与四个新文件，不用工作区里现在的文件。
2. 按新文件文件头写的“原 round.ts 第 N～M 行”切出旧文件对应的行段，逐段和新文件正文做逐行比对（含缩进、空行），再用多重集合比对一遍“旧文件每一行是否还在新文件里、新文件多出哪些行”。
3. 在 b13882b 的快照上跑 `deno check push-dispatch/round.ts`：通过，没有类型错误、没有找不到的名字、没有循环引用报错。
4. 另写一个只存在于临时目录的检查文件，从 `round.ts` 一次性 import 拆分前所有导出的名字（含类型），`deno check` 通过。
5. 逐个新文件检查 import 列表：没有未使用的名字，也没有缺的名字。

## 搬动对照表

“旧行”指 `b13882b^` 的 `round.ts`；“新行”指 b13882b 里新文件的行号。

| 内容 | 旧行 | 新位置 | 对照结果 |
|---|---|---|---|
| 文件头注释（流程总说明） | 1～33 | `round.ts` 1～32 | 原样保留；只在末尾多 2 行拆分说明（第 33、34 行） |
| import（checkEndpoint、PayloadInput/PayloadKind、DeliverResult/Device/PushOptions） | 34～36 | `round-dispatch.ts` 3～4、`round-types.ts` 3～4 | 按用途分到两个文件；`PushOptions` 在两边都要用，所以两边各引一次 |
| 类型、常量、`kindOf`（Table、TABLES、kindOf、MIN_MS 到 RoundResult） | 38～206 | `round-types.ts` 6～174 | 逐行一致，整段没改；全部本来就带 `export`（第 175 行是文件末尾空行） |
| 小工具 `dueAtOf`、`isDue`、`isHandledAfterPush`、`parseDnd`、`showTitleOf`、`renderText`、`pool` | 208～282 | `round-util.ts` 6～78 | 逐行一致（含注释） |
| `groupBy`（原本不导出） | 271 | `round-util.ts` 68 | 仅声明前加 `export`，函数体一致 |
| `uniq`（原本不导出） | 282 | `round-util.ts` 79 | 仅声明前加 `export` |
| `logTzInvalid`（原本不导出） | 324 | `round-util.ts` 85 | 仅声明前加 `export`，函数体一致 |
| `filterUsable` | 704～720 | `round-util.ts` 96～115 | 逐行一致 |
| `runRound` | 286～298 | `round.ts` 43～55 | 原样留在 `round.ts`，调用顺序仍是 `step0` → `steps1to8` → 分批写 logs |
| `insertLogsSplit` | 300～318 | `round.ts` 57～76 | 原样留在 `round.ts` |
| 第 0 步 `step0` | 338～430 | `round-step0.ts` 5～98 | 逐行一致；仅 `step0` 声明前加 `export`，文件头多 import（类型、`groupBy`、`logTzInvalid`、`pool`、`uniq`） |
| 第 1～8 步 `steps1to8` | 432～702 | `round-dispatch.ts` 10～278 | 逐行一致；仅 `steps1to8` 声明前加 `export`，文件头多 import（类型、常量、`filterUsable` 等小工具） |

**转发名单**（`round.ts` 第 39、40 行）

| 来源 | 写法 | 覆盖的名字 |
|---|---|---|
| `round-types.ts` | `export *` | Table、TABLES、kindOf、MIN_MS、SNOOZE_MIN、AHEAD_MS、BEHIND_MS、LOG_SRC、SETTING_KEYS、QueueItem、QueueRef、ItemRow、Profile、UserSettings、DeviceRow、LogRow、DeviceOutcome、RoundStore、NotifyMsgLike、NotifyTextLike、NotifyInputLike、Dnd、AnnivCtx、AnnivNext、RoundLogic、Limits、RoundCtx、RoundResult（28 个，含类型） |
| `round-util.ts` | 点名转发 | dueAtOf、filterUsable、isDue、isHandledAfterPush、parseDnd、pool、renderText、showTitleOf（8 个） |
| `round.ts` 自己 | 本地导出 | runRound（1 个） |

合计 28 + 8 + 1 = 37 个，与拆分前 `round.ts` 的 37 条 `export` 声明逐个对上，用 `deno check` 从 `round.ts` 一次性 import 全部名字验证过，没有缺项。`groupBy`、`uniq`、`logTzInvalid`、`step0`、`steps1to8` 是新增导出，只在拆分后的几个文件之间用，没有从 `round.ts` 转出去，和拆分前“这几个不对外”一致。

**调用方**：`core.ts`（`runRound`、`Limits`、`RoundLogic`、`RoundStore`）、`index.ts`（`RoundLogic`）、`store.ts`（`LOG_SRC`、`SETTING_KEYS`、`TABLES` 和若干类型）、测试 `tests/edge/*`（含 `isDue`、`parseDnd`、`SNOOZE_MIN`、`filterUsable`、`isHandledAfterPush`）、`tests/functions/push-dispatch-usable.test.ts`（动态 import `filterUsable`）都照旧从 `round.ts` 引，这次提交没有改它们。

**import 关系**：`round-types.ts` 只有类型 import，不依赖其他新文件；`round-util.ts` 只依赖 `round-types.ts`；`round-step0.ts` 依赖 types 和 util；`round-dispatch.ts` 依赖 types 和 util；`round.ts` 依赖这四个。没有循环引用，模块加载顺序不影响行为。

## 夹带行为改动检查

| 项目 | 结果 |
|---|---|
| 条件、比较符、阈值 | 无变化（逐行一致） |
| 常量（MIN_MS、SNOOZE_MIN、AHEAD_MS、BEHIND_MS、LOG_SRC、SETTING_KEYS） | 无变化 |
| 调用顺序（`runRound` 里 step0 → steps1to8 → logs；两个 step 内部） | 无变化 |
| 错误处理（try/catch、`logs_failed`、乐观条件写回、插回队列） | 无变化 |
| 日志字段（`logs` 的 code、`tz_invalid` 只写表名） | 无变化 |
| 闭包与共享状态（`logs`、`res`、`overBudget` 由 `runRound` 创建后传入两个 step） | 与拆分前同一份对象，没有被复制 |
| 模块级可变状态 | 旧文件没有，新文件也没有 |

## 发现的问题

### 高

无。

### 中

无。

### 低

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| L1 | `round-types.ts` 第 1 行、`round-util.ts` 第 1 行、`round-step0.ts` 第 1 行、`round-dispatch.ts` 第 1 行 | 四个文件头都写“原 round.ts 第 N～M 行”。`round.ts` 现在只剩 76 行，这些行号在以后的提交里会指到一个已经不存在的版本，读的人会去现在的 `round.ts` 里找，找不到 | 把“原 round.ts 第 38～206 行”改成“b13882b^ 的 round.ts 第 38～206 行”。以后几次提交若已改过这些注释，只在下次碰到时顺手改，不必单独提交 |
| L2 | `round.ts` 第 39、40 行 | 转发名单没有测试盯着：`export *` 会把 `round-types.ts` 以后新增的名字也悄悄带出去，点名转发的 8 个名字则靠现有测试间接覆盖（`isDue`、`parseDnd`、`SNOOZE_MIN`、`filterUsable`、`isHandledAfterPush` 有测试在用，`dueAtOf`、`pool`、`renderText`、`showTitleOf` 没有测试直接从 `round.ts` 引）。现在没问题，以后有人调整 util 的导出时，漏转发要等到有调用方才会报错 | 在 `tests/edge` 里补一条很短的测试：从 `round.ts` import 全部 37 个名字并断言值类名字不是 undefined（类型名靠 `deno check` 兜底）。不卡这次的签 |
| L3 | 提交 b13882b 的拆分方式 | 这次拆分和农历 BE-5、节假日、推送替身、文档混在同一个提交里（BE-2 复审时说“11 由主持人提交时按组拆”）。提交说明里已经写了“复审 9.5 通过”，但这份书面记录是事后补的。只看 `round` 目录的 diff 虽然够用，但以后回溯拆分要先过滤一遍 | 记录用，不要求改提交。以后同类“只搬家”的拆分单独一个提交，提交说明里写明复审记录的文件名 |

## 说明

- 本次没有运行任何用例，也没有连库；唯一执行的命令是在 b13882b 的文件快照（临时目录，不在仓库内）上跑 `deno check`，没有改动仓库里的任何文件。
- 之后几次提交里对 `round*.ts` 的行为改动，已经各自单独审过，不在本记录范围。
- “用例不改照样过”这一条：b13882b 里 `tests/edge/`、`tests/functions/` 下与推送调度相关的用例文件都没有出现在改动清单里（改动清单里的 `tests/functions/push-dispatch-store.test.ts` 只有新增行（61 行，0 行删除），不是改旧用例），满足这个条件。用例是否实际全绿没有重跑，沿用提交时的结果，以主持人的跑测记录为准。
