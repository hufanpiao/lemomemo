# B2 代码审查 · K8 第一批（core 的 resolveGone）＋ REMIND-offline-ack-merge 本机一半

- 审查员：代码审查员（只读；变异只在 scratchpad 的独立副本里做，做完已删，node_modules 联接先 rmdir 再删）
- 日期：11-05
- 方案：docs/09-路线图/B2-K8-冲突提示-实现方案.md 4.3、4.4；方案评审 docs/03-评审/B2/B2-方案评审-K8冲突提示.md
- 结论：**7.5 分，不通过**。必改 M1～M3，改完只需复查改动部分

## 一、审查范围

| 文件 | 内容 |
|---|---|
| src/core/write-gone.ts | 入口 resolveGone、restoredRemind（M7）、失败映射 |
| src/core/outbox-gone.ts | resolveGoneImpl：plan（事务外读、合并、校验）＋ apply（写事务）＋ GoneChanged 重读 |
| src/core/outbox.ts | outboxCtx（WeakMap，createOutbox 登记）；合并那行改调 rows.mergePatch |
| src/core/outbox-types.ts | ResolveGoneReport、ResolveGoneOptions |
| src/core/outbox-new-item.ts | newItem（K8 R2 ①）、mergePatch（REMIND R4-L1） |
| src/core/outbox-logic.ts | WriteCode 带 newItem、mergePatch，loadRowSchemas 同批懒加载 |
| src/core/sync/send.ts、types.ts | conflict 事件加 opId |
| src/core/sync/__tests__/fake-server.ts、send-patch-codes.test.ts | 改用 shared/sync/fork-suffix-data.ts 的 FORK_SUFFIX；ko-KR 160 字截断 |
| tests/build/first-paint-graph.test.ts | K8 守护（L1）：三个文件不进首屏静态闭包 |
| src/core/__tests__/outbox-gone.test.ts、write-gone.test.ts、outbox-remind-merge.test.ts | 单测 |

副本里相关 7 个测试文件基线：88 通过、1 跳过（REMIND-failed-unsynced 那条 it.skip，等 K8 提交后再开）。

## 二、逐项判断（主持人点名的重点）

1. **restore / drop 在同一个 IndexedDB 事务里**：是。apply 的一个 `[table, OUTBOX]` readwrite 事务里：重读、比对、`put` 恢复项、删 gone 组和跟随组、`rewriteRow`。拒收（readonly_row、row_missing）在事务里抛，整个回滚。变异 M3（把删除挪到第二个事务）被“两个标签页同时点”用例拦住。✔
2. **GoneChanged 回滚重读**：正确。事务里重读的 op_id 指纹和 plan 的不同就抛哨兵，事务回滚；外层最多两轮，第二轮还变返回 nothing。drop 同样比对。变异 M1（不比对指纹）、M2（不重读）都被拦住。✔
3. **和 enqueueImpl 共用 newItem**：是。`p.rows.newItem(ctx, …, row, rest, all, ts)`；ts 在事务外取一次，seq 取全队列。base_rev 取本机 server.rev（补拉前是删除前的值，见第 5 点）。变异 M17（rest 换成 mine）存活，但属于等价变异：gone 项不可能跟在没确认的 insert 后面（同一条记录的项按序发，insert 没确认 patch 发不出去），afterInsert 结果一样。✔
   - **但合并 data 没有共用 mergePatch**，见必改 M1。
4. **opId 链路**：代码对（send.ts 用 `item.op_id`）；探针测试实跑通过：gone → restore 返回的 opId → 再发，conflict / forked 事件的 opId 等于它；not_found 时 outbox 的 rejected 事件 `item.op_id` 也等于它。**但现有断言太弱**：send.test 只断言 `expect.any(String)`，变异 M5（opId 填成记录 id）存活，见必改 M3。
5. **服务器口径是否被 core 正确上报**（副本里用假服务器写了 3 条探针，全部通过）：
   - 补拉前恢复：服务器回 conflict，`conflicts` 含 `deleted_at`，服务器行已恢复（deleted_at: null、我的修改在）；core 原样上报，过滤 deleted_at、undone 是 gate 的事（方案 4.4），core 不需要做。✔
   - 随手记恢复时同时 forked：事件 `status: 'forked'`、opId 等于恢复项，原行已恢复。✔
   - not_found：恢复项被丢掉、队列清空，rejected 事件 `code: 'not_found'`、item 是恢复项。✔
   - 这三条现在只在本次审查的探针里，仓库里没有，见建议 S1。
6. **首屏 0 增加**：落点合理（见第三节）。L1 守护能拦静态引入：变异 M9（write.ts 静态 import write-gone）、M10（outbox.ts 用 `export … from` 转出 resolveGoneImpl）都被拦住。首屏里写 `import()` 由同文件已有的“动态引入必须归类”用例管。体积 127018 B 我没复测：副本缺 docs 下的令牌文件，构建失败；以开发者实测和 e2e 首屏预算为准。

## 三、入口落点和方案原稿不同：合理

- 原稿是 write.ts 加 `write.resolveGone`、Outbox 接口加方法；两者都在首屏块里，实测 +72～100 B gzip，余量只剩 0.3 KB。改成 write-gone.ts（入口）＋ outbox-gone.ts（实现）＋ outboxCtx（WeakMap），首屏只多一次 `outboxCtx.set`，代价可以接受。
- 功能层仍只经 write-gone 的 `resolveGone`，M2（功能不直接碰 outbox）的意图保住了。
- 方案 4.3 加了“实现时的落点”说明，但下面的代码块仍是 write.ts、Outbox 接口的原写法，靠一句“读作”对应，见低 L1。
- 缺口：没有任何架构检查拦“功能层直接 import outbox-gone.ts 或 outboxCtx”，见建议 S2。

## 四、必改

**M1（中高）restore 合并 data 用的是 `Object.assign`，绕过了 mergePatch 的 R4-L1 例外，这也是两边改动唯一真实的冲突点。**
`outbox-gone.ts` plan()：`for (const i of items) Object.assign(merged, i.data);`。
场景：离线改了提醒（gone 项 `{remind_days: 1, notified_for: null}`），之后又按了一次旧提醒的“知道了”（跟随组 `{notified_for: OLD}`）。普通入队时 mergePatch 会把 notified_for 留成 null；恢复时却并成了 OLD，服务器照留，新那次提醒会被压住，正是 R4-L1 要防的问题。
探针实测恢复补丁是 `{"remind_days":1,"notified_for":1700000000000,"deleted_at":null}`。
改法（副本里试过，33 条相关用例加探针全部通过）：把 loadRowSchemas 挪到合并之前，改成 `merged = rows.mergePatch(merged, i.data)` 逐项合并；再补一条单测（gone 组换提醒 ＋ 跟随组“知道了” → notified_for 是 null）。方案 4.1、4.3 写的“按 seq 合并，后面的覆盖前面的”也顺手改成“按 mergePatch 合并”。gate 那边 4.1 只用合并结果判 undone，不受影响。

**M2（中）跟随组的 deps 在恢复项里丢了。**
pick() 把跟随组整组并进恢复项，但 newItem 的入参没带 deps。探针实测：跟随项 `deps: [{categories, …}]`，恢复后恢复项 `deps: []`。
普通入队故意不合并带 deps 的项（outbox.ts 注释“带依赖的新项不合并，免得被提前”）；恢复项带 remind 时会整条提前发，可能跑到它依赖的 insert 前面。服务器回 patch_bad_args 时这一项被丢掉，用户点了“恢复”却静默丢失。
改法：恢复项的 deps 取 gone 组和跟随组 deps 的并集（去掉自己这条记录、去重）；补一条单测。

**M3（低中）opId 链路的断言太弱，变异拦不住。**
send.test 只断言 `opId: expect.any(String)`，`opId: item.id` 也能通过（变异 M5 存活）。
改法：断言等于发出去那一项的 op_id，forked 也加一条。最好直接补建议 S1 的端到端用例：restore 返回的 opId 等于后续 conflict 事件的 opId。

## 五、建议

- **S1** 把本次的 3 条探针收进仓库（src/core/sync/__tests__ 下，假服务器）：①补拉前恢复回 conflict、conflicts 含 deleted_at、opId 对得上；②随手记恢复同时 forked、opId 对得上；③恢复后 not_found，rejected 事件的 item.op_id 是恢复项。方案 4.4 的三条口径现在没有 core 层用例钉住。
- **S2** check_arch 或 first-paint-graph 加一条：outbox-gone.ts、`outboxCtx` 只准 core/write-gone.ts 和测试引用，功能层不准直接引。
- **S3** 跟随组的 `!i.sent` 条件没有用例（变异 M4 存活）：补一条“pending 但 sent 为 true（resetInflight 或启动复位后）的跟随项不并进来”。
- **S4** write-gone 映射只测了 undone 一种拒收；补 readonly_row → `{ reason: 'rejected', code: 'readonly_row' }`。
- **S5**（REMIND）mergePatch 判“换了一次提醒”只看 prev。连续合并时 prev 一旦带了 date，后面再按的“知道了”一律不并，就算按的是新那次提醒也一样，结果是新提醒多推一次。这比压住提醒好，可以接受，在注释里写明取舍即可。另外待办改 `due` 不算“换一次提醒”：服务器 round-step0 按“同一天”判压住，挪截止日一般换了天，影响不大，也写进注释。

## 六、低

- **L1** 方案 4.3 的 ts 代码块仍写 write.ts、Outbox 接口新增方法，和实际落点不一致；建议把代码块改成 write-gone.ts、resolveGoneImpl 的真实签名，免得后来的人照着加回首屏。
- **L2** types.ts 的 gone 事件注释仍写“再 outbox.discard(opId)”，现在应是 `write-gone` 的 resolveGone。
- **L3** fake-server 冲突副本标题：`p_patch.title` 为 null 时取原行标题；SQL 是 `coalesce(patch ->> 'title', '')` 取空串。两边不一致，schema 不允许 title 为 null，影响很小，统一一下更稳。
- **L4** 方案 4.1 写“只靠计数变化可能漏一次通知”；又发现 gone 的 failed 项排在这条记录最前时，sendOrder 会把整条挡住（first.state 不是 pending），跟随组本来就发不出去。复审一 R2 ② 说跟随组“会先发出去、又回 gone”与代码不符，不影响实现，方案里改一句即可。

## 七、变异验证（17 个，拦住 14 个；存活 3 个，其中 1 个是等价变异）

| # | 变异 | 结果 |
|---|---|---|
| M1 | 事务里不比对 op_id 指纹 | 拦住（2 条并发用例） |
| M2 | GoneChanged 不重读（只一轮） | 拦住 |
| M3 | 删除挪到第二个事务（不原子） | 拦住（两标签页并发） |
| M4 | 跟随组不排除 sent | **存活** → S3 |
| M5 | conflict 事件 opId 填记录 id | **存活** → 必改 M3 |
| M6 | 恢复项 remind 恒 false | 拦住 |
| M7 | 服务器 undone 时不补 undone: false | 拦住 |
| M8 | 事务里不判 ro | 拦住 |
| M9 | write.ts 静态引 write-gone | 拦住（L1 守护） |
| M10 | outbox.ts 用 export-from 转出 resolveGoneImpl | 拦住（L1 守护） |
| M11 | mergePatch 去掉 remind_days 判定 | 拦住 |
| M12 | mergePatch 例外整条去掉 | 拦住 |
| M13 | enqueue 合并改回 `{...last.data, ...input.data}` | 拦住 |
| M14 | write-gone 拒收码丢掉 | 拦住 |
| M15 | restoredRemind 不看 remind_at、snooze_at | 拦住 |
| M16 | drop 也删跟随组 | 拦住 |
| M17 | newItem 的 rest 换成 mine | 存活（等价变异，见二.3） |

另有 5 条探针（不是变异）：P1～P3 通过（服务器口径），P4 复现必改 M1，P5 复现必改 M2。

## 八、REMIND-offline-ack-merge 本机一半（前端 B）

- **mergePatch**：口径和 reminders/remind-write.ts 的 hasTimingChange 一字不差。prev 换了提醒、next 带非空 notified_for 时，保留 prev 的 notified_for（prev 没写时删掉这一键）；其余照常后写覆盖。逻辑正确。
- **outbox.ts 合并那一行**：改调 `rows.mergePatch(last.data, input.data)`，其余条件（pending、未 sent、同 v、无 deps）不变。✔
- **outbox-logic.ts 两处**：`import type { mergePatch, newItem }` 只引类型，不进首屏；loadRowSchemas 同批给出 mergePatch。✔
- **新测试**：纯函数 2 条、真 outbox 1 条，覆盖了三种“换提醒”和反向顺序；变异 M11～M13 全部拦住。REMIND-failed-unsynced 那条 it.skip 写明了在等 K8 提交，合理。
- 不足见 S5（只看 prev、待办的 due 不算），不阻塞。
- **评价**：这一半本身 8.5，可以通过。

## 九、两边改动冲突不冲突

- 文件层面不冲突。两边都改了 outbox-new-item.ts（K8 加 newItem，REMIND 加 mergePatch）、outbox-logic.ts 的 WriteCode 和 loadRowSchemas、outbox.ts 的入队合并那一段（K8 改调 newItem，REMIND 改调 mergePatch）。现在工作区是合在一起的状态，类型一致，7 个相关测试文件 88 条全过，互不覆盖。
- **语义上有一处冲突，就是必改 M1**：K8 的 restore 自己手写了一份合并，没走 REMIND 新加的 mergePatch，R4-L1 的保护在恢复路径上失效。改法见 M1。
- 后续注意：REMIND-failed-unsynced 要改 outbox.ts 的 refresh，和 outboxCtx 不在同一段，K8 提交后再改不会冲突；但改完要重跑 outbox-gone.test 的 `remindRecs` 断言（恢复项 remind 为 true 时在 remindRecs 里）。

## 十、开发者修改（前端 A，11-05，送原审查员复查改动部分）

| 项 | 改法 | 位置 |
|---|---|---|
| M1 | loadRowSchemas 挪到合并之前，逐项 `merged = rows.mergePatch(merged, i.data)`；补单测“gone 组换提醒 ＋ 跟随组知道了 → notified_for 仍是 null” | outbox-gone.ts plan()；outbox-gone.test.ts |
| M2 | 恢复项 deps = gone 组和跟随组 deps 的并集，去掉自己、去重（depsOf）；补单测 | outbox-gone.ts；outbox-gone.test.ts |
| M3 | send.test 断言 opId 等于回 conflict 那一项的 op_id；send-patch-codes 的 forked 用例同样断言 | send.test.ts、send-patch-codes.test.ts |
| S1 | 三条探针收进仓库：①conflict 含 deleted_at ②notes 恢复同时 forked ③not_found 的 rejected，opId / item.op_id 都等于恢复项 | 新 src/core/sync/__tests__/send-gone-restore.test.ts |
| S2 | 新测试扫 src、shared：outbox-gone.ts（任何引法）和 outboxCtx 只准 write-gone.ts 引；没放进 check_arch.py（那是共用脚本），放在 tests/build 跟 first-paint-graph 一起跑 | 新 tests/build/k8-gone-imports.test.ts |
| S3 | 补“pending 但 sent（resetInflight 复位过）的跟随项不并进来” | outbox-gone.test.ts |
| S4 | 补 readonly_row → `{ reason: 'rejected', code: 'readonly_row' }`（真走 resolveGoneImpl） | write-gone.test.ts |
| S5 | mergePatch 注释写明两条取舍（只看 prev；待办 due 不算换提醒） | outbox-new-item.ts（只改注释） |
| L1 | 方案 4.3 代码块换成 write-gone / resolveGoneImpl / outboxCtx 的真实签名，原稿作废 | 方案 4.3 |
| L2 | gone 事件注释改成 write-gone 的 resolveGone | sync/types.ts |
| L3 | 假服务器副本标题同 SQL：patch 带 title 键用它，否则原行；null 当空串 | fake-server.ts |
| L4 | 方案 4.3 跟随组那句更正（gone 项在最前时整条被挡住） | 方案 4.3；4.1、4.3 的“按 seq 合并”同时改成按 mergePatch |

验证：副本（scratchpad/mut-copy）里 4 个变异全拦住——不走 mergePatch、不带 deps、opId 填记录 id（4 条红）、跟随组不排除 sent。
工作区：src/core 全部加两个新测试 566 过 1 跳过（--maxWorkers=4）；tsc app/node 0 错；eslint 改动文件 0；check_arch 0 错。
首屏：改动都在 outbox-gone.ts（不在首屏）和测试里，mergePatch 原本就在 WriteCode 同批懒加载，首屏不变。

## 十一、复查（原审查员，11-05，只看第十节的改动）

**结论：8.5 分，有条件通过。条件是补 N1（一条单测），不用再送审。**

逐项复查：

| 项 | 判断 |
|---|---|
| M1 | 已解决。loadRowSchemas 挪到合并之前，逐项 `rows.mergePatch`；新单测钉住 notified_for 仍是 null |
| M2 | 已解决。depsOf 取并集、去掉自己、去重，经 `deps: p.deps ?? []` 传给 newItem；变异 R1、R2、R4 都拦住 |
| M3 | 已解决。send.test、send-patch-codes 的 forked 都断言 opId 等于发出去那一项的 op_id |
| S1 | 已解决。send-gone-restore.test.ts 三条口径齐全；变异 R5（not_found 改发 error 事件）、R7（假服务器不报 deleted_at 冲突）都拦住 |
| S2 | 已解决。k8-gone-imports.test.ts 自带假源码的正反例；变异 R6（功能层 import outboxCtx）拦住。放在 tests/build、不进共用的 check_arch.py，可以接受 |
| S3、S4、S5、L1～L4 | 都已解决；L3 假服务器的取法和 SQL 的 coalesce 一致 |

新发现：

- **N1（必补，一条单测）合并顺序没有用例钉住。** 变异 R3 把 `rows.mergePatch(merged, i.data)` 换成 `rows.mergePatch(i.data, merged)`，也就是先写的赢，结果 97 条全过、存活。
  - 原因：现有用例里 gone 组和跟随组改的列都不重叠（title / note）。
  - 补法：gone 项 `{ title: 'A' }`、跟随项 `{ title: 'B' }`，恢复补丁里的 title 应为 'B'。两个 gone 项改同一列的情况再加一条更好。

复查用的变异 7 个，拦住 6 个：R1～R7 中只有 R3 存活。基线是相关 9 个测试文件，97 条通过、1 条跳过，跑时 `--maxWorkers=4`。副本已删。
