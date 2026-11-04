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
