# 正式发布说明：本机运行 `publish.ps1`（R-206）

- 日期：2026-10-28（B0，运维初稿；B7a 前按演练结果再改一版）
- 依据：R-206（不买 GitHub Pro；正式环境的令牌不放 GitHub；正式发布由负责人本机运行脚本；CI 只构建和测试）；R-220（令牌不另存：正式令牌每次发布时临时生成、发完删掉，取代 R-206 的“每次从 iPhone‘密码’App 粘贴令牌”）；架构 8.3 deploy-prod 一行、8.4、8.5；人员名单第七节；[上线与回滚手册-v4](上线与回滚手册-v4.md)
- 脚本：[`tools/release/publish.ps1`](../../tools/release/publish.ps1)（Windows PowerShell 5.1 能跑，UTF-8 带 BOM）
- 谁运行：**产品负责人本人**，在自己电脑上新开的 PowerShell 窗口里。AI 只写脚本，不运行正式发布，不碰令牌。

> 架构 8.3 的 deploy-prod.yml（tag 触发、production 环境审批）被 R-206 取代：GitHub 免费版私有仓库**没有 Environments**（环境密钥、审批人都用不了，2026-10-28 已查 GitHub 官方文档）。现在 CI 在打 tag 时只跑 [release-build.yml](../../.github/workflows/release-build.yml)：构建、测试、显示产物指纹，不部署。架构 0.30 已按这个做法改了 8.3、8.4，并新增 8.3a；本脚本和 8.3a 还不一样的地方见[环境清单](环境清单-v4.md)第七节第 1 条。

> **架构 0.31（2026-10-28）已定产物来源**：改为**下载 CI（release-build）的产物部署，本机不重新构建、不跑 npm**（方案 A；理由见架构 0.31 第 24 条）。下载不用 gh，脚本调 GitHub REST API，凭据是一把发布时粘贴的只读令牌（只管本仓库、只有 Actions 读、90 天到期）；令牌出自开发账号还是负责人本人账号，由负责人在 B7a 演练前定。运维在 B6-exe 期间改脚本，B7a 前审查冻结；**改完之前本说明第一、四节描述的仍是第一版（本机构建 ＋ 比总指纹）**，改完时同步改这两节。备份目录 `E:\柠檬记-备份\版本前\<日期>_<版本>发布前\` 已定为统一写法（0.31 第 25 条）。

---

## 一、为什么这样做、风险怎么补

R-206 时已告诉负责人：发布时令牌会经过 AI 所在的电脑，安全不如在 iPhone 上发布。补救写进了脚本：

| 补救 | 脚本里怎么做 |
|---|---|
| 运行的是审查过的脚本 | 开头打印脚本自己的 SHA-256，你和代码审查记录里登记的哈希核对（第二节） |
| 发布期间不开 AI 会话 | 输入令牌前检查有没有名字以 `claude` 开头的进程，有就停 |
| 粘贴后清剪贴板 | 每粘贴一把令牌立即清空剪贴板，并尝试清 Windows 剪贴板历史；剪贴板历史（Win+V）开着就不让继续 |
| 令牌不落盘、不打印 | `Read-Host -AsSecureString` 读入，只放进本进程的环境变量；不写文件、不进命令行参数（PowerShell 历史里没有）；结束时清掉 |
| 本机构建没被动过手脚 | 本机构建的产物算一个“总指纹”，你在 iPhone 上看 GitHub 里同一个 tag 的 release-build 摘要，两边一样才继续（**0.31 起改为**：下载 CI 产物、逐个核 `SHA256SUMS`、再比总指纹，本机不构建） |
| 先构建、后输令牌 | `npm ci`、构建都在输入令牌之前做完；部署工具（Supabase CLI、wrangler）装到临时目录并核对哈希，用前再核对一次 |
| 发错项目 | 用令牌查项目：必须在首尔、状态正常；你要手动输入项目名确认 |
| 迁移出意外 | `db push` 先演练列出要执行的迁移，你输入“确认推送”才真推 |
| 负责人的 GitHub 账号不登录开发电脑 | 脚本不需要 GitHub 登录：tag 从本机仓库取，核对指纹用 iPhone 看 |

**还剩的风险（有意接受，R-206）**：开发电脑上如果早已有恶意程序，它能在你粘贴时读到令牌。所以正式令牌要：只管正式项目（Supabase 项目级令牌）、只给需要的权限、设到期时间（90 天），发现异常立刻在网页上吊销。

## 二、冻结副本：每次发布用的脚本从哪来

1. `tools/release/publish.ps1` 每次改动都要过代码审查和安全审查（人员名单：运维脚本）。
2. 审查通过后，代码审查员在审查记录里写下这个版本的 SHA-256（`Get-FileHash tools\release\publish.ps1`），记录提交进仓库。
3. 发布当天，你把这个文件复制到仓库外面，例如 `E:\柠檬记-发布\publish-v4.0.0.ps1`，以后这一版就从这个副本运行，不直接运行仓库里的那份。
4. 脚本第一行会打印自己的 SHA-256。你在 iPhone 上打开 GitHub 里那份审查记录，核对两个哈希一样再往下走。不一样就关掉窗口，在聊天里说一声。

（副本放在哪里都能被这台电脑上的程序改，真正起作用的是第 4 步拿 GitHub 上的记录核对。）

## 三、第一次发布前要准备的（只做一次）

三把正式令牌和密码**不在这里准备、也不另存**（R-220）：每次发布当场生成，见本节末尾的“发布当天临时生成”。

| 东西 | 放在哪 | 谁做 | 说明 |
|---|---|---|---|
| `.env.production.local` | 仓库根目录（被 `.gitignore` 忽略，不进仓库） | 运维写好内容、负责人核对 | **只放公开值**，脚本会检查只能有 `VITE_PUBLIC_` 开头的行。内容见下 |
| GitHub 仓库 Variables 的 `PROD_` 几项 | GitHub › 仓库 › Settings › Secrets and variables › Actions › Variables | 负责人 | 和 `.env.production.local` 的值一样，给 release-build 用，两边构建才一致 |
| 关掉 Windows 剪贴板历史 | 设置 › 系统 › 剪贴板 | 负责人 | “剪贴板历史记录”“跨设备共享”都关 |

`.env.production.local` 的内容（值都是公开的，写进前端的就是这些）：

```
VITE_PUBLIC_ENV=production
VITE_PUBLIC_SUPABASE_URL=https://lemomemo.com/sb
VITE_PUBLIC_ANON_KEY=<正式项目的 anon / publishable key>
VITE_PUBLIC_VAPID_KEY=<VAPID 公钥>
VITE_PUBLIC_TURNSTILE_SITE_KEY=<Turnstile 站点密钥（Site Key，公开的那个，不是 Secret Key）>
```

**发布当天临时生成（R-220，取代原来“令牌怎么从 iPhone 到电脑上”的待选项）**：正式令牌不长期保存，每次发布前在这台电脑的浏览器里当场生成，复制后直接粘贴进脚本，不经过手机：
1. 正式 Supabase 令牌：Supabase › Account › Access Tokens › 生成新令牌（不要选 legacy），资源范围只勾正式项目，权限照[环境清单](环境清单-v4.md)第四节，**到期 1 天**；
2. 正式数据库密码：正式项目 › Project Settings › Database › 重设数据库密码（Reset database password），生成一个新的；
3. 正式 Cloudflare 令牌：Cloudflare › 我的个人资料 › API 令牌 › 创建自定义令牌，权限照环境清单第四节（Pages: Edit ＋ Workers Scripts: Edit），TTL 结束日期选**明天**；
4. 发布完（不论成功失败）：回到这两页把两把令牌删掉（数据库密码不用再改，下次发布再重设）。

## 四、每次发布（约 15～20 分钟）

前提：这一版的 B7a（或修复版的对应检查）已签完，[上线与回滚手册](上线与回滚手册-v4.md)第二节的检查清单全部打勾；主持人已在 main 上打好带说明的 tag（`git tag -a vX.Y.Z`）并推到 GitHub，release-build 是绿的。

1. **完全退出 Claude**（桌面 App 和所有终端里的 claude）。
2. 开一个新的 PowerShell 窗口：
   ```
   cd "D:\claude code\柠檬记APP"
   git fetch --tags
   git switch main
   git pull
   git switch --detach v4.0.0
   ```
3. 先演练一遍（不要令牌，可以前一天做）：
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File E:\柠檬记-发布\publish-v4.0.0.ps1 -Tag v4.0.0 -Ops -DryRun
   ```
   **一定要带 `-Ops`**（10-29 起）：usage-report 和监控 Worker lemo-ops 必须同一次部署，这个 tag 里两样都有时不带 `-Ops` 脚本第 1 步就停（[上线与回滚手册](上线与回滚手册-v4.md)第三节“部署 lemo-ops”）。第一次带 `-Ops` 前，`workers/lemo-ops/wrangler.toml` 里 KV 的 id 要换成真的命名空间 ID，还是占位值第 1 步也会停。
   会做：发布前检查（含 lemo-ops 的配置）→ 发布前备份（没有就做一份，放 `E:\柠檬记-备份\版本前\<日期>_4.0.0发布前\`）→ 构建 → 显示产物指纹（你在 iPhone 上核对后输入“一致”）→ 装部署工具 → lemo-ops 打包演练（`wrangler deploy --dry-run`，不上传）。到这里停。
4. 正式发布：同一行命令去掉 `-DryRun`（`-Ops` 留着）。前面几步会再走一遍（备份已有就跳过），然后：
   - 再核对一次工作区干净、仍是这个 tag、仓库里没有 `.env`、`.env.local`（wrangler 会自动读它们，有就停）；检查剪贴板历史关着、没有 transcript 和日志策略（R-223 起不再检查 Claude 是否在运行，但第 1 条照样要你先退出 Claude）；
   - 输入正式项目的 Project ref（不是密钥）；
   - 按提示依次粘贴三样（屏幕不显示，每样粘完清剪贴板）：正式 Supabase 令牌、正式数据库密码、正式 Cloudflare 令牌（要有 Pages: Edit ＋ Workers Scripts: Edit）；
   - 输入 Cloudflare Account ID（不是密钥）；
   - 核对项目名并输入它；脚本先只读核对 Cloudflare 令牌有 Workers 权限（没有就停，此时还没改库）；看迁移演练、输入“确认推送”；
   - 自动部署函数、紧接着部署 lemo-ops、再部署网页，最后核对 `https://lemomemo.com/app/version.json`。
5. 看到“完成”以后关掉这个 PowerShell 窗口，**马上删掉这次临时生成的两把令牌**（第三节末尾第 4 条）。
6. 在聊天里告诉主持人“发布完成”和屏幕上的产物指纹（指纹不是密钥），主持人记进[发布记录](发布记录.md)。

只想查一下能不能发：`-CheckOnly -Ops`，只做第 1 步检查。

**回滚服务器函数**（[上线与回滚手册](上线与回滚手册-v4.md)第四节第 2 层办法 A）：照第 2 步切到上一个 tag（`git switch --detach <上一个 tag>`），然后
```
powershell -NoProfile -ExecutionPolicy Bypass -File E:\柠檬记-发布\publish-v4.0.0.ps1 -Tag <上一个 tag> -Only functions -Ops
```
可以先加 `-DryRun` 演练（不要令牌）。只重新部署那个 tag 的服务器函数，紧接着把 lemo-ops 也部署成同一个 tag 的版本；不构建网页、不 db push、不部署 Pages，**不要数据库密码**，只粘贴 Supabase 令牌和 Cloudflare 令牌（Workers Scripts: Edit）两样；tag 里没有 lemo-ops、不带 `-Ops` 时只要 Supabase 令牌一样。不要不带 `-Only` 跑整套（会连 db push 和网页一起动）。

## 五、出错时

- 任何一步不过，脚本会写“发布停止：……”并退出；令牌、剪贴板、临时文件照样清掉。10-30 起多了几种停下的情形（照屏幕上的原话发给主持人）：wrangler 依赖树和锁文件对不上；中途有文件被改（dist 副本、aws4fetch 的哈希变了）；全局 git 配置不干净（global 一级有 `filter.*`、`core.attributesfile`，或默认全局属性文件不为空）；lemo-ops 少了某个密钥；窗口里预先有令牌那几个环境变量。10-30 第五批起：Git 要 2.42 以上（更老的版本脚本第 1 步就停、提示升级）；Git 自带的系统配置只认 4 项 `filter.lfs.*`，多了别的也停；脚本自己设 `GIT_ATTR_NOSYSTEM=1`，你不用手动设。把这一行原话发给主持人（**不要截令牌所在的窗口以外的东西，也不要把令牌发出来**）。
- **停在 lemo-ops 这一步**（屏幕上是“发布停止：lemo-ops 部署失败……”）：这时数据库迁移已推、服务器函数已是新版，lemo-ops 和网页还是旧版。这种状态能用，只是 usage-report 和 lemo-ops 的新约定（上线与回滚手册第三节“usage-report 和 lemo-ops 必须同一次部署”）没生效。处理：把这一行原话发给主持人，修好原因（常见是令牌少了 Workers Scripts: Edit、KV id 不对、六个密钥没设）后，**用同一个 tag、同样的参数原样重跑 `-Ops`**（迁移演练会显示没有新迁移，函数和 lemo-ops 重新部署一遍，再部署网页）。回滚时（`-Only functions -Ops`）停在这一步也一样：函数已是那个 tag 的版本、lemo-ops 还是原来的，修好后原样重跑。
- 迁移推了一半、网页没上：按[上线与回滚手册](上线与回滚手册-v4.md)第四节处理。回滚要用正式令牌的那几步，同样由你本人在自己的窗口里执行（人员名单第七节第 5 条）。
- 怀疑令牌泄露：立刻在 Supabase › Account › Access Tokens、Cloudflare › My Profile › API Tokens 里删掉那一把；下次发布照常当场重新生成（R-220，不另存）。

## 六、这个脚本还没做的（照实写）

| 项 | 现状 | 什么时候补 |
|---|---|---|
| 发布前触发服务器的 backup-daily 并等它成功（架构 8.3 deploy-prod） | backup-daily 函数还没有；4.0.0 首次上线前正式库没有用户数据 | B7a，后端做好 backup-daily 后由运维加进第 2 步 |
| 生成 GitHub Release | 不做（开发电脑不登录 GitHub）；需要的话负责人在 iPhone 上建 | — |
| exe 的签名和发布（desktop.yml） | 不在本脚本；做法架构 0.30 已定（8.3a 第 8 步：下载 desktop.yml 的未签名产物，本机 `-Desktop` 签名后随 Pages 部署） | B6-exe |
| 下载 CI 产物（替换本机构建） | 架构 0.31 第 24 条定方案 A；只读下载令牌的出处待负责人定 | B6-exe 期间改，B7a 前冻结 |
| 提高 `min_client_version` | 照架构 8.3，不在任何流水线和脚本里，由负责人手动改。值只能是**每段 1～6 位的三段数字、不带后缀**（如 `4.1.0`，正则 `^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$`，只认半角数字；数据库约束同一写法，迁移 20261029190000，写错报 23514）；两道版本门不认的格式会放行所有人（B1 K10） | — |
| 真实环境跑通 | 只在临时仓库里演练过（见第七节），还没对真的 Supabase / Cloudflare 跑过 | 第一次预览部署跑通后，B7a 前在正式项目上演练一次 |

## 七、自测记录（2026-10-28，运维）

在临时仓库（本仓库的克隆，加一个假的 `package.json` 和构建脚本、`VERSION`、带说明的 tag `v4.0.0`、假的备份清单）里跑：

- `-CheckOnly`：全部检查通过 ✔
- 反例，都在正确的地方停下 ✔：工作区有多余文件；tag 写成 `4.0.0`；tag 不存在；`.env.production.local` 里混进非 `VITE_PUBLIC_` 的行
- `-DryRun`：检查 → 找到已有备份 → `npm ci --ignore-scripts` 和构建 → 指纹（输入“一致”继续；输入别的就停）✔ → 下载 Supabase CLI 2.120.0 并核对 SHA-256 ✔ → `npm ci` 装 wrangler 4.150.0 ✔ → 在输入令牌前停下、清掉临时目录 ✔
- Windows PowerShell 5.1 语法解析 0 错误；`supabase` 2.120.0 确认有 `--yes`、`db push --dry-run --linked`、`functions deploy --use-api`
- **没测**：输入令牌以后的部分（没有、也不该有真令牌）；剪贴板清理（为了不清掉本机用户的剪贴板，只在输入过令牌后才清）
