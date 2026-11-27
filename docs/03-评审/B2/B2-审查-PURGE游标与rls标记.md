# B2 审查：PURGE-date-cursor 与 rls 标记引用（R1）

- 日期：2026-11-05
- 审查员：只读审查员（兼安全）
- 范围：工作区未提交改动
  - PURGE-date-cursor：`supabase/migrations/20261105130000_core_purge_backups_cursor.sql`、`supabase/functions/account-purge/core.ts`、`index.ts`、`shared/db.types.ts`、`tests/functions/account-purge-cursor.test.ts`、`account-purge-fakes.ts`、`account-fakes.ts`、`account-purge-budget.test.ts`、`supabase/tests/store-it/account-store.it.ts`、`supabase/tests/rls/39_purge_backups_cursor.test.sql`
  - R1：`supabase/tests/rls/_target.psql`，12、23、25、26、29、34 六个文件的引用，`tests/build/rls-target-include.test.ts`
- 依据：接手清单 PURGE-date-cursor 一条；架构第 6 节第 3 步（本次改动后的文字）
- 做了什么：读代码和测试；跑相关 vitest（8 个文件 127 条全过）；全量 vitest（排除 gen-tauri-key，4 个 worker）；用 node 对检查段正则、游标过滤做了两个小模拟。没连数据库、没起 Docker、没跑 supabase/deno。

## 结论

**不通过。总分 7.0 / 10**（PURGE-date-cursor 7.5，R1 6.5）。

全量 vitest：**1 条失败**，546 个文件通过、3 个跳过。失败的是 `tests/build/push-vectors-sync.test.ts`，由 R1 引起（见 M1）。

## 一、PURGE-date-cursor

### 核对过、没问题的

1. **漏删 / 重复删（前提成立时）**：游标只在“确认删空”（列为 0，或删完再列为 0）之后才推进（`advanceBackupCursor` 在 `backups_not_empty`、子目录错误之后才调）；预算停下（`time_budget`）时推进发生在判断之前，刚删完的那个日期也记进去。跳过的只有“不大于游标、写法相同、不是最后一个”的日期。重复删就是多列一次，没有副作用。
2. **中断后续跑**：游标只在 `catch` 里写回。函数中途崩溃、来不及写，下一轮从旧游标起多列几次，结果不变。写回条件带 `purge_started_at = claimedIso`：认领被别人重领以后旧进程写不进去；`.or(backups_done_through.is.null, lt.<date>)` 保证只往后推。读游标也带认领时刻，认领不对就读到 null、从头列，偏保守。成功路径不写（这一行随 deleteUser 级联删掉），第 6 步认领丢了直接回 skipped 也不写，都对。
3. **并发 / 注入**：`saveBackupsCursor` 先过 `BACKUP_DAY` 才拼进 `or()` 过滤串，迁移 check 再拦一次（rls/39 有逗号、斜杠用例）。
4. **重新申请注销清游标**：`account_request_deletion` 的 on conflict 分支写 `requested_at = excluded.requested_at`（now()），触发器 `before update of requested_at` 加 `is distinct from` 判断，rls/39 覆盖“同值不清、重写清空”。restore 删整行，游标一并没了。
5. **授权与 RLS**：迁移只加列、加触发器函数和触发器。`pending_deletions` 的授权仍是 0001 给 service_role 的表级 select/insert/update/delete，没有列级授权；没有新增 grant、policy；private 对 anon/authenticated 没有 usage（rls/39 ③ 有 authenticated 42501 用例）。触发器函数 `set search_path = ''`、security invoker；0001 的 `alter default privileges ... revoke execute on functions from public` 已覆盖新函数。**授权和 RLS 没有放宽。** `lock_timeout = '5s'` 写法同前。
6. `db.types.ts` 三处（Row/Insert/Update）都加了列，类型对。

### 必改

- **M2 前提“backup-daily 只往当天日期写”没有任何守护，不成立时会在注销完成后留下用户备份。**
  后果：游标推过日期 D 以后，若有人往 D 补写这个用户的文件（补跑漏掉的那天、重试、改写法按“数据日期”命名等），之后每一轮都跳过 D，第 3 步照样判“删完”，接着写 `deleted_accounts`、deleteUser，账号标成已删，**D 下这个人的备份留在 backups 桶里**，要等 7 天轮换删掉（backup-daily 和轮换现在都还没写，轮换没做之前就是一直留着）。这是注销承诺的一部分，属于隐私问题。
  现在只靠架构文档和接手清单写一句“前提”，backup-daily 还没建，到时候没有测试会提醒。
  改法（任选其一，代价都很小）：
  ① `backupDatesToScan` 永远照列**最新的 K 个日期**（K ≥ 备份保留天数 + 1，例如 8），游标只跳更老的；正常账号只有约 7 个日期，等于没有游标，只有几百个日期的大账号才省；保留期外的日期就算被补写也很快会被轮换删掉；
  ② 或者在最后一轮（不再因预算停下、要往第 4 步走之前）对“不大于游标、在保留期内”的日期再列一次。
  另外补一条单测：游标推过 D 之后往 D 补一个文件，整轮跑完 `backups.count(A)` 仍为 0。

### 建议

- **S1 日期名正则太宽**：`^[0-9]{4}-?[0-9]{2}-?[0-9]{2}$` 的两个连字符各自可选，`2026-1231`、`202610-01` 都算“日期”，长度相同但写法不同。模拟结果：游标 `202610-01` 时 `2026-1231` 被跳过（按字符串 `-` 比 `1` 小）。backup-daily 不会出这种名字，但改成 `^\d{4}-\d{2}-\d{2}$|^\d{8}$` 更稳，迁移 check、`BACKUP_DAY` 一起改。
- **S2 游标可能永久冻结（只影响性能）**：排在最前面的非日期名、或两种写法混在一起（例如 `20251231` 排在 `2026-01-01` 之前）时，每一轮第一个扫到的就让 `frozen = true`，游标再也不推进，退回老行为。不错删，记一笔即可；backup-daily 定写法时守住一种写法。
- **S3 单测名不副实**：“最后一个日期每轮照列：上一轮之后它又多了文件，照样删掉”这条并没有在上一轮之后补文件，而且最后一个日期本来就大于游标，没测到“最后一个日期不大于游标仍照列”的整轮情形（纯函数用例有，整轮没有）。

## 二、R1：rls/_target.psql 与静态单测

### 核对过、没问题的

- `_target.psql` 的检查段和 `_helpers.psql` 开头逐字一致，单测比对；`.psql` 扩展名不会被 pg_prove（`--ext .pg --ext .sql`）当成测试选中。
- 12、23、25、26、29、34 六个文件都在 `begin; select plan(n);` 之后第一句 `\ir _target.psql`；其余文件引 `_helpers.psql`。离线跑法在会话里 `set_config('lemo.test_target','offline')`，CI 在 ci.yml 第 245 行给 lemo-ci 设 `'ci'`。
- 漏引能拦住：单测对每个 `*.test.sql` 逐个断言 begin 之后第一句；`begin; delete …` 写在同一行、没有 begin、用 `start transaction` 都会判失败。现有文件 begin 之前都只有注释，也没有中途 commit。
- 检查段在事务里报错，前面同一事务里做的事一起回滚，所以“第一句”这一条主要防的是事务外的副作用。

### 必改

- **M1 `build/gen_push_vectors.mjs` 没跟着改，全量 vitest 失败 1 条。** 29 号文件是由 `tests/fixtures/push-endpoints.json` 生成的，手工加的 `\ir _target.psql` 让 `tests/build/push-vectors-sync.test.ts` 判“和 fixture 不一致”（差的正是这一行）。而且谁按提示重新跑一次生成脚本，这一行就被抹掉（那时 rls-target-include 会拦住，但两条测试互相打架）。改法：生成脚本在 `select plan(...)` 之后输出 `\ir _target.psql`，再生成一次核对一致。
- **M3 静态单测还有两个口子，拦不住“检查段失效”：**
  ① `CHECK` 正则中间是 `[\s\S]*?`，`raise exception` 这一行没钉。模拟：两个文件都改成 `raise notice`，正则仍匹配、逐字比对仍相同，单测全过，标记检查却不再中止事务。把 raise 那一行（至少 `raise exception '`）写进正则。
  ② 只看 begin 之后，**begin 之前**的语句不查。写在 `begin;` 之前的语句在自动提交下先执行、检查段根本拦不到，恰好是这道防线要防的情况。补一条：`begin;` 之前只许空行和 `--` 注释；顺带断言文件里只有一个 `begin;`、`commit;` 不出现（只许最后的 `rollback;`）。

### 建议

- `lemo.test_target` 是数据库级参数，谁都能在会话里 `set` 掉，只防手误、不防故意，注释里写明即可（现在的注释已经差不多是这个意思）。

## 三、必改汇总

| 编号 | 项 | 位置 |
| --- | --- | --- |
| M1 | 生成脚本同步输出 `\ir _target.psql`，全量 vitest 回到 0 失败 | build/gen_push_vectors.mjs、supabase/tests/rls/29_push_endpoint_vectors.test.sql |
| M2 | 前提不成立时会漏删：最新 K（≥8）个日期永远照列（或完成前复核保留期内的日期），补“游标后往旧日期补写”的单测 | supabase/functions/account-purge/core.ts、tests/functions/account-purge-cursor.test.ts |
| M3 | 静态单测钉住 `raise exception` 那一行；`begin;` 之前只许注释，只有一个 begin、没有 commit | tests/build/rls-target-include.test.ts |

改完请原审查员复审：M1 看全量 vitest，M2 看新单测和独立副本里去掉“最新 K 个照列”时新单测失败，M3 看独立副本里改成 `raise notice`、在 begin 前加一句时单测失败。

## 复审（2026-11-05，同一审查员，同一尺度）

做了什么：读改动后的 core.ts、迁移、rls/39、rls-target-include.test.ts、gen_push_vectors.mjs、build/d1/db-target.mjs 及两个调用方、login-probe.mjs；全量 vitest（排除 gen-tauri-key，4 个 worker）：**550 个文件通过、3 个跳过、0 失败**（7080 条）。没连数据库、没起 Docker。后端说的独立副本变异（mut-s2、mut-m3）、lemo-e2e 实测没有重跑，按回报采信；对应逻辑已逐行核对。

### 上一轮意见逐条复查

| 编号 | 结论 | 核对 |
| --- | --- | --- |
| M1 | 已解决 | 生成脚本第 31 行写出 `\ir _target.psql`；push-vectors-sync 转绿，全量 0 失败 |
| M2 | 已解决 | `BACKUP_RECENT_KEEP = 8`，合格日期里最新 8 个永远照列，不看游标。新用例在 day(14)（游标 day(16) 以内）补写，第二轮删净。推演过：最新 8 个里有不大于游标的日期时，比游标大的日期必然也都在这 8 个里，扫描顺序不会让游标越过没确认的日期；内存里游标暂时变小时，库里 `lt` 条件挡住回退。保留期外补写写进了架构第 6 节第 3 步，可以接受 |
| M3 | 已解决 | 正则钉住 `raise exception '…'` 那一行；txProblems 查 begin 之前只许注释、begin 恰好一个、没有 commit/abort/end transaction、最后一句是 rollback;。plpgsql 函数体里的 `end;` 区分不了，注释已写明，接受 |
| S1 | 已解决 | core.ts 和迁移 check 用同一个正则；rls/39 加了 2026-1231、202610-01，plan(15) |
| S2 | 已解决 | 写进架构和接手清单 |
| S3 | 已解决 | 用例改成“游标等于最后一个日期照样列、照样删”；补文件的场景挪到 M2 那条 |

### D1 防线（新）

- d1Target：本机必须是本机地址加 55322；没设 D1_DB_URL 时只有 CI 放行，而且 config 要恰好是 lemo-ci、没有 .env*。两个调用方连库之前都先过它；build/、tools/、supabase/tests/ 里除 db-target.mjs 外只剩注释里提到 54322。login-probe 改用 store-it 同一道护栏，本机不再调 supabase status。思路对。
- **低 L1**：设了 D1_DB_URL 又 `CI=true` 时，端口不查、config 也不查。本机 shell 里要是设了 CI=true（act、某些终端配置），`D1_DB_URL=…:54322` 照样能连上 lemomemo。建议这时也过一遍 config 检查，或者 CI 下只认 54322，同时要求 config 是 lemo-ci。不阻塞。
- **低 L2**：主机只看 URL 的 hostname；postgres.js 是否认 `?host=` 这类查询参数来改掉主机，没有核实。建议地址里带查询参数一律拒绝。

### 复审分数

**8.5 / 10，通过**（PURGE-date-cursor 8.5，R1 8.5，D1 8.0）。必改：无。建议：L1、L2。

## 复审二：L1、L2 改动（2026-11-05）

范围：build/d1/db-target.mjs、tests/build/d1-target.test.ts、ci.yml 的 d1_negative 一步。只读，没连数据库。d1-target 单测 15/15 通过。

- **L1 已解决**：设了 D1_DB_URL 就只许本机地址加 55322，CI=true 也不例外，单测钉住了 CI 指 54322 被拒。
- **L2 已解决**：地址里出现 `?`、`#`（原串和 URL 解析结果都查）一律拒绝，CI 里也一样。
- **会不会误拒 CI**：d1_negative 和 test:db 里的 `deno task d1` 同在 db 任务里，都排在第 87 行 sed 把 project_id 改成 lemo-ci 那一步之后；GitHub Actions 自带 `CI=true`。仓库里唯一的 `.env*` 是 supabase/functions/.env.example，不在只查的仓库根和 supabase/ 两层里；ci.yml 里也没有哪一步写 .env 或设 D1_DB_URL。`deno task d1` 走的是同一条默认路径，而且 allow-env 里有 CI，allow-net 里有 54322，所以 test:db 能过，这一步就能过。按代码判断不会误拒。CI 上实际跑一次还没看到，要以第一次推送的结果为准。
- **会不会连错库**：默认地址 127.0.0.1:54322 是这个 runner 上 supabase start 起的 lemo-ci，口令 postgres 是 CLI 的本地默认值，和原来 `supabase status` 给的 DB_URL 一样；runner 上只有这一套库。本机设了 CI=true 也会因为 project_id 不是 lemo-ci 被拒（单测里用仓库现状 config 测了）。
- **低（记一笔，不阻塞）**：d1Target 不像 guard-cli 那样查 SUPABASE_* 环境变量；它反正不读这些变量，影响不大。

结论：**通过**，分数维持 D1 8.5。必改：无。

## CI 兼容样例复盘（2026-11-06）

背景：ef3a569 的 CI（run 42122550396）“兼容样例”一步变红，根因是 R1 以后 `_helpers.psql` 要求库上有 lemo.test_target 标记，而样例循环每轮 `supabase db reset` 把标记清掉了。范围：ci.yml 兼容样例循环、tests/compat/sql-case.ts、run-compat.ts、supabase/tests/offline/run.mjs、sample_rename_column.psql、tests/build/run-compat.test.ts。只读，没连库。

**这是 R1 带出来的漏项**：上一轮审 R1 时只核对了 test:db 那一步前面有没有打标记，没查同一个任务后面还有没有 db reset。这一点算本审查员漏看。

核对结果：
- ci.yml 里一共两处 `db reset`：第 217 行在打标记（245 行）之前，没问题；第 348 行在样例循环里，现在 reset 后马上重新打标记（第 350 行，写法同 245 行），然后才跑样例。没有别的 reset。
- judgeSample：`fail <SQLSTATE>` 要求至少一条失败，而且失败的 SQL 用例全是这个码。“标记没打”“helpers 报错”这类其他原因的失败不再算符合，假通过的口子堵上了。run-compat.ts 里 httpOk 只赋值一次（只起一次 vitest），不会被覆盖。离线和 CI 用的是同一个判定函数。
- 离线标记挪到所有分段之前，`--only=compat` 时也有标记。
- 本机实测：run-compat 单测 20/20 通过；离线 `--only=compat` 两个样例都符合（rename 按 42703 失败）。lemo-e2e 上的正反对照组按后端回报采信，没有重跑。

建议（低，不阻塞）：
- **C1**：`fail` 不写码时仍是“随便失败就算符合”，同样的假通过以后还会出现。建议在 run-compat.test.ts 里加一条：supabase/tests/compat 下所有 `fail` 样例都必须写 SQLSTATE。
- **C2**：同一个任务里以后再加 db reset 还可能漏打标记。可以让 run-compat.test.ts 钉住“ci.yml 里每个 `supabase db reset` 后面紧跟打标记，或者排在第 245 行之前”。

结论：**通过 8.5/10**，必改：无。
