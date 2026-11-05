# B2 代码审查：outbox 的 newItem 重构（K8 R2 ①）

- 审查人：独立代码审查员（只读，默认不通过，10 分制，8 分及以上才算通过）
- 快照：2026-11-05 14:28:17，在独立副本 cr-r14 里核对（变异、构建都在副本里做，做完已删）
- 范围：src/core/outbox-new-item.ts（新增）；src/core/outbox.ts 改为调 rows.newItem；src/core/outbox-logic.ts 的 WriteCode、loadRowSchemas；tests/build/first-paint-graph.test.ts 的 NOT_FIRST_PAINT 登记

## 一、核实

| 项 | 做法 | 结果 |
|---|---|---|
| 行为不变 | 拿 `git diff HEAD` 里 outbox.ts 删掉的那段对象字面量，和 newItem 的返回值逐个字段比 | 19 个字段的规则完全一样：op_id、rec、base_rev 和 own_revs 的 afterInsert 规则、seq 取全队列最大值加 1、remind、deps 拷贝、error: null |
| ts 只在事务外取一次 | 读 outbox.ts:85 和 :111-114 | `const ts = ctx.now()` 在事务外取一次；合并分支和 newItem 都用这个 ts，newItem 自己不取时间。op_id 照旧在事务里由 ctx.newOpId() 生成，和原来一样 |
| 懒加载 | 读 outbox-logic.ts:223-231 | newItem 和 rows.ts、manifest-source.ts 用 Promise.all 同一批下载。newItem 的类型由 `import type` 引入，不进首屏 |
| 首屏 | 副本里跑 `npm run build`、`npm run size`、check_first_paint_chunks | 首屏 JS 是 124.0 KB（gzip），预算 150 KB；首屏块里没有 zod |
| 用例 | vitest 跑 src/core、src/features/auth、src/motion、first-paint-graph，以及 tz 相关的两个文件 | 95 个文件、894 条全绿 |
| 变异：改成静态引入 | 在 outbox.ts 里直接 `import { newItem } from './outbox-new-item.ts'` | 首屏 124.0 KB 涨到 124.1 KB，**first-paint-graph 的 15 条用例照样全过，没拦住**。NOT_FIRST_PAINT 只是给 import() 的目标归类，不检查静态闭包里有没有这个文件；tz-label、glass-ghost 都另外有一条“静态闭包到不了”的守护，newItem 没有 |

## 二、问题表

| 编号 | 严重程度 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| L1 | 低 | tests/build/first-paint-graph.test.ts:179-185 | outbox-new-item.ts 只登记在 NOT_FIRST_PAINT 里，没人守它不被静态引入首屏。改成静态引入首屏只涨 0.1 KB，但用例拦不住，和文件头“首屏余量很紧”的说法不符 | 照 tz-label、glass-ghost 的写法，加一条“main.tsx 和首屏各块的静态闭包到不了 outbox-new-item.ts”，再附一条变异用例 |

## 三、评分与结论

**9.0，通过。** 行为逐字段不变，ts 只在事务外取一次，首屏实测没涨。**必改：无**。建议 L1。

## 四、复审：M6 动效墙钟用例改成假时钟（2026-11-05 15:03:43 快照，接手清单 MOTION-wallclock-tests）

- 范围：只改了三个测试文件，appear-exit-from.test.tsx、features-async.test.tsx（只改“没到时挂上的弹层，到了以后关”这一条）、features-retry.test.ts。
- 核对在独立副本 cr-r17 里做，做完已删。

### 4.1 改成假时钟以后，原来的行为还钉得住吗（没有空转）

基线：3 个文件共 10 条全过。我在产品代码上做了 5 个变异，全部被拦住：

| 变异 | 结果 |
|---|---|
| E1：停稳后退场从 none 起播，不从“原位”起播（Appear.tsx:37） | 红 3 条：appear-exit-from 两条；features-async 那条（“退场途中 scale 恒为 1”抓住的） |
| E2：重新进场时不清“已停稳”（Appear.tsx:62） | 红 2 条，都是 appear-exit-from 的“第二次退场从当前值起播” |
| F1：下载失败的那一次 resolve 成 undefined | features-retry 红，“既不 resolve 也不 reject”这条起作用了 |
| F2：下载失败的那一次 reject | features-retry 红 |
| F3：失败后不把 pending 清掉 | features-retry 第二次调用卡住，8 秒超时红 |

- features-retry 里 `expect(chunk.loads).toBe(1)` 保证了“失败的那一次确实发生了”，F1、F2 也证明这时失败处理已经跑完。所以“不 settle”这条断言不是因为还没到失败那一步才碰巧成立的。

### 4.2 收尾会不会漏到后面的用例

- appear-exit-from 和 features-async 都在 afterEach 里先 `await drainAndRestore()`，再 cleanup，和 fake-frames.test.tsx 的写法一样；features-retry 在 afterEach 里 `vi.useRealTimers()`。
- 按默认顺序跑整个 src/motion，4 份并发全绿。
- 文件内打乱顺序（`--sequence.shuffle`）：appear-exit-from 加 features-retry，6 个种子都是 3 条全过。features-async 在打乱后会红，但我用同样 3 个种子跑**旧版**，红的条数一模一样（5、1、2）。这个文件按“还没到 → 到了以后”的顺序设计，本来就不支持打乱，不是这次引入的。

### 4.3 和 fake-frames.ts 的用法是否一致

一致：都是 `vi.useFakeTimers({ toFake: [...FAKE] })`，用 fakeWait、until 按帧推。features-retry 只需要推时间、不推帧，所以只用了 FAKE 加 `advanceTimersByTimeAsync`，合理。

### 4.4 问题表

| 编号 | 严重程度 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| L2 | 低 | src/motion/__tests__/features-async.test.tsx 文件头 | 文件依赖用例顺序（先“还没到”，后“到了以后”），打乱就红，文件里没写明 | 在文件头写一句“本文件依赖顺序，不支持 shuffle”，或者给后半段加 `describe.sequential` |

### 4.5 评分与结论

**9.0，通过。必改：无。** M6 关闭。
