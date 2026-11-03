# B2 安全审查：BE-2 推送调度

日期：2026-11-03　审查：安全审查员　被审：后端　记录：主持人照审查员回报落盘（审查员只读，没有写文件）

## 结论：有条件通过，2 条必改

## 必改

| # | 级别 | 问题 | 改法 |
|---|---|---|---|
| 1 | 高（跨用户拒绝服务） | store.ts 的 `dueRows`（66～72 行）配合 round.ts 386～395 行，粗筛只用 remind_at ≤ hi 加三列之一 > lo，每表按 remind_at 升序 limit 500，精确条件留到 JS。`snooze_at` 客户端可写且无约束：一个用户建 500 条 remind_at 很早、snooze_at 极远的日程，就能永远占满前 500 条，全站其他人的提醒每轮都取不到。不攻击时，一小时内超 500 条已推行也会挤掉新到点行。`pushedRows` 同样 | 新建 `private.remind_due(lo, hi, per_user, lim)`（security definer、`search_path=''`、lock_timeout、只授 service_role，同步 whitelist、fn-lock-timeout、03 号测试、db.types），SQL 里精确判 due_at、pushed_for、notified_for，按 due_at 排序，`row_number() over (partition by user_id …)` 限每人条数再 limit；三张表 snooze_at 加范围约束；补“一个用户造 500 条怪值，另一用户照样取到”的测试 |
| 2 | 中 | `remind_queue_pop` 按 `table_name, id` 排序出队，id 是客户端给的 UUID，可全取 0000… 插队；每分钟改 ≥ 500 行就让全站新提醒算不出 remind_at | 按人公平取，或加 enqueued_at 先进先出；停用、冷静期用户的队列项先 limit 再判可用，或用 not exists |

## 建议

1. round.ts 441、446 行 `dndDeferUntil`、`isValidTz` 不在 try 里，怪值会让整轮中断；每个候选单独 try，记 `dnd_failed`。
2. payload 的 noC0 扩到 U+007F、C1（U+0080～U+009F）、双向控制符（U+202A～U+202E、U+2066～U+2069）；SW 端 clipText 同步。
3. 第 0 步 profiles 里没有这个人时不要插回队列循环，丢弃并记原因码。
4. ai-consent-gate 放行 fcm 后加固：另加一条忽略大小写、不受豁免的 `/(generativelanguage|aiplatform)\.googleapis\.com/i`，googleapis 那条改忽略大小写，自测补三个反例。

## 采纳情况（主持人，11-03）

- 必改 1、2 和建议 1、3、4 交后端；建议 2 后端改 payload、前端 A 改 SW 的 clipText。
- 改完由本审查员只看改动复核。

## 复核（11-03）：有条件通过，剩 1 条必改

- 必改 1、2 已解决：remind_due、remind_pushed 条件与 isDue、isHandledAfterPush 逐条一致，“500 条早 remind_at、远 snooze_at”的攻击在 SQL 里就排除；两个函数 security definer、search_path=''、lock_timeout=5s、只授 service_role（31 号测试 ①② 核过），白名单、fn-lock-timeout、03 授权、db.types 同步；remind_queue_pop 按人公平取，客户端自选 UUID 插不了队，返回的 user_id 来自目标表。
- 剩余必改（中，可用性）：三张表 pushed_for 没有索引，remind_pushed 每分钟全表扫，一个用户（每表 2 万行）就能把扫描撑大、可能拖到 pg_net 25 秒超时。改法：三张表各加 (pushed_for) where pushed_for is not null 部分索引。
- 建议：remind_due 加下界并配部分索引（或等预览实测再定）；isStrippedChar 与 SW 的 CONTROL_CHARS 范围一致，noC0 建议改名。
- push-test：通过。verify_jwt + requireActiveUser，鉴权失败不扣次数；版本门在前；push-test:<user_id>:<UTC yyyymmddhh> 每人每小时 5 次，取不到回 503 不放行；只回 {device_id, result} 四种枚举、最多 20 台、负载只有 {v, type:'test', user_id}、端点走白名单；日志只记错误码；不加 CORS，经 /sb 同源。“没有 profile 只有假鉴权单测”判断够（共享 requireActiveUser 已有离线和真库覆盖）；以后改成自己判断就要补真库测试。
- 跑过：vitest 19 个文件 206 条、offline 全过（30 号 21 条、31 号 18 条）、deno check 通过、deno task test 298 过。未连接或启停任何 Supabase、Docker。

主持人（11-03）：必改和建议已转后端，改完请安全审查员复核。

## 第二次复核（11-03）

结论：**通过，没有剩余必改。**

- 上一轮必改“pushed_for 索引”：已解决。三表加了 `(pushed_for) where pushed_for is not null`，登记进 `REQUIRED_INDEXES`，定义串和迁移一致。
- 上一轮建议“remind_due 加下界”：已解决。三支加了 `remind_at、snooze_at、defer_until 任一 > p_lo`，和 due 层的 `d > p_lo` 等价，语义不变；配了纪念日 remind_at、三表 snooze_at、defer_until 的部分索引，共 10 条都已登记。
- 控制字符：服务器端 `isStrippedChar` 和 SW 端 `CONTROL_CHARS` 范围一致；函数改名 `strippedToSpace`，没有残留引用。
- 设备过滤（M4）：只去掉本来就收不到推送的人；条目不认领、`pushed_for` 不变，补上设备后在窗口内照常推，31 号测试已核；别人无法让某人被过滤，也无法借此绕过。
- 分批读取（M5）：按主键去重分批，`keyed` 逐条核对 user_id 的逻辑不变，第 0 步核对和所有写入带 user_id 条件都保留；任一批出错整步按失败处理。
- 索引不改变 RLS 和授权，03 号测试和 D1 白名单都通过。
- 迁移的锁：4.0.0 上线前表很小，部分索引锁很短，沿用 20261031120000 的做法，不用 concurrently，可以接受。
- 建议：以后表大了再加索引或约束时，迁移开头加 `set local lock_timeout`，或改成在迁移外用 concurrently 建；31 号测试补下界边界用例。
- 跑过的测试：vitest 17 个文件 182 条、离线 SQL（30 号 21 条、31 号 20 条）、`deno task test` 299 条、`deno check` 全部通过。

（审查员只读，本节由主持人照回报原样落盘。）
