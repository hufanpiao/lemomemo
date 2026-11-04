# B2 代码审查 · REMIND-close-occkey（服务器一半）

- 审查人：独立代码审查员（只读，默认不通过，10 分制，8 分及以上才算通过）
- 日期：2026-11-04
- 对象：工作区里还没提交的改动
  - 挪动：`shared/logic/remind-route.ts`（新增 `OccurrenceRef`、`isAllDayRemind`、`occurrenceKey`）、`shared/logic/remind.ts`（新增 `allDayRemindDay`）、`src/features/reminders/data/reminder-model.ts`（改成原地转发导出）；
  - 接线：`supabase/functions/push-dispatch/logic.ts`、`round-types.ts`、`index.ts`、`round-dispatch.ts`（两处）、`tests/edge/push-dispatch-mem.ts`；
  - 测试：`tests/shared/occurrence-key.test.ts`、`tests/edge/push-dispatch-occkey.test.ts`、`tests/edge/push-dispatch-round.test.ts` 改的两处断言。
- 不在范围：
  - `_shared/push/payload.ts` 的白名单（另有安全审查员）；
  - `round-*.ts` 第 1 行文件头里“b13882b^ 的 round.ts”的注释（主持人改的）；
  - 工作区里其他前端改动（例如 `src/features/reminders/index.ts` 的 routes，属于 REMIND-wiring）。
- 运行结果：
  - `npx vitest run tests/edge tests/functions tests/shared src/features/reminders --exclude tests/build/gen-tauri-key.test.ts`：102 个文件，1654 条通过（2 条 skip，1 条 todo）；
  - `deno check push-dispatch/index.ts`：通过；
  - `check:arch`：0 个错误（1 条 W2 警告，预期内）；`check_backend.py`：0 个错误。
- 探针测试：放在会话临时目录，没有写进仓库。在同一行上分别用服务器（跑 `handle()` 得到的负载）和前端（`reminderOf` 加 `occurrenceKey`）算标识，对照结果。

## 结论：通过，8 / 10

挪动的部分没有改变行为，前端用到的地方也不受影响。正常推送时，服务器和前端在全天日程的前一天、当天，按了“稍后”的那一次，有时刻的日程，待办，纪念日这几种情况下，算出的标识都一样。也没有夹带别的行为改动。

有两处探针证实的不一致：

- **M1**：按了“稍后”的那一次推出去以后，用户再按一次“稍后”，收回通知（resolve）时带的标识和当初推出去的那一条对不上。
- **L1**：R-336 让服务器保留了旧的提醒时刻，之后再按“稍后”，服务器和前端会把“是不是稍后那一次”判得不一样。

现在 SW 还没有用这个标识（`src/sw/` 里没有读 `occurrenceKey` 的代码），所以暂时不会出事。M1 必须在 SW 接上之前定好匹配规则，所以这次判 8 分，有条件通过：M1 要在前端 A 接 SW 之前处理掉。

## 三件事逐项核对

### 0. 挪动：导出名和行为都没变

- `allDayRemindDay`：原来用 `str()`、`num()` 判断（`str` 只认字符串，`num` 只认有限的数字），现在直接用 `typeof` 和 `=== 0 / 1` 判断。对 `time`、`date`、`remind_days` 的任何取值，两种写法的结果都一样。参数类型从 `Row` 放宽成 `Record`，原来的调用方照样能用。
- `occurrenceKey`：原来以 `allDayRemindDay(r.row) === null` 作为“不是全天”的判断，现在换成 `!isAllDayRemind(r.row)`，两者条件相同（`occurrence-key.test.ts` 第 29～46 行用边界值逐个核对）。拼出来的字符串原来是 `str(date) ?? ''`、`String(num(remind_days))`，走到这一步时 date 一定是字符串、remind_days 一定是 0 或 1，所以和现在的 `String(row.date)`、`String(row.remind_days)` 结果相同。
- `reminder-model.ts` 第 140 行 `export { allDayRemindDay, occurrenceKey }` 原地转发。用到它们的三处——`local-notify.ts:16,21`（`shownKey = occurrenceKey`）、`useReminders.ts:20` 和 reminder-model 内部——导入路径和名字都不用改。occkey 测试第 101～106 行断言了转发出去的就是 shared 里的同一个函数。
- `remind-route.ts` 仍然没有任何 import（文件头的规矩保住了），SW 可以直接引用。

### 1. 服务器和前端算出的 occurrenceKey 是不是每种情况都一样

服务器的算法（`logic.ts`）：`tag = reminderTag(kind, id, due)`；`snoozed = snooze_at 不为空、等于 due、且 due 不等于 row.remind_at`；然后调用 shared 的 `occurrenceKey`。前端的算法（`reminderOf`）：`raw = greatest(本机算的 remindAt, snooze_at, defer_until)`，`tag = reminderTag(kind, id, raw)`，`snoozed = snooze_at 等于 raw、且 raw 不等于本机算的 remindAt`。两边公式相同，唯一的差别是服务器用库里存的 `remind_at`，前端用本机现算的 `remindAt`。

| 情况 | 结果 | 证据 |
|---|---|---|
| 全天日程，前一天提醒（20:00） | 一致：`event:<id>:allday:<日期>:1` | 探针 A；occkey 测试第 24 行 |
| 全天日程，当天提醒 | 一致：`…:allday:<日期>:0` | 探针 A |
| 全天日程，按了“稍后”以后推出的那一次 | 一致：两边都是 tag（`event:<id>:<snooze_at>`） | 探针 B；occkey 测试第 74 行 |
| 全天日程被免打扰推迟（`defer_until`） | 一致：两边都不算“稍后”，都是全天写法 | 读代码：两边的 due 都包含 `defer_until` |
| 有时刻的日程 | 一致：tag。两边的 `eventRemindAt` 都按日程自己的 tz 算 | occkey 测试第 37 行 |
| 待办 | 一致：tag | occkey 测试第 48 行 |
| 纪念日 | 服务器照 tag；前端现在不处理纪念日（reminder-model 只算日程和待办），等 B5 | occkey 测试第 59 行 |
| **R-336 压住以后（服务器保留了旧的 `remind_at`）再按“稍后”** | **不一致**，见 L1 | 探针 C |

另外：occkey 测试里用来对照的 `expected()` 是把服务器那条公式在测试里又写了一遍，并没有调用前端的 `reminderOf`。所以它证明的是“服务器的负载等于服务器自己的公式”，不是“等于前端算的”（见 L2）。

### 2. resolve 用 pushedFor 算对不对：大多数情况对，再按一次“稍后”时不对（M1）

- resolve 要撤回的是当初推出去的那一条，所以把 `pushedFor`（当初推送的 due_at）放进 tag，方向是对的，也和负载里的 `due_at: pushedFor` 一致。
- 但 `snoozed` 是拿**现在**这一行算的：`snooze_at === pushedFor`。如果当初推的就是“稍后”那一次，之后用户又按了一次“稍后”，`snooze_at` 已经变成新的时刻，不再等于 `pushedFor`，于是 `snoozed` 变成假，resolve 带上的是全天写法的标识，而当初那一条带的是 tag。
- **探针 B2 证实**：09:00 推“今天 · X”，按“稍后”以后 09:10 推出 tag `event:<id>:<09:10>`；再按“稍后”（09:20），下一轮 resolve 的 `due_at` 是 09:10，但带的标识是 `event:<id>:allday:2026-11-05:0`，和要撤回的那一条不同。
- 其他情况都对得上：按“知道了”（行没变，occkey 测试第 85 行）；第一次按“稍后”（当初推的不是稍后那一次，现在 `snooze_at` 也不等于 `pushedFor`，仍是全天写法）；删除、撤销；免打扰推迟。改日期、改 `remind_days` 时 `touch()` 会把 `pushed_for` 清空，根本不会发 resolve，所以不会出现按改过的日期算错标识的情况。

### 3. 有没有夹带别的行为改动：没有

- `round-dispatch.ts` 只在两个 `buildPayload` 调用里多传了 `occurrenceKey`，其余逻辑不变。
- `round-step0.ts`、`round-util.ts`、`round-types.ts` 只改了第 1 行的注释（不算）；`round-types.ts` 多了 `RoundLogic.occurrenceKey` 的类型声明。
- `index.ts` 和替身都只在 `makeLogic({…})` 里多列了 `reminderTag`、`occurrenceKey`，接线测试照样核对两边名单一致（已通过）。
- `push-dispatch-round.test.ts` 改的两处断言只是多了 `occurrenceKey`，原来的字段一个没少。

## 问题清单

### 中

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| M1 | `round-dispatch.ts:263`；`logic.ts`（`occurrenceKey` 的 `snoozed`） | 当初推的是“稍后”那一次，之后用户又按了一次“稍后”，resolve 带的标识会从 tag 变成全天写法，和要撤回的那一条对不上（探针 B2）。SW 以后如果**只按** `occurrenceKey` 匹配来撤回，这一条“稍后”的旧通知就收不回来；全天写法反而可能误撤回当天原来那条通知。 | 二选一：<br>① 服务器 resolve 时按“当初那一次”判断 `snoozed`：`pushedFor !== row.remind_at && pushedFor !== row.defer_until`（当初推的不是提醒时刻本身，也不是免打扰推迟的时刻，那就是“稍后”那一次），不看现在的 `snooze_at`；补一条测试：推了“稍后”那一次以后再按“稍后”，resolve 带 tag。<br>② 在架构 5.3 和 payload 文件头约定：SW 撤回时同时认 tag（由 `kind、id、due_at` 拼出）**或** `occurrenceKey`，两个任一对上就撤回。<br>两种做法都要在前端 A 接 SW 之前定下来。 |

### 低

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| L1 | `logic.ts`（`due !== row.remind_at`），配合 `round-step0.ts` 的 R-336 | 服务器按 R-336 保留了旧的 `remind_at`，本机已经按新的 `default_time` 算出新时刻。这时再按“稍后”，服务器把这次推送判成“稍后那一次”，标识是 tag；前端因为本机算的 `remindAt` 更晚，判成“不是稍后”，标识是全天写法。**探针 C**：07:00 推过，把 `default_time` 改成 21:00，再按“稍后”到 07:15，服务器推出 `event:<id>:<07:15>`，前端算出 `…:allday:2026-11-05:0`。只在“改 `default_time` 之后又按稍后”这种组合下出现。 | 写进接手清单（REMIND-close-occkey 那一行），和 M1 一起处理：用做法 ②（SW 同时认 tag）时自然能兜住；或者把前端的 `snoozed` 改成看 `snooze_at` 是否等于 raw，不和 `remindAt` 比，前提是本机“稍后”的含义不受影响，要单独评估。 |
| L2 | `tests/edge/push-dispatch-occkey.test.ts:18～21` | 对照用的 `expected()` 是服务器公式的复制，没有调用前端的 `reminderOf`，所以证不到“服务器和前端一样”。要证这一点（协调者点名的第 1 条），应该在同一行上跑一次 `reminderOf(...)` 再调 `occurrenceKey`。 | 每条用例再加一句：`occurrenceKey(reminderOf(kind, row, due, SEOUL, null, defaultTime)!)` 等于负载里的值。把探针的 B2（预期按 M1 的决定）和 C（预期写明是已知差异）也加进去。 |

## 通过条件

有条件通过，8 / 10：

1. M1 按做法 ① 或 ② 定下来。做法 ① 改服务器并补测试；做法 ② 写进架构和 payload 文件头，并在接手清单里交代给前端 A 接 SW 时照做。必须在 SW 开始用 `occurrenceKey` 之前完成。
2. L1、L2 同一批改掉，或者写进接手清单。

## 登记册一行

| docs/03-评审/B2/B2-代码审查-occurrenceKey服务器.md | 评审 | B2 代码审查：REMIND-close-occkey 服务器一半（occurrenceKey、allDayRemindDay 挪进 shared，push-dispatch 负载带 occurrenceKey），8 分有条件通过；挪动行为不变、无夹带；中 1 条（推了“稍后”那一次后再按稍后，resolve 的标识和原通知对不上，须在 SW 接入前定匹配规则），低 2 条 | 代码审查员 | 11-04 | 在用 |

---

## 第二轮（2026-11-04，同一审查人，同一尺度）

- 对象：后端按第一轮报告改完的工作区（仍未提交）。
  - `logic.ts`、`round-types.ts`：`RoundLogic.occurrenceKey` 加了第 4 个参数 `at: 'push' | 'resolve'`；
  - `round-dispatch.ts`：推送时传 `'push'`，撤回时传 `'resolve'`；
  - 架构 5.3 和 `payload.ts` 文件头：写进了兜底约定；
  - `push-dispatch-occkey.test.ts`：补了 M1、L1 两条，`expected()` 换成 `frontKey()`；
  - `payload.ts` 的 `isRealDay`：按安全审查的建议改的，不在我的范围，只确认没有影响本轮的行为。
- 运行结果：
  - `npx vitest run tests/edge tests/functions tests/shared src/features/reminders --exclude tests/build/gen-tauri-key.test.ts`：102 个文件，1658 条通过（2 条 skip，1 条 todo）；
  - `deno check push-dispatch/index.ts`：通过；
  - `check:arch`：0 个错误；`check_backend.py`：0 个错误。
- 探针测试：在会话临时目录补跑了“换时区以后撤回”“免打扰推迟以后撤回”两种情况，没有写进仓库。

### 结论：通过，9 / 10，可以提交

M1、L1、L2 都解决了。新的撤回判断加上“tag 和 occurrenceKey 任一对上就撤回”的约定，能盖住目前想到的所有组合。后端提出的免打扰那种情况，靠这个约定就够了（理由见下面）。剩下 2 条低问题，不影响提交。

### 第一轮问题逐条复查

| 编号 | 状态 | 复查 |
|---|---|---|
| M1 | 已解决 | 撤回时“是不是稍后那一次”改成：`pushedFor` 既不等于 `remind_at`，也不等于 `defer_until`。不再看现在的 `snooze_at`，所以用户再按一次“稍后”不影响结果。occkey 测试第 102 行：09:10 推了稍后那一次（tag），再按稍后（09:20），撤回带的是 09:10 的 tag。拿第一轮的写法去跑这条测试会失败，第一轮探针 B2 已经证实，所以这条测试是有效的。 |
| L1 | 服务器一侧已解决，和前端的差异靠兜底约定 | 服务器推送和撤回都判成 07:15 的 tag，前后一致了（测试第 119 行，拿旧写法去跑同样会失败）。前端本机按新的 `default_time` 算，仍会得出全天写法，测试第 134～136 行明确标成“已知差异”。SW 撤回的是推送来的通知，它的 tag 就是服务器的 `due_at`，按约定比 tag 一定能对上；本机通知由本机自己的逻辑收回，不经过 SW。所以这个差异不会让通知收不回来。 |
| L2 | 已解决 | `frontKey()` 直接调用前端的 `reminderOf`，再调用 `occurrenceKey`。全天前一天、当天、有时刻的日程、待办、稍后那一次、M1 这几条，都拿负载和前端的结果比了。纪念日前端不处理，仍然只和 tag 比，合理。 |

### 新的撤回判断：逐种情况推演

撤回时把 `pushedFor` 看成“当初那一次的 due”：等于 `remind_at` 的是正常那一次，等于 `defer_until` 的是免打扰推迟的那一次，两样都不是就是“稍后”那一次。

| 情况 | 推送时带的标识 | 撤回时带的标识 | 是否对上 |
|---|---|---|---|
| 正常推送以后按“知道了”、删除、撤销 | 全天写法 | 全天写法 | 直接对上（测试第 85 行） |
| 正常推送以后第一次按“稍后” | 全天写法 | 全天写法（`pushedFor = remind_at`） | 直接对上 |
| 推了稍后那一次，以后再按稍后（M1） | tag | tag | 直接对上（测试第 102 行） |
| 免打扰推迟以后推送，再按“知道了” | 全天写法 | 全天写法（`pushedFor = defer_until`） | 直接对上（探针 DND） |
| R-336 保留了旧的 `remind_at`，再按稍后（L1） | tag | tag | 直接对上（测试第 119 行） |
| **换了时区**：`remind_at` 按新时区重算、换了一天，没被 R-336 压住 | 全天写法 | **tag**（`pushedFor` 已经不等于新的 `remind_at`） | 标识对不上，**靠比 tag 撤回**（探针 TZ：撤回的 `due_at` 就是当初推送的 09:00，tag 一样） |
| 后端提的：免打扰推迟以后推送，按稍后又落进免打扰，`defer_until` 变了 | 全天写法 | 可能是 tag | 标识对不上，靠比 tag 撤回 |
| 改日期、改 `remind_days`、全天和有时刻之间切换 | — | 不发撤回（`touch()` 已把 `pushed_for` 清空） | 不涉及 |
| 有时刻的日程、待办、纪念日 | tag | tag | 直接对上（这几种不看“稍后”） |

**后端提的那种情况，靠比 tag 兜住，够用。** 理由有三条：

1. 撤回负载的 `due_at` 一律是 `pushedFor`，也就是当初推送的 `due_at`。tag 由 `kind`、`id`、`due_at` 拼成，所以撤回时拼出的 tag 和当初那条通知的 tag 一定相同。只要 SW 按约定比 tag，就一定能撤回。
2. 实际上很少会走到“标识对不上”：用户按了“稍后”以后，下一分钟就会发撤回；而新的稍后时刻要 10 分钟后才到，那时第 2 步才会改 `defer_until`。撤回那一轮读到的行里，`defer_until` 还是旧值，判断结果仍是全天写法。只有撤回被拖延（时间预算用完、只剩苹果设备不发撤回之类）才会碰上。
3. 万一判成 tag，也不会误撤回别的通知：tag 里带了具体的 `due_at`，只会命中当初那一条。

### 本轮问题

#### 高、中

没有。

#### 低

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| R2-L1 | `logic.ts`（撤回时的判断） | 换时区这种情况，第一轮的写法本来能直接对上（全天写法），新写法在这里变成了只能靠比 tag 撤回（探针 TZ）。结果没错，但多了一种依赖兜底的情况。架构里列举的组合是“按了稍后、R-336 压住旧 remind_at、免打扰推迟”，没有写换时区。 | 把“换时区”加进架构 5.3 和 payload 文件头列举的组合里；occkey 测试补一条“换时区以后撤回：标识是 tag、`due_at` 等于当初推送的”，把兜底依赖钉住。 |
| R2-L2 | 兜底约定的落实 | 约定现在只写在文档里，SW 还没有实现（`src/sw/` 里没有读 `occurrenceKey` 的代码）。如果前端 A 以后接 SW 时只比 `occurrenceKey`，上表里换时区、免打扰两种情况就撤不回来。 | 在接手清单 REMIND-close-occkey 的前端那一半里写明“tag 和 occurrenceKey 任一对上就撤回”，并要求 SW 的测试覆盖“标识不同、tag 相同也要撤回”。 |

### 能不能提交

可以提交。R2-L1、R2-L2 写进接手清单，或者随前端那一半一起处理。
