# B2 安全审查：发布脚本改用 copy_shared 生成 _shared\gen（PUBLISH-shared-rewrite）

- 日期：2026-11-05
- 审查人：安全审查员（只读，默认不通过）
- 范围：
  - `tools/release/publish.ps1`：第 6 步改库前跑 `node build\copy_shared.mjs`；新函数 `Assert-SharedRewritten`；删掉原来的 Copy-Item
  - `tests/build/publish-run-fakes.ts`、`publish-run-harness.ts`：新增 LEMO_FAKE_COPY_SHARED 和 copyShared 选项
  - `tests/build/publish-run-shared.test.ts`：新增 6 条
  - 上线与回滚手册：回滚办法 B
- 做了什么：
  - 读代码；
  - 跑了 `publish-run-shared.test.ts`，6 条全过；
  - 单独再跑一次回滚那条，前后比较真仓库 `supabase/functions/_shared/gen` 的修改时间，没有变化。
  - 没部署，没连任何 Supabase 项目。

## 结论：不通过，1 条必改

改动方向正确：原来的 Copy-Item 会把三个函数部署坏，这次改掉了。但第二次核对只看文件头和裸包名，既拦不住“生成以后被改了”，也拦不住“这次根本没生成、用的是旧的 gen”。见必改 P1。

## 一、演练里转给真 node，会不会碰到假仓库以外的东西：不会

- **假仓库是独立的工作区**：用 `git clone --shared` 建在系统临时目录 `lemo-publish-run-*` 下。`--shared` 只共享对象库，工作区里的文件都是真文件，`build\copy_shared.mjs` 也在其中。
- **真 node 写到哪里**：发布脚本先 `Push-Location $RepoPath`（演练时就是假仓库），再调假 node 函数。假 node 只有在第一个参数以 `copy_shared.mjs` 结尾时，才转给真 node（`$global:RealNode` 在定义假函数之前，用 `Get-Command -CommandType Application` 取到）。copy_shared 的 ROOT 取的是 `import.meta.dirname/..`，也就是假仓库。它只读假仓库的 `package.json` 和 `shared/`，只写假仓库的 `_shared/gen`。假仓库 `node_modules` 里那些目录联接，copy_shared 不碰。
- **实测**：单跑“回滚 -Only functions”那条演练，真仓库 `_shared/gen/core/date.ts` 的修改时间前后一致。
- **令牌**：演练用的是假令牌。正式流程里 copy_shared 跑在 `Invoke-WithSecrets` 外面，进程环境里没有令牌。
- **fail、raw、bare 三种模拟**：只在假仓库里改动（`Copy-Item`、`AppendAllText` 用的都是相对 `Get-Location` 的路径）。

## 二、两次核对之间被改了，第二次能不能拦住：只能拦住一部分（必改 P1）

`Assert-SharedRewritten` 只核对三件事：
- gen 目录里有文件；
- 每个 .ts 以 copy_shared 的文件头开头；
- 没有裸引 zod 或 aws4fetch。

所以下面两种情况都拦不住：

1. **生成以后内容被改，但文件头还在**。中间要等人输入“确认推送”，这段窗口可能很长。gen 被 git 忽略，`Assert-ContentMatchesHead` 不覆盖它，`Assert-NoIgnoredDeployFiles` 又专门把 gen 排除在外。所以 gen 里的任何改动（例如改了一个 schema 的校验规则），只要文件头还在，就会照样部署到正式环境。
2. **copy_shared 这次没有真正跑**。copy_shared.mjs 判断“是不是直接运行”的写法，和两连接脚本复审五 R5-2 的问题一样：`import.meta.url === pathToFileURL(process.argv[1]).href`。`-RepoPath` 如果是经目录联接、符号链接或 subst 盘符给的，这两个值对不上，main 不跑，退出码 0。
   - 这时仓库里原有的 gen 一般还在：开发机跑过 `npm run copy:shared`，或者上次发布留下的。旧的 gen 同样带文件头、没有裸引，所以两次核对都会通过，最后部署的是**旧的 shared 代码**配**新的函数**。
   - 默认路径 `D:\claude code\柠檬记APP` 我核对过，不是联接，所以平时不会触发。但是运维用 `-RepoPath` 指到别的克隆时，这个风险是真实存在的。

**改法（三条都做）：**
- 跑 copy_shared 之前，先在 PowerShell 里删掉 `supabase\functions\_shared\gen`。这样 copy_shared 如果没跑，第一次核对就会因为“没有生成的文件”停下。
- 第一次核对通过以后，用现成的 `Get-DistHash` 给 gen 记一个哈希。部署函数前第二次核对时，重新算哈希并比较，不一致就停。写法和 `Assert-Aws4Unchanged` 一样。
- copy_shared.mjs 的入口判断改成比较 realpath（或者发布脚本改成 `node --input-type=module -e "import('./build/copy_shared.mjs').then(m => m.copyShared())"`），和 R5-2 的修法一致。

演练补两条：
- 两次核对之间往 gen 的某个文件里改一行、保留文件头，要停在部署函数之前；
- copy_shared 不生成任何文件、退出码 0，要停在改库之前。

## 三、生成的 npm:包@版本 和 deno.lock、deploy-preview 是否一致：一致

- copy_shared 的版本取自 `package.json` 的 dependencies：zod `4.6.7`、aws4fetch `1.0.20`，都是精确版本，没有 `^`、`~` 这类范围。
- 和 `supabase/functions/deno.json` 的 imports、`deno.lock` 里记的版本完全一致。
- deploy-preview 用的是同一个 `npm run copy:shared`，生成规则相同。
- 部署端不读锁，间接依赖的漂移由 `Assert-NoNpmDrift`（`build\ci\check_deno_drift.mjs`）把关：第 1 步查一次，输入令牌前再查一次。
- package.json 和 deno.json 两边的版本是否一致，靠 CI 的 `tests/build/deno-config.test.ts` 保证；发布脚本本身不核对。tag 是从 main 打的，CI 没过的提交一般到不了这一步。所以不算必改，见建议 P-S1。

## 四、回滚 -Only functions：同样走到

copy_shared 和两次核对都在 `if ($script:DoWeb)` 外面，回滚只部署函数时一样会执行。演练里“回滚 -Only functions”那条已经钉住了：copy_shared 在 `functions deploy` 之前执行，核对执行了两次。

-Only functions 不跑 `npm ci`，但 copy_shared 只用 `node:fs`、`node:path`、`node:url`，不需要 node_modules。

手册回滚办法 B 已经改成 `npm run copy:shared`，和脚本一致。

## 五、正式环境里有没有新的出错分支：没有危险的

- **node 不在 PATH**：第 1 步已经对所有模式检查 `node`（第 273 行），会在输入令牌之前就停下。
- **node 版本太旧**：没有 `import.meta.dirname`（Node 20.11 以前）时，copy_shared 会抛错，退出码不为 0，停在改库之前。这是安全的失败方式。
- **copy_shared 自己报错**：shared 引了不许的包、相对 import 没带 .ts 等，退出码 1，停在改库之前。演练 fail 那条钉住了。
- **唯一一个“该失败却不失败”的出口**，就是第二节说的入口判断静默跳过，算在必改 P1 里。

## 六、必改

| # | 级别 | 问题 | 改法 |
|---|---|---|---|
| **P1** | 中 | gen 没覆盖进内容核对：生成后被改（文件头还在）、或者 copy_shared 静默没跑而沿用旧 gen，两次 `Assert-SharedRewritten` 都会通过，正式环境部署的不是这个 tag 的 shared | 生成前删 gen；第一次核对后记 `Get-DistHash`，部署前比较；copy_shared 的入口判断改成比 realpath；演练补“中途改内容”“静默不生成”两条 |

## 七、建议（不阻塞）

- **P-S1**：`Assert-SharedRewritten` 再加一条：gen 里出现的每个 `npm:包@版本`，都必须和 `supabase/functions/deno.json` 的 imports 完全一致。这样发布脚本自己就能拦住版本漂移，不用依赖 CI 结果。
- **P-S2**：跑 copy_shared 之前，先调一次 `Assert-ContentMatchesHead`。第 5 步的 `Assert-StillClean` 和这里之间，还要等人输入令牌、Account ID、项目名，间隔不短。仓库里的 `build\copy_shared.mjs`、`shared\`、`package.json` 在执行前最好再核一次，省得执行的是改过的脚本。

## 八、打分（10 分制）

| 维度 | 分 | 说明 |
|---|---|---|
| 正确性（部署出来的函数能用） | 9 | 裸包名问题已修，回滚路径同样覆盖 |
| 部署内容完整性 | 6 | gen 不在内容核对范围内，可能是被改过的或旧的（P1） |
| 演练安全 | 9 | 转给真 node 只作用于假仓库，实测没写真仓库 |
| 失败方式 | 8 | 报错都停在改库之前；只有静默跳过这一个出口 |
| 测试 | 7 | 6 条覆盖了生成、回滚、失败、原样复制、裸引；没覆盖中途改内容和静默不生成 |

## 复审一（11-05）：P1、P-S1、P-S2

本轮只读，没有 git add，没部署，没连任何 Supabase 项目。

我做了这些：

- 用 `git clone --shared` 在草稿目录建了一个独立副本：把工作区当前的改动复制进去、在副本里提交，`node_modules` 用目录联接指向工作区。
- 在副本里跑了 `publish-run-shared.test.ts`，11 条全过。
- 做了两个变异，做完已还原，并和工作区逐字核对一致。
- 在共享工作区跑了 `copy-shared.test.ts`（7 条）和 `publish-run-gitsafety.test.ts`（20 条），都全过。

### 结论：通过。P1 已解决，P-S1、P-S2 已采纳，没有新的必改

**P1 已解决：**

- **先删 gen**：执行 copy_shared 之前，先在 PowerShell 里删掉 `_shared\gen`，删不掉就停。我在草稿目录实测过 PS 5.1 的 `Remove-Item -Recurse -Force`：
  - gen 本身是联接时，只删掉联接；
  - gen 里面套着联接时，也不会删到联接指向的目标。
  
  所以就算有人把 gen 换成联接，也不会误删别处的文件。
- **记指纹、比指纹**：第一次核对通过以后，用 `Get-DistHash` 记下指纹 `$script:GenHash`。部署函数之前，先用 `Assert-GenUnchanged` 比文件数和总哈希，再做一次生成规则的核对。`Get-DistHash` 遇到 gen 里有联接就停。
- **入口判断**：`copy_shared.mjs` 的 `isMain()` 改成两边都用 `realpathSync.native` 解析成真实路径再比，subst 盘符也能解析。`copy-shared.test.ts` 新加了一条：经目录联接调用、输出到临时目录，照样生成文件。

**变异（在独立副本里做，只跑 3 条行为用例，不靠静态核对抓）：**

| 改法 | 结果 |
|---|---|
| 基线 | 3 条全过 |
| 去掉“先删 gen” | 3 条全红（包括“静默不生成时沿用旧 gen”那条） |
| 去掉“部署前比指纹” | 2 条红（“中途改了内容”“两次指纹一致才部署”） |

两个变异都被抓到。

**P-S1 已采纳**：gen 里每个 `npm:包@版本` 都必须一字不差地出现在 `supabase\functions\deno.json` 的 imports 里。演练的 ver 替身（把 zod 改成 0.0.1）能拦住，停在改库之前。

**P-S2 已采纳**：跑 copy_shared 之前，先调一次 `Assert-ContentMatchesHead`。gitsafety 那组里，内容核对的次数相应改成 5，测试通过。

### 打分（同一尺度）

| 维度 | 上一轮 | 本轮 |
|---|---|---|
| 正确性 | 9 | 9 |
| 部署内容完整性 | 6 | 9 |
| 演练安全 | 9 | 9 |
| 失败方式 | 8 | 9 |
| 测试 | 7 | 9 |
