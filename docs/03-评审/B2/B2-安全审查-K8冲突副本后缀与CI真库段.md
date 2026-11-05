# B2 安全审查：K8 冲突副本后缀按语言生成，CI 跑 set-cron-secret 的真库段

- 日期：2026-11-05
- 审查人：安全审查员（只读，默认不通过）
- 范围：
  - 一、`supabase/migrations/20261105100000_core_apply_patch_fork_suffix.sql`、`supabase/tests/rls/14_apply_patch.test.sql`（73 → 79 条）、`shared/sync/fork-suffix-data.ts`、`tests/build/fork-suffix-sql.test.ts`
  - 二、`.github/workflows/ci.yml` 的 db 任务新增的一步、`tests/build/set-cron-secret.test.ts` 新增的护栏
- 做了什么：
  - 新旧函数体逐行 diff；
  - 跑离线库 `npm run test:db:offline -- --only=rls`：14 号 79 条全过；
  - 跑 `fork-suffix-sql.test.ts`、`set-cron-secret.test.ts`：16 条全过（本机没有测试库，真库段照旧跳过）；
  - 在草稿目录的独立副本（scratchpad\mutdb）里对新迁移做了 4 个变异，做完已还原，并和工作区逐字核对一致。
- 没起 lemo-e2e，没连预览库和正式库，没 git add。

## 结论：两项都通过，没有必改

## 一、K8 冲突副本后缀

### 1. 和原迁移逐行比：只有说明里的三处改动

我把 `20261029200000_core_apply_patch.sql` 第 35～152 行（原函数）和新迁移里的函数整段取出来，只把 `create or replace` 还原成 `create`，再做 diff。差异只有三处：

- declare 多了一行 `sfx text;`；
- forked 分支插副本之前，多了按 `ui_locale` 选后缀的 `case`（6 行，含 2 行注释）；
- 截断从 `left(…, 154) || '（冲突副本）'` 改成 `left(…, 160 - char_length(sfx)) || sfx`。

白名单、判定顺序、返回体、异常处理一字未动。两份迁移之间，没有别的迁移改过 apply_patch。

### 2. 授权、函数属性、search_path：和原函数一致

- 原函数就是 **security invoker**，不是 definer（任务描述里写成了 definer）。新函数同样是 `language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s'`，逐字一致。
- `create or replace` 不改属主，也不改已有的 EXECUTE 授权。原迁移授权给 `authenticated`，并且从 `public, anon, service_role` 收回，这些都保留下来。签名没变，所以不会另建一个重载、绕过这些授权。pgTAP 14 号原有的授权核对照旧全过。

### 3. 读 profiles 只看本人：对

- 后缀按 `(select p.ui_locale from public.profiles p where p.user_id = (select auth.uid()))` 取。条件只用 `auth.uid()`，没有用任何参数（`p_id`、`p_patch` 都不参与），调用方没法通过参数改成读别人的。
- 函数是 invoker，还要再过一道 `prof_sel` 策略（`user_id = auth.uid()`），只放行本人那一行。
- 取不到值（比如没有 profile）时得到 null，走 else 分支，用中文后缀。不会报错，也不会回滚整个调用。
- `ui_locale` 列有 `not null` 和 `check in ('zh-CN','ko-KR')` 约束，正常只会是这两个值。
- 变异 K4 证明这条有测试钉住：把条件写死成另一个用户 B，被测试抓到。

### 4. pgTAP 里临时去约束：不会漏出子事务

- `tests.fork_title_with_locale` 的 drop constraint、drop not null、改值、造数据、触发 forked，全都在带 `exception` 的内层块里。PL/pgSQL 的这种块就是一个子事务。块的最后主动 `raise` 一个 P0L10，接住后返回副本标题。子事务回滚时，约束、数据，连同 ALTER TABLE 拿的 AccessExclusive 锁一起还原、释放。后面经 dblink 跑的几条不会被锁挡住，实测 79 条全过就说明了这一点。
- 如果中途抛的是别的错，handler 接不住，错误会往外传。但子事务此时已经回滚，整个测试又在 `begin … rollback` 里，最坏结果是这个测试文件报错，不会把改过的表结构留下来。
- 这个辅助函数建在 `tests` schema 里，也在外层事务中，会随最后的 rollback 一起消失。

### 5. 截断边界：对

- `notes.title` 的约束是 `char_length(title) <= 160`，`left()` 也是按字符（码点）截。两边口径相同，多字节字符（韩文、中文、emoji）不会算错长度。
- 韩文后缀 `' (충돌 사본)'` 共 8 个字符（空格、括号、汉字都按 1 个算），所以截到 152；中文后缀 `'（冲突副本）'` 共 6 个字符，截到 154。两种情况副本标题最多正好 160 字。pgTAP 用 160 字满额的标题测了这两种（`repeat('나', 160)`、`repeat('长', 160)`），截完正好 160。
- 标题为空或 null 时，`coalesce(…, '')`，副本标题就只有后缀，满足约束。
- 小局限（不影响安全）：按码点截，可能把一个组合字符或 emoji 序列从中间截断，显示上会出现半个字符。原来的 154 也是这样。

### 变异（独立副本，4 个全被抓）

| # | 改法 | 结果 |
|---|---|---|
| K1 | ko-KR 也用中文后缀 | 被抓（2 处失败） |
| K2 | 截断固定为 154（韩文会超 160） | 被抓（3 处失败） |
| K3 | 不认识的语言用韩文后缀 | 被抓（5 处失败） |
| K4 | 读 profiles 改成按另一个用户 | 被抓（2 处失败） |

## 二、CI-setcron-realdb

### 1. 会不会把密钥打进公开日志：不会

- db 任务里没有引用任何 `secrets.*`。lemo-ci 是一次性的本地库，没有真实的密钥。
- 真库段在事务里跑脚本发出的两段 SQL，最后回滚：
  - 写入用的值在库里用随机数生成，SQL 文本里没有值；
  - 读回只取 `decrypted_secret ~ '^[0-9a-f]{64}$'` 这样的布尔结果，打印出来的只有 `cron_secret|t|1` 这一类。断言失败时 vitest 打印的也只是这些。
- 假服务端那几条用例里出现的值，都是测试临时生成的随机数，不是真实密钥。

### 2. 本机没设变量时照旧跳过：对

- 新护栏一开头就判断 `LEMO_REQUIRE_TEST_DB` 是否为空，为空直接返回。本机实测：没开测试库，16 条全过，真库段照旧跳过。
- 设了这个变量时，要求三件事：
  - 变量值本身在白名单里（`testDbAllowed`，只认 lemo-ci、lemo-e2e，带 lemomemo、lemo-purgeit 的一律拒）；
  - 探到的容器正好是它；
  - 有 PowerShell（GitHub 的 ubuntu runner 自带 pwsh）。
  
  任何一条不满足就失败，不会静默跳过。这个变量只用来核对，不能把白名单放宽，也不能让测试去连别的容器。
- 用 act 在本机跑、镜像里没有 pwsh 时，这一步会失败。这是失败而不是放过，可以接受。

## 打分（10 分制）

| 维度 | 分 | 说明 |
|---|---|---|
| 迁移改动范围 | 10 | 只有说明里的三处，逐行 diff 核过 |
| 权限与隔离 | 9 | invoker、授权保留，只读本人的 profile |
| 测试 | 9 | 满额截断、两种语言、未知值、空值都有；4 个变异全抓到 |
| CI 真库段 | 9 | 不泄露密钥，设了变量就不许跳过，本机照旧 |

## 建议（不阻塞）

- **K8-S1**：pgTAP 再加一条反向用例：B 的 `ui_locale` 设成 ko-KR，A 是 zh-CN，A 触发 forked 后，副本必须用中文后缀。这样能从两个方向都钉住“只看本人”。
- **K8-S2**：`fork-suffix-data.ts` 改名完成以后，确认 `tests/build/fork-suffix-sql.test.ts` 比对的是新文件名，迁移注释里引用的路径也一致。现在这两处已经是新名字。
