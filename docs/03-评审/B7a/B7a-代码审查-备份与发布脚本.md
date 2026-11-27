# B7a 代码审查：服务器备份、拉回、恢复、正式发布脚本（四轮，2026-11-26～27）

审查员：独立复审员（同一位审查员复查四轮，只读，不给历史和台账）。主持人落盘，各轮原文在附录。

## 签字结论

**通过（2026-11-27，第四轮）**：`tools/release/publish.ps1` 可以签字登记；B7a 可以合主线。

**这一版 publish.ps1 的 SHA-256（`Get-FileHash tools\release\publish.ps1 -Algorithm SHA256`）：**

```
E85D28775036D6B9BF453BF3F19E7DD8A5CF219E1F53A00EE9D2D2373A229ABA
```

脚本第 1 步自己打印的是同一个值的小写：`e85d28775036d6b9bf453bf3f19e7dd8a5cf219e1f53a00ee9d2d2373a229aba`。
审查时的提交：工作副本 b7a-merge，HEAD `175f45ee`（含 `a5b25c76`、`adc3d4dc`），工作区干净；之后合主线的 `e15a8201` 只多了 `shared/logic/weather/cities.ts`，主持人复算哈希不变。

按 [正式发布说明](../../08-发布/正式发布说明-publish.md) 第二节：发布时脚本打印的哈希必须和上面这一行一样，不一样就关掉窗口。

## 四轮经过

| 轮 | 日期 | 审查的提交 | 结论 | 怎么处理的 |
|---|---|---|---|---|
| 第一轮 | 11-26 | `b9f1918c` | 不通过：服务器旧备份没人删（“保留 7 天”没实现）；恢复会把安全、同意状态写回旧值；等 | 全部返工（storage-sweep 删过期日期；恢复跳过安全、同意相关的表和列） |
| 第二轮 | 11-26 | `df682c32` | 可以合主线，无高或严重；两条中低建议合并前修 | 合并前修掉：begin 建标记后重列目录再定代（`a5b25c76`）；chain 重试成功记 `next_retry_ok` |
| 第三轮 | 11-27 | `175f45ee` 前 | publish.ps1 不签：高 1 点引用的 safe-window.ps1 不在哈希范围里，冻结副本单独运行会失败；中 2 拉回前没再核对内容；低 3 查项目没限跳转；低 4 正式环境写死项目名 | `adc3d4dc`：安全窗口检查内联回脚本（和 safe-window.ps1 一字不差，keys-guard-sync 测试钉住）；Invoke-BackupPull 运行 pull.ps1 前再调 Assert-ContentMatchesHead；查项目加 `-MaximumRedirection 0` 和 try/catch；低 4 登记跟进 |
| 第四轮 | 11-27 | `175f45ee` | **通过，签字** | 登记上面的哈希、做冻结副本 |

## 第四轮原文要点（复审员交回，主持人逐条核过）

1. 高 1 已解决：Test-PolicyOn、Assert-NoRecording 已内联，逐字比对和 `tools/keys/safe-window.ps1` 一致；脚本里没有点引用、`$PSScriptRoot`、`Invoke-Expression`、`iex`、`Import-Module`，哈希管得住全部代码。冻结副本单独复制出来运行 `-Tag v0.0.0 -CheckOnly -Ops`，越过了原来出错的地方，打印出上面的哈希，停在“.git 不是目录”（工作副本是 git worktree，脚本只认普通 clone，属预期拦截）；能完整过第 1 步由 publish-run-deploy 的冻结副本用例在假 clone 里证明，复审员跑过，通过。
2. 中 2 已解决：Invoke-BackupPull 先清并核对环境变量，再 `Assert-ContentMatchesHead $state`，然后才运行 `& powershell.exe`；gitsafety 测试钉住先后。
3. 低 3 已解决：查项目加 `-MaximumRedirection 0`、`-Verbose:$false` 和 try/catch，出错只报状态码、清 `$Error`、`$hdr` 置空。
4. 低 4（正式环境写死 lemomemo-prod）：同意登记跟进，不挡签字；现有防护有 ref 格式、首尔地区、ACTIVE_HEALTHY、不许用预览 ref、手动输入项目名。
5. 合并核对：`git diff adc3d4dc 175f45ee --name-only` 不含 tools/release、tools/keys、tools/backup、备份相关函数、_shared/backup、account-purge、migrations。
6. 新问题：没有。
7. 跑过：`npx vitest run tests/build/keys-guard-sync.test.ts tests/build/publish-run-gitsafety.test.ts tests/build/publish-run-deploy.test.ts`，3 个文件 49 条全过。

主持人另核：合并后全量单测 998 个文件、12529 条通过，typecheck 通过；按 CI 做法生成 `_shared/gen` 后 check_backend 0 错误。

## 跟进项（不挡这次签字）

- 低 4：正式环境项目名写死 lemomemo-prod，以后改成从配置读并核对。
- 第一、二轮留下的低项（过期接管的小窗口等）见附录原文，登记进接手清单。

## 冻结副本

`D:\claude code\柠檬记\本机资料\05-构建测试\2026-11-27_publish冻结副本\publish.ps1`（复制后主持人复算哈希，和上面一致）。

---

## 附录：各轮原文

### 第一轮（11-26，HEAD b9f1918c）

##### 独立评审结论：B7a 服务器备份、拉回、恢复、发布（工作副本 b7a-merge，HEAD b9f1918c）

只读评审，没有改文件，没有提交。跑了 9 个测试文件共 117 条，全部通过。测试只用假依赖，下面这些问题它们都测不到。

###### 严重（建议合并前修）

**1. 服务器上的旧备份没有任何代码去删，"保留 7 天"没有实现**
- 位置：`supabase/functions/backup-daily/core.ts` 全文、`backup-manifest/core.ts:66`（只是"只列最新 7 个"）。全仓库没有一处删 `backups/<日期>/` 的代码，桶也没有生命周期策略。account-purge 只删已注销的账号。
- 触发：每天每人新增约 22 个文件，免费版 1 GB 会一直涨。隐私说明承诺"永久删除后服务器备份里最多还留 7 天"（架构 15.7 第 7 项、手册第 3 层第 2 步）实际做不到。account-purge 要列的日期目录也越来越多。
- 建议：backup-daily 写完 `_manifest` 后，删掉这个人 8 天前的日期目录；或 storage-sweep 加一段，按 `BACKUP_DATE_RE` 删超过 7 天的目录。注意 account-purge 的游标前提"最新 8 个日期"不能破。加测试。

**2. 恢复会把安全状态和同意状态写回旧值（不在凭据表名单里）**
- 位置：`tools/backup/restore-lib.mjs:30`（`CREDENTIAL_TABLES`）、`:259`（除主键外整行覆盖）。
- `profiles`：会写回 `disabled_at`/`disabled_reason`。备份只给可用账号做，所以值是空的。管理员事后停用的账号、或在注销冷静期里的账号，一恢复就被重新启用（冷静期的人还留着 `pending_deletions`，状态自相矛盾）。
- `profiles` 和 `settings`：会写回 `consent_ai_at` 和 `ai.enabled`。用户撤回 AI 同意以后再恢复，同意就"复活"了，AI 会接着处理他的数据。
- `vault`：会写回 `pin_hash`、`pin_epoch`、`fail_count`、`lock_level`、`locked_until`。旧 PIN 复活；epoch 回退会让已失效的 vault_token 重新有效；暴力破解锁定也被清零。
- `invites`：`used_count` 回退，已用完的邀请码又能用了，等于绕过注册门槛。
- `user_limits`：管理员调过的上限被撤回。
- 建议：
  - `vault`、`invites` 加进默认不恢复的名单，或改成 `on conflict do nothing`；如果一定要写 vault，`pin_epoch` 取两边较大的再加 1。
  - `profiles` 的停用两列、同意两列，以及 `settings` 里的 `ai.*`、同意相关的 key，恢复时保留库里现值。
  - 加对应测试。

**3. 发下一段超时后会重发，同一段可能有两条接力同时跑，写坏当天备份**
- 位置：`backup-daily/core.ts:380-392`（`chain` 超时或 5xx 后重试一次）、`:426-433`（`stillMine` 只比 run_id）、`index.ts:25`（等 60 秒）。
- 触发：一段读 16 MB 再加上传，超过 60 秒时，调用方放弃等待，但被调的那一段还在跑。重发后同一个 state 有两份在跑，两边都通过 `stillMine`，往同名切片里写，各自往下接力。数据在两次读之间被用户改过，就会出现"某个切片的内容来自 A，`_manifest` 里的 sha256 来自 B"。
- 后果：坏的那一代被提交，`cleanup` 又删了旧的那一代。当天的备份没法用（pull 和恢复会报 checksum 拒收），lemo-ops 发现不了，因为 `_manifest` 是在的。
- 建议：标记里记上段号 k，`stillMine` 要求 `mark.k === state.k`，再写成 k+1；或者超时后不重发。写 `_manifest` 前再核一次标记。

###### 中

**4. 同一个人两轮几乎同时开始时，都会通过"正在做"检查**
- 位置：`core.ts:485-492`、`:415-423`；只有一段的情况下写 `_manifest` 前（`:507-509`）不再核对。
- 触发：例如发布触发和定时任务撞在同一时刻。两轮选的是同一代，都写标记、写同名文件；先做完的那轮 `cleanup` 会删掉另一轮的标记；最后的 `_manifest` 可能和数据文件对不上。
- 建议：写完标记后读回来核对 run_id 再开工；写 `_manifest` 前再 `stillMine` 一次。

**5. backup-manifest 的上限会把整个拉取卡死，大约 32 个账号就到顶**
- 位置：`backup-manifest/core.ts:23-24`（`MAX_FILES=5000`、`MAX_LISTS=600`）。
- 算法：每人每天约 22 个文件，7 天约 154 个，5000 ÷ 154 ≈ 32 人。超过就永远回 503，每天的 pull 和发布前备份全部失败。
- 建议：按日期或分页请求；或者只签 `_manifest` 里列的文件，并放宽上限；至少在接近上限时让 lemo-ops 报警。

**6. 等备份时每 2 分钟问一次，和"每小时 10 次"的全站限流冲突**
- 位置：`pull.ps1:56`、`backup-manifest/core.ts:19`。
- 触发：等到第 10 次（约 18 分钟）以后，这个小时剩下的时间都被拒（429）。备份其实已经做完，也要等到下一个整点才看得到；同一小时 09:00 那一轮也共用这个次数。
- 建议：轮询改成每 6 分钟以上；或者发布等待改用单独的计数键。

**7. 首尔零点前后发布会等不到备份**
- 位置：`publish.ps1:1367` 没有把数据库给的首尔日期 `$d` 传给 pull；`pull.ps1:177` 用本机时钟算"今天"。
- 触发：23:5x 触发、零点以后才轮询，就去找第二天的目录，等满 60 分钟后失败。发布说明第 116 行自己也写了这条"还要定"。
- 建议：调 pull.ps1 时加 `-Today $d`，一行就能修。

**8. 手册照着做不下去：BACKUP_PULL_TOKEN 没有生成和写入的步骤，09:00 的计划任务也没人建**
- 位置：`环境清单-v4.md:150` 只写了"存进凭据管理器"。backup-manifest 读的是函数 secrets 里的 `BACKUP_PULL_TOKEN`（`index.ts:47`），但没有脚本或步骤生成这个值、写进 Supabase secrets，也没有 90 天轮换的做法。
- 另外，`pull.ps1:6` 说"任务计划程序每天 09:00 运行"，但没有任何脚本或手册步骤去建这个计划任务。R2 里的照片和附件，本机拉回是唯一副本。
- pull 失败时只写本机的"失败原因.txt"，不会通知任何人。
- 建议：照 `new-ops-secret.ps1` 补一个脚本（本机生成，经管理接口写进 secrets，同时写进凭据管理器）；补一个注册计划任务的脚本；pull 失败要让人知道（比如拉取成功时写一个心跳给 lemo-ops 判）。

###### 低

9. **报错文字不准**（`restore-lib.mjs:359-366`、`restore.mjs:80-83`）：
   - 连不上库、密码错（ECONNREFUSED、28P01）也报成"写库出错……库里一条没变"，试运行时也这么说。
   - COMMIT 时连接断了，实际可能已经提交，却说"一条没变"。
   - 非 RestoreError 一律报"连不上库或连接串不对"。如果数据已提交后 `sql.end` 出错，会被误报成连库失败，退出码 2。
   - 建议：连接错误单独一个码；提交阶段出错写"状态未知，请先跑 --dry-run 核对"。
10. **环境变量里的连接串不限目标**（`restore.mjs:52`）：`LEMO_RESTORE_DB_URL` 写着"本机测试用"，但对正式库也生效，正式密码可能留在环境变量里。建议只在目标是本机时认它。
11. **恢复可能被上限触发器整体回退**：只增不删，加上 `row_quota`、`todo_items_cap` 这类上限触发器，现有行加备份行超过上限时整个恢复回退，报错只给 sqlstate。建议试运行时预先算一下各表会不会超。
12. **恢复查询用不上索引**（`restore-lib.mjs:209` 等）：`列::text = $1` 用不上索引，每张表要全表扫好几遍；数据量大了会慢。
13. **试运行也要粘写令牌**（`restore-files.ps1:71-78`）：读写令牌在第 88 行试运行退出之前，只读的拉取令牌其实就够了。
14. **pull.ps1 -Setup 没做安全窗口检查**：其他 12 个密钥脚本都会在剪贴板历史开着时停下，它只在最后提醒去删。
15. **文档和注释过时**：
    - 手册第 60 行和发布说明第 27、89 行写的 pull 命令少了 `-ExpectCount`，照抄会退出码 1。
    - 发布说明第 53 行还写"备份分支 feat/b7a-backup"。
    - `set-r2-tokens.ps1:32` 还说会检查"没有 Claude 在运行"，`safe-window.ps1` 已经删了这项。
    - 迁移 120000 文件头还写"发布前手动 execute cron.job 里的命令"。

###### 重复代码和更简单的写法
- 迁移 `20261126120000` 和 `20261126130000` 都还没进 main，也没上过预览。130000 用同名任务把 120000 的两条覆盖了。建议把 120000 并进 130000，删掉一层历史，`75_backup_daily_cron` 也跟着简单。
- backup-daily 和账号导出 `account/export-part.ts` 之间：
  - `keyOk`（core.ts:211 对 export-part.ts:38）、`pageSize`（core.ts:255 对 :74）逐字重复；
  - 两边各写一份 gzip；
  - 分页读表的主循环也是同一个思路；
  - 建议抽成 `_shared/table-pager.ts`。
- `sha256Hex`（core.ts:280）和 `_shared/body.ts:83` 重复。
- `backupDate`（core.ts:221）、`usage-report/usage.ts:62` 的 `seoulDate`、push-dispatch 的 `SEOUL_MS` 是同一个算法。
- 凭据管理器的 C# 封装在 `pull.ps1:78-112`、`set-r2-tokens.ps1`、`claude-intake/add.ps1` 各一份；`Read-Secret` 有三份。建议抽成 `tools/keys/cred.ps1`，用点引用，和 safe-window 一样。

###### 查过没发现问题
- **授权**：`backup_read`、`backup_missing` 只授 service_role（0001 第 7 行的默认权限已收回 public；77 号测试钉住）；`backup_dispatch` 收回了 public、没授给任何角色；三个都是 `search_path=''`；`backup_read` 用 case 写死五张表，不拼 SQL，只按 `user_id` 读。
- **备份读得全不全**：隐私记四张表和 `ai_memories` 走 `backup_read`，其余走 PostgREST（`max_rows` 1000，每页不超过 250 行）；清单里新加 `backup:'json'` 的表、`TABLE_KEYS` 没写的会直接报错，不会悄悄漏备份。
- **两代轮换**：按顺序跑的情况下，中途失败时旧 `_manifest` 和旧一代文件都完好。补跑在标记过期后接得上，已做完的跳过。（并发的情况见第 3、4 条。）
- **拉回**：每个文件都核字节数和 sha256；换目录是先改名旧的、再换入新的、最后删旧的，中途失败能复原。
- **恢复**：整个在一个事务里；写完再读回核对；三张有第二唯一索引的表（AI 记忆、分类、设置）的占位、改指引用，我推演了互换、改名、软删几种情况，都对；凭据类五张表默认跳过。
- **告警**：心跳 26 小时；`REQUIRED_HEARTBEATS` 含 backup-daily 和 storage-sweep；首尔 09:07 查 `backup_missing`；读不到时保留原告警状态。全部失败或部分人失败都会响。
- **密钥不外泄**：日志只记错误码；令牌只在请求头里；连接串隐藏输入、不进命令行；pull 的子进程环境里没有发布令牌。
- **发布来源**：本机 `--is-ancestor main` 加上 CI 的 `tag-on-main.sh`；产物按 `head_sha`、工作流、`head_branch` 匹配；SHA256SUMS 整份逐字比对，还要人在 iPhone 上核总指纹，绕不过去。
- **storage-sweep**：先查行再删；每轮最多删 5000 个、有时间预算；删失败的那一轮不写心跳。

###### 总分：6/10，不建议现在合并
严重的第 1～3 条必须先修；第 5、7、8 条建议一起修（第 7 条只改一行）。

###### 进程
我只起过两次 `npx vitest run`（单个测试文件），都已正常退出。按本工作副本路径查进程，没有残留。机器上其他 node、workerd、powershell 进程不是我起的，没有碰。

### 第二轮（11-26，HEAD df682c32）

B7a 复查第二轮（只读，没改文件、没提交、没推送）

【先说明】工作副本实际 HEAD 是 df682c32，不是 b069ec47。log 顺序：df682c32、e8947776、ecb5a9d1、b069ec47、a918eb7e……四个收口提交都在里面，df682c32 是最新的一个。以下按 df682c32 评审。git status 干净。

【结论】建议可以合主线。没有高或严重级别的问题。下面两条中低的建议合并前顺手修掉，也可以登记成跟进项；其余都是低。

一、上一轮意见逐条
1. 服务器备份保留期、停用账号的备份过期：已解决。storage-sweep 每天统一删所有人的过期日期，停用的也删。删除条件是“首尔日期早于 D-6，并且不在桶里最新 7 个日期里”（storage-sweep/core.ts 的 expiredBackupDates）。backup-daily 只写当天，所以删不到最近 7 个日期，也删不到正在写的那一代。account-purge 的 BACKUP_RECENT_KEEP = BACKUP_KEEP_DAYS + 1，游标前提没变。删除失败会计 failed，这一轮不写心跳，能触发告警。
2. 恢复会把库里的新值退回旧值：已解决。DEFAULT_SKIP 跳过令牌、设备、密钥、admins、vault、invites；KEEP_LIVE 保留停用、同意、锁定这几列的现值，pin_epoch 用 bump，ai. 开头的设置不写。残留一点：`--only vault` 仍会写回备份里的旧 pin_hash，但 epoch 已经加 1，可以接受。
3. 同一段被重发、两份同时跑：已解决。段号标记用 upsert=false 原子创建，同一个编号只能建成一次。
4. 两轮同时开始互相覆盖：基本解决，同一个轮次号只能建一次。剩下一个小窗口，见新问题 1。
5. 清单上限：已解决。改成分页，每页 50 人、1500 个文件；单人超过 2000 个文件回 503。
6. 轮询撞限流：已解决。拉取和等待分开计限流键，等待间隔按页数动态算。
7. 零点前后日期错位：已解决。publish 传 -Today（数据库给的首尔日期），另一种情况见新问题 5。
8. 拉取令牌和计划任务：已解决。新增 set-backup-pull-token.ps1：开头做安全检查，令牌用 SecureString 读，核对项目名和地区，写入前后都比对 secrets 名单，只有 prod 才写凭据管理器（CredWriteW），值不打印、不落盘。ecb5a9d1 的权限名（Edge Function Secrets 读写、Project Settings 只读）有官方文档出处。新增 register-pull-task.ps1，lemo-ops 加了 26 小时的 backup-pull 心跳告警。
9～15. 已解决。报错按 db_connect、db_write、commit_unknown 分开；打印报告出错单独报 print_after_commit；连接串只认指向本机的；有额度预警；查询改成 = $1::uuid，用得上索引；restore-files 试运行只要只读令牌；set-r2-tokens 文件头已改。
重复代码：已收口。table-pager、gzip、首尔日期 backupDate、cred.ps1 都只剩一份；迁移 120000 已并进 130000。

二、新问题（按严重程度）
1. 中低：supabase/functions/backup-daily/core.ts:422-432（begin）
   问题：定代（a 还是 b）和删残片，用的都是建标记之前列出来的 listed（492 行）。
   场景：B 列完目录以后、建标记之前，A 完整跑完并删光了全部标记。这时 B 也能建成同一个轮次号 1，接着按过时的 listed 去定代、删残片，可能删掉或覆盖 A 刚提交的那一代。窗口很小，但 a/b 轮换要防的正是这种覆盖。
   改法：claim(…,0) 建成以后重新列一次目录，用新结果定代和残片。
2. 中低：core.ts:364-376（chain 重试）
   问题：发下一段失败时，失败的那次请求可能已经建好了这一段的标记，于是重试必定回 200 superseded，chain 不记任何日志。
   场景：中途一次临时 503，这一轮就静默断掉，只能等标记过期后 02:30 补跑。补跑也断的话，当天没有备份，只靠 backup_missing 告警发现。
   改法：重试拿到 superseded 时记一个日志码；或者在标记里区分“开始过但失败了”。
3. 低：tools/backup/pull.ps1 的 {done:true}
   问题：publish 调用的那次拉取（-SkipFiles -SkipCleanup）也写 backup-pull 心跳。
   场景：当天 09:00 的计划任务没跑，但发版时跑过一次拉取，告警就被掩盖了。
   改法：带 -SkipFiles 时不写心跳。
4. 低：register-pull-task.ps1 让计划任务直接跑仓库工作区里的 pull.ps1。AI 会话改到一半的版本也会被执行。建议指向冻结副本或 tag 检出。
5. 低：-Today 取的是触发那一刻的数据库日期。零点前几秒触发、而有人的备份在零点以后才开始时，仍可能等错一天。
6. 低：storage-sweep/core.ts 的 expireBackups 达到 BACKUP_MAX_DELETES 以后，日期循环还会继续列目录，只是多花时间，无害。
7. 低：storage-sweep 把桶根和日期目录下的散文件计进 R2 的 unknown，两种口径混在一起。

三、按同一尺度整块看过、没发现问题的
- a/b 两代轮换：写完 _manifest 才算换过去；写之前（518 行）再核一次 stillOwner。
- manifest 签名和分页；等待用的页不签名。
- 恢复走一个事务。
- 发布脚本 1365-1368 行传 -Today。
- 正在写的那一代不会被 storage-sweep 删到。
- account-purge 的游标前提。
- 补丁叠补丁、重复实现：已查，无。

四、测试
在工作副本里跑了 npx vitest run，4 个文件：tests/edge/backup-daily.test.ts、tests/edge/backup-manifest.test.ts、tests/functions/storage-sweep.test.ts、tests/build/backup-restore.test.ts，98 条全部通过。

五、起过、已关掉的进程
只起过一次 vitest，跑完自己退出了。复查过，命令行带 b7a-merge 的进程里没有 node 或 vitest。没建临时文件，没碰 Docker、Supabase，也没碰别的会话的进程。

总分：8.5/10，可以合主线。

### 第三轮（11-27）

B7a 第三轮：publish.ps1 审查结论是不通过，不签字，不登记哈希

一、结论：不通过
文档规定的运行方式（从冻结副本运行）实测跑不起来；而且被哈希核对的只是 publish.ps1 一个文件，它运行时还会载入一份不在核对范围里的代码。修好下面第 1 条再送审。按协调者的要求，不通过就不给哈希，所以没跑 Get-FileHash 签字。

二、a5b25c76 两处改动：都对
- begin：先拿占位的代建段号 0 的标记，标记里本来就不存代，然后 `files.list(dir)` 重新列目录，再定代、删残片。上一轮提的窗口已经关上。
- chain：i>0 且回 2xx 时记 next_retry_ok，对。
- tests/edge/backup-daily.test.ts 41 条全过。合并 3ec75bae 没碰 tools/release、tools/backup、backup 函数、_shared、迁移。
- 残留一个可以忽略的窗口：A 的最新标记已经过期（超过 10 分钟），但 A 还活着、正在写 _manifest，这时 B 接管，仍可能同代相撞。现实里一段远短于 10 分钟，登记跟进即可。

三、必须修的
1. 高：tools/release/publish.ps1:1310-1312
   问题：`$SafeWindow = Join-Path $PSScriptRoot '..\keys\safe-window.ps1'; . $SafeWindow`，按脚本自己所在的位置去点源共用的安全窗口检查（26a73c47“安全窗口检查改成点引用一份共用文件”引入）。
   ① 跑不起来：正式发布说明第二节第 3 条和手册第 84 行要求只把 publish.ps1 一个文件复制到 `本机资料\05-构建测试\<日期>_publish冻结副本\` 去运行。实测：在 scratchpad 里照这个结构放一份，跑 `-Tag v0.0.0 -CheckOnly`，退出码 1，报“已停止：缺少 …_publish冻结副本\..\keys\safe-window.ps1（安全窗口检查），请从仓库完整取出 tools\keys 目录”。
   ② 安全漏洞：负责人要是照提示把 keys 目录也复制过去，或者直接在仓库里运行，第二节第 5 条核对的只是 publish.ps1 的哈希。safe-window.ps1 在主流程之前就执行（比第 309 行打印自身哈希还早），和令牌在同一个进程里，能重定义 Read-Secret、Fail 之类的任何函数。哈希签字因此保证不了实际运行的代码。
   测不出来的原因：tests/build/publish-run-harness.ts:29 只从仓库里的 tools/release 运行脚本。
   改法（二选一）：
   - 推荐：把 Assert-NoRecording 和 Test-PolicyOn 内联回 publish.ps1，keys-guard-sync.test.ts 加一条核对内联的这份和 safe-window.ps1 一字不差；
   - 或者：从 $RepoPath 读 safe-window.ps1，点源之前先比对 publish.ps1 里写死的 SHA-256。
   两种都要加一条测试：把 publish.ps1 单独复制到别的目录跑 -CheckOnly，必须能过第 1 步。

四、建议同一版一起修（中、低，不挡这次签字以外的事）
2. 中：publish.ps1:1361-1368（Invoke-BackupPull）
   问题：第 6a 步运行仓库里的 tools\backup\pull.ps1（它还会点源 backup-lib.ps1、cred.ps1）。这时本进程内存里已经有 Supabase 令牌、数据库密码、Cloudflare 令牌三样，同一用户的子进程读得到父进程内存。上一次逐个比内容是第 5 步的 Assert-StillClean，中间隔着人工输入。
   改法：照 lemo-ops 部署前（1505 行）的做法，调 pull.ps1 之前再跑一次 Assert-ContentMatchesHead（约 0.4 秒）。
3. 低：publish.ps1:1458 Get project 没有 `-MaximumRedirection 0`，也没有 try/catch，和同文件其他请求的写法不一样。出错时异常原文（含对方响应体）会被主 catch 打印出来，不含令牌。改法：照 Invoke-GitHubJson 的写法改。
4. 低：publish.ps1:1463 正式环境只让负责人照抄接口返回的项目名，没有写死预期的项目名。set-backup-pull-token.ps1 写死了 lemomemo-prod。改法：正式环境再加一条名字必须等于 lemomemo-prod（预览已经固定了 ref）。

五、按说明第一节补救表逐条核对（除第 1 条外都对得上）
- 运行审查过的脚本：309 行打印自身哈希。但被第 1 条破坏：核对的不是全部代码。
- 部署的就是 CI 在这个 tag 上的构建：对得上。
  - Find-PubArtifact 核对了产物名、没过期、head_sha、工作流路径、push 触发、仓库和 head_repository 不是 fork、tag 或运行号、html_url 前缀；
  - 解压前查路径；Assert-PubManifest 用全文一字不差比对 SHA256SUMS，再拿 dist_hash.py 对一遍算法；
  - Assert-PubSourceMatchesRepo 双向逐个比；_shared\gen 按规则核；最后在 iPhone 上输入“一致”。
- 发布包中途没被换：输令牌前、link 前、真推前、部署函数前、部署网页前各比一次（1420、1480、1487、1494、1517 行）。对得上。
- 粘贴后清剪贴板、剪贴板历史开着就停：Read-Secret 调 Clear-Clip，Assert-NoRecording 拦剪贴板历史。对得上。
- 令牌只在内存：读入是 SecureString；Invoke-WithSecrets 每个子进程只给它要的那把，结束就清；进程里预先有令牌变量就停；GitHub 令牌只放进 api.github.com 的请求头，下载完在 finally 里清掉，跳转后的地址不带令牌；带令牌时不跑仓库里的 python 或 node 脚本（dist_hash、check_backend、check_deno_drift 都在 GitHub 令牌清掉以后、部署令牌输入以前跑）。对得上，例外见第 2 条。
- 先下载核对、后输部署令牌：Supabase CLI 和 wrangler 依赖树都核哈希，第 5 步再核一次。对得上。
- 发错项目：ref 格式；预览只认写死的 ref，正式不许用预览 ref；正式必须在首尔、ACTIVE_HEALTHY；手动输入项目名。对得上（加强建议见第 4 条）。
- 改库前有备份：只在完整发布时做。没有 dispatch 又有账号就停；首发两样都没有时跳过。用数据库给的时间和日期；pull.ps1 退出码不是 0 就停在改库前。SQL 里拼进去的 $d、$t 都先过了正则。对得上。
- 迁移出意外：先 db push --dry-run，再输入“确认推送”，推之前再比一次指纹。对得上。
- 负责人的 GitHub 账号不登录开发电脑：只粘贴 github_pat_ 开头的细粒度令牌，经典的 ghp_ 拒收。对得上。
- 其余 git、wrangler、环境变量各道防护（fsmonitor、hooksPath、替换对象、属性文件、.env、往上找 wrangler 配置、代理变量）：已查，无新问题。

六、跑过的命令（都是只读）
- git log、git show a5b25c76、git diff a5b25c76 938f9dae --stat、git status、git rev-parse。工作副本 HEAD 是 938f9dae（合并提交），git status 干净。
- `npx vitest run tests/edge/backup-daily.test.ts`：41 条通过。
- 实测冻结副本：把 publish.ps1 复制到 scratchpad\frozen-test\2026-11-26_publish冻结副本\，运行 `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <副本> -Tag v0.0.0 -CheckOnly -RepoPath <工作副本>`，退出码 1，报错见第 1 条。
- grep、sed 读文件；Get-CimInstance 查进程。
- 没跑 Get-FileHash 签字，因为没通过。

七、起过、已关掉的进程和临时文件
- 我那次 vitest（单个文件，23:40:46 启动，0.3 秒就退出了）；
- 一个 powershell.exe 子进程（跑冻结副本实测，退出码 1，已退出）；
- 临时目录 scratchpad\frozen-test 已删，核过不存在；
- 工作副本没改动。
- 查进程时看到另一组 node：23:41:00 启动的全量 `vitest run`（不带文件参数，父进程 30184，二十多个 worker），以及 check_binimport.mjs、check_backend_ast.mjs。这些不是我起的，应该是你那边在跑全量测试，我没碰，请你自己确认收尾。

### 第四轮（11-27，HEAD 175f45ee）

要点见正文“第四轮原文要点”，复审员交回原话已逐条转录在那一节。
