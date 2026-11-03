# B2 代码审查：BE-2 推送调度

日期：2026-11-03　审查：代码审查员　被审：后端　记录：主持人照审查员回报落盘（审查员只读，没有写文件）

被审：`supabase/functions/push-dispatch/`（round.ts、store.ts、payload.ts 等）、`remind_queue_pop` 迁移、`tests/edge/push-dispatch-mem.ts` 及相关测试。

## 结论：现在不签，6 / 10

结构没问题：先认领再发、最多发一次、不带 Topic、resolve 不发给苹果端点、按钮按类型分、超长先截正文、日志只记原因码。不签是因为有一个确定的运行时 bug（M1），内存替身不核对列名所以没测出来。M1、M2 改完补上测试，可只复审改动。

## 必改

| 编号 | 位置 | 问题 | 改法 |
|---|---|---|---|
| M1（阻断） | `store.ts:15` 的 `COMMON` | `COMMON` 里有 `source`，但 `public.anniversaries` 没有这一列。真库上：第 0 步遇到纪念日整批失败并插回，全站 remind_at 重算停摆；第 1 步纪念日永远不推；resolve 也失败 | `source` 挪到 events、todos 分支；补测试：`colsOf(t)` 每列都在 `db.types.ts` 对应表 Row 键里 |
| M2（会漏发） | `store.ts:66-72` `dueRows`，配合 round.ts:388；`pushedRows` 同样 | 粗筛把已推、已处理的行算进 `limit 500`，61 分钟窗口内超 500 条时新到点行一直取不到，滑出窗口后静默漏掉 | 精确条件放进 SQL 函数（与安全审查必改 1 合并）；补测试：先放 500 多条已推行再放一条新到点行，这轮要能发出 |
| M3（测试缺口） | `tests/edge/push-dispatch-mem.ts` | 内存替身对三张表一视同仁，查不出列名和粗筛差异 | 至少补 M1、M2 两条测试；能在离线 PGlite 跑一次 store 的三条查询更好 |

## 建议（不卡签）

1. round.ts 拆成 step0.ts、dispatch.ts、round-util.ts（现 ESLint 有效 505 行，上限 300）。
2. 20 秒预算不是硬上限：同一条目多台设备串行发，最坏 20 + N×5 秒；改成并发，免打扰循环加 `overBudget()`。
3. `filterUsable` 串行查，改有限并发或批量。
4. 重算写回无条件覆盖，建议 `writeRemind` 带 `.eq('remind_at', 旧值)` 乐观条件，没更新到就插回队列。
5. 出队即删，进程崩溃会丢这批重算；风险写进架构 5.3 和接手清单，以后可改租约式。
6. `tz_invalid` 每轮一条会刷屏、吃 logs 配额；每人每小时只记一次，批插失败拆小重试。
7. current_tz 坏了这人的日程也全不推，可考虑退回日程自己的 tz（产品取舍，问负责人）。
8. resolve 不认 `done`、`deleted_at`，已完成或已删的旧通知不会收回（问架构师）。
9. rls/30 第 ⑦ 段标题写“上限封顶 500”但没测超过 500 条。
10. `reserve` 名额只增不退，加注释说明。
11. vitest.config.ts 混了 B6-exe 的 SLOW 列表改动，提交时按组拆开。

## 核对通过的项

- 出队函数 security definer、`search_path=''`、`lock_timeout=5s`、只授 service_role；`for update of q skip locked`；p_limit 截到 0～500；whitelist、fn-lock-timeout、03_roles_grants 一致；db.types 与 SQL 一致。
- 认领带 `or(pushed_for.is.null, pushed_for.neq.due)`，认领后出错不再推；设备写回带 `push_endpoint` 原串条件；每条写都带 user_id。
- 上限常量与 `LIMITS` 一致；预算到了第 0 步插回、第 1 步计入 `left` 并置 `budget_hit`。
- 不带 Topic；按钮待办 snooze+done、日程纪念日 snooze+ack，推迟 10 分钟两处一致。
- 隐藏标题三类各一个键，zh、ko 都有；超长先截 body 再截 title。
- 非法时区逐行跳过记 `tz_invalid`；日志只有原因码；ai-consent-gate 对 fcm.googleapis.com 放行写法正确。

## 跑过的测试

- vitest 10 个文件 79 条通过（没跑 gen-tauri-key）；`deno task test` 298 过 0 失败 1 忽略；离线库全过（rls/30 17 条、03_roles_grants 43 条）；check_backend 0 错误；eslint 只有 round.ts max-lines 1 条警告。
- 没有连接、启动或停止任何本地 Supabase 或 Docker。

## 采纳情况（主持人，11-03）

- M1～M3 交后端必改，M2 与安全审查必改 1 用同一个 SQL 函数解决。
- 建议 1～6、9、10 交后端一起做；7、8 是产品取舍，记入明早清单问负责人；11 由主持人提交时按组拆。
- 改完由本审查员只看改动复审。

## 复审（11-03，只看改动）：有条件签，7.5 / 10

- M1～M3 已解决：store.ts 的 COMMON 去掉 source、纪念日补 source: 'page'，push-dispatch-cols 测试逐列对 db.types.ts；private.remind_due 在 SQL 里精确判到点，每人有上限、总数 ≤ 500，remind_pushed 加了 R-317 的完成、删除、撤销、三列提醒全空；remind_queue_pop 按人轮流取、每人最多 50 条；snooze_at 值域约束先 not valid 再 validate。
- 建议 ②③④⑤⑥⑨⑩ 已落实。R-316、R-317 符合负责人决定。
- 剩余必改：
  - M4：没有推送设备的人的到点行每轮都被 remind_due 返回，占 500 名额，会把有设备的人的新提醒挤出 60 分钟窗口。改法：ok CTE 加“有未删、有订阅的设备”条件，补 rls/31 和 push-dispatch-due 用例。
  - M5：store.ts 的 keyed() 和 profiles、settings、devices、tzLoggedSince 的 .in(...) 一次最多 500 个 UUID，查询串约 18.5 KB，可能 414/400 整轮失败。改法：通用分批（每批 ≤ 100），补“250 个 id 发 3 次请求”测试。
- round.ts 先不拆：接受推迟，条件是记进接手清单、下一轮只搬家不改行为、用例不改照样过、拆完只看搬动部分复审；再夹带行为改动就不接受推迟。
- 建议（不卡签）：pushed_for 部分索引；remind_due 加下界并给纪念日补 remind_at 索引；免打扰循环里 left 是上界、写注释；改完在 lemo-b2push 上整链重跑，至少覆盖一条纪念日。
- 跑过：vitest 15 个文件 122 条、deno task test 298 过、offline 全过（03 43 条、25 4 条、30 21 条、31 18 条）、check_backend 0 错误、eslint 0 错误 1 警告（round.ts max-lines）。

主持人（11-03）：M4、M5 和全部建议已转后端（a69ee2282d33a86d5），改完请审查员复核。

## 第二次复审（11-03）：签，8.5 / 10

先逐条核对上一轮意见，再按同一尺度打分。

### 上一轮必改

- **M4 已解决。** `remind_due` 的 `ok` CTE 加了 `exists (… devices … deleted_at is null and push_endpoint is not null)`，没设备的人不再返回、不再占 500 名额。devices 已有 `(user_id, synced_at)` 索引，这个 exists 按 user_id 前缀能走索引。
  - `remind_pushed` 不加设备过滤，理由成立：推过的行就算设备后来没了，releasePushed 仍会把 pushed_for 清掉（round.ts 里 `targets.length === 0` 时先释放再返回），下一轮就不再返回，不会长期占名额。
  - current_tz 坏了的人不过滤，已写进迁移文件头 ④：每人最多 20 条，挤不满 500，接受。
  - 用例：rls/31 新增 2 条（20 条全过）；push-dispatch-due 加了“30 人 600 条没设备的行 + 1 条有设备的新行，claimed = 1”。
- **M5 已解决。** `inChunks` 先去重再按 100 一批顺序发。各批 id 或 user_id 互不重叠，合并时不会重复；去重前后集合相同，不会丢行。`keyed` 仍按 SQL 返回的顺序重排，读的时候行没了或 user_id 对不上的才丢掉。settings 是按 user_id 分批的，同一个人的设置一定在同一批里，按人聚合不受影响。每批的行数都在 PostgREST 默认 max-rows 1000 以内：settings 每批最多 100 人 × 4 键 = 400 行；tz_invalid 每人每小时最多一条，`limit(1000)` 按批算也够用。用例“250 个 id + 1 个重复，5 处各发 3 次请求”覆盖了这些。

### 上一轮建议

- **下界条件和 `greatest(...) > p_lo` 等价，含 null 的情况也成立。** greatest 不看 null，所以“greatest > lo”等价于“三列里非空的那几列至少有一列 > lo”。下界里 null 列的比较结果是 null，在 OR 里不会变成真；`remind_at` 本身已有 is not null 条件。三列全空的情况也不存在。due 那一层仍保留 `c.d > p_lo`，就算等价性有问题也不会多返回。
- **部分索引用得上。**
  - `pushed_for > p_lo`、`snooze_at > p_lo`、`defer_until > p_lo` 都是严格运算符，规划器能推出 `is not null`，参数化的通用计划下 `where … is not null` 的部分索引照样用得上。
  - 纪念日新补的 `remind_at` 索引的 where（`deleted_at is null and remind_at is not null`）在查询条件里原样出现。
  - todos 原有索引的 `done = false` 会被规范化成 `not done`，和查询里的 `not t.done` 对得上。
  - OR 的三支各有可用的索引，能走 BitmapOr。是否真选它取决于统计信息，不影响正确性。
  - 10 条索引都登记进了 REQUIRED_INDEXES，定义逐字比对，d1-required-indexes 测试已改。
- left 已在注释里写明是上界（round.ts 第 32 行、第 493 行）。`noC0` 已改名 `strippedToSpace`。lemo-ops 心跳字段已核对，并加了对拍测试。
- round.ts 先不拆：REMIND-round-split 已记进接手清单（B1-接手清单-来自B0评审.md 第 225 行），上一轮给的条件照旧。eslint 仍报 max-lines 一条警告。

### 剩余必改

无。

### 建议（不卡签）

1. 整链冒烟（39 项，含一条纪念日）是后端在 lemo-b2push 上跑的，我只核对了代码和离线用例，没有重跑真库。建议把这次冒烟的输出附在任务单里存档。
2. 下一轮拆 round.ts 时，把 store.ts 的 `inChunks` 一并拆成可单独测试的小工具（现在已导出，单测可以直接测它，不必绕到 makeStore）。

### 跑过的测试

- vitest 17 个文件 153 条通过（加了 `--exclude tests/build/gen-tauri-key.test.ts`）：push-dispatch 全部、push-dispatch-cols、push-dispatch-store、push-dispatch-usable、lemo-ops-b2、notify-text、shared/push、ai-consent-gate、d1-fn-lock-timeout、d1-required-indexes。
- `node supabase/tests/offline/run.mjs` 全部通过（03_roles_grants 43 条、30 21 条、31 20 条）；`deno task test` 298 过 0 失败；check_backend 0 错误。
- 没有连接、启动或停止任何 Supabase 或 Docker。
