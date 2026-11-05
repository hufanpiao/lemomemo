# B2 方案说明：REMIND-queue-crash-loss（push-dispatch 第 0 步“出队即删”的崩溃丢失）

- **作者**：后端　**日期**：2026-11-04　**状态**：**负责人 11-04 定 R-348：B7a 前做丙**，有毒项上限 5 次、租约 180 秒照建议；后端已实现（迁移 20261104130000），11-04 两份审查不通过，已按主持人定的改法返工（第六节“审查返工”），待复审、待提交。实现和下面方案的差别见第六节
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

## 六、实现记录（11-04，R-348）

照第三节做，签名、列、租约 180 秒、上限 5 次、4 个入口都和方案一致。下面几处是实现时定的细节，审查时请一起看：

1. **放回时 `attempts` 减 1**（方案没写）。放回的是“读行失败、预算到了没处理、乐观写回不成立或写回报错”，不是崩溃。不减的话，一个人连续几轮都排在预算之外，取满 5 次就会被当成有毒项丢掉。现在只有“取走以后没调 finish”（崩溃、finish 失败）才累计次数。
2. ~~重新入队不清 `attempts`~~：**返工后改为清零**（见下面“审查返工”第 3 条）。
3. **有毒项只在 push-dispatch 侧记 `queue_poison`**，数据库里不另写记录。方案写了“函数里写一条记录”，实现时没加：出队函数以 `claim` 为空的一行返回（带 `user_id`），push-dispatch 照常经函数日志记原因码，不写标题、不写 id，和别的原因码同一处看。
4. **租约秒数限在 30～3600**，空按 180。push-dispatch 固定传 `QUEUE_LEASE_S = 180`（`core.ts`）。
5. **入队入口只在“正被租着或取过”时才写**：返工后是 `on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0 where q.claim is not null or q.attempts > 0`。没被租着、也没取过的项照旧什么都不写，用户编辑时不多一次写。
6. **加锁之后再看一次租约**：`locked` 里再判一次“没被租或已过期”，防止候选和加锁之间别的轮刚打上租约并提交（`skip locked` 只跳过还锁着的）。
7. **`p_release` 不是数组就报 `bad_release`**；`p_claim` 为空什么都不做（不会把没被租的项当成“这个租约的”删掉）。
8. **D1 加一条**（方案“漏改一个入口”那一行的兜底）：凡是 `insert into private.remind_queue` 的 private 函数，每一处都要配清租约那一句（`build/d1/remind-lease.ts`，单测 `tests/build/d1-remind-lease.test.ts`，反例 `supabase/tests/d1-fixtures/38_enqueue_no_lease_reset.psql`）。
9. **发布顺序**：迁移和函数先后都行，中间那一两分钟第 0 步跳过、队列不丢；回滚 push-dispatch 到租约版之前会让第 0 步一直跳过（`remind_queue_pop(int)` 已删），写进了上线与回滚手册第三节、第四节第 2 层。

### 审查返工（11-04，代码审查 H1/L2/L3/L4/S_noLockedRecheck，安全审查必改 1～3、S1～S3）

1. **重试模式（H1 / 必改 1，主持人定代码审查改法 1）**：原来一批里有一项一算就崩，整批每项 attempts 都 + 1，5 轮后同批无辜的项一起被当成有毒项丢掉。现在 `remind_queue_pop` 的候选里只要有 attempts ≥ 1 的项，这一轮只交出 1 项（attempts 最小的先，再按 table_name、id），单独一个租约；push-dispatch 第 0 步处理完马上单独 finish，再取下一项（`round-step0.ts` 的循环）。取到一批（> 1 项）或什么都没取到就结束这一轮。没有取过的项时照旧按批出队（每轮最多 500 项、每人 50 项）。账号不可用的取过的项不算进重试模式，不卡住别人的批量出队。效果：bad 和 innocent 同批、bad 每次都崩时，innocent 第 3 轮单独算完、算对；只有 bad 在第 6 轮被丢掉（pgTAP rls/30 ⑮、vitest `push-dispatch-lease-retry.test.ts` 同一个场景）。
   - **口径一（主持人定）：重试模式每轮最多 20 次出队**（`core.ts` 的 `QUEUE_RETRY_POPS = 20`，跑在第 0 步自己的时间预算里）。崩溃留下的取过的项每分钟最多单独处理 20 项，**500 项这样的积压约 25 分钟消化完**；上线与回滚手册第四节第 2 层回滚节照这个数写。**11-05 补**：这 25 分钟只是这些重试项自己晚算，不再挡新项（见下面“复审返工”第 1 条）。
   - ~~行为变化：被改过的项同一轮就算完~~：11-05 复审返工以后新项每轮只按批出队一次，被改过的项（attempts 已清零，算新项）照旧下一分钟按新值算，和 11-03 版一样。
2. **finish 和删孤儿都 `for update ... skip locked`（必改 2 / S3）**：finish 的放回和删除先用 skip locked 子查询挑出没被别的事务锁着的行，外层再判 `q.claim = p_claim`；被用户事务锁着的行（用户正在改这一行，入队触发器锁住了队列行）跳过、不等锁，用户提交后租约和 attempts 已清零，下一轮当新项算；用户回滚了就等租约过期按重试模式单独重取。**删孤儿那一句也改成 skip locked，是我顺手加的**：两连接测试第一次跑时连接 2 出队等了 3178 毫秒，排查是删孤儿在等连接 1 提交（造孤儿复现 3257 毫秒），改后约 175 毫秒。可以重复跑的两连接测试 `tools/db/remind-queue-2conn.mjs`（lemo-b2push）：用户持锁 7 秒时 finish（删除、放回两种）不等锁、不报错、同租约其余项照常处理；一个连接出队后持锁 4 秒，另一个连接同时出队拿不到任何项、不等锁（含孤儿）。
3. **重新入队 attempts 清零（L2，主持人定）**：改了就是新的一次重算，不背上一版的次数；有了重试模式，有毒项靠反复编辑绕过上限的代价只是这一项自己多崩几次，不再连坐别人。6 处入队都改；D1 的 `build/d1/remind-lease.ts` 要求清租约那一句带 `, attempts = 0`。
4. **心跳 `queue_ok`、`queue_poison`（必改 3 / L3）**，进 usage-report 的 D2-S2 白名单（`DETAIL_FIELDS_BY_NAME['push-dispatch'].num`），lemo-ops 新规则 `workers/lemo-ops/src/push-queue.ts`：
   - **口径二（主持人定）：`queue_ok` 记这一轮的 1 或 0**（第 0 步出队、读行、收尾任一出错是 0）；**`queue_poison` 按首尔当天累计**（写心跳前读上一次心跳，同一首尔日就累加，换日从这一轮重新算；读上一次失败记 `heartbeat_read_failed`，按这一轮的个数写）。
   - lemo-ops：`queue_ok = 0` 沿用 minRounds，**连续 3 次抽查（约 45 分钟）**才发“推送服务的提醒时刻重算一直失败”；`queue_poison > 0` 当天就发“有提醒的重算被当成有毒项丢掉了”，首尔 0 点后报已恢复。心跳里有 `sent` 却没有 `queue_ok`（回滚到了租约版之前的 push-dispatch）也按 0 算，回滚后靠这条发现；lemo-ops 跟着一起回滚到旧 tag 时这条规则也没了，手册里写了人工查法。
5. **S1**：迁移开头 `set local lock_timeout = '5s'`，`db push` 时撞上长事务不会一直卡着锁表。**S2**：pgTAP 补租约上限断言（传 100000 按 3600 秒：3599 秒前打的不重取、3601 秒前打的重取）。**L4**：`store.ts` 里出队结果强转那一行加了注释（生成类型把返回列一律当非空，但有毒项返回的 claim 是 null；`QueueItem` 写的是 `string | null`，`round-step0.ts` 靠它判有毒项，不要照生成类型去掉 null 判断）。
6. **S_noLockedRecheck 判为接受存活**：变异“去掉 locked 里加锁后再判一次租约”测不出来，因为 PGlite、pgTAP 单会话造不出“候选快照之后、加锁之前另一个事务打上租约并提交”的窗口；真发生时后果只是这一项多算一次、attempts 多加 1（结果幂等，不丢不错），两连接脚本场景 B 覆盖了相邻的“提交后不重取”。理由写在迁移 locked CTE 的注释里，接手清单已登记。

### 复审返工（11-05，安全复审 N1 / 代码审查复审 M1、N1～N3，安全复审建议 R1、R2，HEARTBEAT 安全审查 G1～G3）

1. **重试项不再挡新项（N1 / M1，主持人定改法）**：11-04 版只在“没有重试项”时才按批出队，只要队列里还有可重取的取过的项，全站新改的项都不出队。一批 500 项崩一次，约 25 分钟里全站编辑都不重算；普通用户还能用持锁后回滚的批量修改，让收尾跳过自己的项、反复维持这个状态（审查员按 SQL 语义推断）。现在：
   - `remind_queue_pop(p_limit, p_lease_s, p_retry boolean)`：`p_retry = true` 只取 attempts ≥ 1 的项、一次 1 项；`false` 或空只取 attempts = 0 的项、按批（每人 50、总数 500）。迁移还没提交，直接改了 20261104130000 里的签名（`(int, int)` 改成 `(int, int, boolean)`），3.3 C、附录 A 的 grant 行跟着改。
   - `round-step0.ts`：先做单项重试（至多 `QUEUE_RETRY_POPS = 20` 次，取空就停；**另加 `QUEUE_RETRY_MS = 5000`**，这一轮开始 5 秒后不再重试，重试慢的时候也给新项和推送留出时间），**然后不管还有没有重试项，都做一次新项按批出队**。单项重试里取到的项把进程弄死时，这一轮就没有新项出队；那一项最早 3 分钟后（租约过期）才会再被取到，所以最多耽误这一轮。
   - **重试池按先来先到排，没有另设每人限额**：同样 attempts 的按 `claimed_at` 早的先（放回过、claimed_at 为空的最先），再按表名、id。我先试了“每人轮流”（按人编号），发现一次只取 1 项时每次都会重新编号，所有人的第一项都是 1 号，还是按 id 排、不起作用，就改成了先来先到。反复让自己的项收尾失败的人，他的项每被取一次就拿到新的 claimed_at、排到后面，占不住别人的重试次数。新项既然已经不受重试影响，再加每人限额收益不大，就没做。
   - 口径变化：500 项崩溃积压照旧约 25 分钟消化完，但只是这些项自己晚算，新项每轮照常出队。手册回滚节、第六节口径一已改。
   - pgTAP rls/30（67 条）：⑮ 的 8 轮模拟改成“先重试、再新项按批”；新增 ⑯，有 30 项重试项时新项按批出队照样取到别人的新项，单项重试 p_limit 500 也只交出 1 项，p_retry 为空按新项，先来先到（id 大的但更早被取走的先），放回过的排最前。vitest：A 有 30 项重试项时，B 的新项同一轮算对；出队慢时 5 秒后停止重试、新项照样出队。
2. **预算到了不再反复取同一项（代码审查复审 N1）**：补测试，第一次出队后就过了 20 秒预算，这一项放回，之后不再出队。
3. **R2 / 代码审查复审 N2 的 lock_timeout**：新静态检查 `tests/build/migration-lock-timeout.test.ts`。凡是 `alter table private.remind_queue` 的迁移（20261104130000 起），第一句这样的 alter 之前要有 `set local lock_timeout`；以后别的热表加进 `HOT_TABLES`。
4. **R1 / 代码审查复审 N2 的 skip locked**：两连接脚本接进 CI 的 db 任务，在 test:db 和 D1 反例之后跑，约 20 秒。CI 里库的 project_id 是 lemomemo，脚本只在 `GITHUB_ACTIONS=true` 且 `CI=true` 时放行 `supabase_db_lemomemo`，本机照旧拒绝（`--dry` 只判断名字、不连库，已验证四种情况）。三处 skip locked 在单会话下测不出，登记为接受存活（接手清单 REMIND-lease-skiplocked），手册写明改过就跑一次。**CI 里这一步还没真跑过，要等推上去以后看第一次结果。**
5. **N3（queue_poison 重叠少算）**：没有简单的修法，原子累加要在 SQL 里做，得加新函数、新授权。`core.ts` 注释和手册写明了：只在两轮重叠时少算；极端情况下这一次的提示也会漏掉，以函数日志里的 `queue_poison` 为准。
6. **HEARTBEAT G1、G2、G3**：
   - G1：d1-policies 单测里服务心跳名改成从代码里取（lemo-ops 的 HEARTBEAT_LIMITS、usage-report 白名单、各函数的 `HEARTBEAT` 常量），断言和 FN_AI_HEARTBEATS 没有交集；原来那份手写清单保留。
   - G2：D1 加一条，fn 角色的策略（heartbeat 另外逐字比对）using、with check 都要含 `current_setting('app.uid'`，例外只有 counters 的 fn_global（要含 `'global'`）。反例 42 是 `1 = 1`、`key is not null`。拦不住的是“含 app.uid 却又 or 上恒真式”，要逐表逐字比对才能拦，登记为接手清单 HB-policy-verbatim（低）。
   - G3：手册第三节写明了 HEARTBEAT 迁移头的回滚语句会重新打开口子，用了要尽快补新迁移收回。

验证（都只在本机，lemo-b2push 跑完已 `supabase stop`，`docker ps` 前后一致）：

- 复审返工后（11-05）：离线 rls/30 共 67 条全过、D1 过（反例 42 报出）；lemo-b2push 真库 `supabase test db` 34 个文件 1445 条全过，真库 D1 和 D1 反例都过，`supabase gen types` 和 shared/db.types.ts 逐字一致，两连接脚本全过，第 0 步冒烟 13 项全过（崩溃后租约过期由单项重试重取、算对）；vitest 全量 6562 条全过，lease-retry 13 条；变异 14 个全部抓到（SQL 7 个、lock_timeout 静态检查 1 个、G2 规则 1 个、step0 5 个；第一轮存活的 3 个——重试循环不看总预算、出队失败仍做新项、重试取空不停——补了测试后都抓到）。

- 返工后：离线 rls/30 共 61 条全过；lemo-b2push 真库 `supabase test db` 34 个文件 1439 条全过，D1 过（反例 38 照样报出），两连接脚本全过（连跑两遍），第 0 步冒烟 14 项全过（含心跳读写）；vitest push-dispatch 加 store 193 条、lease-retry 8 条、lemo-ops 150 条全过；vitest 全量 6537 条全过。
- 返工前（第一版）：

- pgTAP：离线 PGlite 全过；lemo-b2push 真库 `supabase test db supabase/tests/rls` 33 个文件 1409 条全过（rls/30 重写为 52 条：执行权、属性、列、公平、上限、打租约、过期重取、迟到的旧租约 finish、放回、有毒项、4 个入口清租约、孤儿）。
- D1：离线和 lemo-b2push 真库都过；反例 38 报出。
- 两个连接的并发（lemo-b2push，psql 两个进程）：一个连接锁着某一项时另一个出队跳过它、不等锁；租着的项被另一个连接改了，租约清空、attempts 不清；两个连接同时出队，同一项只有一个拿到。
- PostgREST：`rpc/remind_queue_pop`（`p_limit`、`p_lease_s`）、`rpc/remind_queue_finish`（jsonb 数组）通；只带 `p_limit` 的旧调用回 PGRST202；anon 调 finish 回 42501。
- 第 0 步真库冒烟（真的 `store.ts` 和 `round-step0.ts`）：正常一轮算对、队列清空；崩溃后租约内不重算；租约过期后按新值重算、队列清空。
