# B1 安全审查：PURGE-heartbeat-ops（account-purge 心跳 held、remaining、forced 接进 lemo-ops）

- **作者**：安全审查员　**日期**：2026-11-04
- **范围**（工作区未提交的改动，以 `git status`、`git diff` 为准）：
  - `supabase/functions/usage-report/core.ts`：`DETAIL_FIELDS` 加 `held`、`remaining`、`forced`
  - `workers/lemo-ops/src/purge-detail.ts`（新文件）：三条新提示，另把 `purge:overdue`、`purge:stuck` 从 rules.ts 原样挪来
  - `workers/lemo-ops/src/rules.ts`：接上 `evaluatePurgeDetail`、`evaluatePurgePending`
  - 测试：`tests/functions/lemo-ops-purge.test.ts`（9 条）、`tests/functions/lemo-ops-harness.ts`
  - 文档：架构 0.29 续第 137 条 ⑦、TC-B1-102、`PURGE-cpu-budget-执行记录.md` 第 15 节（只核对口径）
- **对照**：`supabase/functions/account-purge/core.ts` 第 460～476 行（心跳 detail 实际写什么）；三处 SQL 写 cleanup 心跳的位置（`0001_core.sql` 第 563 行，`20261029192000`、`20261029210000` 两个迁移）；`push-dispatch/store.ts` 第 66 行；`private.heartbeat` 的授权（`0001_core.sql` 第 589、609、610 行）；`workers/lemo-ops/src/alerts.ts` 的去重、恢复、冷却和每日额度；`B2-安全审查-S-B2签字.md` 的 D2-S2。
- **做法**：只读，默认不通过。本文件以外没有改仓库里的任何文件，没有做 git 操作，没有连库。变异是在会话草稿目录里另拷的一份副本上做的（拷了 tests/functions、usage-report、_shared、workers/lemo-ops；node_modules 用目录联接），共享工作区没动，跑完后核对过 `git status` 和改动前一样。
- **跑过**：
  - `npx vitest run tests/functions --exclude tests/build/gen-tauri-key.test.ts`：53 个文件，971 过、1 跳过、1 todo
  - 副本里的变异 8 个，结果见第五节

## 结论：有条件通过，1 条必改（低，文字）

数据面没有问题：
- 新放行的三个键都只是个数，现在只有 account-purge 写这三个键，别的心跳不会因此多带出东西。
- 告警邮件里没有任何账号可识别信息。
- 去重、“已恢复”和每日额度限住了发信量，外人刷不起来。
- 和 D2-S2 的口径一致。

必改的一条是注释过时，会误导以后的审查。

---

## 一、共用白名单会不会让别的心跳带出不该出的字段

**现在不会。** 逐个核对了 `private.heartbeat` 的所有写入方：

| 心跳 | detail 里的键 | 新放行的三个键 |
|---|---|---|
| cleanup（SQL，三处迁移同一写法） | `rows`、`ms` | 没有 |
| push-dispatch | `claimed`、`sent`、`failed`、`budget_hit` 等 | 没有 |
| account-purge | `purged`、`failed`、`deferred`、`held`、`forced`、`remaining`、`sent`、`postponed`、`remind_left`、`ops`、`remind_ops`、`ms` | 只有它写 |

全仓库搜 `held`、`remaining`、`forced` 作为心跳键，只在 account-purge/core.ts 第 470 行出现。`deferred`、`postponed`、`remind_left`、`ops`、`remind_ops` 照旧被丢掉，测试第 30 行钉住了。

**数字本身的含义（规模）**：
- 三个数都是“最近一轮”里的账号个数，量级和已经转发的 `purged` 相同，而且 usage-report 本来就把“冷静期中的账号”逐行报出来。所以这次没有给同一个通道增加新的规模信息。
- 读的一方只有 lemo-ops：usage-report 要密钥，lemo-ops 再把个数写进发给负责人的邮件。
- 发信服务商 Resend 能看到这几个个数，和原来 `purge:overdue` 的个数同一级。

**以后的隐患（建议 S1）**：白名单是按字段名、跨所有心跳共用的。以后哪个心跳碰巧也用 `held`、`remaining`、`forced`、`sent` 这类名字，却装了别的含义，就会被自动转发出去。`pickDetail` 只要求是有限数字，负数、小数也放行（lemo-ops 一侧的 `isCount` 会挡住，转发本身不挡）。

**顺带发现（已有问题，不是这次引入的，建议 S2）**：`private.heartbeat` 给 `fn_ai` 的策略是 `for all using (true) with check (true)`，能改写**任何名字**的心跳，包括 account-purge 那一行。fn_ai 一旦被攻破，原来就能伪造 `at` 来掩盖“心跳停了”的告警；这次以后，还能伪造或压住 held、forced 提示。影响只是告警被误报或漏报，不涉及泄露。

## 二、告警邮件内容有没有账号可识别信息

**没有。**
- 三条新提示的标题都是固定文字，不带个数（测试第 56 行核对了标题里没有数字，而且个数变了标题也不变）。
- 正文只写个数和排查指引，没有 user_id、邮箱、时刻。测试同一处断言正文里没有 `@`，也没有 UUID 片段。
- 正文里提到“函数日志里……只有 user_id 前 8 位”，只是告诉人去哪里查，邮件本身不带这几位。
- 新规则读到的 detail 先经 usage-report 的 `pickDetail` 只留数字。就算 account-purge 以后误把账号标识写进 detail，也到不了 lemo-ops（变异 M2 证明测试会抓到）。
- `purge:stuck` 的正文会列出每行的 `purge_started_at` 时刻：这是原来就有的写法，这次原样挪过来。时刻是 cron 认领的时间，不是用户的输入，单独看认不出是谁，所以本次不要求改。

## 三、去重和“已恢复”能不能被利用来刷信

**刷不起来。**
- **谁能影响这几个数**：只有自己申请注销、冷静期满 7 天、而且信一直发不出去（或者没有邮箱）的账号，才会进 held 和 forced。攻击者要先注册、申请注销，再等 7 天以上，成本很高。remaining 要连续 104 轮（26 小时）都大于 0 才发信。
- **发信上限**（alerts.ts）：
  - 同一个 key 6 小时内只发一次；
  - 连续 2 轮正常才发“已恢复”；
  - 恢复后冷却 6 小时，期间只出现 1 轮的不发信；
  - 全天最多 20 封，另给“监控连不上”和“推送停了”留 3 封。
- account-purge 一天只在首尔 03:30～05:30 跑 9 轮，最后一轮写的值一直留到第二天。所以 held、forced 一天最多是“发现、已恢复、又出现了”几封，抢不光额度，压不住别的告警。
- 标题不带个数，个数一变不会被当成“情况有变”而马上再发一封。这一点测试第 56 行和变异 M4 都核过。

## 四、和 D2-S2 的口径是否一致

**一致。** D2-S2 的口径是“只加数字和布尔字段，不加别的”。这次只加了三个数字键，`pickDetail` 只收 `typeof === 'number'` 且有限的值，字符串、布尔、对象、数组、null 都丢掉（测试第 35 行，变异 M1 也核过）。

架构第 137 条 ⑦ 写的是“只是个数，没有账号标识；held > 0 当天、remaining 连续 26 小时、forced 当天；purge:overdue 照旧兜底”，和代码、TC-B1-102 一致。

## 五、变异（只在副本里做）

| # | 变异 | 结果 |
|---|---|---|
| M1 | `pickDetail` 不再要求是数字 | 被抓到 |
| M2 | `pickDetail` 转发 detail 的全部键 | 被抓到 |
| M3 | lemo-ops 读所有心跳的 detail，而不是只读 account-purge 那一行 | 被抓到 |
| M4 | held 的标题带上个数 | 被抓到 |
| M5 | remaining 的宽限期从 104 轮改成 103 轮 | 被抓到 |
| M6 | 负数、小数也当成个数 | 被抓到 |
| M7 | forced 加 2 轮宽限期 | 被抓到 |
| M8 | forced 的正文拼进 `detail.user_id` | **存活** |

M8 存活的原因：测试直接调用 `evaluatePurgeDetail` 时，传入的 detail 里没有账号标识，所以拼进去的只是 `undefined`。真实路径上有 `pickDetail` 先挡掉（M2 被抓到），所以不是漏洞，只是这一层自己没有被钉住，见建议 S3。

## 六、必改

| # | 级别 | 问题 | 改法 |
|---|---|---|---|
| 1 | 低（文字，会误导审查） | `supabase/functions/account-purge/core.ts` 第 26～27 行的注释还写着“held、forced 也不进 usage-report 白名单……运维侧现在靠 purge:overdue 兜底”，和这次的改动相反 | 改成“held、remaining、forced 经 usage-report 的 DETAIL_FIELDS 转发，lemo-ops 的 purge-detail.ts 提示；purge:overdue 照旧兜底” |

## 七、建议

- **S1**：把白名单改成按心跳名分开，例如 `{ cleanup: [rows, ms], 'push-dispatch': [...], 'account-purge': [...] }`，或者加一条测试：列出每个心跳写入方实际写的键，断言新加进白名单的键只出现在预期的那一个心跳里。`pickDetail` 也可以顺带只收非负整数（`ms` 本来就是整数）。
- **S2**（已有问题）：把 `private.heartbeat` 给 `fn_ai` 的策略收窄到它自己的那个心跳名，或者查明 fn_ai 不需要写心跳就撤掉这项授权。
- **S3**：给 `evaluatePurgeDetail` 补一条测试：传入带 `user_id`、`email` 的 detail，断言正文里没有这些值，把 M8 钉住。

---

## 补审（11-04）：PURGE-halfway-flip 方案 ①，连同上一轮 S1、S3

- **范围**：工作区相对 HEAD（dfd2a8b）的 11 个文件，以 `git diff` 为准：
  - 代码：`account-purge/core.ts`、`usage-report/core.ts`、`lemo-ops/src/purge-detail.ts`、`rules.ts`
  - 测试：`lemo-ops-purge.test.ts`（13 条）、`account-purge.test.ts`、`account-purge-budget.test.ts`、`tests/edge/push-dispatch.test.ts`
  - 文档：架构第 137 条 ⑦、TC-B1-102、执行记录第 16 节
- S2 另记为 HEARTBEAT-fnai-policy，这次不审、不扣分。
- **做法**：只读，默认不通过。变异在会话草稿目录里重新拷的一份副本上做（拷了 supabase/functions、shared、workers、tests/functions、tests/fakes），共享工作区没动。
- **跑过**：副本基线 3 个文件 37 条全过；变异 12 个，见下文。

### 结论：通过，没有必改

### 一、上一轮意见逐条核对

| 意见 | 现状 | 判定 |
|---|---|---|
| 必改 1：account-purge/core.ts 第 26～27 行的注释过时 | 1494038 里已改成“held、remaining、forced 经 usage-report 白名单转发……purge:overdue 照旧兜底” | 已解决 |
| S1：白名单按心跳名分开；只收非负整数 | `DETAIL_FIELDS_BY_NAME` 三个心跳各列各的键。查心跳名用 `Object.hasOwn`，没登记的名字 detail 整个不转发（`__proto__`、`toString` 都测了）。数字只收 `Number.isSafeInteger && >= 0`，布尔只收 true/false。测试逐个断言 held、remaining、forced、blocked 只出现在 account-purge 一行；account-purge 白名单里的每个键都是它真写的 | 已解决 |
| S3：钉住“正文不带账号标识” | 新增一条测试：detail 里混进 user_id、user_id 前 8 位、邮箱、名字，四条提示的标题和正文都不出现这些值，也不出现 `undefined`。上一轮存活的 M8，这次对应的 B11 被抓到 | 已解决 |
| 上一轮的 M8 | 见 B11 | 已解决 |

lemo-ops 实际读的字段（cleanup 的 `ms`；push-dispatch 的 `claimed`、`sent`、`failed`；account-purge 的四个键）都还在各自的白名单里，按心跳名分开以后没有功能回退。account-purge 原来也被转发的 `sent`、`ms`、`failed` 照留。

### 二、blocked 会不会被 detail 带出个人信息

**不会。**
- `blocked` 是 account-purge 里的一个计数变量，只在 `skip_admin`、`skip_not_disabled` 两种情况下加 1，写进心跳的只是这个整数。
- 经过 usage-report 时只放行非负安全整数，到 lemo-ops 再用 `isCount` 校验一次。
- `purge:blocked` 的标题是固定文字；正文只写个数，以及 `skip_admin`、`skip_not_disabled` 这两个原因码的名字（告诉人去函数日志查，日志里只有 user_id 前 8 位），邮件本身不带 id。
- `purge:overdue` 正文补的那一句也只是这两个原因码的名字。
- 测试第 56 行和 S3 那一条都覆盖到了；变异 B9（标题带个数）、B11（正文拼 user_id）都被抓到。

### 三、白名单能不能被原型链或同名字段绕过

**绕不过。**
- **心跳名**：用 `Object.hasOwn` 查表，`__proto__`、`constructor`、`toString` 这类名字拿不到 `Object.prototype`。B1 去掉 hasOwn 被抓到（`__proto__` 会直接抛错）。B5 让没登记的名字套用 account-purge 的白名单，也被抓到。
- **同名字段**：别的心跳写了 held、blocked 这些键，按心跳名分开以后一律丢掉。B6 给 push-dispatch 也放行 held，被抓到。
- **detail 里的键**：同样用 `Object.hasOwn`，输出用 `Map` 加 `Object.fromEntries` 组装，键只会来自白名单，原型上的东西进不来。B2 去掉这一处的 hasOwn 后**存活**，但这是等价变异：detail 来自 jsonb，经 `JSON.parse` 解出来，不会有继承来的属性；`"__proto__"` 只会被解成对象自己的普通键，而这个名字本来就不在白名单里。所以不算漏洞，只是这层纵深防御没有被测试钉住，见建议 P1。
- **数字的形态**：B3 收小数、B4 收负数都被抓到；NaN、Infinity 也测了。
- **伪造心跳**：fn_ai 能改写 account-purge 那一行心跳，这个缺口照旧存在，归 HEARTBEAT-fnai-policy，这次不扣分。

### 四、blocked 一直不回 0 时，会不会刷屏或被压住

**不会刷屏**：
- blocked 的账号每一轮都会再被算进来，最后一轮写的值一直留到第二天，所以这件事会持续存在。按 alerts.ts 的规则，同一个 key 发一封，之后每 6 小时一封“仍未恢复”，一天最多 4 封。
- 这些账号每次认领后都会被放回，`purge_started_at` 是 null，到期超过 1 天后 `purge:overdue` 也会同时报，一天同样最多 4 封。两件合计最多 8 封，占不满每天 17 封的普通额度。“仍未恢复”在额度紧时排在最后，挤不掉新告警。
- 要制造 blocked，得手工改 admins 或 profiles，或者绕过 `admin_set_disabled`、`account_restore` 这两个正规函数，普通用户做不到。

**也不会被压住**：
- 不设宽限期，测试和 B10 核过：加 2 轮宽限期会被抓到。
- 只有 blocked 回到 0、并且连续 2 轮正常才发“已恢复”。
- 残余情况（低，不扣分）：如果某一轮在碰到这个账号之前就因预算停手，它会被记成 deferred 而不是 blocked。要是当天最后一轮正好这样，blocked 那天就是 0，可能先发一封“已恢复”。但这时 `remaining` 和 `purge:overdue` 照样会报，不会整件漏掉。

### 五、blocked 的口径

`skip_claim_gone` 只算 skipped，不算 blocked。测试有一条专门核这一点，`blocked` 返回值也在测试里。

变异 B7（所有 `skip_` 开头的都算 blocked）存活，也是等价变异：`skip_claim_gone` 走的是第 357 行直接 `return 'skipped'`，不经过 `giveUp`；而 `giveUp` 现在只会收到 `skip_admin`、`skip_not_disabled` 两种 skip 码。以后要是给 `giveUp` 加新的 skip 码，就需要补测试。

B8（blocked 不写进心跳）、B12（blocked 等于 0 也提示）都被抓到。

### 六、变异汇总（12 个）

- 被抓到 10 个：B1、B3、B4、B5、B6、B8、B9、B10、B11、B12
- 存活 2 个，都是等价变异：
  - B2：detail 键查找去掉 hasOwn，JSON 解出来的对象没有继承属性
  - B7：skip_claim_gone 不经过 giveUp

### 七、打分（同一尺度，10 分制）

| 维度 | 分 | 说明 |
|---|---|---|
| 信息泄露 | 9 | 只有个数；标题固定；正文没有标识，有测试钉住 |
| 白名单 | 9 | 按心跳名分开，两处 hasOwn，只收非负安全整数；扣 1 分是因为 detail 一侧的 hasOwn 没有被测试钉住（B2） |
| 告警不刷屏、不被压住 | 8 | 有上限，不设宽限期，和 overdue 互为兜底；扣分是因为有“当天最后一轮预算停手”的残余情况，以及 blocked 和 overdue 会就同一件事各发一份 |
| 测试质量 | 8 | 10/12 被抓到，剩下 2 个是等价变异；两条纵深防御没有测试 |

### 八、建议（不阻塞）

- **P1**：补一条测试，传入 `Object.create({ held: 9 })` 这类带继承属性的 detail，断言不转发，把 B2 钉住。
- **P2**：在 `giveUp` 旁边写一句：以后加新的 `skip_` 码，要明确它算 blocked 还是 skipped；或者把映射改成显式表，而不是 `startsWith('skip_')`。
- **P3**（可选）：`purge:blocked` 正文写明“这几个账号也会出现在‘超过 1 天还没删除’的提示里”，让负责人知道两封信说的是同一件事。
