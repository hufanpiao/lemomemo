# 正式发布说明：本机运行 `publish.ps1`（R-206）

- 日期：2026-10-28（B0，运维初稿）；**2026-11-26 B7a 改版**：本机不再构建，改为下载 CI 发布包、按 `SHA256SUMS` 核对后部署；加 `-Env preview` 预览演练、`-SiteOrigin`（首发先发到 pages.dev）、发布前触发 backup-daily；这次只上网页，exe 之后单独发（负责人 11-26 选“做齐再上”、不发电脑版 exe）
- 依据：R-206（不买 GitHub Pro；正式环境的令牌不放 GitHub；正式发布由负责人本机运行脚本；CI 只构建和测试）；R-220（令牌不另存：正式令牌每次发布时临时生成、发完删掉）；R-223（不再检查 Claude 是否在运行）；架构 0.31 第 24 条（方案 A：下载 CI 产物）、8.3 deploy-prod 一行、8.3a、8.4、8.5；人员名单第七节；[上线与回滚手册-v4](上线与回滚手册-v4.md)
- 脚本：[`tools/release/publish.ps1`](../../tools/release/publish.ps1)（Windows PowerShell 5.1 能跑，UTF-8 带 BOM）
- 谁运行：**产品负责人本人**，在自己电脑上新开的 PowerShell 窗口里。AI 只写脚本，不运行正式发布，不碰令牌。

> 架构 8.3 的 deploy-prod.yml（tag 触发、production 环境审批）被 R-206 取代：现在 CI 在打 tag 时只跑 [release-build.yml](../../.github/workflows/release-build.yml)：构建、测试、把发布包 `release-publish-<tag>` 传到这一次运行的 Artifacts（保留 90 天）、在 Summary 页“发布包指纹”一段显示文件数和总指纹，不部署。部署由本脚本在负责人电脑上做。

> **11-26 起本脚本按架构 0.31 第 24 条方案 A 做**：发布包里有网页（含 CI 打包好的 Pages Functions `_worker.js\`）、已经 copy:shared 的服务器函数、迁移和 `SHA256SUMS`。本机**不跑 npm ci、不构建、不跑 copy_shared**；下载用 GitHub REST API，不用 gh。下载令牌是**负责人本人账号**新建的细粒度令牌（只选本仓库、Actions 只读、到期选第二天），用完删掉（见第三节）。

---

## 一、为什么这样做、风险怎么补

R-206 时已告诉负责人：发布时令牌会经过开发电脑，安全不如在 iPhone 上发布。补救写进了脚本：

| 补救 | 脚本里怎么做 |
|---|---|
| 运行的是审查过的脚本 | 开头打印脚本自己的 SHA-256，你和代码审查记录里登记的哈希核对（第二节） |
| 部署的就是 CI 在这个 tag 上构建的东西 | 第 3 步经 GitHub API 找到这个 tag 提交上那一次 release-build 的发布包（核对仓库、工作流、tag、提交都对得上），下载、查路径、解压；文件集合和每个文件的 SHA-256 必须和包里的 `SHA256SUMS` 一字不差；再把服务器函数和迁移和这个 tag 的源码逐个比（`_shared\gen` 按 copy_shared 的规则核）；最后请你在 iPhone 上打开那一次运行的 Summary 页，核对“发布包指纹”一段的文件数和总指纹，输入“一致”才继续 |
| 发布包中途没被换 | 改库前、真推迁移前、部署函数前、部署网页前各重算一次整个发布包的指纹，和第 3 步核对过的不一样就停 |
| 粘贴后清剪贴板 | 每粘贴一把令牌立即清空剪贴板，并尝试清 Windows 剪贴板历史；剪贴板历史（Win+V）开着就不让继续 |
| 令牌不落盘、不打印 | `Read-Host -AsSecureString` 读入，只在本进程内存里；不写文件、不进命令行参数（PowerShell 历史里没有）；只在启动要用它的子进程时临时放进环境变量，子进程结束就清；GitHub 下载令牌只放进请求头、下载完立即清掉，跳转后的下载地址不带令牌 |
| 先下载核对、后输部署令牌 | 下载核对、装部署工具（Supabase CLI、wrangler 装到临时目录并核对哈希，用前再核对一次）都在输入部署令牌之前做完 |
| 发错项目 | 用令牌查项目：必须在首尔、状态正常；你要手动输入项目名确认；正式环境不许贴预览项目的 ref，预览演练只认预览的 ref |
| 改库前有备份 | 完整发布时改库前触发一次 backup-daily，再运行这个 tag 里的 `tools\backup\pull.ps1 -Today <数据库给的首尔日期> -WaitForToday -ExpectCount <这次发了请求的人数> -Since <触发时刻> -Snapshot <tag> -SkipFiles -SkipCleanup`：等每个可用账号当天的备份做完、下载核对到 `E:\柠檬记-备份\每日\`、另存一份到 `E:\柠檬记-备份\发布前\<日期>_<tag>\`，退出码 0 才改库（首发库里还没有账号，跳过）。pull.ps1 用它自己 `-Setup` 时存进 Windows 凭据管理器的备份令牌，本脚本不给它任何令牌 |
| 迁移出意外 | `db push` 先演练列出要执行的迁移，你输入“确认推送”才真推 |
| 负责人的 GitHub 账号不登录开发电脑 | 不在浏览器或 git 里登录：tag 从本机仓库取，只粘贴一把 1 天到期的只读下载令牌，核对指纹用 iPhone 看 |

R-223 起**不再检查 Claude 是否在运行**（不查 `claude` 开头的进程）；第四节第 1 条照样要你先完全退出 Claude。

**还剩的风险（有意接受，R-206）**：开发电脑上如果早已有恶意程序，它能在你粘贴时读到令牌。所以正式令牌要：只管正式项目（Supabase 项目级令牌）、只给需要的权限、**1 天到期**、发完就删，发现异常立刻在网页上吊销。

## 二、冻结副本和发布用的仓库副本放哪

1. `tools/release/publish.ps1` 每次改动都要过代码审查和安全审查（人员名单：运维脚本）。
2. 审查通过后，代码审查员在审查记录里写下这个版本的 SHA-256（`Get-FileHash tools\release\publish.ps1`），记录提交进仓库。
3. **冻结副本**：审查通过当天把这个文件复制到 `D:\claude code\柠檬记\本机资料\05-构建测试\<审查日期>_publish冻结副本\publish.ps1`，以后这一版就从这个副本运行，不直接运行仓库里的那份。
4. **发布用的仓库副本**：每次发布在 `D:\claude code\柠檬记\工作副本\发布-<tag>` 新 clone 一份干净的仓库、切到这个 tag，脚本用 `-RepoPath` 指向它（不用开发用的主目录 `D:\claude code\柠檬记\柠檬记APP`，那里常有没提交的改动）。发布完删掉这个副本。
5. 脚本第一行会打印自己的 SHA-256。你在 iPhone 上打开 GitHub 里那份审查记录，核对两个哈希一样再往下走。不一样就关掉窗口，在聊天里说一声。

（两样都放在这台电脑上，都能被这台电脑上的程序改，真正起作用的是第 5 步拿 GitHub 上的记录核对、第 3 步拿 GitHub 上的发布包指纹核对。架构 8.3a 原来写的 `E:\柠檬记-发布\` 按 11-23 起“柠檬记的东西只放柠檬记文件夹”的规定改成上面两处。）

## 三、要准备的

**只做一次**：

| 东西 | 放在哪 | 谁做 | 说明 |
|---|---|---|---|
| GitHub 仓库 Variables 的 `PROD_` 几项 | GitHub › 仓库 › Settings › Secrets and variables › Actions › Variables | 负责人 | 都是公开值，release-build 构建网页时写进前端（`VITE_PUBLIC_SUPABASE_URL=https://lemomemo.com/sb`、正式 anon key、VAPID 公钥、Turnstile 站点密钥）。B7a 起本机不构建，原来仓库根目录的 `.env.production.local` 不再需要 |
| 关掉 Windows 剪贴板历史 | 设置 › 系统 › 剪贴板 | 负责人 | “剪贴板历史记录”“跨设备共享”都关 |
| 备份拉取的凭据和配置 | Windows 凭据管理器 `lemomemo.backup.pull`、`lemomemo.backup.r2-pull`；`E:\柠檬记-备份\配置.json` | 负责人 | 在自己的 PowerShell 窗口先运行 `tools\keys\set-backup-pull-token.ps1 -Target prod`（本机生成 BACKUP_PULL_TOKEN，经管理接口写进函数 secrets，同时写进 `lemomemo.backup.pull`；不用粘贴），再运行 `tools\backup\pull.ps1 -Setup`（只粘贴 R2 只读令牌），`配置.json` 里填自己的 user_id（protected_user_ids）；最后运行 `tools\backup\register-pull-task.ps1` 注册每天 09:00 的拉取（错过开机补跑）。BACKUP_PULL_TOKEN 每 90 天重跑一次 set-backup-pull-token.ps1 轮换（见上线与回滚手册第七节“备份拉取令牌每 90 天轮换”）。第 6a 步调 pull.ps1 时没有这些就退出码 1、发布停在改库之前；首发库里没有账号，用不到它 |
| `OPS_SECRET` | 正式 Supabase › Edge Functions › Secrets，和 lemo-ops 的 secrets（上线与回滚手册“设好六个密钥”） | 负责人 | 在自己的 PowerShell 窗口运行 `tools\keys\new-ops-secret.ps1 -Target production` 当场生成，屏幕只显示一次，两处粘贴同一个值，不另存（R-220）；预览环境用 `-Target preview`，只放预览 Supabase |

**每次发布当天临时生成（R-220，都不另存）**：在这台电脑的浏览器里当场生成，复制后直接粘贴进脚本，不经过手机：
1. **GitHub 下载令牌**：GitHub（负责人本人账号）› Settings › Developer settings › Personal access tokens › Fine-grained tokens › Generate new token：Repository access 只选本仓库，Permissions 只给 **Actions: Read-only**（Metadata 只读会自动带上），**Expiration 选第二天**。脚本只认 `github_pat_` 开头的细粒度令牌。同一天先做预览演练再做正式发布时可以共用这一把，全部做完删掉；
2. **正式 Supabase 令牌**：Supabase › Account › Access Tokens › 生成新令牌（不要选 legacy），资源范围只勾正式项目，权限照[环境清单](环境清单-v4.md)第四节，**到期 1 天**。权限清单（以环境清单为准）：Edge Functions 读写、Migrations 读写、API Keys 只读、API Key Secrets 只读、Connection Pooling 只读、Project Settings 只读、Edge Function Secrets 只读（脚本只看名字，核对线上没有推送替身变量），**Database 读写（11-26 新加，负责人 11-26 同意：第 6a 步经管理接口的 SQL 接口执行 `private.backup_dispatch('publish')`、查有没有这个函数和可用账号）**，其余不给；
3. **正式数据库密码**：正式项目 › Project Settings › Database › 重设数据库密码（Reset database password），生成一个新的；
4. **正式 Cloudflare 令牌**：Cloudflare › 我的个人资料 › API 令牌 › 创建自定义令牌，权限照环境清单第四节（Pages: Edit ＋ Workers Scripts: Edit），TTL 结束日期选**明天**；
5. 发布完（不论成功失败）：回到这几页把这次的令牌都删掉（数据库密码不用再改，下次发布再重设）。

## 四、每次发布（约 20～30 分钟）

前提：这一版的 B7a（或修复版的对应检查）已签完，[上线与回滚手册](上线与回滚手册-v4.md)第二节的检查清单全部打勾；主持人已在 main 上打好带说明的 tag（`git tag -a vX.Y.Z`）并推到 GitHub，release-build 的 build 任务是绿的（它跑完才有发布包）。**4.0.0 首发按上线与回滚手册第三节“首发顺序”走**，比下面多了预览演练、`-SiteOrigin` 和绑域名几步。

1. **完全退出 Claude**（桌面 App 和所有终端里的 claude）。
2. 开一个新的 PowerShell 窗口，准备发布用的仓库副本（第二节第 4 条）：
   ```
   cd "D:\claude code\柠檬记\工作副本"
   git clone https://github.com/hufanpiao/lemomemo.git 发布-v4.0.0
   cd 发布-v4.0.0
   git switch --detach v4.0.0
   npm ci --ignore-scripts
   ```
   `npm ci --ignore-scripts` 只为第 1 步的后端检查（`build\check_backend.py` 要用 node_modules 里的 typescript），不跑任何安装脚本；部署的东西全部来自发布包。
3. 先演练一遍（只要 GitHub 下载令牌，可以前一天做）：
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记\本机资料\05-构建测试\<审查日期>_publish冻结副本\publish.ps1" -Tag v4.0.0 -Ops -RepoPath "D:\claude code\柠檬记\工作副本\发布-v4.0.0" -DryRun
   ```
   **一定要带 `-Ops`**（10-29 起）：usage-report 和监控 Worker lemo-ops 必须同一次部署，这个 tag 里两样都有时不带 `-Ops` 脚本第 1 步就停（[上线与回滚手册](上线与回滚手册-v4.md)第三节“部署 lemo-ops”）。第一次带 `-Ops` 前，`workers/lemo-ops/wrangler.toml` 里 KV 的 id 要换成真的命名空间 ID，还是占位值第 1 步也会停。
   会做：发布前检查（含 lemo-ops 的配置）→ 发布前源码备份（没有就做一份，放 `E:\柠檬记-备份\版本前\<日期>_4.0.0发布前\`）→ 粘贴 GitHub 下载令牌、下载发布包、逐个按 `SHA256SUMS` 核对 → 显示发布包指纹和那一次运行的链接（你在 iPhone 上打开 Summary 页“发布包指纹”一段，核对文件数、总指纹、提交后输入“一致”）→ 装部署工具 → lemo-ops 打包演练（`wrangler deploy --dry-run`，不上传）。到这里停。
4. 正式发布：同一行命令去掉 `-DryRun`（`-Ops` 留着；首发再加 `-SiteOrigin https://lemomemo.pages.dev`）。前面几步会再走一遍（备份已有就跳过，GitHub 下载令牌要再粘贴一次），然后：
   - 再核对一次工作区干净、仍是这个 tag、仓库里没有 `.env`、`.env.local`（wrangler 会自动读它们，有就停）、临时目录里的发布包和部署工具没被改过；检查剪贴板历史关着、没有 transcript 和日志策略；
   - 输入正式项目的 Project ref（不是密钥）；
   - 按提示依次粘贴三样（屏幕不显示，每样粘完清剪贴板）：正式 Supabase 令牌、正式数据库密码、正式 Cloudflare 令牌（要有 Pages: Edit ＋ Workers Scripts: Edit）；
   - 输入 Cloudflare Account ID（不是密钥）；
   - 核对项目名并输入它；脚本先只读核对正式项目的 secrets 名单里没有推送替身变量、Cloudflare 令牌有 Workers 权限、lemo-ops 六个密钥都在（有一样不对就停，此时还没改库）；
   - 第 6a 步触发 backup-daily，接着运行 `tools\backup\pull.ps1 -Today <数据库给的首尔日期> -ExpectCount <这次发了请求的人数>` 等每个可用账号当天的备份做完、拉回本机、做发布前快照（至少每 2 分钟问一次，账号多时按服务器给的等待限额自动拉长，最多等 60 分钟；库里还没有 backup-daily 定时任务、也没有账号时跳过，首发就是这样；pull.ps1 退出码不是 0 就停，此时还没改库）；
   - 看迁移演练、输入“确认推送”；
   - 自动部署函数、紧接着部署 lemo-ops、再部署网页，最后核对 `<SiteOrigin>/app/version.json`。
5. 看到“完成”以后照屏幕上“接下来”几条做（首发多一条：`set-fn-role-passwords`、绑域名、核对 lemomemo.com），关掉这个 PowerShell 窗口，**马上删掉这次临时生成的令牌**（第三节第 5 条），删掉发布用的仓库副本。
6. 在聊天里告诉主持人“发布完成”和屏幕上的发布包总指纹（指纹不是密钥），主持人记进[发布记录](发布记录.md)。

只想查一下能不能发：`-CheckOnly -Ops`，只做第 1 步检查，不要任何令牌。

**预览演练**（`-Env preview`，首发前做一次）：tag 写那一次预览构建的 `v4.0.0-preview.N`（N 是 deploy-preview 的运行号；预览发布包 `preview-bundle` 只留 3 天），不带 `-Ops`，发布用的仓库副本切到这个预览 tag；粘贴的是预览 Supabase 令牌、预览数据库密码、预览 Cloudflare 令牌，ref 只认预览项目；iPhone 上核对的是那一次 deploy-preview 运行 Summary 页的“预览产物清单”一段（不是“发布包指纹”）。会把同一套流程完整走一遍、部署到 lemomemo-preview，核对 `https://preview.lemomemo.com/app/version.json`。

**回滚服务器函数**（[上线与回滚手册](上线与回滚手册-v4.md)第四节第 2 层办法 A）：在发布用的仓库副本里切到上一个 tag（`git switch --detach <上一个 tag>`），然后
```
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记\本机资料\05-构建测试\<审查日期>_publish冻结副本\publish.ps1" -Tag <上一个 tag> -Only functions -Ops -RepoPath "D:\claude code\柠檬记\工作副本\发布-<上一个 tag>"
```
可以先加 `-DryRun` 演练（只要 GitHub 下载令牌）。函数取的是上一个 tag 的发布包 `release-publish-<上一个 tag>`（保留 90 天，过期了在那个 tag 上重跑 release-build）；只重新部署那个 tag 的服务器函数，紧接着把 lemo-ops 也部署成同一个 tag 的版本；不 db push、不部署 Pages，**不要数据库密码**，除了 GitHub 下载令牌只粘贴 Supabase 令牌和 Cloudflare 令牌（Workers Scripts: Edit）两样；tag 里没有 lemo-ops、不带 `-Ops` 时只要 Supabase 令牌。不要不带 `-Only` 跑整套（会连 db push 和网页一起动）。

## 五、出错时

- 任何一步不过，脚本会写“发布停止：……”并退出；令牌、剪贴板、临时文件照样清掉。常见的几种（照屏幕上的原话发给主持人）：找不到这个 tag 的发布包（release-build 还没跑完，或超过 90 天过期）；GitHub 下载令牌不对（不是 `github_pat_` 开头、没选本仓库、过期）；发布包里的文件和 `SHA256SUMS` 对不上、多了或少了文件、和这个 tag 的源码对不上；你输入的不是“一致”；临时目录里的发布包中途被改；backup-daily 没等完或 `pull.ps1` 退出码不是 0（1 本机配置或凭据、2 服务器或网络或 60 分钟没做完、3 要人工确认，原因在 `E:\柠檬记-备份\失败原因.txt`、`需要人工确认.txt`）；wrangler 依赖树和锁文件对不上；全局 git 配置不干净（global 一级有 `filter.*`、`core.attributesfile`，或默认全局属性文件不为空）；lemo-ops 少了某个密钥；窗口里预先有令牌那几个环境变量。Git 要 2.42 以上；Git 自带的系统配置只认 4 项 `filter.lfs.*`；脚本自己设 `GIT_ATTR_NOSYSTEM=1`，你不用手动设。把这一行原话发给主持人（**不要截令牌所在的窗口以外的东西，也不要把令牌发出来**）。
- **停在 lemo-ops 这一步**（屏幕上是“发布停止：lemo-ops 部署失败……”）：这时数据库迁移已推、服务器函数已是新版，lemo-ops 和网页还是旧版。这种状态能用，只是 usage-report 和 lemo-ops 的新约定（上线与回滚手册第三节“usage-report 和 lemo-ops 必须同一次部署”）没生效。处理：把这一行原话发给主持人，修好原因（常见是令牌少了 Workers Scripts: Edit、KV id 不对、六个密钥没设）后，**用同一个 tag、同样的参数原样重跑 `-Ops`**（迁移演练会显示没有新迁移，函数和 lemo-ops 重新部署一遍，再部署网页）。回滚时（`-Only functions -Ops`）停在这一步也一样：函数已是那个 tag 的版本、lemo-ops 还是原来的，修好后原样重跑。
- 迁移推了一半、网页没上：按[上线与回滚手册](上线与回滚手册-v4.md)第四节处理。回滚要用正式令牌的那几步，同样由你本人在自己的窗口里执行（人员名单第七节第 5 条）。
- 怀疑令牌泄露：立刻在 GitHub › Settings › Developer settings › Fine-grained tokens、Supabase › Account › Access Tokens、Cloudflare › My Profile › API Tokens 里删掉那一把；下次发布照常当场重新生成（R-220，不另存）。

## 六、这个脚本还没做的（照实写）

| 项 | 现状 | 什么时候补 |
|---|---|---|
| 发布前触发 backup-daily | **11-26 已做**（第 6a 步，经 Supabase 管理接口的 SQL 接口执行 `select private.backup_dispatch('publish')`，回值是这次发了请求的人数；正式环境接着运行 `tools\backup\pull.ps1 -WaitForToday -ExpectCount <回值> -Since -Snapshot -SkipFiles -SkipCleanup` 等、下载、做发布前快照，预览演练 pull.ps1 用不了（它只认 lemomemo.com），改在 SQL 接口里数 backups 桶里当天的 `_manifest.json.gz` 到回值那么多个）。正式 Supabase 令牌多一项 Database 读写：负责人 11-26 已同意。首尔跨零点：已改成用数据库在触发那一刻给的首尔日期（`-Today`），pull.ps1 不用本机时钟算今天（B7a 复审第 7 条）。还要定的：等不完就停、会挡住发布 | 安全审查 B7a 时定 |
| 生成 GitHub Release | 不做（开发电脑不登录 GitHub）；需要的话负责人在 iPhone 上建 | — |
| exe 的签名和发布 | **这次不发**（负责人 11-26 选：网页先上，exe 之后单独发）。这一版 `publish.ps1` 没有 `-Desktop`，正式 Pages 里没有 `desktop/`。exe 单独发布时再定签名在哪做、和 Pages 整站快照（架构 0.48 第 2 条：正式 Pages 重新部署要带上同一个 tag 的 `desktop/`）怎么配合 | exe 单独发布前 |
| 下载 CI 产物（替换本机构建） | **11-26 已做**（第 3 步；正式 `release-publish-<tag>` 保留 90 天，预览 `preview-bundle` 保留 3 天；下载令牌出自负责人本人账号） | — |
| 提高 `min_client_version` | 照架构 8.3，不在任何流水线和脚本里，由负责人手动改。值只能是**每段 1～6 位的三段数字、不带后缀**（如 `4.1.0`，正则 `^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$`，只认半角数字；数据库约束同一写法，迁移 20261029190000，写错报 23514）；两道版本门不认的格式会放行所有人（B1 K10） | — |
| 真实环境跑通 | 只在临时仓库里演练过（见第七节），还没对真的 GitHub、Supabase、Cloudflare 跑过 | 首发顺序第 1 步：负责人在预览项目上完整演练一次 |

## 七、自测记录

**2026-10-28（运维）**：在临时仓库（本仓库的克隆，加假的构建脚本、`VERSION`、带说明的 tag、假的备份清单）里跑 `-CheckOnly`、`-DryRun` 和几种反例，都在正确的地方停下；Windows PowerShell 5.1 语法解析 0 错误；`supabase` 2.120.0 确认有 `--yes`、`db push --dry-run --linked`、`functions deploy --use-api`。

**2026-11-26（B7a 改版，运维）**：同样在本仓库的临时克隆里，用假的 GitHub API、假的 supabase、wrangler 跑（`tests/build/publish-run*.test.ts`，Windows 上 `npm test` 才跑）：

- 下载核对：哈希不对、多一个文件、少一个文件、带 `.env` 的路径、version.json 不对、没有 `_worker.js`、有 source map、迁移和源码不同或缺、正式包里混进预览专用函数、`_shared\gen` 原样复制、裸引 `zod`、gen 整个没有——都停在下载这一步、没要部署令牌 ✔；GitHub 接口 401、找不到产物、产物出自 fork、提交对不上、zip 接口 401、经典令牌 `ghp_`、没输入“一致”——都停 ✔；下载令牌只发给 api.github.com，跳转后的下载请求不带令牌 ✔
- 预览演练完整走一遍（部署 voice-probe、Pages 项目 lemomemo-preview、核对 preview.lemomemo.com）；预览加 `-Ops`、运行号不对、ref 不对、正式贴了预览 ref——都停 ✔
- backup-daily：正式环境触发后调 `pull.ps1 -Today <数据库日期> -WaitForToday -ExpectCount <回值> -Since <数据库时间> -Snapshot <tag>`、子进程里没有令牌、退出码 0 才 link（pull.ps1 用演练窗口里的假函数代替）；退出码 1、2、3 都停在改库之前；预览演练在 SQL 里等、等不完就停；没有任务且没有账号时跳过；令牌没有 Database 权限停；`-Only functions` 不触发 ✔
- `-SiteOrigin https://lemomemo.pages.dev`：核对 pages.dev 上的 version.json，结束时提示 `set-fn-role-passwords` 和绑域名 ✔；不在允许名单里的地址第 1 步就停 ✔
- 发布包中途被改：迁移演练时、真推迁移时、部署函数时、部署网页前各停在对应的一步 ✔
- **没测**：真的 GitHub、Supabase、Cloudflare（没有、也不该有真令牌）；剪贴板清理（为了不清掉本机用户的剪贴板，只在输入过令牌后才清）
