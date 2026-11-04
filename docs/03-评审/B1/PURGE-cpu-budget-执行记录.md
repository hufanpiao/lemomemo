# PURGE-cpu-budget 执行记录：account-purge 按调用次数停手、半截续删、提醒不挤占删除、没提醒的不删（2026-11-04，含返工）

- 条目：接手清单 PURGE-cpu-budget（来源：`docs/03-评审/B1/B1-pgnet超时-执行记录.md` 的“另外发现”：3 个账号 × 400 个备份日期时，一次运行被每次调用 2 秒的 CPU 硬上限掐断，第 3 个账号停在半截、认领卡 1 小时、这一轮没有心跳）。
- 执行：后端（B2 后端子 agent）。没有 git add、没部署；只在本机 lemo-b2push 上验证，没碰 lemomemo、lemo-purgeit，没连预览库和正式库。
- 第一版（8 秒墙钟预算、提醒和删除共用）经代码审查 6.5 分不通过：`docs/03-评审/B1/B1-代码审查-PURGE-cpu-budget.md`。本记录是返工后的版本，按主持人定的返工方案（高 1、中 1、中 2、低 1～5、补跑 cron）和负责人定的“补发提醒并顺延 24 小时”（11-04）改。

## 改了哪些文件

| 文件 | 改了什么 |
|---|---|
| `supabase/functions/account-purge/core.ts` | 预算改按调用次数、两段分开；检查点只在真删了东西之后；没提醒过的不删（held）；到期了还没提醒的补发并顺延；心跳字段 |
| `supabase/functions/account-purge/index.ts` | `listRemind` 含已到期的、按 `purge_after` 排序；新 `postponeNotice`（一条 update 同时改两列）；`listDue` 带出 `notice_sent`、同一时刻到期的按 `user_id` 固定先后 |
| `supabase/functions/_shared/account-mail.ts` | 新文案 `deletionReminderLateMail`（补发的“删除时间已顺延”，中、韩；已按 B2 韩文审校改定，见第 11 节） |
| `supabase/migrations/20261104120000_core_account_purge_catchup_cron.sql`（新） | 补跑：03:45～05:30（首尔）每 15 分钟一次，三条 cron 任务，命令和 03:30 那一条一字不差；旧迁移没改 |
| `supabase/tests/rls/34_account_purge_catchup_cron.test.sql`（新） | 补跑任务的 pgTAP：三条、时刻、命令和 03:30 那条一字不差、没有写死的值 |
| `tests/functions/account-purge-budget.test.ts` | 删除段：按次数停手、remaining 口径、R2 检查点、空桶不停（低 3）、400 个日期分几轮、中 1 两种（次数版、墙钟版） |
| `tests/functions/account-purge-remind.test.ts`（新，从上一个拆出） | 提醒段上限、最急的先发、不重复、不挤占删除；补发、顺延只一次、发信失败不顺延、CAS 冲突、顺延后能 restore、文案 |
| `tests/functions/account-purge-schedule.test.ts` | 中 2：第 5 步把时钟拨到 110 秒的新测试；旧测试按实际行为改名为“R2 检查点停手” |
| `tests/functions/account-purge.test.ts`、`account-purge-harness.ts`、`account-fakes.ts` | 只测删除的用例改用 `toFirstRun` / `markNoticed`（当作提醒已经发过）；假库加 `postponeNotice`、`beforePostpone`、`listDue` 带 `notice_sent` |
| `supabase/tests/store-it/purge-remind.it.ts`（新）、`run.mjs`、`harness.ts` | 真 index.ts 打本机真库：多账号同时到期 + 一批要提醒的；`pending()` 造的行当作提醒过 |
| `tests/data-manifest/purge-runner.ts` | TC-B0-117 真链路注入“冷静期已满”时一并标 `notice_sent = true` |
| `tools/e2e/pgnet-timeout-purge.mjs` | 三种模式都多轮；`--expect timeout` 只判第 1 轮超时（低 5）；默认 `rounds`；`--remind N` 场景；待删账号造成提醒过 |
| `docs/10-架构/架构设计-v4.md` | 0.29 续第 137 条加 ④ 补发并顺延、⑤ 补跑；第 7 节冷静期那句同步 |
| `docs/06-测试/测试用例-v4.md` | TC-B1-107 期望列（c[-5]）追加备注 |
| `docs/09-路线图/B1-接手清单-来自B0评审.md` | PURGE-cpu-budget 那一行追加返工后的准确说法（改正“最多晚一天”），状态没改 |

## 怎么做的

### 1. 预算按调用次数，两段分开（高 1）

- 每次调用 CPU 硬上限 2 秒（架构 0.47）。函数里拿不到 CPU 用量，墙钟又随线上延迟变（审查低 4），所以改数**调用次数**：列、删、查各算一次。`core.ts` 的 `countedDeps` 给依赖包一层计数：
  - 库的每个方法 1 次；取邮箱、deleteUser、发信各 1 次；
  - R2 的 `deletePrefix` 按“列 + 每千个删一次 + 再列”折算：`2 × (1 + ⌊删的个数 / 1000⌋) + ⌈删的个数 / 1000⌉`；
  - backups：列日期、列一个日期下的文件按每千个一页，删按每千个一次。
- 两段各一份计数、各一个上限：
  - 删除段 `PURGE_WORK_OPS = 400`：超了就不再认领新账号（`deferred`），正在做的账号在下一个检查点停下、放回认领；
  - 提醒段 `REMIND_WORK_OPS = 200`：超了这一轮就不再发，记 `remind_budget:<剩几封>`、心跳 `remind_left`，剩下的交给 15 分钟后的补跑。
- 墙钟上限 `PURGE_TIME_BUDGET_MS = 110000` 保留，两段共用兜底。
- 提醒按 `purge_after` 从早到晚发（`index.ts` 里 `order('purge_after')`，core 里再排一次），最急的先发。

### 2. 上限怎么定的

- 依据是本机 lemo-b2push 的两次实测（http、无 TLS）：
  - B1-left-pgnet-timeout 那次，一次请求做 3 × 400 个备份日期：约 3400 次调用时碰到 2 秒 CPU 硬上限，约 1850 次时报 CPU soft limit，折合**每次约 0.6 ms CPU**；
  - 这次返工复跑（下面第 3 节）：同一个 worker 连着处理几次请求，累计约 2400、3600 次调用时各报一次 soft limit（worker 在当次请求处理完以后退役，不是被掐断），和 0.6 ms 同一个量级。
- 线上是 https，TLS 和更大的 JSON 解析更耗 CPU，按 3 倍算约 1.8 ms：
  - 删除段 400 次约 0.7 秒 CPU，低于建议的 1.2 秒，离 2 秒硬上限留一倍以上余量；
  - 提醒段 200 次约 0.36 秒，两段加起来约 1.1 秒。
- 检查点只在真删了东西之后（第 3 小节），一轮实际会多出“这个账号已删空的日期各列一次”。普通账号约 7 个日期，可以忽略；400 个日期的极端情况，本机 3 × 400 实测一轮最多 424 次调用（下面“本机复跑”），线上折合约 0.8 秒。每个空日期多 1 次调用：单元测试里 640 个空日期一轮约 680 次，线上约 1.2 秒；空日期上千个才会贴近 2 秒，见文末“局限”。
- 吞吐（按复审问题 3 的计数改准，低 F）：一个普通账号（4 个桶各有少量对象、7 个备份日期）约 46 次调用，一轮约 8 个；一封提醒约 4 次（取邮箱、取 profile、发信、标记），另列一次，一轮约 49 封。
- 这个比例要在预览上复跑确认：函数日志里不能出现 `CPU time hard limit reached`（见“局限”）。

### 3. 检查点只在真删了东西之后（中 1、低 3）

- R2：某个桶这次删掉了对象（`deleted > 0`），而且不是最后一个桶，才判断预算。最后一个桶交给备份段，账号没有备份时直接走完（低 3）。
- backups：某个日期这次删掉了文件，而且不是最后一个日期，才判断预算。
- 空桶、空日期只列一次、不停。所以每一轮停下之前，至少真删掉一样东西；后面几轮不会因为“列已删空的日期”超了预算就原地打转。
- 代价：已删空的日期每一轮都要再列一遍。400 个日期的极端账号，后面几轮光列空日期就超上限，每轮只删得掉一个日期，单元测试里一共 28 轮才删完（本机 3 × 400 见下表）。服务器备份按 7 天轮换，一个账号约 7 个日期，碰不到。要彻底去掉这个代价得记住“删到哪个日期了”，要改表结构，这次没做。
- 真遇到空日期多到顶住 CPU 硬上限，worker 会被掐（认领 1 小时后过期，有 `purge:stuck` 和心跳缺失告警），不会无声地原地打转。

### 4. 不可逆步骤前的 110 秒保护（中 2）

- 写 `deleted_accounts`、`deleteUser` 之前只看 110 秒墙钟上限，不看调用次数：备份都删完了，剩下几次小查询，领了的账号尽量走完。
- 新测试：第 5 步（counters）做完时把时钟拨到 110 秒，断言 `time_budget`、没写 `deleted_accounts`、账号还在、认领已清；下一次运行从头再走一遍，删完。
- 旧测试“做到一半时间用完：在写 deleted_accounts 之前停下”实际停在第一个 R2 桶，按实际行为改名为“认领后墙钟就用完、R2 有对象：在第一个删了对象的桶之后停下（R2 检查点）”，并核对只调了第一个桶、备份段没开始。

### 5. 没收到到期提醒的不删；到期了还没提醒的补发并顺延（高 1；负责人 11-04 定 B）

- 约定先核对过：架构 0.29 续第 137 条①（满 7 天前 24～48 小时提醒、`notice_sent`）、第 131 条⑦（注销邮件）、TC-B1-107（A 一共收三封：申请、提醒、彻底删除）、TC-B7a-05（三封、正文没有链接）。
- 删除段第 0 步：`notice_sent` 不是 true 的不删、不认领，记函数日志 `purge_held_no_notice:<前 8 位>`，算进心跳 `held`（例外见第 12 节：没有邮箱的、扣满 3 天的照删）。
- 提醒段也取“已到期、还没提醒”的行（`listRemind` 去掉了 `purge_after > now` 的条件）：
  - 补发一封“删除时间已顺延”的提醒（`deletionReminderLateMail`，中、韩，不放链接），信里写新的时刻 = 现在 + 24 小时；
  - 发成功后一条 CAS：`update … set notice_sent = true, purge_after = <新时刻> where user_id = … and notice_sent = false and purge_after = <原值> and purge_started_at is null`；
  - 顺延只一次（改完 `notice_sent` 就是 true，不再进提醒段）；发信失败什么都不改、不顺延，账号也不删（held），下一次运行再补；
  - CAS 改不到（别的一次先顺延了、被认领了、restore 删了这一行）就不改，记 `remind_postpone_skipped`。这时 `notice_sent` 仍是 false 的照样不删；
  - 顺延以后 `purge_after` 在将来，restore 照常能用。这类账号的冷静期会超过 7 天（架构第 137 条④写明）。
- 正常窗口里的提醒照旧：先发、发成功再 CAS `notice_sent`，`purge_after` 不变。
- 告警：`purge_held_no_notice` 是函数日志；运维侧这类账号 `purge_after` 已过，lemo-ops 的 `purge:overdue`（到期超过 1 天还没执行）会报。

### 6. 补跑 cron（主持人同意）

- 新迁移 `20261104120000_core_account_purge_catchup_cron.sql`：03:45～05:30（首尔）每 15 分钟一次。pg_cron 按 UTC，即 18:45～20:30。
- 一条 cron 表达式写不出“18:45 起到 20:30 止”，所以分三条：
  - `account-purge-catchup-1`：`45 18 * * *`；
  - `account-purge-catchup-2`：`*/15 19 * * *`；
  - `account-purge-catchup-3`：`0,15,30 20 * * *`。
- 加上 03:30 那一条，一天 9 次。命令和 03:30 那一条一字不差（值从 Vault 读、不碰 public / private 的表，D1 的 `CRON_WITHOUT_USABLE` 不用加；URL 的 F9 核对已有）。
- 函数一次最长 110 秒墙钟、cron 间隔 15 分钟，前后两次不会重叠。

### 7. 两段都幂等

- 提醒：发过的 `notice_sent = true`，不再进候选；补发的顺延只一次。重复的唯一来源是“信发出去了、标记失败”，下一次运行会再发一封。这是第一版就定的“先发后标”的代价（少一封比多一封坏）。cron 自己不会撞上，只有手动补跑撞上 cron 时可能多一封。
- 删除：删过的桶、日期再列是空的；认领 1 小时内互斥；写 `deleted_accounts` 是 `on conflict do nothing`。

### 8. 心跳字段和 remaining 的口径（低 1）

- `detail` 只放数字：

  | 字段 | 含义 |
  |---|---|
  | `purged`、`failed`、`deferred`、`held` | 删除段这一轮的结果（`held` 含“没收到提醒”和“这一轮刚提醒过”两种） |
  | `forced` | `purged` 里没收到提醒就删的（没有邮箱、或扣满 3 天；第 12 节） |
  | `remaining` | `deferred + failed + held` |
  | `sent`、`postponed`、`remind_left` | 提醒段这一轮发出的、其中补发并顺延的、超了上限留给下一次的 |
  | `ops`、`remind_ops` | 两段各发了多少次调用 |
  | `ms` | 这一轮的墙钟 |

- `remaining` 是“这一轮列出的到期账号里没做成、下一次运行还会再看的个数”，**不等于还有多少账号等着删**：
  - 没到期的不在里面；
  - `skipped`（管理员、没停用、别人正在做）不算；
  - `failed` 里也可能有永远不会好的（`bad_user_id`），会一直算进去。

  这个口径写在 `core.ts` 的心跳注释里。
- 运维侧要不要看到（**后来已由 PURGE-heartbeat-ops 做了，见第 15 节**；下面是当时的建议）：当时 usage-report 的 `DETAIL_FIELDS` 不转发这些新字段，lemo-ops 只读 `age_s`，新字段不破坏它。建议（**这次没改白名单**）：
  - 把 `held` 和 `remaining` 两个数字加进 `DETAIL_FIELDS`；
  - lemo-ops 加两条：`held > 0` 当天就提示（有人没收到提醒、删号卡住了）；`remaining > 0` 连续 2 天提示（删号在积压）。
  - 按安全审查 D2-S2 的口径只加数字，要过安全审查。

### 9. 其余低项

- 低 2（半截状态跨天，中途被改成不停用 / 管理员就永远停在半截）：**没改**。要在 `pending_deletions` 加一个“已开始删数据”的标记（改表结构），或在 lemo-ops 对“有过 time_budget 又变成 skip 的账号”告警，按审查建议放到 B7a 前再定。边界写在这里：返工后普通账号一轮就删完，跨轮的只有备份日期特别多的账号。
- 低 3：改了，见第 3 小节。
- 低 4（8 秒对应 0.7 秒 CPU 是本机按 http 测的）：改成按调用次数，和线上延迟无关；CPU 比例按 3 倍放宽；仍要预览复跑确认。
- 低 5（工具默认的 `--expect timeout` 在 3 × 400 下过不了）：三种模式都改成多轮，默认 `rounds`；`timeout` 只判第 1 轮超时、而且那一轮的心跳晚于 5 秒。本机 3 × 400 的第 1 轮（三个账号的第一次运行要先列、删 R2 和前几十个日期）用了 5661 ms，超过 pg_net 的 5 秒，函数照样跑完、写了心跳，所以 `timeout` 模式本机这次过了；但它只比 5 秒多一点，换台机器可能不超时，所以默认用 `rounds`。

### 10. “最多晚一天”改正

- 一天 9 次运行，删除段一轮约 8 个普通账号、一天约 72～80 个；提醒段一轮约 49 封、一天约 440 封（按复审问题 3 改准，低 F）。
- 当天到期的超过这个量，就积压到第二天（不是“最多晚一天”），由 lemo-ops 的 `purge:overdue`（到期超过 1 天）告警发现。
- 没收到提醒的不删，补发并顺延 24 小时，所以这些账号会比 `purge_after` 晚至少 1 天删。
- 接手清单那一行已追加这段说法。

### 11. 复审低项（11-04）

- 低 A（顺延那一步写库出错会再发一封补发信）：没改代码，写进文末“局限”。
- 低 B：`core.ts` 文件头里“告警用”改准：这几个日志码只在函数日志里，没有告警通道直接读；运维侧靠 `purge:overdue` 兜底，转发进告警见接手清单 PURGE-heartbeat-ops。白名单没动。
- 低 C：补了两条测试。
  - `account-purge-budget.test.ts`“空桶不是检查点（复审低 C）”：第一个桶是空的、列完时墙钟已过上限，断言四个桶都列了、备份也删了，停在不可逆步骤前的 110 秒保护，下一轮删完。拦住变异 `emptyBucketStop`。
  - `account-purge-remind.test.ts`“库那边返回的顺序乱了”：`listRemind` 倒序返回，断言第一轮发的仍是最急的那些。拦住变异 `noSort`。
- 低 D：已在明早清单的预览复跑里，没改。
- 低 E：TC-B7a-05 的步骤加了“同时把 `notice_sent` 设为 true”，期望列（c[-5]）追加备注：不设的话真邮箱先补发并顺延、测试邮箱扣 3 天才删。
- 低 F：吞吐数字按复审改准（第 2 小节、第 10 小节、`core.ts` 常量注释）。
- 补发信文案按 B2 韩文审校（`docs/03-评审/B2/B2-韩文审校-补发删除提醒信.md`）改定：
  - 韩文按第四节全文：必改“탈퇴 유예 기간”→“탈퇴 대기 기간”；标题改成和②同一开头“레모 계정이 곧 완전히 삭제돼요 (삭제 시각 변경)”；补“죄송해요”、拆成三句；新时刻改成整句“레모 계정은 {when}에 완전히 삭제돼요.”。
  - 中文按建议 6（审校第三节）：标题“你的柠檬记账号即将彻底删除（删除时间已顺延）”；补“很抱歉”、写出“将在 {when} 彻底删除”；“选”改“点”。
  - 建议 4（“(Asia/Seoul)”的写法）、建议 5（“本信没有链接”一句）这次不改，要五封一起定。审校第三节第 3 条说②也顺带把“选”改成“点”，主持人 11-04 定：②（`deletionReminderMail`）中文里的“选”也改成“点”，只改这一个字，韩文不动。

### 12. 复审中 A、中 B（负责人 11-04 定）

- 中 A“只保证不在同一轮删”：
  - 第二段 `listDue` 改用本轮开始时刻 `t0`：第一段按 `t0` 判“还没到期”、发了普通提醒的，第二段不会因为跑到了 `purge_after` 之后就列进来；
  - 另外跳过这一轮第一段刚发过提醒（含补发）的账号（日志 `purge_held_just_reminded:<前 8 位>`，算进 `held`），下一轮才删。这一层管的是“补发了、顺延没写成，但 `notice_sent` 被并发的另一次标成了 true”这类情况；
  - 离到期不足 24 小时才收到提醒的不另外顺延，提醒到删除的最短间隔是一轮（15 分钟）。
- 中 B“等 3 天后照删并告警”：
  - 到期后还没提醒成功的，每轮照旧试着补发（第一段不变；进了照删期以后不再补发，见第 13 节）；
  - 从 `purge_after` 起超过 3 天（`PURGE_HOLD_MAX_MS`）还是发不出去，第二段照删，日志 `purge_forced_no_notice:<前 8 位>`；
  - Auth 里没有邮箱的（第一段取到 null，日志 `remind_no_email:<前 8 位>`），到期直接删，日志 `purge_no_email_no_notice:<前 8 位>`；
  - 两种都算进心跳新字段 `forced`（只算真删成的）；
  - `@lemomemo.test` 测试邮箱真函数不真发（`mail_skipped_test`），按同一条规则：扣 3 天，超过 3 天照删；TC-B7a-05 已对上（第 11 节低 E）。
  - 这几个日志码只在函数日志里。心跳里的 `held`、`remaining`、`forced` 已由 PURGE-heartbeat-ops 转发进 usage-report 并接上 lemo-ops 的提示（第 15 节，待安全审查）；`purge:overdue` 照旧兜底。
- 新测试 `tests/functions/account-purge-hold.test.ts`（8 条）：
  - 中 A：`purge_after` 只比 `t0` 晚 2 秒、发信花 5 秒，这一轮发普通提醒、不删、不另外顺延，下一轮才删；已经提醒过、第一段跑了 5 秒的，按 `t0` 这一轮不删；刚提醒过、顺延没成但 `notice_sent` 已是 true 的，这一轮不删（`purge_held_just_reminded`）；
  - 中 B：3 天内每轮照旧补发、不删，超过 3 天照删并记 `purge_forced_no_notice`；扣着的 3 天里补发成功就照常顺延；没有邮箱的到期直接删；没有邮箱但没到期的不删；`@lemomemo.test` 测试邮箱扣 3 天、之后照删、一封都没真发。
- 同步改了架构第 137 条（④ 加“例外见⑦”，新增 ⑥⑦）和 TC-B1-107 的期望列（c[-5]）备注 ⑦。
- 变异验证（独立副本 `scratchpad/mut-lowc`，node_modules 用联接）：基线 59/59 通过，下面 7 种每种至少 1 条失败。

  | 变异 | 失败条数 |
  |---|---|
  | `listDue` 改回用 `deps.now()` | 1 |
  | 不跳过本轮刚提醒过的 | 1 |
  | 不照删扣满 3 天的 | 2 |
  | 扣的时长改成 0（到期没提醒就照删） | 5 |
  | 没有邮箱的也扣着 | 1 |
  | 空桶之后也停（低 C） | 1 |
  | `core.ts` 里不排序（低 C） | 1 |

- 真库复跑：改完以后在本机 lemo-b2push 上再跑了一遍 `supabase/tests/store-it/purge-remind.it.ts`，3/3 过（第二段按 `t0` 列到期的，3 个到期的照样第 1 次运行就删完）；跑完 `supabase stop`，`docker ps` 前后一致。

### 13. 第三轮复审（11-04）

逐条对照代码核实过，审查员说的都成立。负责人定的两条规则（只保证不在同一轮删；3 天后照删并告警）不变，只把边界对齐。

- 中 C（必改）：照删期开始以后，第一段还在补发“已顺延”信。
  - 核实：`remind` 对 `pa <= now` 的一律补发并顺延，没区分是不是已进照删期；`listRemind` 不排除已认领的行。两个后果：
    - P1：照删删了一半、碰到上限停手，下一轮信又发得出去，就被顺延回冷静期，数据已缺一块却能 restore；
    - P2：照删认领后进程被掐、认领卡住，每轮补发一封（顺延因为已认领改不到），第二段又因“刚提醒过”跳过，永远不删。
  - 改法：
    - ① `core.ts` 第一段在判断“到期没提醒”之前加 `if (pa <= now - PURGE_HOLD_MAX_MS) continue;`：进了照删期，不再补发、不再顺延；
    - ② `index.ts` 的 `listRemind` 加 `.is('purge_started_at', null)`：正在删的不发提醒；假库 `account-fakes.ts` 的 `listRemind` 同样加了这个条件；
    - 原来那条测试顺带断言“照删那一轮还有 `remind_mail_failed`”，改成断言没有、且 `sent 0`。
  - 新测试（`account-purge-hold.test.ts`）：
    - P1：第 1 轮照删碰到上限停手（`deferred 1`、`forced 0`），第 2 轮信能发了，断言 `sent 0`、`postponed 0`、删完、只收到“已注销”一封；
    - P2：认领卡住、信能发，连跑 4 轮每轮 `sent 0`、一封没发，认领过期以后照删；
    - 还没到 3 天、认领卡住时第一段也不补发，`notice_sent`、`purge_after` 都不动（专门守 ②）。
  - 真库：`purge-remind.it.ts` 加了一个“已到期、没提醒、`purge_started_at` 刚写上”的账号，断言它一封没收到、没被标记也没被顺延，用来守 `index.ts` 里 `is('purge_started_at', null)` 这个真库查询条件。本机 lemo-b2push 3/3 过，跑完 `supabase stop`，`docker ps` 前后一致。
- 低 G：
  - “3 天改 4 天”没被拦住，是因为原测试的时刻用常量 `PURGE_HOLD_MAX_MS` 算，常量改了测试跟着变。现在改成字面量 3 天（`DAYS(3) + 1 分钟` 这一轮照删），并断言常量就是 3 天；
  - “没删成也算进 forced”：由 P1 第 1 轮（照删停手时 `forced` 是 0）守住。
- 低 H：TC-B1-107 的期望列、架构第 137 条里引用 ② 原文的“选‘恢复账号’”，都改成了“点”。
- 低 I：`purge_forced_no_notice`、`purge_no_email_no_notice` 只在真删成时记；判了照删、这一轮没删成的另记 `purge_forced_attempt:<前 8 位>`，不算告警码。P1 第 1 轮断言了这一点。
- 低 J：写进文末“局限”，`core.ts` 文件头也点了一句。
- 文档同步（主持人 11-04 定）：架构第 137 条 ⑦、TC-B1-107 期望列备注 ⑦ 都补了一句“进了照删期（从 `purge_after` 起超过 3 天）后不再补发、不再顺延；正在删的账号也不发提醒”。
- 为了让 `core.ts` 不超过 300 行（max-lines），把 `out.sent++` 和 `out.reminded.add(...)` 合到了一行，没改行为。
- 变异验证（独立副本 `scratchpad/mut-r3`，node_modules 用联接）：基线 62/62 通过，下面 7 种每种至少 1 条失败。

  | 变异 | 失败条数 |
  |---|---|
  | 扣 4 天才照删（低 G） | 4 |
  | 没删成也算进 `forced`（低 G） | 1 |
  | 没删成也记 `purge_forced_no_notice`（低 I） | 1 |
  | 照删期仍补发（去掉 ①，中 C） | 2 |
  | 假库 `listRemind` 不排除已认领的（②，中 C） | 1 |
  | `listDue` 改回用 `deps.now()`（复跑） | 1 |
  | 不跳过本轮刚提醒过的（复跑） | 1 |

### 14. PURGE-r4-low（第四轮复审 8.5 通过后剩下的低问题，11-04）

- 低 K：`tests/functions/account-fakes.ts` 超 max-lines。把 account-purge 用的那套假库（`PurgeStore` 的内存版，原来是 `FakeDb.purgeStore()` 的方法体）挪到新文件 `tests/functions/account-purge-fakes.ts` 的 `fakePurgeStore(db)`。
  - `FakeDb.purgeStore()` 留成一行转调，调用方一个都不用改；
  - `FakeDb.guard` 新文件也要用，所以从 private 改成了公开；
  - `FakeBackups`、`purgeDeps` 没挪：它们要用 account-fakes.ts 里的值（`CRON`、`mailer`），挪过去会两个文件互相引用；
  - 新文件只 import FakeDb 的类型，运行时不互相引用。拆完 eslint 不再报 max-lines，行为不变（基线 63 条照过）。
- 低 L：`listRemind` 加了时间下限：
  - 接口改成 `listRemind(until, since)`，`since = now - 3 天`，只列 `since < purge_after <= until` 的。照删期的行不再列出来，第一段碰上限时 `remind_left` 不会把它们算进去；
  - `index.ts` 加 `.gt('purge_after', sinceIso)`，假库同样加了这个条件；
  - `core.ts` 里第三轮加的“照删期 continue”留着兜底；
  - 新测试（remind 测试）：5 个到期超过 3 天的加 60 个窗口里的，第一轮 `remind_left` 正好是 10，不是 15；`listRemind` 一个照删期的都没列；照删期那 5 个只收到“已注销”一封；
  - 真库：`purge-remind.it.ts` 新加一条，直接调 `makeStore(admin).listRemind`：到期 3 天又 10 分钟的不列，到期差 10 分钟满 3 天的照列。本机 lemo-b2push 4/4 过，跑完 `supabase stop`，`docker ps` 前后一致；
  - 两处测试里包装 `listRemind` 的替身，原来只转发一个参数，改成两个都转发。
- 低 M：写进文末“局限”。
- 变异（独立副本 `scratchpad/mut-r4`，node_modules 用联接，用完已删）：基线 63/63，下面 4 种每种至少 1 条失败。

  | 变异 | 失败条数 |
  |---|---|
  | `core.ts` 传的下限改成 1970 年（等于没有下限） | 1 |
  | 假库 `listRemind` 不看下限 | 1 |
  | 假库 `listRemind` 不排除已认领的（复跑） | 1 |
  | 没有下限、也去掉照删期 continue | 3 |

### 15. PURGE-heartbeat-ops（11-04，待安全审查）

- usage-report：`DETAIL_FIELDS` 白名单加了 `held`、`remaining`、`forced` 三个数字字段。
  - 和 D2-S2 同一口径：只加数字、不加别的，非数字一律丢；
  - account-purge 心跳本来就只有数字、没有任何账号标识；
  - 白名单是所有心跳共用的，别的心跳写了同名数字也会转发，但 lemo-ops 只看 account-purge 那一行。
- lemo-ops：新模块 `workers/lemo-ops/src/purge-detail.ts`（照 orphans.ts 的写法拆出，免得 rules.ts 超行数），由 `evaluateHeartbeat` 调用。
  - 三条提示：

    | key | 条件 | 什么时候发 |
    |---|---|---|
    | `purge:held` | `held > 0` | 当天（这一轮就发） |
    | `purge:remaining` | `remaining > 0` | 连续 104 轮（26 小时）都 > 0 才发 |
    | `purge:forced` | `forced > 0` | 当天（这一轮就发） |

  - key 都以 `purge:` 开头，已在 `HEARTBEAT_SCOPES` 里，“已恢复”、6 小时去重、每天限额照 alerts.ts 的通用做法；
  - 标题不带个数，正文只写个数，不写 user_id、邮箱；文案中文，照现有写法；
  - “连续 2 天”的口径：心跳只记最近一轮，最后一轮的值留到第二天 03:30。偶尔 > 0 是正常的（留给 15 分钟后的补跑），所以用 alerts.ts 已有的 `minRounds` 宽限期，要连续 26 小时都 > 0 才发。26 小时盖住了第二天整段运行时间（03:30～05:30），意思是连着两天的运行都没清到 0；中间只要抽到一轮是 0，就从头算。
- 局限：
  - `forced` 是“这一轮发生了”的数，下一轮通常就回到 0，所以这件事随后会报“已恢复”；
  - lemo-ops 每 15 分钟只抽一次心跳，和 account-purge 的运行刚好错开时，可能漏看某一轮的 `forced`（和推送失败比例是同一个抽样局限），漏掉的那次在函数日志 `purge_forced_no_notice` 里还在；
  - 要不漏，得让 account-purge 在心跳里按天累计，要改 `core.ts`，这次没做。
- 测试 `tests/functions/lemo-ops-purge.test.ts`（9 条）：
  - 白名单：account-purge 真写的 12 个键，只放行 purged、failed、held、remaining、forced（和原有的 sent、ms）；三个新键是字符串、布尔、对象、数组、null 的都丢；混进来的 user_id、邮箱不转发；
  - 判断边界：0 不报、1 就报；负数、小数、字符串、缺字段不判；标题不带个数；只看 account-purge 那一行；
  - 端到端（真 usage-report 白名单 → 判断 → 去重发信）：`held` 这一轮就发、回到 0 两轮后发“已恢复”；`forced` 这一轮就发；`remaining` 第 103 轮不发、第 104 轮发，中间有一轮回到 0 就从头算。
  - `lemo-ops-harness.ts` 加了 `setPurgeDetail`（照 `setPushDetail` 的写法）。
- 变异（独立副本 `scratchpad/mut-hbops`，含 workers 目录，node_modules 用联接，用完已删）：跑 lemo-ops、usage-report、push-dispatch 对齐测试共 184 条，基线全过，下面 10 种每种至少 2 条失败。

  | 变异 | 失败条数 |
  |---|---|
  | 白名单少 `held` | 3 |
  | 白名单少 `remaining` | 2 |
  | 白名单少 `forced` | 2 |
  | 白名单不看类型（字符串等也转发） | 3 |
  | `held >= 0` 就报 | 3 |
  | `forced` 要大于 1 才报 | 2 |
  | `remaining` 没有宽限期 | 2 |
  | `remaining` 宽限期改成 24 小时 | 2 |
  | 读的是 push-dispatch 那一行 | 4 |
  | `evaluateHeartbeat` 没接上 | 4 |

- 为了不让 `rules.ts` 超 max-lines（改之前正好 300 行），把 account-purge 现有的两条 `purge:overdue`、`purge:stuck` 连同常量 `PURGE_OVERDUE_S`、`PURGE_STUCK_S`，原样挪进 `purge-detail.ts` 的 `evaluatePurgePending`。`rules.ts` 照旧导出这两个常量，行为不变，原有测试全过。挪完在第二个独立副本里重跑了一组变异：

  | 变异 | 失败条数 |
  |---|---|
  | 没接 `evaluatePurgePending` | 4 |
  | 没接 `evaluatePurgeDetail` | 4 |
  | 读的是 push-dispatch 那一行 | 4 |
  | 逾期改成 2 天 | 3 |
  | 卡住改成 25 小时 | 1 |

- 不涉及数据库（没有迁移、没有 SQL），这次没起本机 lemo-b2push。
- 没改 `account-purge/core.ts`（在复审）。它文件头里还写着“held、forced 也不进 usage-report 白名单（接手清单 PURGE-heartbeat-ops）”，这句注释已经过时，等复审完一起改。

## 单元测试

`tests/functions/account-purge-budget.test.ts`（8 条，复审后加了低 C 一条）、`account-purge-remind.test.ts`（14 条，复审后加了低 C 一条、PURGE-r4-low 低 L 一条）、`account-purge-hold.test.ts`（11 条，复审中 A、中 B 和第三轮中 C，见第 12、13 节）、`account-purge-schedule.test.ts`（新增中 2 一条、改名一条），连同 `account-purge.test.ts` 共 5 个文件 63 条，全过。假库在 `tests/functions/account-purge-fakes.ts`（第 14 节）。

- 删除段：
  - 做完 A 时次数用完，B 不认领，15 分钟后的补跑接着做完；
  - `remaining = deferred + failed + held`，心跳的键正好是那 12 个（复审后加了 `forced`）、都是数字；
  - R2 检查点停下、放回认领，15 分钟后做完；
  - 空桶不停（低 3）；
  - 400 个日期分 28 轮删完、每轮严格变少、都有心跳、都放回认领，B 的不少；
  - 中 1：前 640 个日期已删空、只剩 10 个时，每轮删一个（9、8、…、1、0），不原地打转；
  - 中 1 墙钟版：列空日期花的墙钟超过 110 秒也不停，删掉一个日期才停。
- 提醒段：
  - 60 个账号同在窗口：第一轮发到上限（50 封）停、记 `remind_budget:10`，按到期先后；第二轮发完剩下的 10 封；第三轮一封不发；每人正好一封；
  - 60 封提醒的同一轮里到期的 A 照样删掉；
  - 两段计数各记各的。
- 补发并顺延：
  - 补发的信和时刻；
  - 顺延只一次（之后每 15 分钟跑都不再发，到新时刻照常删，A 一共三封）；
  - 发信失败不顺延、不删（held、告警日志），下一次发成功才顺延；
  - CAS 冲突三种（别人先顺延、被认领、被 restore 删了）都不顺延、不删；
  - 顺延之前 restore 回 `expired`、顺延之后回 `ok`；
  - 正常窗口里的提醒不顺延；
  - 中、韩文案写新时刻、没有链接。
- 变异验证（按 11-04 新规矩在独立副本里做：`scratchpad/mut-purge`，node_modules 用联接；共享工作区不动）：基线 49/49 通过，下面 11 种每种至少 1 条失败。

  | 变异 | 失败条数 |
  |---|---|
  | 空日期也停（中 1） | 2 |
  | 去掉不可逆步骤前的 110 秒保护（中 2） | 1 |
  | 两段共用计数 | 2 |
  | 不看 `notice_sent` | 2 |
  | 提醒段不设上限 | 1 |
  | R2 空桶、最后一桶也停 | 2 |
  | 不按到期先后发 | 1 |
  | 发信失败也顺延 | 2 |
  | 到期的不补发 | 7 |
  | 顺延不加 24 小时 | 5 |
  | 删除段不看上限 | 1 |

  这一组之前（新规矩之前），我在共享工作区里对第一版上限做过一组 8 种的变异，已向主持人说明。

## 本机 lemo-b2push 复跑

- 环境同 B1-left-pgnet-timeout：scratchpad 里的 supabase/ 副本，同步了新的 functions/ 和 migrations/；`supabase db reset` 重放迁移和 seed（含新迁移）；跑完 `supabase stop`。
- 前后各记一次 `docker ps`（名字和端口）做对比；lemomemo 的容器开始前就在跑，没动。
- 补跑迁移：在本机库跑 `supabase test db` 的 rls/12、rls/34，2 个文件 11 条全过。`cron.job` 里是 `account-purge`（`30 18 * * *`）和三条补跑。

- 真库 store-it：`supabase/tests/store-it/purge-remind.it.ts` 3/3 过（Resend 拦 fetch 记收件人）。场景：3 个到期（各有 R2 和一份备份）、60 个 48 小时内要提醒、2 个已到期没提醒。
  - 第 1 次运行：3 个全删（purged 3、failed 0、held 0），提醒段停在上限（remind_left > 0）；
  - 之后的运行把提醒发完，每人正好一封，第 1 次运行按到期先后发（先是 2 个已到期的），最后一次一封不发；
  - 窗口里的 `purge_after` 不变；补发的 2 个顺延约 24 小时、`notice_sent = true`、没删，其中一个顺延后 `account_restore` 回 `ok`；
  - `account-store.it.ts`、`invite-admin` 同时跑，共 16 条过。
- 边缘运行时 3 × 400（`tools/e2e/pgnet-timeout-purge.mjs --users 3 --dates 400 --expect rounds`）：

  | 项 | 结果 |
  |---|---|
  | 轮数 | 84 轮（每个账号 28 轮，和单元测试一致） |
  | 第 1 轮 | pg_net 超时（5 秒），函数 5661 ms 跑完、写了心跳 |
  | 其余各轮 | 都回 200 |
  | 一轮最多调用次数 | 424 |
  | CPU | 没有 `CPU time hard limit reached`；soft limit 18 次（worker 处理完当次请求后退役） |
  | 认领 | 每轮结束都放回，0 留存；每轮都有心跳 |
  | ①～⑤ | 全过；三个账号都删干净；对照账号 B 的 400 个备份、R2 各 2 个前后不变 |

- 边缘运行时“多账号到期 + 一批要提醒”（`--users 3 --dates 7 --remind 80`）：
  - 第 1 轮 purged 3、ops 139、held 0、remaining 0：删号没被提醒段挤占，一轮删完；
  - 提醒段 remind_ops 202、remind_left 73：停在自己的上限（200），留给下一次；
  - 80 个要提醒的账号一个没删、没认领；①～⑤、④' 全过；
  - 本机这些账号的邮箱是 `@lemomemo.test`，函数不真发（`mail_skipped_test`），算发信失败，每个账号只用 3 次调用、不标记，所以这个场景看的是“停手、不挤占删除”；“一封不漏、不重复”由上面的 store-it 拦 Resend 验证。
- 第一次用 `--remind 60` 跑：60 × 3 + 1 = 181 次没到上限，看不到停手，所以改用 80，并在工具用法里写明要 N ≥ 67。
- 跑完 `supabase stop`；`docker ps` 前后对比一致（只有 lemomemo 的 8 个容器，lemo-b2push 没有残留）。

## 局限

- 低 A：补发信发出去了、顺延那一步写库出错（网络断）时，这一行仍是 `notice_sent = false`、`purge_after` 已过，第二段不删（`held`）；15 分钟后再补发一封、写新的时刻再顺延。用户会收到两封补发信，时刻以后一封为准，不会提前删。同样，手动补跑撞上 cron 时可能各发一封，只有一次顺延成功。没加“以最新一封为准”这句，要加的话得和韩文审校一起定。
- 低 M（第四轮）：没有邮箱的账号，如果照删时认领卡住了，要等满 3 天才删。原因是认领卡住以后第一段不再列它（`purge_started_at` 不为空），它就进不了 `noEmail`；认领过期以后第二段列出它，判成 `held`，直到满 3 天按 `purge_forced_no_notice` 照删。不会永远扣着，也不会发信，只是晚一些。没改代码。
- 低 J（第三轮）：发信接口超时、但 Resend 其实已经收下的那次，`sendMail` 回 false，函数当作没发出去；用户手里却有一封写着“现在 + 24 小时”的补发信。到了第 3 天照删，可能早于信里写的时刻。只在发信接口超时时出现，没改代码。
- 中 B 的代价：发信一直失败（比如正式库没配好发信钥匙）的账号，从 `purge_after` 起 3 天后照删，用户可能一封提醒都没收到。这是负责人定的取舍；能发现靠 `purge:overdue` 和函数日志 `purge_forced_no_notice`。

- 吞吐：400 个日期的账号要 28 轮（一天 9 次，约 3 天）才删完，因为已删空的日期每一轮都要再列一遍。要根治得记住“删到哪个日期了”，要在 `pending_deletions` 加列（改表结构），这次没做，请主持人定要不要另开一项。普通账号（约 7 个日期）一轮删完，不受影响。
- 空日期特别多（几百个以上）时一轮的调用次数会超过上限不少（中 1 的代价），线上折算可能贴近 2 秒 CPU 硬上限；真被掐了有 `purge:stuck` 和心跳缺失告警。
- CPU 比例（每次约 0.6 ms、线上按 3 倍）是本机 http 测的，要在预览上复跑确认函数日志里没有 `CPU time hard limit reached`。
- 本机发信不真发，“提醒一封不漏”只在 store-it（拦 Resend）里验证；预览上要看一次真信。
