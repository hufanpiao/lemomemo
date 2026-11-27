# B6-exe 任务单 架构审

- 日期：2026-11-03　审查人：架构师（独立评审，默认不通过）
- 对象：`docs/09-路线图/B6-exe-任务单.md`（草稿，未提交），仓库 main `21557c1`
- 对照：架构设计 v4 的 0.28、1.3（B6-exe 行和“哪些可以并行”）、5.10、8.2、8.3、8.3a、8.4、8.5、15.4（S-B6、S-B6b、S-B7）、15.6 第 3 点、14.2；开发计划 v4 第二、三、五、六节；实际文件 `.github/workflows/deploy-preview.yml`、`.github/workflows/release-build.yml`、`tools/release/publish.ps1`、`functions/_lib/cors.ts`、`functions/sb/[[path]].ts`、`functions/files/[[path]].ts`、`desktop/turnstile-probe/`
- 本文件只写审查意见；任务单、架构、开发计划的修改由主持人统一合（任务单第五节约定 8）。

## 结论：有条件通过

范围、估算、负责人步骤的大框架和 1.3、8.3a 一致，安全红线写得对，B2 冲突的约定可行。Q-A1 指出的问题**属实，而且比任务单写的更大**（正式环境的 `-Desktop` 也有同样问题，见第二节）；双环境编译还漏了几样会让预览版 exe 根本跑不通的配置（CSP、安装标识、MSI 版本号）。下面第四节的 **必改 M1～M8** 改完，主持人核对一遍即可转负责人，不用再回架构审。

---

## 一、范围、估算、负责人步骤：和架构对得上的与对不上的

### 1. 对得上的

- F1～F7、F9～F11 与 5.10、8.3、8.3a、15.4 S-B6 / S-B6b / S-B7 一一对应，出处标得准。
- 估算：开发 3.5～4（含预览更新通道 0.5～1，Turnstile 退路 +2～3）照抄 1.3；运维 3～4 照抄 8.3a，单列不进总数（R-204）。**本审定下的做法不改人日**（Q-A1 的新做法比原写法少一次网页部署；Q-A3 少改每个函数），开发小计和合计不动。
- 负责人步骤 S1～S8 的“AI 不代做”范围和 8.4、R-206、R-220 一致；S3、S4 的醒目提醒按 0.37 写了。
- 第三节“不在本批”（正式更新线、B7a 重打 exe、publish.ps1 冻结）和 1.3、开发计划第六节第 5 点一致。
- F12 不做皮肤变量和 `skins/*.css`：比 1.3 工期说明第 3 点做得少，但理由（B2 液态玻璃同时改 `tokens.json`）成立，**同意**；F12 不计入 B6-exe 的 3.5～4（那是 B6 的活，归 A 的估算）。

### 2. 已经做完、任务单写成“要做”的

- **426 带 exe 的 CORS 头已经有了**：`functions/sb/[[path]].ts` 第 151 行、`functions/files/[[path]].ts` 第 50 行都经 `applyCors` 生成 426。F5 这半句改成“核对（TC-B6X-22）”，不是新开发。
- **`x-upsert`、`cache-control` 不用等抓包再删**：5.10 表里已经划掉（0.32 起客户端不用 storage-js），`functions/_lib/cors.ts` 现在就可以删；抓包只用来发现表里**没有**的头。R7 的应对改一下。

### 3. 漏掉的（会影响能不能做成）

1. **预览版 exe 的 CSP 连不上预览站**：5.10 的 `connect-src` 只写了 `https://lemomemo.com wss://lemomemo.com`（`desktop/turnstile-probe` 的配置也是），预览版 exe 的 supabase-js 打的是 `https://preview.lemomemo.com/sb`，会被 CSP 拦下。“双环境编译”不只是公钥和更新地址，还要按环境换：CSP 的 `connect-src`、页面的 `VITE_PUBLIC_*`（`--mode preview`）、Turnstile sitekey、secureStorage 白名单里的会话键名（预览是 `sb-preview-…`，14.2 第 2 点）。→ M3
2. **预览版和正式版要能装在同一台电脑上**：负责人和 QA 的电脑上线后两个都会装。`identifier` 一样的话，预览版会覆盖正式版，自启、单实例、托盘、卸载项也会串。→ M3
3. **MSI 装不了 `-preview.N` 版本号**：Tauri 打 Windows 的 MSI（WiX）时，版本号的预发布段只能是纯数字；8.5 定的 `4.0.0-preview.<run>` 打不了 MSI。安装包和更新只用 NSIS（`bundle.targets: ["nsis"]`），开工第一天前端 B 用 `4.0.0-preview.1` 实际打一次确认。8.5“CI 把版本号同步进 `tauri.conf.json`”这一步任务单 F9 也没写。→ M4
4. **预览 tag 不触发 release-build**：`release-build.yml` 的触发是 `tags: ['v[0-9]+.[0-9]+.[0-9]+']`，`v4.0.0-preview.N` 不匹配。所以预览版的 `SHA256SUMS`、总哈希、Summary 页**只能由 desktop.yml 自己出**；S6 第 5 步“用 iPhone 对 Summary 页”对的是 desktop.yml 那次运行。任务单 F9 写的“release-build.yml 等 desktop.yml、生成 SHA256SUMS”只对正式 tag 成立。→ M5
5. **发布机上的签名工具从哪来**：8.3a 第 1 步要核对“签名工具二进制的哈希”，五处第 ① 条又要求发布机不跑 npm。`@tauri-apps/cli` 是 npm 包，不能在发布机上 `npm ci` 装。运维要定一个锁在 `tools/ci-tools.lock` 里的独立二进制（Tauri 官方发布的 `cargo-tauri` Windows 二进制，或兼容 minisign 格式的签名工具，以能被 updater 验过为准），过安全审查。任务单 F10 没写。→ M6
6. **注册按钮怎么打开浏览器**：5.10（0.38 第 41 条）把“auth 窗口发事件给 main 打开，还是 auth 页只显示网址”留给 B6 定，任务单没列。**架构定**：auth 窗口发一个**不带任何载荷**的事件 `auth:open-signup`，main 收到后用 Rust 里写死的 `https://lemomemo.com/app/auth/`（预览版写死预览地址）调 `open_external`；网址不从 auth 窗口传过来。auth 的 capability 只多“发这一个事件”。→ M7
7. **导航限制要按窗口分**：F3 写“导航只留在本地页面”，5.10 还要求 **main 不能导航到 `auth.html`**（Rust 里按窗口判断）。补进 F3 和 A5 的验收。
8. **Cloudflare 超额时的错误页没有 CORS 头**（5.10）：data 层要按“同步失败、稍后重试”处理。现在只在第五节冲突表里提了一句“跨域失败按断网处理”，F5 里没写；它在 `src/platform/http.ts`，写清由谁改（建议前端 B 改、A 审）。

### 4. 多出来的

- F5 里“Edge Functions 的 `_shared/cors.ts`”和第五节约定 5“一次接完”：按 Q-A3 的决定**删掉**，冲突表那一行冲突程度降为“无”。
- 前端 A“约 0.25”、UI-4“约 0.25”：都在 25% 返工里，不单列人日，写成“在 B2 / 25% 里吸收”即可（前端 A 那条已经这样写，UI-4 那条补一句）。

---

## 二、交架构师的四条：架构决定

### Q-A1 预览更新通道放哪

**先核实（属实）**：
- `deploy-preview.yml` 最后一步是 `wrangler pages deploy dist/web --project-name "$PAGES_PROJECT" --branch main`。Cloudflare Pages 的每次部署都是**整站快照**，上传目录里没有的文件在新部署里就不存在；`dist/web` 里没有 `desktop/`，所以推一次 `main`，`preview.lemomemo.com/desktop/latest.json` 就变成 404（落到 `404.html`），updater 按“断网”安静失败，TC-B6X-18～21 测不稳。
- 反方向同样成立：`publish.ps1` 现在**根本没有 `-Env`、`-Desktop` 参数**（param 块只有 `-Tag -RepoPath -PagesProject -SiteOrigin -BackupRoot -CheckOnly -DryRun -Ops -Only`），而且还在本机 `npm ci`、`npm run build`（第 911～917 行，五处第 ① 条还没改）。将来加上 `-Desktop` 后，只往同一个 Pages 项目部署 `desktop/` 也会把整个网页和 `_worker.js` 换掉。
- **正式环境也受影响**：8.3a“其他用法”写的“`-Desktop` 只签 exe 并部署 `/desktop/`”在正式环境同样做不到（会冲掉正式网站）。正式的完整发布第 8、9 步网页和 exe 一起部署，这条路没问题；问题只在单独用 `-Desktop`，以及以后任何“只重新部署网页”的回滚操作（必须带上同一个 tag 的 `desktop/`）。

**架构定**：预览版 exe 的更新地址**不放在 `preview.lemomemo.com` 上**，改成**同一个预览 Pages 项目的单独分支部署**：
- `publish.ps1 -Env preview -Desktop` 只把签好的安装包和 `latest.json` 放进一个只有这两个文件的目录，执行 `wrangler pages deploy <该目录> --project-name <预览项目> --branch desktop`，固定地址是 `https://desktop.<预览项目名>.pages.dev/latest.json`（Pages 给非生产分支的固定别名）。
- deploy-preview 照旧 `--branch main`，两边永远不碰对方，**deploy-preview.yml 不用改**。
- 预览版 exe 编进这个地址；`latest.json` 里的安装包 `url` 也指向同一个别名下。
- updater 在 Rust 端发请求，不受页面 CSP 管；完整性靠签名，不靠主机名。地址是 `pages.dev`，在中国大陆可能连不上，预览通道只给负责人和 QA 在韩国测，接受。

**理由**：比任务单推荐的 a（单独的小 Pages 项目加子域）还少一步——**不新建项目、不加子域、不改 DNS**，用的就是现有预览 Pages 项目和本来就要用的那把 Pages: Edit 令牌；和 a 一样完全隔开 deploy-preview。没选的做法：
- 在 deploy-preview 里把线上 `/desktop/` 下载回来再一起部署：只解决“deploy-preview 冲掉 desktop”这一个方向；签名那一步仍要整站重新部署，就得拿到同一提交的网页产物（保留 3 天、带 `_worker.js`、版本号要对上），负责人签一次预览包等于把整个预览网站和 Functions 用临时令牌重部署一遍，影响面更大。
- `/desktop/*` 放 R2：要新建桶、负责人另生成一把能写的 R2 令牌、`_routes.json` 加路径（占 Functions 每天的额度）或者给桶开公开域名（和 S-B0 ①“R2 桶不公开、没有自定义域名”相反），步骤最多。
- 任务单的 c（约定测试期间不推 `main`）：卡住主线的预览部署，不可行。

**要负责人做的**：
- 本方案**不改任何 Cloudflare 设置**，但会在我们的账号下多出一个公开地址 `desktop.<预览项目名>.pages.dev`。按“改 Cloudflare 配置要负责人同意”的口径，**由主持人随第六节一起问负责人一句“同意吗”**；回答写进拍板记录。
- S6 第 3 步的临时令牌：GitHub 只读下载令牌（Q-O5）＋ 一把预览用的 Cloudflare“Pages: Edit”令牌（负责人临时生成、1 天到期、用完删）。没有别的网页操作。
- **退路**（第一次预览签名时实测）：如果分支别名用不了（例如预览部署被 Cloudflare Access 挡住、或 wrangler 拒绝直传项目的非生产分支），改用任务单的 a：单独一个只放 desktop 的 Pages 项目，用它自带的 `<项目名>.pages.dev` 地址即可，子域可不绑。**新建项目要负责人同意**（可由运维用同一把令牌建，不必负责人本人点）；要绑子域的话，加自定义域名那一步由负责人本人在 Cloudflare 控制台做（约 10 分钟）。约 +0.25 运维人日，不进总数。

**要改的地方**：
- 架构 0.28 第 2 条（不改原文，加一条新修订记录 0.48 说明“预览 `/desktop/` 改为分支部署”）；1.3 B6-exe 行“预览 Pages 下放 `/desktop/latest.json`”；5.10“更新由 Rust 端做”一条补预览地址；8.2“exe 的更新地址（M7）”补预览地址；8.3a“其他用法”改成：**“`-Desktop` 只能和 `-Env preview` 一起用，部署到预览 Pages 项目的 `desktop` 分支；正式的 exe 只随 `-Tag` 完整发布和网页一起部署，不单独部署。任何对正式 Pages 的重新部署（含回滚）都必须带上同一个 tag 签好的 `desktop/`”**；上线与回滚手册同步这一句。
- 开发计划第六节“交架构师定的一项”第 1 点：“预览环境的 Pages 下放 `/desktop/latest.json`”改成“预览版 exe 的更新地址是预览 Pages 项目 `desktop` 分支的固定别名，只由负责人本机 `publish.ps1 -Env preview -Desktop` 部署，deploy-preview 不碰”。
- 任务单：F8、R2、运维行、S6 第 3 步、第六节 Q-A1。

### Q-A2 来源用 http 还是开 `useHttpsScheme`

**架构定：维持 `http://tauri.localhost`，不开 `useHttpsScheme`**（任务单 a）。
**理由**：① B0 的 `functions/_lib/cors.ts`（`EXE_ORIGIN`）、预览 Turnstile 主机名、5.10、15.6 都按它写好了；② `*.localhost` 在 Chromium（WebView2）里本来就算“可信来源”，`crypto.subtle`、IndexedDB 这些要安全上下文的能力在 http 下照样能用，换 https 没有功能收益；③ **改来源等于换了一个源**，localStorage、IndexedDB（含离线队列里没发出去的记录）全部读不到——所以必须在第一个装出去的包之前定死，**以后不改**。
**例外**：只有 TC-B0-65 或 B6-exe 实测发现 http 来源下某项能力确实不可用时才改，改的话同一个 PR 改 `cors.ts`、两套 Turnstile 主机名、5.10、15.6，并且只能在 4.0.0 发布前。
**要改的地方**：5.10 第 1 点“来源”那句把“B6 核实”改成“定为 http，0.48”；任务单 F1 去掉“二选一”。

### Q-A3 Edge Functions 要不要各自加 CORS

**架构定：只在转发层做（`functions/_lib/cors.ts`），Edge Functions 不加**（任务单 a）。
**理由**：
- exe 的 CSP `connect-src` 只放行 `https://lemomemo.com`（预览版是 `preview.lemomemo.com`），**exe 连不到 `supabase.co`**，所有调用都经 `/sb/functions/v1/*`。
- 预检在 `/sb` 本地回 204、**根本不转发**（`[[path]].ts` 第 124 行）；实际响应经 `applyCors` **先删掉上游的全部 `Access-Control-*` 再重写**。函数自己加的 CORS 头一个都到不了客户端，是死代码。
- 多一份白名单就多一处要和 `cors.ts` 保持一致的地方；而且函数在 `supabase.co` 上直接回 CORS 头，只会给绕过转发层的调用多开一个口子（虽然 CORS 不是身份校验）。
- 14.2 第 9 点的退路 Worker（`/workers/sb-proxy/`）用的是同一份 `cors.ts`，一致。
- **唯一要回头看的情况**：哪天数据接口改走 14.2 的 B（Supabase 自定义域名，exe 直连函数），那时再给函数加 CORS。
**顺带加一道便宜的防线**（低，B6-exe 里做，约 0.1 人日，在 25% 里）：`build/check_backend.py` 加一条“`supabase/functions/` 下不得出现 `Access-Control-Allow-Origin`”，防止以后有人照网上示例写 `*`。
**要改的地方**：5.10“跨域（CORS）”第一、二个小点（“和全部 Edge Functions（`_shared/cors.ts`）加 CORS”“Edge Functions 也在 `_shared/cors.ts` 里直接回”）改为“只在 `/sb/*`、`/files/*` 的 Pages Function 里做，Edge Functions 不加（0.48）”；1.3 B6-exe 行“CORS 白名单和预检（Pages Function、Edge Functions）”删去“Edge Functions”；15.4 S-B6 不用改（写的是“CORS 白名单只放 exe 来源”）。任务单删掉 F5 的 Edge Functions 部分、第五节约定 5、冲突表 `supabase/functions/*` 一行的 B6-exe 一栏，后端行改成“无”。

### Q-A4 `save_attachment` 在 B4b-1 做时要不要重开 S-B6

**架构定：不重开 B6-exe 的签字，但也不是只等 B7a**（任务单 a，加一条）：
- `save_attachment` 的代码、给 main 窗口加 capability 的改动，在 **B4b-1 的 ② 代码审查（exe 一节）和 ③ 安全审查里核**；B4b-1 的安全签字文件单列一节“**S-B6 增量**”，由安全审查员按 S-B6 的口径核对 capability 的差异（只有 main 多了 `save_attachment`，auth、quick-add 不变，`remote.urls` 仍不开）和 5.13 第 4 点（Rust 带 `X-Files-Sig`、URL 带查询串或片段一律拒、不跟随重定向、只认 `/files/v1/o/files/` 前缀、带 Mark-of-the-Web）。
- B7a 用最终页面重打的 exe 时，S-B6 全量逐项再打一次勾（本来就在 B7a 的 P0 逐项打勾里）。
**理由**：B6-exe 已签的内容没有变，重开签字只会让副线反复挂起；而一个新的 Rust 命令等到 B7a 才审太晚（B7a 发现问题要回到 B4b-1 返工）。1.3 写的“S-B6 也要核对这个命令”就落在 B4b-1 的增量核对上。
**要改的地方**：15.4 S-B4b-1 行末尾加“exe 的 `save_attachment` 按 S-B6 口径做增量核对，签字文件单列一节（0.48）”；1.3“哪些可以并行”里 `save_attachment` 那条的“S-B6 也要核对这个命令”后补“（在 S-B4b-1 的增量核对里做，B7a 全量复核）”。

---

## 三、负责人七问（Q-O1～Q-O7）的推荐

| # | 推荐 | 架构意见 |
|---|---|---|
| Q-O1 | a | **同意 a，但不该当成二选一问**：5.10（0.38 第 41 条）已经定了“要加就只在 Turnstile 控制台的主机名列表里加 `tauri.localhost`，函数的 hostname 白名单不加”；b 是 5.10 的退路，只在 Turnstile 在 Tauri 里根本不能用时才走。建议改成：**TC-B0-65 出结论后**主持人告知负责人“要在正式 Turnstile 站点加 `tauri.localhost`，请本人在控制台加”（S5 第 2 步），只问“同意吗”。TC-B0-65 结论是不能用的话，正式和预览一起走退路，这条自然作废。 |
| Q-O2 | a | **同意 a**，补两句写进任务单和 1.3：① 先签的部分必须包含 S-B6 全部 P0 里不依赖主线的项（依赖主线的 4 条里没有 P0，只有 TC-B6X-30 是 P1）；② 4 条“随批补测”是 **B7a 的进门条件**，任何一条没补完，B7a 不开工。 |
| Q-O3 | a | **同意 a**。补一句：预览冻结副本只包括 `-Env preview -Desktop` 用到的文件，记在 `docs/03-评审/B6-exe/` 下；它不等于 B7a 的冻结，B7a 冻结时整份重审。 |
| Q-O4 | a | **同意 a**。补：Rust 工具链用仓库里的 `rust-toolchain.toml` 锁版本，8.6 本机开发环境清单加 Rust、VS Build Tools 两行（运维写）；本机编的只用来开发和调试，**交给 QA 和负责人装的一律是 CI 产物**（经 publish.ps1 签名的那份）。 |
| Q-O5 | a | **同意 a**（0.31 第 30 条 B0～B6 不建开发账号；R-220 临时生成）。注意 8.3a 第 2 步还写着“90 天到期”，和 R-220 的“每次临时生成、1 天到期”不一致，0.48 一并改成 1 天；令牌由负责人在自己的设备上登录 GitHub 生成（8.3a 安全措施：负责人账号不在开发电脑上登录），只在发布时粘贴。 |
| Q-O6 | a | **同意 a**。这一项架构确实没写，0.48 补进 5.10 和 12 风险表：“4.0.0 的 exe 不买 Authenticode 证书，接受 SmartScreen‘未知发布者’；官网下载页写怎么点‘仍要运行’并公布 SHA-256；用户多了再议”；下载页的文字归 B7b。updater 下载的更新包不经浏览器、一般不带 Mark-of-the-Web，自动更新不受这个提示影响（B6-exe 实测记一笔）。 |
| Q-O7 | a | **同意 a**（8.4 预览签名私钥一行已写 Google 密码管理器 + U 盘，不改规则）。但发现**负责人待办和 8.4 对不上**：`docs/00-团队/产品负责人待办-v4.md` B6-exe 两行写的是“存在你本机和你选的 U 盘”“存你本机”——私钥**不该存在开发电脑上**（任务单 R4 的前提就是它不留在 AI 所在的电脑）。由主持人把待办两行改成“U 盘 + Google 密码管理器，开发电脑上不留”；任务单 S3 第 6 步“只显示一次私钥”也改成脚本**不在终端里打印私钥**，由负责人从 U 盘上的文件复制进 Google 密码管理器、复制后清剪贴板（终端回滚缓冲区和转录策略都可能留下打印过的内容）。 |

---

## 四、必改项（改完即算通过，主持人核对）

| # | 必改 | 改在哪 |
|---|---|---|
| M1 | 按 Q-A1 的决定改写 F8、R2、运维行、S6 第 3 步、第六节 Q-A1；第六节交负责人的问题里加一句“预览 exe 的更新地址放在预览 Pages 项目的 `desktop` 分支（`desktop.<预览项目名>.pages.dev`），同意吗” | 任务单 |
| M2 | 写明 `-Desktop` 只和 `-Env preview` 搭配；正式 exe 只随完整发布部署；正式 Pages 的任何重新部署都要带同一 tag 的 `desktop/` | 任务单 F10；架构 8.3a（主持人合）；上线与回滚手册 |
| M3 | F8“双环境编译”列全：更新地址、公钥、CSP `connect-src`（`preview.lemomemo.com` / `lemomemo.com`，http 和 wss 各一）、`VITE_PUBLIC_*`（`--mode preview`）、Turnstile sitekey、secureStorage 会话键白名单、`identifier` 和 `productName`（预览版如 `com.lemomemo.app.preview`、“柠檬记 预览”，能和正式版并存）。desktop.yml 的环境核对覆盖这些项，并对编出的 exe **反向搜对方环境的公钥和主机名**，搜到就失败 | 任务单 F8、F9、A14；架构 5.10、15.4 S-B6、开发计划第六节第 3 点（主持人合） |
| M4 | 安装包只打 NSIS（MSI 不接受 `-preview.N`）；F9 加“CI 把 VERSION（含 `-preview.N`）同步进 `tauri.conf.json`”（8.5）；开工第一天用 `4.0.0-preview.1` 实打一次 | 任务单 F1 / F9、第二节 D0～D1；架构 5.10、8.5 |
| M5 | 预览 tag 不触发 release-build：desktop.yml 遇到 `-preview.N` 的 tag 时自己出 `SHA256SUMS`、总哈希和提交 SHA，写进 Summary；页面按 `--mode preview` 构建。S6 第 5 步写明对的是 desktop.yml 那次运行的 Summary | 任务单 F9、S6；架构 8.3 desktop.yml 一行 |
| M6 | F10 写明发布机上的签名工具：锁在 `tools/ci-tools.lock` 的独立二进制（不经 npm），由运维选定、安全审查员审；8.3a 第 1 步“签名工具二进制的哈希”就是它 | 任务单 F10；架构 8.3a |
| M7 | 加 Q-A3、Q-A4、注册按钮（`auth:open-signup` 不带载荷、main 用写死的地址）三条决定：删 F5 的 Edge Functions 部分和第五节约定 5；F2 / F6 写注册按钮的做法；F3 补“main 不能导航到 `auth.html`”；F5 写清“超额错误页按同步失败处理”由谁改；F5 的 426 改为“核对”；R7 改成 `x-upsert`、`cache-control` 现在就删 | 任务单；架构 5.10 |
| M8 | 第六节 Q-O1 改成“告知 + 同意”的写法；Q-O2 补“S-B6 不依赖主线的 P0 全在先签部分、随批补测是 B7a 进门条件”；Q-O7 那条附上“待办两行改掉‘存你本机’、S3 第 6 步不打印私钥” | 任务单第三、六节；负责人待办（主持人改） |

建议（不卡通过）：
- 第二节 1 的 UI-4 行写明“在 25% 里”；
- `check_backend.py` 加“函数里不得出现 `Access-Control-Allow-Origin`”（Q-A3）；
- 第二节 2 的流程图里，S3、S4 生成私钥前先要 `gen-tauri-key.ps1` 过审并冻结（同 Q-O3 的冻结副本做法），图上补一句；
- 第一次预览签名后，QA 在 TC-B6X-18 的记录里写清用的是 `desktop.<预览项目名>.pages.dev`（或退路的独立项目），方便以后对照。

---

## 五、要改架构和开发计划的位置（主持人合，记为架构 0.48）

| 文档 | 位置 | 改什么 |
|---|---|---|
| 架构 | 新增 **0.48**（B6-exe 任务单架构审） | 记下 Q-A1～Q-A4、注册按钮、NSIS、双环境配置清单、预览 tag 的哈希、签名工具、Authenticode 不买、8.3a 令牌到期改 1 天 |
| 架构 | 1.3 B6-exe 行 | “预览 Pages 下放 `/desktop/latest.json`”改为分支部署；“CORS 白名单和预检（Pages Function、Edge Functions）”删去 Edge Functions |
| 架构 | 1.3“哪些可以并行”`save_attachment` 一条 | 补“在 S-B4b-1 的增量核对里做，B7a 全量复核” |
| 架构 | 5.10 | 来源定 http；CORS 两个小点改为只在转发层；更新一条补预览地址；注册按钮做法；双环境配置清单；NSIS；不买 Authenticode |
| 架构 | 8.2“exe 的更新地址（M7）” | 补预览地址 |
| 架构 | 8.3 desktop.yml 一行 | 预览 tag 自己出 `SHA256SUMS` 和总哈希、按环境构建页面、核对项按 M3 |
| 架构 | 8.3a | 第 1 步签名工具来源；第 2 步只读令牌改 1 天到期；“其他用法”`-Desktop` 改写（M2） |
| 架构 | 8.5 | 写明安装包只用 NSIS（`-preview.N` 版本号） |
| 架构 | 12 风险表 | 加“exe 没有 Authenticode 证书，SmartScreen 提示未知发布者” |
| 架构 | 15.4 S-B6 | “公钥和更新地址与环境一致”扩成 M3 的清单（含反向搜索） |
| 架构 | 15.4 S-B4b-1 | 末尾加 `save_attachment` 的 S-B6 增量核对 |
| 开发计划 v4 | 第六节“交架构师定的一项”第 1、3 点 | 第 1 点改地址和部署方式；第 3 点核对项按 M3 |
| 开发计划 v4 | 第六节负责人事项 B6-exe 行 | 预览签名每次多一把临时 Pages 令牌（S6 第 3 步） |
| 负责人待办 v4 | B6-exe 两行 | 去掉“存你本机”，改为 U 盘 + Google 密码管理器 |

人日、日历都不变；Q-A1 退路如果用上，运维约 +0.25，单列不进总数。

## 修改记录

| 日期 | 改了什么 | 谁 |
|---|---|---|
| 2026-11-03 | 第一稿 | 架构师 |
| 2026-11-03 | 按主持人要求把第五节合进架构 0.48、开发计划、负责人待办、上线与回滚手册；check_backend 那条登记为接手清单 CORS-fn-guard（没改 check_backend.py）；任务单本身仍由作者改 | 架构师 |
