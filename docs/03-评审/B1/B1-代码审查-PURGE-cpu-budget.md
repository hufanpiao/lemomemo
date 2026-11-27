# B1 代码审查：PURGE-cpu-budget（account-purge 按工作预算停手）

- 日期：2026-11-04
- 审查人：独立代码审查员（只读；除本文件外没有改任何文件，没有 git add，没有连数据库、没有起 docker）
- 范围：工作区未提交改动 `supabase/functions/account-purge/core.ts`；配套 `tests/functions/account-purge-budget.test.ts`、`tools/e2e/pgnet-timeout-purge.mjs`（`--expect rounds`）、`docs/03-评审/B1/PURGE-cpu-budget-执行记录.md`
- 参照：`docs/09-路线图/B1-接手清单-来自B0评审.md` 第 213、214 行；架构 0.47（每次调用 2 秒 CPU）；`supabase/migrations/20261029171000_core_account_purge_cron.sql`（每天 18:30 UTC 一次）；`workers/lemo-ops/src/rules.ts`；`supabase/functions/usage-report/core.ts`

## 总分：6.5 / 10（不通过）

主体思路是对的：检查点都在可逆的步骤上，停手时只清自己的认领，不可逆的两步（写 `deleted_accounts`、`deleteUser`）前面只看 110 秒墙钟上限；backups 逐日期核对没有降低严格程度；心跳新字段不影响 lemo-ops。单元测试和类型检查全过，变异验证里 4 个关键点有 3 个能拦住。

不通过的原因有三条：
1. 预算从 110 秒降到 8 秒，而且提醒和删除共用这 8 秒，cron 又是一天一次，所以一天能处理的账号数大约降了一个数量级。提醒挤不进去的账号会在没收到到期提醒的情况下被删掉。执行记录和接手清单里“最多晚一天”的说法，在待删账号积压时不成立（高 1）。
2. 空日期之后也设了检查点，“每轮至少做完一个日期”保证的只是往后走一个日期，不保证真删掉东西，可能原地打转（中 1）。
3. 去掉不可逆步骤前那道 110 秒保护，现有测试拦不住；旧测试名字写的是“在写 deleted_accounts 之前停下”，现在实际停在第一个 R2 桶（中 2）。

---

## 高

### 高 1　8 秒预算由提醒和删除共用，cron 一天只跑一次：日处理量骤降，提醒会被挤掉，“最多晚一天”不成立

- 位置：
  - `supabase/functions/account-purge/core.ts:278-280`（`budget = min(8 s, 110 s)`）
  - `core.ts:284`（`remind(d, t0, overBudget)`：提醒也用 8 秒预算）
  - `core.ts:152`（提醒超预算就 `break`）
  - `core.ts:302`（删除段超预算就 `deferred`）
  - `supabase/functions/account-purge/index.ts:38-39`（`listRemind` 没有 `order`）
  - `supabase/migrations/20261029171000_core_account_purge_cron.sql:13`（`'30 18 * * *'`）
  - `docs/09-路线图/B1-接手清单-来自B0评审.md:214`（“最多晚一天”）
- 出错场景：
  1. **删除吞吐。** 一个 7 个备份日期的普通账号，一轮大约要 35～45 次串行网络调用：认领、isAdmin、profile、getUserById；4 个桶各“列、删、再列”；listDates；7 个日期各列一到两次；邮箱哈希两样；counters；stillClaimed；insert；deleteUser；remainingRows；发信。线上每次调用按 60～150 ms 算，一个账号要 2.5～6 秒墙钟，8 秒预算一天只够删 1～3 个账号。改之前是 110 秒，一天能删几十个。某天到期的账号超过当天的处理量，积压就会一天天往后滚，不是“最多晚一天”。lemo-ops 的 `purge:overdue`（`rules.ts:70`，24 小时）会告警，但除了改代码或手动补跑，没有自动消化积压的办法。
  2. **提醒被挤掉。** 提醒先跑，每封要 getUserById、profile、sendMail、casNotice，0.3～1 秒墙钟，绝大部分是等网络，不花 CPU。8 秒大约只够 8～20 封。48 小时的提醒窗口里 cron 只跑约 2 次，`listRemind` 又没排序，挤不进去的账号是随机的。过了 `purge_after` 就不在 `listRemind` 的条件里了，删除段也不看 `notice_sent`，结果就是有的账号没收到到期提醒就被删了。这违反“申请、到期前提醒、彻底删除共三封”（TC-B1-107、TC-B7a-05），而且这条不会告警。
  3. 两段共用预算，还意味着提醒多的那一天，删除段可能一个都不认领（全部 `deferred`）。
- 建议改法（任选其一或组合；涉及 cron 的要主持人定）：
  - 提醒段不用工作预算，只用 110 秒墙钟上限（它的 CPU 很少，墙钟几乎都在等发信）。至少要让提醒和删除各用各的预算，不共用一个 `t0`。`listRemind` 加 `.order('purge_after')`，先提醒最早到期的。
  - 工作预算不要用墙钟估，改成数“CPU 代理量”，比如本轮已经发出的存储调用次数、或者列出和删除的对象数。线上延迟高，8 秒墙钟会白白浪费；按次数计更贴近 CPU，也和延迟无关。
  - 加补跑：03:30～04:30 每 10～15 分钟一次（没有待删账号时，函数几次小查询就返回）。要改 cron 迁移，交主持人定。
  - 不管选哪种，都要把接手清单第 214 行和执行记录“前提和边界”里的“最多晚一天”改成准确的说法：日处理量上限大约是多少、超了会积压、靠 `purge:overdue` 告警发现。
  - 补测试：提醒数量多到超过 8 秒时，删除段仍能认领；或者提醒按 `purge_after` 先到先发。

## 中

### 中 1　空日期之后也设检查点：“至少做完一个日期”只保证往后走一个日期，不保证删掉东西，可能每轮原地打转

- 位置：`core.ts:210-218`，特别是 `core.ts:217` 的 `if (i < dates.length - 1 && overBudget())`
- 出错场景：第 1 轮删掉了前 k 个日期。第 2 轮从头开始，R2 四个桶再列一遍（空），前 k 个已经删空的日期也逐个再列一遍。如果“R2 空列 + k 个空日期各列一次”就超过 8 秒，第 2 轮会在某个**空日期**之后抛 `time_budget`，一个文件都没删，第 3 轮一模一样，一直到永远。比如线上延迟高，或者备份轮换出了问题、日期多起来。每一轮认领都放回了，`purge:stuck` 不会报。`purge:overdue` 会报，但系统自己收不了尾。执行记录第 5 条说“避免了原地打转”，这只对“第一轮”成立；后面几轮的进展条件就是那条前提（“各列一次放得进一轮”），而这条前提在代码里没有兜底。单元测试的 `FakeBackups.listUserFiles` 不花时间，测不到这种情况（`account-purge-budget.test.ts:117-131` 只把 `remove` 放慢了）。
- 建议改法：只在**真删了文件**的日期之后设检查点：`if (files.length && i < dates.length - 1 && overBudget())`。空日期只列一次、不停，这样每一轮至少真删掉一个日期，后面几轮的进展不再依赖“空日期列得够快”。真遇到空日期多到顶住 CPU 上限的情况，worker 会被掐（认领 1 小时后过期，有 `purge:stuck` 和心跳缺失告警），不会无声地原地打转。我在内存里把这一行换成上面的写法跑了全部 account-purge 测试，35/35 通过，和现有用例不冲突。另外补一条测试：`listUserFiles` 每次调用拨时钟，前几轮删空的日期列起来很慢，断言每一轮剩下的备份数严格减少。R2 那边可以照同样的思路改：只在 `deletePrefix` 返回 `deleted > 0` 时设检查点（见低 3）。

### 中 2　不可逆步骤前的 110 秒保护没有测试守着；旧测试名不副实

- 位置：`core.ts:236`；`tests/functions/account-purge-schedule.test.ts:33-45`
- 出错场景：旧测试“做到一半时间用完：在写 deleted_accounts 之前停下”是在 `userEmail` 里把时钟拨 110 秒。改动之后，第一个 R2 桶的检查点（`core.ts:205`）先触发，根本走不到第 236 行。我在内存里把第 236 行整行删掉（`noWall`）跑全部 account-purge 测试，35/35 仍然通过。也就是说，以后谁把这道“不可逆步骤前停手”的保护删了或改坏了，CI 看不出来。这一行是本次改动里唯一守着 `deleted_accounts`、`deleteUser` 不在 150 秒墙钟边上开工的保险。
- 建议改法：加一条测试，在第 5 步（`deleteUserCounters`）或最后一个日期的 `remove` 里把时钟拨到 `PURGE_TIME_BUDGET_MS`，断言 `time_budget`、`deleted_accounts` 没写、`auth.users` 还在、认领清掉。旧测试改名为“R2 检查点停手”，或者改成上面这种注入方式。

## 低

### 低 1　`remaining` 的口径不一致，而且 usage-report 不转发它，lemo-ops 看不到

- 位置：`core.ts:319`；`supabase/functions/usage-report/core.ts:112`（`DETAIL_FIELDS` 没有 `remaining`、`deferred`）
- 场景：
  - `failed` 里有永远不会好的，比如 `bad_user_id`，它会一直算进 `remaining`。
  - `deferred` 里有轮到了也只会 `skipped` 的行（管理员、没停用的），同一个账号预算紧的那天算 `remaining`、不紧的那天不算。
  - lemo-ops 这边：`rules.ts` 只读 account-purge 的 `age_s`，usage-report 的 `pickDetail` 按白名单丢掉了 `remaining`、`deferred`。所以新字段**不会破坏** lemo-ops，但执行记录里“每一轮都写心跳，detail 带 remaining”在运维侧其实看不到，只能直接查 `private.heartbeat`。
- 建议：注释里写清楚 `remaining` 只是“本轮没做成的数”，不等于“还有多少账号等着删”。如果想让运维看到，按安全审查 D2-S2 的口径（只加数字），把 `remaining` 加进 `DETAIL_FIELDS`，并在 lemo-ops 加“连续 N 天 remaining > 0”的提示。这要过安全审查。

### 低 2　半截状态从“一轮之内几秒”变成“可能跨好几天”：中途被改成不停用，就永远停在半截

- 位置：`core.ts:193-196`（每轮重新核对 `isAdmin`、`disabled_at`、`disabled_reason`）
- 场景：第 1 轮已经删了 R2 和部分备份，之后管理员误操作，把这个账号的 `disabled_at` 清了，或者把它设成管理员。后面每一轮都是 `skip_not_disabled` 或 `skip_admin`，账号活着、数据却缺了一块，没人收尾。这种情况以前也有（第 2～7 步失败的时候），但窗口很短。现在大账号会正常地跨天停在半截，窗口变长了。
- 建议：在 `pending_deletions` 加一个“已开始删数据”的标记（或者在第一个检查点写一个时间戳），之后的轮次只要看到这个标记，就不再因为 `skip_*` 跳过；或者 lemo-ops 对“有过 time_budget 又变成 skip 的账号”告警。可以 B7a 前再定，至少先在文档里写明这个边界。

### 低 3　R2 第 4 个桶之后、backups 为空时也会停

- 位置：`core.ts:203-206`
- 场景：账号没有任何备份日期（`dates` 为空），第 4 个桶删完正好超预算，这一轮也会停下，拖到第二天，而剩下的只是几次小查询。这和“最后一个日期做完不停”的理由不一致。R2 空桶之后的检查点同样不推进任何进度（同中 1）。
- 建议：最后一个桶不设检查点，交给 backups 段去判断；或者只在 `deleted > 0` 时才判断。

### 低 4　8 秒对应 0.7 秒 CPU 是本机按 http、无 TLS 测出来的

- 位置：`core.ts:50-55` 的注释
- 场景：本机的存储和 R2 走容器内的 http；线上每次调用都是 https，TLS 和更大的 JSON 解析会占更多 CPU；同时线上延迟更高，墙钟和 CPU 的比例可能往两边偏。执行记录已经写了“预览复跑看 `CPU time hard limit reached`”，这里只是提醒：要在预览上复跑完、看过日志，再把这个值当作定值。这也是高 1 建议改成“按调用次数计”的原因之一。

### 低 5　工具默认的 `--expect timeout` 在 3 × 400 下已经过不了

- 位置：`tools/e2e/pgnet-timeout-purge.mjs:43`、`:189`
- 场景：默认参数（3 个账号、400 个日期）下，单轮只能删 1 个账号，`detail.purged === nUsers + carried.length` 必然失败。而想要“超过 5 秒、又能一轮删完”，只有 5～8 秒这个很窄的区间。B1-left-pgnet-timeout 的执行记录照原命令复跑会误报失败。
- 建议：在用法注释里写清楚，timeout 模式要配 `--users 1` 和合适的 `--dates`（让一轮落在 5～8 秒）；或者 timeout 模式改成判各轮 purged 合计。

### 其他核对（没问题的）

- **问题 1（删除顺序、能不能接着删完）**：检查点只在第 2、3 步（可逆、幂等）之后。停手时 `auth.users`、`profiles`、`pending_deletions` 都在，`deleted_accounts` 没写，认领清空；`purge_after` 已过，restore 会拒；backup-daily 按设计跳过停用账号（ADR-016、TC-B7a-05），不会再生成新备份。下一轮从头再走，删过的部分列出来是空的。除中 1 和低 2 两种情况外，都能收尾。
- **问题 2（并发）**：`release` 是 `update … where user_id = $1 and purge_started_at = claimedIso`（`index.ts:52-53`），只清自己那一条。清完之后，本轮不会再碰这个账号（`giveUp` 直接返回，同一轮的 `due` 循环每个账号只走一次），所以下一轮认领后不会和本轮重叠。第 6 步的 `stillClaimed` 照旧防住了认领被别人接手。
- **问题 3（backups 严格程度）**：有文件的日期删完马上再列，不为 0 就抛错，和原来等价。空日期原来要列两次，现在列一次。原来第二次列只能抓到“两次列之间又冒出来的文件”，而 backup-daily 跳过停用账号，这种情况不该发生；原来对“listDates 之后新冒出来的日期”也同样抓不到。所以严格程度没有实质降低。子目录照样抛 `BackupsSubdirError`。有没有原地打转的风险，见中 1。
- **问题 4（预算边界）**：“最后一个日期不停”（`i < dates.length - 1`）、第 6 步前只看 `overWall`，都对，测试能拦住（见下面的变异表）。`Math.min(PURGE_WORK_BUDGET_MS, PURGE_TIME_BUDGET_MS)` 没问题。
- **问题 5（心跳）**：`remaining = deferred + failed` 的计算本身对，口径问题见低 1；lemo-ops 不受影响。
- **问题 7（项目规矩）**：`core.ts` 和工具里都没有写死密钥、邮箱、主机名。工具的容器主机名由 `--container-host` 传入（F10），测试邮箱是随机的 `@lemomemo.test`（以前就是这样）。注释里的 `lemo-b2push` 是本机 supabase 项目名，不是主机名。执行记录写了没连预览库和正式库，审查期间我也没连。

---

## 跑过的命令和结果

| 命令 | 结果 |
|---|---|
| `git status --short`、`git diff --stat`、`git diff supabase/functions/account-purge/core.ts`、`git diff tools/e2e/pgnet-timeout-purge.mjs` | 看改动 |
| `npx vitest run tests/functions/account-purge-budget.test.ts tests/functions/account-purge.test.ts tests/functions/account-purge-schedule.test.ts tests/functions/lemo-ops-rules.test.ts tests/functions/lemo-ops.test.ts` | 5 个文件 71 条全过 |
| `npx tsc -p tsconfig.functions.json`、`npx tsc -p tsconfig.node.json` | 0 错误 |
| 变异验证：scratchpad 里写一个 vitest 配置（`C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\mut.config.mjs`），用 `load` 钩子在内存里改 `core.ts`，仓库文件不动；`MUT=<名字> npx vitest run --root . --config <它>`，跑 `tests/functions/account-purge*.test.ts` 共 35 条 | 见下表 |

| 变异 | 改了什么 | 结果 |
|---|---|---|
| none | 不改 | 35/35 通过 |
| noRelist | 删掉备份“删完再列一次为 0” | 拦住（1 条失败） |
| wallAtStep6Budget | 第 6 步前把 `overWall` 换成 `overBudget` | 拦住（2 条失败） |
| noR2Check | 删掉 R2 每桶之后的检查点 | 拦住（1 条失败） |
| **noWall** | **删掉第 236 行（不可逆步骤前的 110 秒保护）** | **没拦住：35/35 通过（中 2）** |
| emptyNoStop | 中 1 建议的写法（只在删过文件的日期之后判断预算） | 35/35 通过（说明建议写法和现有用例兼容；现有用例也测不到空日期打转） |

没有跑任何连数据库、起 docker 的命令；没碰 `D:\claude code\待办APP`。

---

## 复审（2026-11-04，返工后）

- 范围：工作区未提交改动，`core.ts`、`index.ts`、`_shared/account-mail.ts`，新迁移 `20261104120000_core_account_purge_catchup_cron.sql`，`tests/functions/account-*`（含新文件 `account-purge-remind.test.ts`），`tests/data-manifest/purge-runner.ts`，`supabase/tests/store-it/*`（含 `purge-remind.it.ts`），`supabase/tests/rls/34_account_purge_catchup_cron.test.sql`，`tools/e2e/pgnet-timeout-purge.mjs`，执行记录，架构第 137 条，TC-B1-107。
- 返工方案（按调用次数算预算、补跑 cron、补发并顺延 24 小时、没提醒的不删）是主持人和负责人定的，这里只审代码有没有把方案做对。下面的中 A、中 B 是方案落到代码里以后才出现的情况，要不要改由主持人和负责人定。
- 尺度和上一轮相同。

### 复审总分：7.5 / 10（不通过；改掉中 A、中 B 由负责人定了做法以后，可以到 8 分以上）

上一轮的高 1、中 1、中 2 都解决了，测试也能拦住回退。这一轮新发现两条中问题：
- 中 A：同一轮里可以先发“即将删除”的提醒、几秒后就把账号删掉。补跑 cron 也把“提醒到删除”的最短间隔从至少一天缩到了 15 分钟。
- 中 B：信一直发不出去的账号（没配发信钥匙、测试收件人、邮箱为空、Resend 一直拒收）会永远不删。

### 上一轮问题逐条核对

| 上一轮 | 结论 | 依据 |
|---|---|---|
| 高 1（共用 8 秒、日处理量骤降、提醒被挤掉、“最多晚一天”不对） | **已解决** | 两段各算各的调用次数（`core.ts:368-375`、`:389`），110 秒墙钟兜底（`:366`）；`listRemind` 按 `purge_after` 排序（`index.ts:38-41`，`core.ts:218-219` 再排一次）；补跑 cron 一天共 9 次；“最多晚一天”在执行记录第 10 节和接手清单里改正了。变异 `sharedOps`（两段共用一份计数）、`noRemindBudget`、`noPurgeOps` 都被拦住。吞吐的重新统计见下面“问题 3” |
| 中 1（空日期之后也停，原地打转） | **已解决** | `core.ts:305` 改成 `files.length && …`；新测试 `account-purge-budget.test.ts:131`、`:147` 把列空日期放慢了。变异 `emptyDateStop`（改回原来的写法）被拦住 |
| 中 2（第 236 行的 110 秒保护没有测试守着） | **已解决** | 新测试 `account-purge-schedule.test.ts:53`；旧测试改名为 `:33`（R2 检查点）。变异 `noWall` 被拦住（上一轮是 35/35 全过） |
| 低 1（remaining 口径；usage-report 不转发） | **部分解决** | 口径写清楚了（`core.ts:417-423`），加了 `held`。`DETAIL_FIELDS` 没改（`usage-report/core.ts:113`），`held`、`remaining`、`remind_left` 运维侧仍看不到，只能靠 `purge:overdue` 兜底（要过安全审查，可以接受，见低 B） |
| 低 2（半截状态跨天，中途被改成不停用就永远停在半截） | **没改，有说明** | 执行记录第 120 行写明放到 B7a 前再定。返工后普通账号一轮就删完，窗口变小了。可以接受 |
| 低 3（R2 空桶、最后一个桶也停） | **代码已解决，测试只守住一半** | `core.ts:292` 改成 `deleted > 0 && i < R2_BUCKETS.length - 1`。变异 `lastBucketStop` 被拦住；变异 `emptyBucketStop`（空桶也停）**没被拦住**（见低 C） |
| 低 4（墙钟估 CPU 不准） | **已解决（仍待预览确认）** | 改成数调用次数；两段合计约 1.1 秒 CPU 的估算写进了执行记录。仍要在预览上复跑，确认日志里没有 `CPU time hard limit reached` |
| 低 5（工具默认模式在 3 × 400 下过不了） | **已解决** | 三种模式都连跑多轮，`--expect timeout` 只判第 1 轮超时，用法注释写清楚了 |

### 这一轮重点问题的结论

**问题 1：补发并顺延时的并发**
- CAS 条件对：`notice_sent = false and purge_after = 原值 and purge_started_at is null`（`index.ts` 的 `postponeNotice`）。真库里 `eq` 比较 timestamptz 由 `purge-remind.it.ts` 覆盖（这次没跑，它要连本机数据库）。
- 不会顺延两次：改成功以后 `notice_sent = true`，就不再进候选。
- 发信失败不会改 `notice_sent`：`core.ts:235-236` 发信失败直接 `continue`，`userEmail`、`profile` 抛错时走 `catch`，什么都不改。变异 `postponeFallbackMark`（顺延失败时退回去只改 `notice_sent`）被拦住。
- 会不会发两封：两次运行同时跑（手动补跑撞上 cron）会各发一封补发信，信里的新时刻差几秒到几分钟，只有一次顺延成功。另一封写的时刻可能比实际晚一点，用户如果照那封信算，会以为比实际多出几分钟。这是方案已经接受的“宁可多一封”的代价。cron 前后两次不会重叠，所以只在人工补跑时出现。
- 发了信却没顺延：顺延的 update 出错（网络断）时，这一行仍是 `notice_sent = false`、`purge_after` 已过，第二段 `held` 不删；15 分钟后再补发一封、写新的时刻再顺延。用户会收到两封补发信，时刻以后一封为准。不会提前删。可以接受（低 A）。

**问题 2：会不会又提醒又删** → 会，见**中 A**。

**问题 3：线上吞吐重新统计**（按 `countedDeps` 的计数规则）
- 删除段，一个普通账号（4 个桶各有少量对象、7 个备份日期）：认领、isAdmin、profile、getUserById 共 4 次；R2 每桶“列 + 删 + 再列”3 次，共 12 次；listDates 1 次；7 个日期各“列、删、再列”，共 21 次；邮箱哈希两样、counters、stillClaimed、insert、deleteUser、remainingRows、最后一封信共 8 次。合计约 46 次，每轮另有 listDue 1 次。
- 400 次的预算一轮约 8 个账号，第 9 个只做一半；一天 9 次，**约 72～80 个账号**。执行记录写的是约 40 次、一轮 10 个、一天 90 个，偏乐观约 15%，量级没错。
- 提醒段：每封 4 次（取邮箱、取 profile、发信、标记或顺延），每轮另有 listRemind 1 次。一轮约 49 封，**一天约 440 封**。48 小时窗口里一个账号有 18 次机会。
- 墙钟：一轮约 600 次调用，每次 60～150 ms，约 36～90 秒，在 110 秒以内；碰到 110 秒由墙钟兜底。
- 这意味着每一轮都远长于 pg_net 的 5 秒超时，线上“pg_net 超时以后函数照样跑完”成了常态前提（见低 D）。

**问题 4：新迁移**
- 时刻：`45 18` = 首尔 03:45；`*/15 19` = 04:00、04:15、04:30、04:45；`0,15,30 20` = 05:00、05:15、05:30。加上 03:30，一天正好 9 次，换算正确。
- 和 03:30 那条不撞：最早一次补跑是 18:45 UTC，间隔 15 分钟，函数最长 110 秒，前后不会重叠。
- 命令和 `20261029171000` 一字不差，值都从 `vault.decrypted_secrets` 读，没有写死的值。三个任务名不重复。`check_backend` 0 错误；`check-backend-migrations` 测试通过。rls 34 号测试要连数据库，没跑。

**问题 5：测试能不能拦住回退** → 16 个变异里 14 个被拦住（见文末的表）。没拦住的是 `noSort`（低 C，真库测试覆盖了）和 `emptyBucketStop`（低 C）。

### 复审新发现

#### 中 A　同一轮里先发“即将删除”的提醒、几秒后就删；补跑 cron 把提醒到删除的最短间隔缩到 15 分钟

- 位置：`core.ts:227-229`（`late = pa <= now`，这里的 `now` 是本轮开始时刻 `t0`）；`core.ts:382-383`（`listDue` 用的是第一段跑完以后的 `deps.now()`）。
- 场景（在独立副本里写临时测试实测过）：`purge_after` 比本轮开始晚 1 秒，`notice_sent = false`，因为前两天窗口里的提醒都没发出去，比如 Resend 故障。
  1. 第一段判它“还没到期”，走普通提醒，发“你的账号将在 <purge_after> 彻底删除”，并把 `notice_sent` 改成 true；
  2. 第二段这时 `now` 已经过了 `purge_after`，`listDue` 把它列出来，当场删掉。
  3. 实测结果：`{"purged":1,"sent":1,"postponed":0}`，两封信依次是“即将彻底删除”“已注销”，间隔 2 秒。
- 跨轮也一样：`purge_after` 落在两次补跑之间（比如 03:31），03:30 那轮发普通提醒，03:45 那轮就删。改之前 cron 一天一次，提醒以后至少隔到第二天才删，补跑 cron 把这个间隔缩到了 15 分钟。
- 这正是负责人“到期了还没提醒就补发并顺延 24 小时”想防的情况：用户收到提醒，却没有时间去恢复。只不过 `purge_after` 差几秒、几分钟没到，绕过了顺延。正常情况下提醒窗口里有 18 次机会，只有连续两天发信失败才会碰到；可一旦碰到，就是 TC-B1-107 和安全审查中 4 要防的那种误删。
- 建议：
  - （要负责人定）把“补发并顺延”的判断从“已经到期”放宽到“离到期不足一个最短提前量”，比如 `pa <= now + REMIND_LATE_POSTPONE_MS`：这种情况一样走补发信，并把删除时刻顺延到“现在 + 24 小时”（`postponeNotice` 的 CAS 条件不用改）。这样“提醒到删除至少 24 小时”就有了保证。
  - （代码层面的最小修补，不用改方案）第二段 `listDue` 改用本轮开始时刻 `t0`，并跳过本轮刚发过提醒的 user_id。这样至少不会同一轮里刚提醒就删，但跨轮 15 分钟的问题还在。
  - 补测试：`purge_after = t0 + 1 秒`、发信时拨时钟，断言这一轮不删。

#### 中 B　信一直发不出去的账号永远不删

- 位置：`core.ts:235-236`（`email === null` 或 `sendMail` 回 false，就什么都不改）；`core.ts:396-400`（`notice_sent !== true` 就 `held`）；`_shared/account-mail.ts:26-32`（`@lemomemo.test` 回 false）；`account-purge/index.ts:191`（没配 Resend 钥匙时回 false）。
- 场景：
  1. 预览库或正式库没配 Resend 钥匙，或者钥匙失效：**所有**待删账号都停在 `held`，一个都不删；
  2. Resend 对某个地址一直回 4xx（格式不对、被拉进拒收名单），这个人永远不删；
  3. getUserById 取不到邮箱（`email === null`），永远不删；
  4. 用 `@lemomemo.test` 测试邮箱做真链路的，不手动标 `notice_sent = true` 就永远不删。这次的测试和工具都手动标了，所以测试全绿，但线上的人工演练会碰到，见低 E。
- 改之前，这些情况都是照删（只记 `no_email`、`remind_mail_failed`）。现在变成“数据一直不删”，违背了注销 7 天后删除的承诺。能发现：`purge:overdue`（到期超过 24 小时、没认领）会告警，所以不是无声的；但系统自己收不了尾，要人工处理。
- 建议（要负责人定）：给 `held` 设一个上限，比如到期超过 N 天、或者补发连续失败 N 次，就照删并告警；`email === null` 的直接当作“没有邮箱可发”，照删。至少要在架构第 137 条和运维手册里写明：`purge:overdue` 告警的一个原因是“发信一直失败，账号被扣住”，处理办法是什么。

### 低

- **低 A**　顺延的 update 出错时会再补发一封（时刻以后一封为准），见问题 1。可以在补发信里加一句“以最新一封为准”，或者不改，记下这个行为。
- **低 B**　`held`、`remaining`、`remind_left` 不进 usage-report 白名单（`usage-report/core.ts:113`），`purge_held_no_notice` 只在函数日志里，没有告警通道直接读它。`core.ts:16` 注释里的“告警用”不准确，要么改注释，要么按 D2-S2 的口径把 `held` 加进白名单，再在 lemo-ops 加 `held > 0` 的提示（要过安全审查）。
- **低 C**　两处测试缺口：
  - 变异 `emptyBucketStop` 没被拦住：`account-purge-budget.test.ts:95` 那条只把最后一个桶加重了，前三个空桶时调用次数没超，测不到“空桶不停”；补一条：前面的步骤先把次数用完，再断言空桶之后不停。
  - 变异 `noSort`（`core.ts` 里不再排序）没被拦住：假实现自己排了序；真库测试 `purge-remind.it.ts:76` 守住了 `index.ts` 的 `order`，所以 `core.ts` 里那次再排序只是双保险，可以接受。
- **低 D**　每轮 36～90 秒、远长于 pg_net 的 5 秒超时，线上“客户端断开以后函数照样跑完”成了每天 9 次的常态前提。B1-left-pgnet-timeout 的预览复跑在 B7a 前必须做；如果托管环境在客户端断开后会掐掉函数，要把 `timeout_milliseconds` 调到 110 秒以上（push-dispatch 那条已经是 25000）。
- **低 E**　TC-B7a-05 的步骤“用 service role 把 `purge_after` 改到过去、触发 account-purge”没更新。照现在的逻辑，这样做会走补发并顺延 24 小时，账号这一轮不删；用测试邮箱则永远 `held`。要在步骤里加“同时把 `notice_sent` 设为 true”，或者把期望改成先补发、24 小时后再删。
- **低 F**　执行记录里“一个普通账号约 40 次、一天约 90 个”偏乐观，按计数规则约 46 次、一天 72～80 个（见问题 3）。改一下数字即可。

### 复审跑过的命令和结果

| 命令 | 结果 |
|---|---|
| `git status --short`、`git diff --stat`、`git diff` 看 `core.ts`、`index.ts`、`account-mail.ts`、测试、工具、文档 | 看改动 |
| `npx vitest run` 跑 account-purge 的 budget、remind、主测试、schedule 四个文件，以及 lemo-ops-rules、lemo-ops、usage-report、`tests/data-manifest/purge-runner.test.ts`、`tests/build/check-backend-migrations.test.ts`（命令里另带的 `tests/functions/account-mail.test.ts` 不存在，没跑到） | 9 个文件，124 条通过、5 条跳过 |
| `npx tsc -p tsconfig.functions.json`、`npx tsc -p tsconfig.node.json` | 0 错误 |
| `python -I build/check_backend.py` | `check_backend：0 个错误` |
| 变异验证：按新规矩建独立副本 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\repo-copy`（复制 supabase、shared、tests、package.json 和几个 tsconfig；node_modules 用联接指到仓库），脚本 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\mut2.py` 逐个改副本里的 `core.ts`，跑 `tests/functions/account-purge*.test.ts`（49 条），跑完把副本还原 | 见下表；共享工作区的源码没有改 |
| 探针：在副本里临时加一个测试（`purge_after = t0 + 1 秒`、发信时拨 2 秒） | 同一轮 `sent 1`、`purged 1`，先“即将彻底删除”、后“已注销”（中 A）；跑完删掉 |

| 变异 | 改了什么 | 结果 |
|---|---|---|
| none | 不改 | 49/49 通过 |
| noHold | 去掉“没提醒的不删” | 拦住（2 条） |
| lateAsNormal | 到期没提醒的按普通提醒走（不顺延） | 拦住（7 条） |
| postponeFallbackMark | 顺延失败时退回去只改 `notice_sent` | 拦住（1 条） |
| sharedOps | 提醒段和删除段共用一份计数 | 拦住（2 条） |
| noRemindBudget | 提醒段不设次数上限 | 拦住（1 条） |
| noPurgeOps | 删除段不设次数上限 | 拦住（4 条） |
| sendMailUncounted | 发信不计次 | 拦住（2 条） |
| r2Uncounted | R2 不计次 | 拦住（2 条） |
| postponeWrongTime | 顺延 48 小时 | 拦住（2 条） |
| heldCountsRemaining0 | `remaining` 不算 `held` | 拦住（2 条） |
| emptyDateStop | 空日期之后也停（上一轮的中 1） | 拦住（2 条） |
| lastBucketStop | 最后一个桶之后也停 | 拦住（2 条） |
| noWall | 去掉不可逆步骤前的 110 秒保护（上一轮的中 2） | 拦住（1 条） |
| **emptyBucketStop** | **空桶之后也停** | **没拦住（低 C）** |
| **noSort** | **core.ts 里不排序** | **没拦住（低 C，真库测试有覆盖）** |

没有连数据库、没有起 docker，没有 git add，没有改共享工作区的源码（只往本审查记录末尾追加了这一节），没碰 `D:\claude code\待办APP`。

---

## 第三轮复审（2026-11-04）

- 范围：`supabase/functions/account-purge/core.ts`、`_shared/account-mail.ts`（含主持人补充的 ② `deletionReminderMail` 中文“选”改“点”）、`tests/functions/account-purge-{budget,remind,hold}.test.ts`、架构第 137 条、TC-B1-107、TC-B7a-05、执行记录第 11、12 节。
- 负责人对上一轮中 A、中 B 的决定照单执行，这一轮只审代码有没有把决定做对，以及新加的照删、跳过逻辑有没有带出新问题：
  - 中 A：只保证不在同一轮删；
  - 中 B：到期仍没提醒成功的，等 3 天后照删并告警。
- 尺度和前两轮相同。

### 第三轮总分：7.5 / 10（不通过；改掉中 C，补上低 G，就可以到 8 分以上）

中 A、中 B 都按负责人的决定改对了，测试能拦住大部分回退，补发信韩文和审校第四节逐字一致。

但“照删”和“补发并顺延”两条规则在“到期超过 3 天”这个边界上会互相打架。这一点我在独立副本里写临时测试实测过（中 C）：
- 照删删了一半以后，信又发得出去了：这时会补发一封“已顺延”的信，账号变回可以恢复，数据却已经缺了一块；
- 照删时认领卡住：之后每一轮都发一封补发信，账号永远不删。

### 上一轮问题逐条核对

| 上一轮 | 结论 | 依据 |
|---|---|---|
| 中 A（同一轮里先提醒、后删除） | **已解决**（按负责人“只保证不在同一轮删”） | `core.ts:403` 的 `listDue` 改用 `t0`；`core.ts:418` 跳过本轮刚提醒过的，记 `purge_held_just_reminded:<前 8 位>`。上一轮的探针场景（`purge_after = t0 + 1 秒`）现在这一轮不删。变异 `listDueLateNow`、`noJustRemindedSkip` 都被拦住。跨轮最短 15 分钟是负责人接受的边界，不再算问题 |
| 中 B（信一直发不出去就永远不删） | **已解决**（按负责人“3 天后照删并告警”） | `core.ts:427-428`：没有邮箱的到期直接删；从 `purge_after` 起超过 3 天照删。`forced` 只算真删成的（`core.ts:445`）。变异 `noForced`、`forced2days`、`noNoEmailPurge`、`noHold` 都被拦住。新边界上的问题见中 C、低 G |
| 低 A（顺延写库出错会再补发一封） | 没改，写进“局限”，可以接受 | 执行记录第 11 节 |
| 低 B（“告警用”的说法不准） | **已解决** | `core.ts:23-24` 注释改准了；白名单没动，转发进告警另立接手清单项 PURGE-heartbeat-ops |
| 低 C（两个变异没拦住） | **已解决** | 我在副本里复跑：`emptyBucketStop`、`noSort` 现在各有 1 条失败 |
| 低 D（线上要靠“pg_net 超时后函数照样跑完”） | 没改，已列进预览复跑清单 | 维持低，B7a 前必须做 |
| 低 E（TC-B7a-05 步骤没更新） | **已解决** | 步骤里加了“同时把 `notice_sent` 设为 true”，期望列有备注 |
| 低 F（吞吐数字偏乐观） | **已解决** | 常量注释改成约 49 封一轮、一天约 440 封 |

### 补发信和 ② 文案核对

- **韩文补发信**（`account-mail.ts:111-117`）：用脚本把标题、正文和审校文档 `docs/03-评审/B2/B2-韩文审校-补发删除提醒信.md` 第四节的“建议采用的韩文全文”逐字比对，**完全一致**。正文唯一的差别是源码里换行写成 `\n` 转义，内容相同。必改的“탈퇴 대기 기간”，建议里的标题同一开头、“죄송해요”、整句写新时刻，全部改到了。
- **中文补发信**（`account-mail.ts:119-124`）：和审校第三节第 1～3 条的建议文字一致：标题“即将彻底删除（删除时间已顺延）”，补了“很抱歉”和“将在 {when} 彻底删除”，用“点”。
- **② 中文“选”改“点”**：`git diff` 里 ② 只改了这一个字，韩文没动，相关测试全过。但文档没跟着改，见低 H。

### 第三轮新发现

#### 中 C　到期超过 3 天的账号：照删开始以后，第一段仍会补发“已顺延”信并顺延；认领卡住时每轮发信、永远不删

- 位置：
  - `core.ts:246` 起：第一段对 `pa <= now` 的一律走补发并顺延，没有区分“已经进入照删期（超过 3 天）”的账号；
  - `index.ts:38-41`：`listRemind` 不排除已认领的行（`purge_started_at` 不为空）；
  - `core.ts:418`：“本轮刚提醒过就跳过”排在照删判断（`core.ts:428`）前面。
- 场景 1（探针 P1，实测）：信连续 3 天以上发不出去，比如发信钥匙失效。第 N 轮照删一个数据多的账号，删掉第一个 R2 桶就碰到调用上限，停手、放回认领，日志里有 `purge_forced_no_notice`、`time_budget`。15 分钟后钥匙修好了，下一轮：
  1. 第一段对它发出“你的柠檬记账号即将彻底删除（删除时间已顺延）”，`postponed 1`；
  2. `purge_after` 被顺延到 24 小时以后，`notice_sent = true`。
  - 结果：账号**又能 restore 了**，但 R2 已经删了一部分。用户照信里说的去恢复，拿回来的是一个缺了照片或附件的账号，而且没有任何提示。
  - 改之前的“照删”语义是删到底；现在一封补发信就把它翻回了冷静期。
- 场景 2（探针 P2，实测）：照删认领以后进程被掐（比如 CPU 上限，正是这一项要防的事），认领卡住，`notice_sent` 仍是 false。之后信发得出去了，每一轮：
  1. 第一段补发成功；
  2. `postponeNotice` 因为 `purge_started_at` 不为空而改不到，记 `remind_postpone_skipped`；
  3. 第二段因为“本轮刚提醒过”，记 `purge_held_just_reminded` 跳过。
  - 实测连跑 4 轮：每轮 `sent 1`、`postponed 0`、`held 1`，一共发了 4 封补发信，账号一直在。
  - 线上就是一天 9 封、每封写的删除时刻都不一样，一直到有人处理为止。认领满 26 小时后 `purge:stuck` 会报，但这期间用户一直在收信。
- 建议（不改负责人定的两条规则，只把边界对齐）：
  - 第一段跳过已经进入照删期的：在 `core.ts:246` 前加 `if (pa <= now - PURGE_HOLD_MAX_MS) continue;`。到了 3 天，规则就是照删，不再补发、不再顺延。我在副本里试过这个改法：59 条里只有 1 条失败，失败的是 `account-purge-hold.test.ts` 里顺带断言照删那一轮还有 `remind_mail_failed` 日志的那一句，改掉这句断言即可，其余行为不变。
  - `listRemind` 加 `.is('purge_started_at', null)`：正在删的不再发提醒。
  - 补测试：照删删了一半、下一轮信能发出去时，不发补发信、不顺延、接着删完；认领卡住加上信能发出去时，不会每轮发信。

### 低

- **低 G**　两处照删边界没有测试守着（副本里变异验证）：
  - `forced4days`：把 3 天改成 4 天，59/59 全过。现有测试只断言了“3 天内不删”，没有断言“刚过 3 天就删”。补一条：`purge_after` 过去 3 天加 1 分钟，这一轮照删。
  - `forcedCountAll`：照删的账号没删成（`deferred`、`failed`、`skipped`）也算进 `forced`，59/59 全过。负责人同意 `forced` 只算真删成的，要补一条：照删的账号碰到预算停手时，`forced` 是 0。
- **低 H**　② 的“选”改成“点”以后，文档里引用 ② 正文的地方还是“选”：TC-B1-107（`docs/06-测试/测试用例-v4.md:342`）、架构第 137 条（`docs/10-架构/架构设计-v4.md:1050`）都还写着 `选‘恢复账号’`。照着用例去核对邮件的人会对不上，跟着改一个字即可。
- **低 I**　`core.ts:444` 只要判了照删，就记 `purge_forced_no_notice`，不管这一轮删没删成（P1 第 1 轮 `deferred` 也记了）。以后按日志计数告警会多算，而且同一个账号停手以后每轮都会再记一次。建议只在 `purged` 时记这个码，没删成的另记一个，比如 `purge_forced_attempt`。
- **低 J**　`sendMail` 回 false、但 Resend 其实已经收下了（响应超时）的那几次，用户手里会有写着“现在 + 24 小时”的补发信，而第 3 天照删可能早于信里写的时刻。只在发信接口超时的情况下出现，记进“局限”即可。
- **个人信息核对**：新加的日志码 `remind_no_email`、`purge_no_email_no_notice`、`purge_forced_no_notice`、`purge_held_just_reminded`、`purge_held_no_notice`，都是“码 + user_id 前 8 位”，没有邮箱、请求头和其他字段；心跳里的 `forced`、`held` 只是数字。没问题。

### 第三轮跑过的命令和结果

| 命令 | 结果 |
|---|---|
| `git diff`、`git diff -U0` 看 `core.ts`、`account-mail.ts`；执行记录第 11、12 节 | 看改动 |
| `npx vitest run` 跑 account-purge 的 hold、budget、remind、主测试、schedule 五个文件，以及 account、lemo-ops-rules、lemo-ops、usage-report、`tests/data-manifest/purge-runner.test.ts` | 10 个文件，152 条通过、5 条跳过 |
| `npx tsc -p tsconfig.functions.json`、`npx tsc -p tsconfig.node.json` | 0 错误 |
| `python -I build/check_backend.py` | `check_backend：0 个错误` |
| 用脚本逐字比对韩文补发信和审校第四节 | 一致（只差 `\n` 转义） |
| 独立副本 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\repo-copy`：用最新的 supabase、shared、tests 重新复制，node_modules 用联接；探针 P1、P2 是临时测试，跑完删掉 | P1、P2 复现了中 C 的两种场景 |
| 副本里的变异脚本 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\mut3.py`，跑 `tests/functions/account-purge*.test.ts`（59 条），跑完把副本还原 | 见下表 |

| 变异 | 改了什么 | 结果 |
|---|---|---|
| none | 不改 | 59/59 通过 |
| listDueLateNow | `listDue` 改回用 `deps.now()` | 拦住（1 条） |
| noJustRemindedSkip | 不跳过本轮刚提醒过的 | 拦住（1 条） |
| noNoEmailPurge | 没有邮箱的也扣着 | 拦住（1 条） |
| noForced | 不照删 | 拦住（2 条） |
| forced2days | 扣 2 天就照删 | 拦住（1 条） |
| **forced4days** | **扣 4 天才照删** | **没拦住（低 G）** |
| **forcedCountAll** | **没删成的也算进 `forced`** | **没拦住（低 G）** |
| noHold | 没提醒的也删 | 拦住（6 条） |
| emptyBucketStop | 空桶之后也停 | 拦住（1 条） |
| noSort | core.ts 里不排序 | 拦住（1 条） |
| fixSkipForcedInRemind | 中 C 建议的改法（照删期不再补发） | 1 条失败：只是那条测试顺带断言的日志，见中 C |

没有连数据库、没有起 docker，没有 git add，没有改共享工作区的源码（只往本审查记录末尾追加了这一节），没碰 `D:\claude code\待办APP`。

---

## 第四轮复审（2026-11-04）

- 范围：
  - 代码：`core.ts`（第一段跳过照删期、低 I 的日志码、合并的那一行）、`index.ts` 的 `listRemind`；
  - 测试：`tests/functions/account-fakes.ts`、`account-purge-hold.test.ts`（P1、P2、“未满 3 天认领卡住也不补发”）、`supabase/tests/store-it/purge-remind.it.ts`；
  - 文档：架构第 137 条 ⑦、TC-B1-107（含“选”改“点”），执行记录的“局限”。
- 尺度和前三轮相同，默认不通过。

### 第四轮总分：8.5 / 10（通过）

第三轮的中 C、低 G～J 都解决了。我在独立副本里跑了 12 个变异，全部被拦住。新改动没有带出中以上的问题，只剩三条低问题，可以带着进 B7a 前的收尾，不挡这一项。

前提条件不变：B7a 前要在预览上复跑，确认函数日志里没有 `CPU time hard limit reached`，以及 pg_net 超时以后函数照样跑完（低 D）。

### 第三轮问题逐条核对

| 第三轮 | 结论 | 依据 |
|---|---|---|
| 中 C（照删期仍补发并顺延；认领卡住时每轮发信） | **已解决** | `core.ts:251` 进了照删期就 `continue`，不补发、不顺延；`index.ts:40` 的 `listRemind` 加了 `.is('purge_started_at', null)`，假库同步（`account-fakes.ts:202`）。新测试 P1、P2、“未满 3 天认领卡住也不补发”对应我第三轮的两个探针。变异 `noForcedSkipInRemind`（去掉这一行）、`forcedSkipOffByDay`（边界错一天）各拦住 2 条。照删边界上，第一段（`core.ts:251`，`now` 就是 `t0`）和第二段（`core.ts:433`）用的是同一个时刻、同一个条件，不会一边跳过、一边又不删。`listRemind` 的过滤靠真库测试 `purge-remind.it.ts:51` 守着：我这边不能连库，没跑，后端自报本机 3/3 |
| 低 G（照删 3 天的边界、forced 计数没有测试守着） | **已解决** | `account-purge-hold.test.ts:74`、`:83` 用字面量写死 3 天和刚过 3 天的时刻。变异 `forced4days` 现在拦住 4 条，`forcedCountAll` 拦住 1 条（P1 那条） |
| 低 H（文档里还写着“选‘恢复账号’”） | **已解决** | TC-B1-107、架构第 137 条里已经没有“选‘恢复账号’”了 |
| 低 I（照删没删成也记告警码） | **已解决** | `core.ts:450` 只在真删成时记 `purge_forced_no_notice` 和 `purge_no_email_no_notice`，没删成记 `purge_forced_attempt`。变异 `alertCodeAlways` 被拦住。日志码仍然只带 user_id 前 8 位 |
| 低 J（发信接口超时但其实已经发出） | **已记录** | 写进了执行记录“局限”和 `core.ts` 文件头，可以接受 |
| 文档 ⑦ | **已同步** | 架构第 137 条 ⑦ 写了“进了照删期后不再补发、不再顺延；正在删的账号也不发提醒”，TC-B1-107 也写到了 |

### 第四轮新发现（都是低）

- **低 K**　`tests/functions/account-fakes.ts` 超过 `max-lines`。
  - eslint 报警告：有效行数 311，上限 300。改动前的版本（`git show HEAD:` 那份）没有这个警告，是这次返工带出来的。
  - 只是警告，`tests/arch/eslint.test.ts` 只核对样例，不会让 CI 失败。但 `core.ts` 为了不超行数特意合并了一行，测试文件却超了，口径不一致。
  - 建议：把 account-purge 的假库拆到单独的文件里，比如 `account-purge-fakes.ts`。
- **低 L**　进了照删期的行仍然由 `listRemind` 列出来，再在 `core.ts:251` 跳过。
  - 这些行不花调用次数，但第一段碰到上限时，`remind_left`（`core.ts:243`）会把它们也算进去，数字偏大。
  - 建议：`listRemind` 再加一个下限 `gt('purge_after', now - PURGE_HOLD_MAX_MS)`，或者算 `remind_left` 时扣掉它们。
- **低 M**　没有邮箱的账号，如果照删时认领卡住了，要多等到 3 天才删。
  - 原因：认领卡住以后，第一段不再列它（`purge_started_at` 不为空），也就不会进 `noEmail`；第二段在认领过期以后列出它，判成 `held`，直到满 3 天按 `purge_forced_no_notice` 照删。
  - 不会永远扣着，也不会发信，只是晚一些，可以接受，记进“局限”即可。

### 第四轮跑过的命令和结果

| 命令 | 结果 |
|---|---|
| `git diff`、`grep` 看 `core.ts`、`index.ts`、`account-fakes.ts`、`account-purge-hold.test.ts`、`purge-remind.it.ts`，以及架构第 137 条、TC-B1-107 | 看改动 |
| `npx vitest run` 跑 account-purge 的 hold、budget、remind、主测试、schedule 五个文件，以及 account、lemo-ops-rules、lemo-ops、usage-report、`tests/data-manifest/purge-runner.test.ts` | 10 个文件，155 条通过、5 条跳过 |
| `npx tsc -p tsconfig.functions.json`、`npx tsc -p tsconfig.node.json` | 0 错误 |
| `npx eslint supabase/functions/account-purge/ supabase/functions/_shared/account-mail.ts tests/functions/account-purge-hold.test.ts tests/functions/account-fakes.ts` | 0 错误，1 个警告（低 K）；`git show HEAD:tests/functions/account-fakes.ts \| npx eslint --stdin` 没有警告 |
| `python -I build/check_backend.py` | `check_backend：0 个错误` |
| 独立副本 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\repo-copy`：用最新的 supabase、shared、tests 重新复制，node_modules 用联接；变异脚本 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\mut4.py`，跑 `tests/functions/account-purge*.test.ts`（62 条），跑完把副本还原 | 见下表 |

| 变异 | 改了什么 | 结果 |
|---|---|---|
| none | 不改 | 62/62 通过 |
| noForcedSkipInRemind | 第一段不跳过照删期（中 C） | 拦住（2 条） |
| forcedSkipOffByDay | 第一段照删期的边界错一天 | 拦住（2 条） |
| forced4days | 扣 4 天才照删（低 G） | 拦住（4 条） |
| forcedCountAll | 没删成的也算进 `forced`（低 G） | 拦住（1 条） |
| alertCodeAlways | 没删成也记告警码（低 I） | 拦住（1 条） |
| noReminded | 不记“本轮刚提醒过”（中 A） | 拦住（1 条） |
| listDueLateNow | `listDue` 改回用 `deps.now()`（中 A） | 拦住（1 条） |
| noNoEmailPurge | 没有邮箱的也扣着（中 B） | 拦住（1 条） |
| noHold | 没提醒的也删 | 拦住（8 条） |
| emptyDateStop | 空日期之后也停（第一轮中 1） | 拦住（2 条） |
| noWall | 去掉不可逆步骤前的 110 秒保护（第一轮中 2） | 拦住（2 条） |

`index.ts` 里 `listRemind` 的 `.is('purge_started_at', null)` 是单元测试测不到的（单元测试用的是假库），由真库测试 `purge-remind.it.ts` 守着；它要连本机数据库，按规矩没跑。

没有连数据库、没有起 docker，没有 git add，没有改共享工作区的源码（只往本审查记录末尾追加了这一节），没碰 `D:\claude code\待办APP`。

---

## 第五轮（低项）（2026-11-04）

- 范围：第四轮剩下的低 K、L、M。改动在 `core.ts`、`index.ts`、`tests/functions/account-fakes.ts`、`tests/functions/account-purge-fakes.ts`（新）、`account-purge-hold.test.ts`、`account-purge-remind.test.ts`、`supabase/tests/store-it/purge-remind.it.ts`，以及执行记录第 14 节。
- 尺度相同，默认不通过。全量 vitest 里 2 条 Dialog-motion 失败，是前端 A 在改 `src/motion`，和这一项无关，按主持人要求不算；我只跑了和 account-purge 相关的测试。

### 结论：通过，8.5 / 10（维持第四轮的分数）

三条低项都按说的改到位了，没有带出新问题。仍然只剩低 D：B7a 前要在预览上复跑。

| 第四轮 | 结论 | 依据 |
|---|---|---|
| 低 K（`account-fakes.ts` 超 max-lines） | **已解决** | 假库挪到 `tests/functions/account-purge-fakes.ts` 的 `fakePurgeStore(db)`；`FakeDb.purgeStore()` 一行转调。我用脚本把 `HEAD` 里旧的 `purgeStore()` 方法体和新文件逐行规范化比对，只差 `listRemind` 多了下限这一处，其余方法一字不差，搬家没走样。新文件对 `FakeDb` 只是 `import type`，编译后没有运行时循环引用。`guard` 改成公开，只是给测试用的假库开了一个口，没问题。eslint 对这几个文件 0 错误、0 警告 |
| 低 L（照删期的行仍被列出，`remind_left` 偏大） | **已解决** | `index.ts` 的 `listRemind` 加了 `.gt('purge_after', sinceIso)`，`core.ts` 传 `since = now - PURGE_HOLD_MAX_MS`。这和第一段的兜底 `pa <= now - PURGE_HOLD_MAX_MS` 跳过、第二段 `pa <= t0 - PURGE_HOLD_MAX_MS` 照删，三处是同一条边界（`now` 就是 `t0`），列表里排除的正好是第二段要照删的。几处替身都改成了转发两个参数。真库边界由 `purge-remind.it.ts:26` 守着（要连库，我没跑，后端自报 4/4） |
| 低 M（没有邮箱又认领卡住，要等 3 天才删） | **已记录** | 执行记录第 14 节和文末“局限”写清了原因和后果，可以接受 |

### 变异（独立副本，跑 `tests/functions/account-purge*.test.ts` 共 63 条，跑完已还原）

| 变异 | 改了什么 | 结果 |
|---|---|---|
| none | 不改 | 63/63 通过 |
| noSince | `core.ts` 传的下限改成 1970 年（等于不设下限） | 拦住（1 条） |
| sinceOffByDay | 下限放宽一天 | 拦住（1 条） |
| sinceTooTight | 下限收紧一天（2～3 天的也不列了） | 拦住（2 条） |
| fakeNoSince | 假库去掉下限过滤 | 拦住（1 条） |
| fakeGte | 假库的 `>` 改成 `>=` | 没拦住，但这是等价变异：正好落在边界上的那一行就算被列出来，也会被 `core.ts` 的兜底 `continue` 跳过，行为不变；真库的 `gt` 由 `purge-remind.it.ts` 守着 |
| noFallbackContinue | 去掉 `core.ts` 里照删期的兜底 `continue` | 没拦住，这是预期内的：`listRemind` 已经按下限不列这些行，这一行只是双保险。中 C 的两个场景（P1、P2）仍由下限和 `.is('purge_started_at', null)` 守住 |

### 跑过的命令

| 命令 | 结果 |
|---|---|
| `git diff`、`git status` 看改动；用脚本比对 `git show HEAD:tests/functions/account-fakes.ts` 的 `purgeStore()` 方法体和新文件 | 搬家内容一致 |
| `npx eslint supabase/functions/account-purge/ tests/functions/account-fakes.ts tests/functions/account-purge-fakes.ts tests/functions/account-purge-hold.test.ts tests/functions/account-purge-remind.test.ts` | 0 错误、0 警告 |
| `npx tsc -p tsconfig.functions.json`、`npx tsc -p tsconfig.node.json` | 0 错误 |
| `npx vitest run` 跑 account-purge 的 hold、budget、remind、主测试、schedule，以及 account、account-status、account-export-p0-auth、lemo-ops、`tests/data-manifest/purge-runner.test.ts` | 10 个文件，127 条通过、5 条跳过 |
| `python -I build/check_backend.py` | `check_backend：0 个错误` |
| 变异：独立副本 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\repo-copy`（node_modules 用联接），脚本 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\mut5.py`，假库那两个变异在副本里直接改、跑完还原 | 见上表 |

没有连数据库、没有起 docker，没有 git add，没有改共享工作区的源码（只往本审查记录末尾追加了这一节），没碰 `D:\claude code\待办APP`。
