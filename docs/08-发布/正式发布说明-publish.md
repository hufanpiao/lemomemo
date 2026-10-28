# 正式发布说明：本机运行 `publish.ps1`（R-206）

- 日期：2026-10-28（B0，运维初稿；B7a 前按演练结果再改一版）
- 依据：R-206（不买 GitHub Pro；正式环境的令牌不放 GitHub；正式发布由负责人本机运行脚本，每次从 iPhone“密码”App 粘贴令牌；CI 只构建和测试）；架构 8.3 deploy-prod 一行、8.4、8.5；人员名单第七节；[上线与回滚手册-v4](上线与回滚手册-v4.md)
- 脚本：[`tools/release/publish.ps1`](../../tools/release/publish.ps1)（Windows PowerShell 5.1 能跑，UTF-8 带 BOM）
- 谁运行：**产品负责人本人**，在自己电脑上新开的 PowerShell 窗口里。AI 只写脚本，不运行正式发布，不碰令牌。

> 架构 8.3 的 deploy-prod.yml（tag 触发、production 环境审批）被 R-206 取代：GitHub 免费版私有仓库**没有 Environments**（环境密钥、审批人都用不了，2026-10-28 已查 GitHub 官方文档）。现在 CI 在打 tag 时只跑 [build-release.yml](../../.github/workflows/build-release.yml)：构建、测试、显示产物指纹，不部署。架构 8.3、8.4 的对应几行要由架构师改，见[环境清单](环境清单-v4.md)第七节。

---

## 一、为什么这样做、风险怎么补

R-206 时已告诉负责人：发布时令牌会经过 AI 所在的电脑，安全不如在 iPhone 上发布。补救写进了脚本：

| 补救 | 脚本里怎么做 |
|---|---|
| 运行的是审查过的脚本 | 开头打印脚本自己的 SHA-256，你和代码审查记录里登记的哈希核对（第二节） |
| 发布期间不开 AI 会话 | 输入令牌前检查有没有名字以 `claude` 开头的进程，有就停 |
| 粘贴后清剪贴板 | 每粘贴一把令牌立即清空剪贴板，并尝试清 Windows 剪贴板历史；剪贴板历史（Win+V）开着就不让继续 |
| 令牌不落盘、不打印 | `Read-Host -AsSecureString` 读入，只放进本进程的环境变量；不写文件、不进命令行参数（PowerShell 历史里没有）；结束时清掉 |
| 本机构建没被动过手脚 | 本机构建的产物算一个“总指纹”，你在 iPhone 上看 GitHub 里同一个 tag 的 build-release 摘要，两边一样才继续 |
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

| 东西 | 放在哪 | 谁做 | 说明 |
|---|---|---|---|
| 正式 Supabase 令牌 | iPhone“密码”App，条目名“柠檬记 Supabase 正式令牌” | 负责人 | 只管正式项目的项目级令牌，权限见[环境清单](环境清单-v4.md)第四节；到期 90 天 |
| 正式数据库密码 | “柠檬记 Supabase 正式数据库密码” | 负责人 | 建正式项目时生成的那个 |
| 正式 Cloudflare 令牌 | “柠檬记 Cloudflare 正式令牌” | 负责人 | 只给 “Cloudflare Pages: Edit”，到期 90 天 |
| `.env.production.local` | 仓库根目录（被 `.gitignore` 忽略，不进仓库） | 运维写好内容、负责人核对 | **只放公开值**，脚本会检查只能有 `VITE_PUBLIC_` 开头的行。内容见下 |
| GitHub 仓库 Variables 的 `PROD_` 几项 | GitHub › 仓库 › Settings › Secrets and variables › Actions › Variables | 负责人 | 和 `.env.production.local` 的值一样，给 build-release 用，两边构建才一致 |
| 关掉 Windows 剪贴板历史 | 设置 › 系统 › 剪贴板 | 负责人 | “剪贴板历史记录”“跨设备共享”都关 |

`.env.production.local` 的内容（值都是公开的，写进前端的就是这些）：

```
VITE_PUBLIC_ENV=production
VITE_PUBLIC_SUPABASE_URL=https://lemomemo.com/sb
VITE_PUBLIC_ANON_KEY=<正式项目的 anon / publishable key>
VITE_PUBLIC_VAPID_KEY=<VAPID 公钥>
VITE_PUBLIC_TURNSTILE_SITE_KEY=<Turnstile 站点密钥（Site Key，公开的那个，不是 Secret Key）>
```

**令牌怎么从 iPhone 到电脑上（待负责人选）**：R-206 写的是“从 iPhone‘密码’App 粘贴”，但 iPhone 上复制的内容到 Windows 要经过某个通道，三种都有代价，请负责人选一种（运维建议 ①）：
1. 在电脑上照着 iPhone 一个字一个字敲：最干净，但 Supabase 令牌有 40 多位，容易敲错（敲错脚本会报“不像 Supabase 令牌”或部署失败，不会泄露）；
2. Windows 版“iCloud 密码”App：在电脑上登录 Apple 账号后能直接复制，但等于把整个钥匙串放到了开发电脑上；
3. 手机连接（Phone Link）的剪贴板同步：会经过微软的云和剪贴板历史，**不建议**。

## 四、每次发布（约 15～20 分钟）

前提：这一版的 B7a（或修复版的对应检查）已签完，[上线与回滚手册](上线与回滚手册-v4.md)第二节的检查清单全部打勾；主持人已在 main 上打好带说明的 tag（`git tag -a vX.Y.Z`）并推到 GitHub，build-release 是绿的。

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
   powershell -NoProfile -ExecutionPolicy Bypass -File E:\柠檬记-发布\publish-v4.0.0.ps1 -Tag v4.0.0 -DryRun
   ```
   会做：发布前检查 → 发布前备份（没有就做一份，放 `E:\柠檬记-备份\版本前\<日期>_4.0.0发布前\`）→ 构建 → 显示产物指纹（你在 iPhone 上核对后输入“一致”）→ 装部署工具。到这里停。
4. 正式发布：同一行命令去掉 `-DryRun`。前面几步会再走一遍（备份已有就跳过），然后：
   - 检查 Claude 没在运行、剪贴板历史关着；
   - 输入正式项目的 Project ref（不是密钥）；
   - 按提示依次粘贴三把令牌（屏幕不显示）；
   - 输入 Cloudflare Account ID（不是密钥）；
   - 核对项目名并输入它；看迁移演练、输入“确认推送”；
   - 自动部署函数和网页，最后核对 `https://lemomemo.com/app/version.json`。
5. 看到“完成”以后关掉这个 PowerShell 窗口。
6. 在聊天里告诉主持人“发布完成”和屏幕上的产物指纹（指纹不是密钥），主持人记进[发布记录](发布记录.md)。

只想查一下能不能发：`-CheckOnly`，只做第 1 步检查。

## 五、出错时

- 任何一步不过，脚本会写“发布停止：……”并退出；令牌、剪贴板、临时文件照样清掉。把这一行原话发给主持人（**不要截令牌所在的窗口以外的东西，也不要把令牌发出来**）。
- 迁移推了一半、网页没上：按[上线与回滚手册](上线与回滚手册-v4.md)第四节处理。回滚要用正式令牌的那几步，同样由你本人在自己的窗口里执行（人员名单第七节第 5 条）。
- 怀疑令牌泄露：立刻在 Supabase › Account › Access Tokens、Cloudflare › My Profile › API Tokens 里删掉那一把，重新生成存进“密码”App。

## 六、这个脚本还没做的（照实写）

| 项 | 现状 | 什么时候补 |
|---|---|---|
| 发布前触发服务器的 backup-daily 并等它成功（架构 8.3 deploy-prod） | backup-daily 函数还没有；4.0.0 首次上线前正式库没有用户数据 | B7a，后端做好 backup-daily 后由运维加进第 2 步 |
| 生成 GitHub Release | 不做（开发电脑不登录 GitHub）；需要的话负责人在 iPhone 上建 | — |
| exe 的签名和发布（desktop.yml） | 不在本脚本；R-206 以后 exe 正式签名私钥也不能放 GitHub production 环境，做法要架构师重定 | B6-exe 前 |
| 提高 `min_client_version` | 照架构 8.3，不在任何流水线和脚本里，由负责人手动改 | — |
| 真实环境跑通 | 只在临时仓库里演练过（见第七节），还没对真的 Supabase / Cloudflare 跑过 | 第一次预览部署跑通后，B7a 前在正式项目上演练一次 |

## 七、自测记录（2026-10-28，运维）

在临时仓库（本仓库的克隆，加一个假的 `package.json` 和构建脚本、`VERSION`、带说明的 tag `v4.0.0`、假的备份清单）里跑：

- `-CheckOnly`：全部检查通过 ✔
- 反例，都在正确的地方停下 ✔：工作区有多余文件；tag 写成 `4.0.0`；tag 不存在；`.env.production.local` 里混进非 `VITE_PUBLIC_` 的行
- `-DryRun`：检查 → 找到已有备份 → `npm ci --ignore-scripts` 和构建 → 指纹（输入“一致”继续；输入别的就停）✔ → 下载 Supabase CLI 2.120.0 并核对 SHA-256 ✔ → `npm ci` 装 wrangler 4.150.0 ✔ → 在输入令牌前停下、清掉临时目录 ✔
- Windows PowerShell 5.1 语法解析 0 错误；`supabase` 2.120.0 确认有 `--yes`、`db push --dry-run --linked`、`functions deploy --use-api`
- **没测**：输入令牌以后的部分（没有、也不该有真令牌）；剪贴板清理（为了不清掉本机用户的剪贴板，只在输入过令牌后才清）
