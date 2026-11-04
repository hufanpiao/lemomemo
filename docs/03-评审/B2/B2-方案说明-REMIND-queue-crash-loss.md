# B2 方案说明：REMIND-queue-crash-loss（push-dispatch 第 0 步“出队即删”的崩溃丢失）

- **作者**：后端　**日期**：2026-11-04　**状态**：只出方案，没写代码；要新迁移、改表结构，等负责人定
- **条目**：接手清单 REMIND-queue-crash-loss（来源：B2 BE-2 代码审查建议 ⑤；架构 0.49 第 3 条、5.3 第 0 步）
- **读过的代码**：
  - `supabase/functions/push-dispatch/round-step0.ts`：第 0 步，出队、重算、写回、插回；
  - `supabase/functions/push-dispatch/store.ts`：`popQueue`、`requeue`；
  - 出队函数 `private.remind_queue_pop`，迁移 `20261103130000`；
  - 队列表 `private.remind_queue`：`0001_core.sql` 第 177 行，主键 `(table_name, id)`，没有别的列；
  - 写队列的入口（都是 `insert … on conflict do nothing`）：
    - `enqueue_remind()`：0001，三张表各一个触发器，0002、0005 挂上；
    - `enqueue_anniv_defaults()`：0005；
    - `enqueue_floating(uuid)`：最新版本在 `20261104100000`；
    - `enqueue_allday_defaults()`：`20261104100000`；
    - push-dispatch 自己的 `requeue`：upsert，`ignoreDuplicates`。

## 一、现在的问题

第 0 步的流程是：`remind_queue_pop` 在一个语句里删掉这一批（最多 500 项）并返回，push-dispatch 再读行、重算 `remind_at`、写回。写回失败的、或者时间预算到了没处理的，再插回队列。

**队列项一出队就没了**。如果进程在出队之后、写回或插回之前死掉，这一批里还没处理完的那些项就不在队列里了。这一行的 `remind_at` 停在旧值，要等它下次被改，或者这个人下次换时区，才会重新算。

- **后果**：服务器按旧的 `remind_at` 推送，或者该推的时候没推。本机通知不受影响，因为客户端用同一份 logic 自己现算。最典型的情况是换时区以后，浮动提醒（待办、纪念日、全天日程）的推送时刻不对。
- **会不会真发生**：会。B1 已经实测过 Supabase 函数会被“每次调用 2 秒 CPU”的硬上限当场掐断（`B1-pgnet超时-执行记录.md` 的“另外发现”）。掐断不会走到任何 catch，`requeue` 也来不及调。push-dispatch 第 0 步一轮最多 500 项，每项都要算一遍 logic，在免费版上不是不可能顶到上限。再加上部署替换、平台重启，都属于“出队后进程没了”。
- **现在为什么没改**：“先读后删”会吞掉处理期间新入队的同一行。用户在这一轮处理的时候又改了这一行，触发器的 `on conflict do nothing` 碰上还没删的旧项，什么也不插；处理完以后一删，这次新改动就丢了，而这一轮用的还是改之前的值。所以 BE-2 选了“出队即删”，接受崩溃丢失，B7a 上线后观察。

## 二、几种做法

| | 做法 | 要不要迁移 | 要不要改表结构 | 能不能真修好 |
|---|---|---|---|---|
| 甲 | 维持现状，只缩小窗口（每轮出队上限 500 降到 100 左右，日志多记一条） | 不要 | 不要 | 不能，只是一次少丢一点 |
| 乙 | 定时补扫：每 10 分钟把最近改过的行重新放进队列 | 要（新 SQL 函数和 cron） | 不要 | 只能补一部分：换时区（`enqueue_floating`）、改默认设置（两个 `*_defaults`）都不会改行的 `updated_at`，扫不到 |
| **丙（推荐）** | **租约式出队**：出队不删，只给这一批打上“处理中”标记，处理完再按标记删；进程死了，过一会儿标记过期，别的轮重新取 | **要** | **要（`remind_queue` 加 3 列）** | **能**：至少处理一次，重算本来就是幂等的 |

下面只展开丙。

## 三、丙：租约式出队（推荐）

### 表结构（新迁移）

`private.remind_queue` 加三列，都可以为空，不影响现有的行：

| 列 | 类型 | 含义 |
|---|---|---|
| `claim` | `uuid` | 这一批的租约号；为空表示没人在处理 |
| `claimed_at` | `timestamptz` | 什么时候被取走的 |
| `attempts` | `smallint not null default 0` | 被取走过几次，用来认出“一处理就把进程弄死”的项 |

主键不变，不加外键。队列平时很小，不另加索引。

### 出队函数：`remind_queue_pop` 改成取租约

新迁移里 `create or replace`，签名改成 `remind_queue_pop(p_limit int, p_lease_s int)`，返回值多一列 `claim uuid`。

- 孤儿照旧直接删，这一段不变。
- 候选只取“没人在处理的”：`claim is null`，或者租约已经过期（`claimed_at < now() - p_lease_s`）。
- 按人公平、每人每轮最多 50 条、`account_usable` 判断、`for update skip locked`：**这些全部原样保留**。
- 最后一步从 `delete … returning` 改成 `update … set claim = <这一轮新生成的 uuid>, claimed_at = now(), attempts = attempts + 1 returning`。
- `attempts` 已经到上限（建议 5 次）的项不再交出去：直接删掉，函数里写一条记录，push-dispatch 侧记 `queue_poison`。这样一个“一算就崩”的项不会每几分钟把整轮拖垮一次。

### 处理完：新函数 `remind_queue_finish(p_claim uuid, p_release jsonb)`

security definer、`set search_path = ''`、只授 service_role，写法和 `remind_queue_pop` 一样。

- `p_release` 里的项（写回时乐观条件不成立、预算到了没处理、读行失败）：把 `claim` 置空，下一轮马上再取。这一步代替现在的 `requeue`。
- 其余 `claim = p_claim` 的项全部删掉。处理成功、算出来和原来一样、`recalc_failed`、`recalc_no_profile`、tz 不认识、R-336 压住，都属于这一类。
- 条件是 `claim = p_claim`。这一轮处理期间被触发器重新入队的项，claim 已经被清空（见下一节），不会被删，下一轮按新值再算。**“先读后删”吞掉新改动的问题就是这样解决的。**

### 触发器：重新入队时清掉租约

写队列的入口一共 4 个函数：`enqueue_remind`、`enqueue_anniv_defaults`、`enqueue_floating`、`enqueue_allday_defaults`。

新迁移里把它们的 `on conflict do nothing` 改成：

```
on conflict (table_name, id) do update set claim = null, claimed_at = null
```

意思是：这一项正在被处理的时候用户又改了这一行，就把它标回“没人在处理”。

- 不清 `attempts`，免得有毒的项靠用户反复改来绕过上限。
- `remind_at`、`next_date` 不在任何触发器的监听列里（核对过 0002、0005 的 `update of` 列表），所以 push-dispatch 自己写回不会把这一项再放进队列。
- 已提交的迁移不改，只在新迁移里 `create or replace`。三个触发器本身（`events_remind` 等）不用动。

### push-dispatch 第 0 步怎么接

`round-step0.ts` 的流程基本不变，只换三个地方：

1. `popQueue(limit)` 改成 `popQueue(limit, LEASE_S)`。返回的每一项带 `claim`（同一批是同一个值）。
2. 现在调 `requeue(xs)` 的两处，改成记进 `release` 列表：
   - 读 profiles、settings、行失败：整批 release；
   - 单项超预算、或乐观写回失败：这一项 release。
3. 第 0 步结尾调一次 `finish(claim, release)`，代替 `requeue(back)`。
   - 调失败就记 `queue_finish_failed`，不重试：租约过期以后别的轮会再取，重算是幂等的，最多重复算一遍。
   - `requeue_failed` 这个日志码就不再有了。

其余都不动：重算逻辑、R-336、R-316 的 tz 判断、乐观写回、`tz_invalid` 限频、第 1～8 步。

**租约时长**：建议 180 秒。

- 一轮最长 20 秒墙钟，pg_net 超时 25 秒，cron 每分钟一次。
- 租约要比一轮加上重叠的余量长得多，又不能让崩溃的那批等太久。
- 180 秒的意思是：崩溃以后最多 3～4 分钟，这批会被重新算。

### 为什么“至少处理一次”在这里安全

崩溃以后同一项可能被算两次。重复的那一次：

- 结果和第一次一样，就是 `same`，不写回；
- 行在中间被改过，乐观条件不成立，不写回，release 给下一轮；
- 不涉及推送：第 0 步只算 `remind_at`，到点推送是第 1～8 步的事，那边靠 `pushed_for` 认领来保证不重复，和这里无关；
- `tz_invalid` 日志每人每小时最多一条，重复算也不会多记；
- 唯一会多出来的是 `recalc_failed`、`recalc_no_profile` 这类函数日志：只在崩溃以后的那一次重复，量很小。

### 风险

| 风险 | 怎么挡 |
|---|---|
| 一个项每次都把进程弄死（CPU、坏数据），每 3 分钟拖垮一轮 | `attempts` 到 5 次就丢掉并记 `queue_poison`；平时 `recalc_failed` 本来就会删掉，不会重试 |
| 触发器多了一次 `do update`，用户改行的时候多一次写 | 只在这一项正好在队列里时才发生，队列平时很小；行锁只持有触发器的那一瞬间 |
| 出队函数和触发器同时碰到同一项 | 出队是单条语句的短事务，加 `skip locked`；触发器的 upsert 最多等出队那一条语句提交 |
| 两轮重叠 | 和现在一样靠 `skip locked`；租约没过期的项，另一轮取不到 |
| `finish` 失败 | 什么都不改，等租约过期；不会丢，只会晚 3 分钟、多算一次 |
| 改了 4 个触发器函数，漏改一个 | 那个入口仍是 `do nothing`，退化成现在的“新改动可能被吞”，只影响这一个入口。D1 和真库测试按 4 个入口逐个核对 |
| 和孤儿清理、`account_usable` 的配合 | 都不变；停用、冷静期的人的项仍不取、不打租约 |

### 要动的地方（负责人同意以后）

- **新迁移一条**：加列；`remind_queue_pop` 换新签名（旧签名删掉，同一个迁移里换授权）；新函数 `remind_queue_finish`；4 个入队函数 `create or replace`。
- **3.3 C 白名单、附录 A**：`remind_queue_pop` 的签名改了、`remind_queue_finish` 是新的。两处要一字不差，D1 的 FUNCTION_EXEC 一起改。service_role 对 `remind_queue` 的表权限不用加：update 和 delete 都在 security definer 函数里做。
- **数据字典**：`remind_queue` 那一行加三列（docs/05，要你单独允许）。
- **架构 5.3 第 0 步、0.49 第 3 条**：把“出队即删、写回失败插回”改成“租约式出队、处理完按租约删”。
- **代码**：`round-step0.ts`、`store.ts`（`popQueue`、`finish`，删掉 `requeue`）、`round-types.ts`（`QueueItem` 加 `claim`，store 接口换方法）。
- **测试**：
  - `tests/edge/push-dispatch-mem.ts`：内存库照新 SQL 写租约、过期、`attempts`；
  - `push-dispatch-step0.test.ts`：
    - 出队后“崩溃”（不调 finish），推进时钟超过租约，下一轮能重新取到并算对；
    - 处理期间同一行被改，finish 后不删、下一轮按新值算；
    - 第 5 次就丢、记 `queue_poison`；
    - release 的项下一轮马上能取；
  - `push-dispatch-due.test.ts`：出队公平那几条照旧；
  - 真库 `supabase/tests/rls/30_remind_queue_pop.test.sql`：补租约、过期、skip locked、4 个入队函数逐个重新入队都会清租约；
  - `32_allday_remind_enqueue.test.sql`：全天那个入口同样核对；
  - TC-DEL-remind_queue：孤儿清理照旧。
- **工期**：约 1～1.5 人日。迁移和真库测试约 0.5，push-dispatch 和内存库约 0.5，文档和审查返工约 0.25～0.5。审查要过 BE-2 推送调度的原代码审查和安全审查（新的 security definer 函数、触发器改写）。

### 和 BE-2 现有设计的关系

- 不改“最多一次推送”：那是第 3 步认领 `pushed_for` 的事。这里只把第 0 步从“最多一次重算”改成“至少一次重算”。
- 不改“停用、冷静期只跳过、不出队”（0.49 第 4 条，M5）和“出队按人公平”（BE-2 安全审查必改 2）。
- 架构 0.49 第 3 条当初拒绝“先读后删”的理由（会吞掉新入队），丙用“重新入队清租约、按租约删”解决了，所以和那一条的初衷不冲突，只是换了实现。

## 四、建议

- **B7a 上线前做丙**。理由：CPU 硬上限掐断已经在 B1 实测出现过，而第 0 步一轮最多 500 项，一次就可能丢几百项的重算；用户看到的是“换时区以后推送时间不对”，很难自己发现，也很难查。
- 如果负责人不想在 B7a 前加迁移：先做甲，把 `QUEUE_POP_LIMIT` 从 500 降到 100，一次最多少丢 400 项，只改一个常量、不用迁移；然后照接手清单原来的写法，上线后看心跳中断和用户反馈再定。
- 乙（定时补扫）不推荐：覆盖不全，又同样要迁移。

## 五、要负责人定的

1. 要不要在 B7a 前加这条新迁移（`remind_queue` 加三列、换出队函数、新加 `remind_queue_finish`、改 4 个入队触发器函数）。
2. 如果不加：是否同意先做甲（出队上限降到 100）。
3. 有毒项的上限次数（建议 5 次）和租约时长（建议 180 秒），可以照建议定，也可以改。
