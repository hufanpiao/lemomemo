# B6-exe 任务单：电脑版外壳（Tauri exe）＋ 预览更新通道

- 日期：2026-11-03　作者：架构师助理
- 状态：**已拍板（Q-O1 待 TC-B0-65）**：负责人 11-03 回答了 Q-O2～Q-O8（第六节“拍板结果”）；架构审 [B6-exe-任务单-架构审](../03-评审/B6-exe/B6-exe-任务单-架构审.md) 有条件通过，必改 M1～M8 已改。本单只做范围、分工、顺序和负责人步骤；技术做法以架构正文为准，架构审和拍板结果已写进架构 **0.48**（末尾“负责人 11-03 拍板”表）和开发计划。
- 依据：
  - [开发计划 v4](开发计划-v4.md)：第二节（B6-exe 在 B1 签完后开工、和 B2～B6 同时做；QA 主线优先）、第三节 B6-exe 行（3.5～4 人日，含预览更新通道 0.5～1；Turnstile 不能用时 +2～3）、第五节负责人事项 B6-exe 行、第六节“交架构师定的一项”（预览更新通道 5 点）；
  - [架构设计 v4](../10-架构/架构设计-v4.md)：1.3 B6-exe 行和“哪些可以并行”、0.28 第 2 条、5.10（exe 全部做法）、8.2（`/desktop/src-tauri/` 布局）、8.3（desktop.yml、release-build.yml）、8.3a（`publish.ps1`，含“冻结前必须改的五处”）、8.4（预览签名私钥、正式签名私钥、“谁来生成最要紧的三把钥匙”）、8.5（版本号）、第 9 节“Windows 必测”、14.2、15.4（S-B6 P0、S-B6b P1、S-B4b-1、S-B7 里 publish.ps1 一项）、15.6；
  - [B6-exe 任务单架构审](../03-评审/B6-exe/B6-exe-任务单-架构审.md)：Q-A1～Q-A4 的“架构定”、注册按钮做法、必改 M1～M8；
  - [B1 接手清单](B1-接手清单-来自B0评审.md)：P2 ★（生成私钥时主持人当场提醒）、KO-K44-pcname、P-r2probe、OPS-deploy；B0 安全审查中 2（publish.ps1 五处，归 B6-exe、B7a 冻结前复审）；
  - [人员名单](../00-团队/人员名单.md)：前端 B 行、运维行、“exe 外壳”“发布脚本”“密钥生成脚本”“Windows 实机测试”几行、第三节六环；
  - [测试用例 v4](../06-测试/测试用例-v4.md)：TC-B0-65、TC-B6X-01～33；[环境清单 v4](../08-发布/环境清单-v4.md) Turnstile 一节和第七节；[B0 验证：Tauri 里 Turnstile](../07-开发日志/B0-验证-Tauri里Turnstile.md)；[产品负责人待办 v4](../00-团队/产品负责人待办-v4.md) B6-exe 两行。
- 安全红线（本单通篇适用）：**签名私钥和私钥密码的生成、设置、保存、粘贴，只能负责人本人做，AI 不经手、不看、不代运行**（架构 8.4“全程不经过 AI”、R-206、R-220）。AI 只写脚本，脚本经代码审查员和安全审查员审过、冻结后才交负责人运行。**私钥不留在开发电脑上**：正式私钥存 U 盘 + Google 密码管理器；**预览私钥只存 Google 密码管理器**（负责人 11-03 定，Q-O7）。

---

## 一、范围和验收标准

### 1. 做什么

| # | 内容 | 出处 |
|---|---|---|
| F1 | Tauri 2 外壳：**页面打包进安装包**；来源**定为 `http://tauri.localhost`，不开 `useHttpsScheme`，以后不改**（改来源等于换源，本机库和离线队列全部读不到；Q-A2 架构定）；开机自启、托盘、单实例、Windows 通知（不带按钮，点开 App 的整页提醒）；**安装包只打 NSIS**（`bundle.targets: ["nsis"]`，MSI 不接受 `-preview.N` 版本号），**开工第一天用 `4.0.0-preview.1` 实打一次确认**（M4） | 1.3 B6-exe 行；5.10；8.5；R-85、R-105；架构审 M4 |
| F2 | 三个窗口：`main`、`auth`（登录，只有 `session_set`、发 `auth:done`、**发 `auth:open-signup`**、关自己）、`quick-add`（全局热键 Ctrl+Shift+空格（R-297，可改）弹出打字框，不连服务器、不碰会话，经 `quick-add:submit` 交给 main 的 outbox） | 5.10；R-110；第三轮架构 M2、安全 X2；架构审第一节 3.6 |
| F3 | 安全外壳：`tauri.conf.json` 的 CSP（含 `ipc: http://ipc.localhost`）、main / auth / quick-add 三页 meta CSP 收紧；`withGlobalTauri = false`；不开 `remote.urls`、shell、文件系统、updater 的 JS 命令；WebView2 权限回调只放行本地页面的通知；外链经 `open_external` 交系统浏览器；导航只留在本地页面，**并在 Rust 里按窗口判断：main 不能导航到 `auth.html`** | 5.10；15.6；S-B6；架构审第一节 3.7 |
| F4 | secureStorage：`session_get/set/remove` 只认 `lemomemo.session.` 前缀下白名单键，存 Windows 凭据管理器；supabase-js 在 exe 里用它；白名单键名按环境（预览是 `sb-preview-…`，14.2 第 2 点，见 F8） | 5.10；S-B6、S-B6b（P1，上线前必须完成） |
| F5 | CORS **只在转发层做**（`functions/_lib/cors.ts`，管 `/sb/*`、`/files/*`），**Edge Functions 不加**（Q-A3 架构定）：<br>① 按 B0 锁定版本的 supabase-js **抓包**，只为发现 5.10 表里**没有**的请求头和要暴露的响应头；<br>② `cors.ts` 里 0.32 起已不用的 `x-upsert`、`cache-control` **现在就删**，不等抓包；<br>③ 426 带 exe 的 CORS 头 **B0 已做**（`functions/sb/[[path]].ts`、`functions/files/[[path]].ts` 经 `applyCors`），本批只**核对**（TC-B6X-22）；<br>④ `build/check_backend.py` 加一条“`supabase/functions/` 下不得出现 `Access-Control-Allow-Origin`”（约 0.1 人日，在 25% 里）；<br>⑤ **Cloudflare 超额时的默认错误页不带 CORS 头**：`src/platform/http.ts` 把这种读不出原因的网络错误按“同步失败、稍后重试”处理（和断网一样进退避，界面显示“暂时同步不了”），**前端 B 改、前端 A 审** | 5.10；开发计划三之二；TC-B6X-04、22；架构审 M7 |
| F6 | 不做：语音、Windows Hello（隐私记在 exe 里只输密码）；exe 里不注册 Service Worker。**注册不在 exe 里做**：auth 窗口的“没有账号？用邀请码注册”发一个**不带任何载荷**的事件 `auth:open-signup`，main 收到后用 **Rust 里写死**的地址调 `open_external`（正式版 `https://lemomemo.com/app/auth/`，预览版写死预览地址）；网址不从 auth 窗口传过来，auth 的 capability 只多“发这一个事件” | 5.10；R-90；0.38 第 41 条；架构审第一节 3.6 |
| F7 | Rust 端自动更新：启动时和每 24 小时查 `latest.json`、验签、系统对话框问重启；426 后页面横幅的“更新”按钮交给 Rust 端检查 | 5.10；0.27 第 1 点 |
| F8 | **双环境编译和预览更新通道**（0.28；M1、M3）。预览版和正式版**按环境整套切换、能装在同一台电脑上并存**，要切换的项：<br>• 更新地址：正式 `https://lemomemo.com/desktop/latest.json`；**预览 `https://desktop.<预览项目名>.pages.dev/latest.json`**（预览 Pages 项目的 `desktop` 分支固定别名，Q-A1 架构定；`latest.json` 里安装包的 `url` 也指向同一别名）；<br>• updater 公钥：只编本环境那一把；<br>• CSP `connect-src`：正式 `https://lemomemo.com wss://lemomemo.com`，预览 `https://preview.lemomemo.com wss://preview.lemomemo.com`（否则预览版 exe 连不上预览站）；<br>• 页面的 `VITE_PUBLIC_*`：预览按 `--mode preview` 构建；<br>• Turnstile sitekey：用本环境的；<br>• secureStorage 会话键白名单：按环境（预览 `sb-preview-…`）；<br>• `identifier` 和 `productName`：预览版如 `com.lemomemo.app.preview`、“柠檬记 预览”，和正式版的自启、单实例、托盘、卸载项互不串；<br>• 注册按钮写死的地址（F6）。<br>desktop.yml 核对以上各项与当前环境一致，并**对编出的 exe 反向搜对方环境的公钥和主机名，搜到就失败** | 开发计划第六节第 1、3 点；1.3；S-B6；架构审 Q-A1、M1、M3 |
| F9 | 流水线（运维）：<br>• desktop.yml：构建页面（正式 `--mode production`，预览 `--mode preview`）→ windows-latest 上 `cargo audit` / `cargo deny` → **把 `VERSION`（含 `-preview.N`）同步进 `tauri.conf.json`**（8.5）→ `tauri build -- --locked`（只打 NSIS）→ **只出未签名**安装包和 `latest.json` 草稿，CI 里没有任何签名私钥；F8 的环境核对和反向搜索；<br>• **预览 tag（`v4.0.0-preview.N`）不触发 release-build**（它只认 `v[0-9]+.[0-9]+.[0-9]+`），所以 desktop.yml 遇到预览 tag 时**自己出 `SHA256SUMS`、总哈希和提交 SHA，写进本次运行的 Summary 页**；<br>• 正式 tag：release-build.yml 等 desktop.yml，生成整包的 `SHA256SUMS` 和总哈希（8.3a） | 8.3 表；8.3a；8.5；S-B6；架构审 M4、M5 |
| F10 | 本机签名（运维写、负责人运行）：<br>• `tools/keys/gen-tauri-key.ps1`：生成正式、预览两把（分两次运行）；**不在终端里打印私钥**（终端回滚缓冲区和转录策略都可能留下打印过的内容），只打印公钥（公开值）。私钥怎么不留在开发电脑上（架构 0.48 第 13 条）：<br>　① 首选：把签名工具的输出直接收进脚本内存，不落盘；脚本把私钥放进剪贴板，负责人粘进 Google 密码管理器后按回车，脚本立即清空剪贴板；<br>　② 签名工具只能写文件时：写进 `%LOCALAPPDATA%\Temp\` 下随机名的新目录（只给当前用户权限，开头核对它不在 OneDrive 等同步目录里），同样经剪贴板存进 Google 密码管理器后，脚本删除文件和目录，**核对两者都不在了才打印“已删除”**，删不掉就停下报错；<br>　③ 正式私钥另把加密的私钥文件写一份到 U 盘；**预览私钥不写 U 盘**（Q-O7）；<br>　④ 脚本开头检查剪贴板历史和跨设备同步已关（同 8.3a 第 1 步），没关就停；运维选签名工具时把“能不能只输出到标准输出”写进选型说明；<br>• `publish.ps1 -Env preview -Desktop`：下载 desktop.yml 的未签名产物、按 `SHA256SUMS` 核对、签名，把**只含安装包和 `latest.json` 的目录** `wrangler pages deploy <该目录> --project-name <预览项目> --branch desktop`；deploy-preview 照旧 `--branch main`，两边互不碰，**deploy-preview.yml 不用改**；<br>• **`-Desktop` 只能和 `-Env preview` 一起用**；正式 exe 只随 `-Tag` 完整发布和网页一起部署，不单独部署；**任何对正式 Pages 的重新部署（含回滚）都必须带上同一个 tag 签好的 `desktop/`**（Pages 每次部署是整站快照）；<br>• **发布机上的签名工具**：不经 npm（发布机不跑 npm），用锁在 `tools/ci-tools.lock` 里的独立二进制（Tauri 官方发布的 `cargo-tauri` Windows 二进制，或兼容 minisign 格式的签名工具，以 updater 能验过为准），由运维选定、安全审查员审；8.3a 第 1 步“签名工具二进制的哈希”核的就是它 | 8.4；8.3a；开发计划第五节 B6-exe 行；架构审 Q-A1、M2、M6、Q-O7 |
| F11 | `publish.ps1` 冻结前必须改的五处（发布机不跑 npm 和构建、改为下载 CI 产物——现在第 911～917 行还在本机 `npm ci`、`npm run build`；每个子进程只拿自己那把令牌；函数用 CI 产物里 `copy:shared` 过的；开头检查和 keys 脚本对齐；release-build 头注释）——**B6-exe 期间改完，B7a 冻结前复审** | 8.3a 末段；B0 安全审查中 2；S-B7 |
| F12 | （可选，B 的空档）B6 里不依赖 App 主体的部分：`build/check_contrast.py`、`build/contrast-pairs.json`。**皮肤变量和 `skins/*.css` 本单不做**（理由见第五节，架构审同意）；F12 是 B6 的活，**不计入 B6-exe 的 3.5～4** | 开发计划第二节“减少返工”③；1.3 工期说明 3 |

### 2. 验收标准（技术验收那一环；全部满足才算过）

照抄架构 1.3 B6-exe 行，用例编号来自测试用例 v4：

| # | 标准 | 用例 | 级别 |
|---|---|---|---|
| A1 | Turnstile 在 `auth` 窗口能出题和通过（**先补完 TC-B0-65**：B0 只做了浏览器对照，真 Tauri 窗口还没跑）；不能用就走退路 TC-B6X-02（+2～3 人日） | TC-B0-65 → TC-B6X-01 或 02 | — |
| A2 | 页面打包进安装包、不开 `remote.urls` | TC-B6X-03 | P0 |
| A3 | CORS 预检和各接口（REST、函数、`/files` 图片、auth 刷新令牌）在 exe 来源下正常，别的来源拿不到 CORS 头 | TC-B6X-04 | P0 |
| A4 | 时钟偏差（读得到 `Date`）、计数查询（读得到 `Content-Range`） | TC-B6X-05 | — |
| A5 | 主窗口没有 `window.__TAURI__`、加载不了 challenges.cloudflare.com、**导航不到 `auth.html`** | TC-B6X-06 | P0 |
| A6 | 三个窗口只调得到给它们的命令（auth 只多 `auth:open-signup` 一个事件；注册按钮经 main 用写死的地址打开系统浏览器） | TC-B6X-07 | P0 |
| A7 | 控制台没有 CSP 报错（含 IPC），**预览版和正式版各测一次** | TC-B6X-08 | P0 |
| A8 | secureStorage 读写不了前缀以外的条目；会话在凭据管理器里 | TC-B6X-09、15 | P0 / P1 |
| A9 | 热键打字框记一条、经 main 的 outbox 同步；Realtime 能连；单实例 | TC-B6X-10、12、29 | — |
| A10 | 通知点开整页提醒（**依赖 B2 的整页提醒**，见第二节 3） | TC-B6X-11 | — |
| A11 | 隐私记只显示输密码；WebView2 的麦克风等权限被拒；外链交系统浏览器；没有语音入口 | TC-B6X-13、14、27 | P0（14） |
| A12 | 安装、开机自启、托盘；SmartScreen 提示记进报告（不买 Authenticode，见 Q-O6；顺带记一笔自动更新下载的包是否带 Mark-of-the-Web）；Edge 安装版各项；**预览版和正式版装在同一台电脑上能并存** | TC-B6X-16、17 | — |
| A13 | **预览更新通道**（地址 `desktop.<预览项目名>.pages.dev`，或退路的独立项目，QA 在 TC-B6X-18 的记录里写清用的是哪个）：`preview.1` → `preview.2` 自动更新；验签失败拒装；不降级；断网安静失败；426 后走 Rust 端更新检查；回退旧版时 `VersionError` 整屏提示不删库；**推一次 `main`（deploy-preview）之后更新地址仍在** | TC-B6X-18～23 | — |
| A14 | desktop.yml：F8 列的各项与环境一致，**反向搜到对方环境的公钥或主机名就失败**；只出未签名包、只打 NSIS；`--locked`；audit / deny 0 高危；Action 固定 SHA；预览 tag 的 Summary 有 `SHA256SUMS`、总哈希和提交 SHA | TC-B6X-24、25 | P0 |
| A15 | 两把签名私钥由负责人本人生成、不放 GitHub；正式存 U 盘 + Google 密码管理器、预览只存 Google 密码管理器，开发电脑上都不留（生成时如有临时文件，已删除并核对），AI 全程没看到；负责人本机跑检查脚本输出“没找到” | TC-B6X-26 | P0 |
| A16 | 隐私记解锁后 Alt+Tab、任务栏缩略图看不到内容（**依赖 B5**） | TC-B6X-30 | P1 |
| A17 | `save_attachment` 用 B6-exe 版本重测（**依赖 B4b-1**） | TC-B6X-28 | — |
| A18 | 安全：15.4 的 **S-B6（P0）** 全部打勾（含 F8 的双环境清单和反向搜索）、S-B6b（P1）；publish.ps1 五处改完（S-B7 里那一项 B7a 冻结前复审，本批只交“已改、待冻结”） | — | P0 |
| A19 | **卸载删本机数据**（架构 0.50 第 11 条、5.10、15.4 S-B6）：交互卸载和静默卸载（`/S`）都删 WebView2 数据目录 `%LOCALAPPDATA%\<identifier>\` 和凭据管理器里的会话条目；自动更新走覆盖安装、不删；预览版、正式版各删各的 | TC-B6X-31 | P0 |
| A20 | 卸载界面中韩提示：“本机缓存会删除，云端数据不受影响；还没同步的改动会丢失，卸载前请先联网打开一次柠檬记”（架构 0.50 第 11 条、5.10） | TC-B6X-32 | — |
| A21 | 启动画面也认“减少动态效果”开关（架构 0.50 第 9 条 X-6、17.4） | TC-B6X-33 | — |

> 注：TC-B6X-25 的期望里还写着“编译和签名分开、签名任务不编译”，那是 R-206 之前的写法（CI 已不签名）。请 QA 在 B6-exe 开工时按 8.3 现行做法改成“desktop.yml 只出未签名包、工作流里不引用任何签名密钥”，并按 A14 补环境核对和反向搜索。本单不改测试用例文件。

### 3. 不在本批

- 正式那条更新线（4.0.0 → 4.0.1）上线前测不了：发 4.0.1 时在负责人电脑和 QA 机器上验证，写进上线与回滚手册的跟进项（开发计划第六节第 5 点）。
- 用最终页面重打 exe、再跑一遍“Windows 必测”里的 exe 项，S-B6 全量再打一次勾：在 **B7a**（第三轮人员 L-d）。
- `publish.ps1` 整份冻结、对预览项目完整演练：在 **B7a**（8.3a、R-206）。B6-exe 期间的“预览冻结副本”不等于 B7a 的冻结（Q-O3）。
- `save_attachment` 的安全核对：在 **B4b-1** 的 ②③ 环做“S-B6 增量”核对，不重开 B6-exe 签字（Q-A4 架构定，见第六节）。
- 平台名“Windows PC / PC 앱”要不要改（接手清单 KO-K44-pcname）：电脑版上线时由韩文审校和前端 A 看，本单只提醒。

---

## 二、分工、估算和先后

### 1. 谁做什么

| 人 | 内容 | 估算（人日） | 说明 |
|---|---|---|---|
| **前端 B**（主做） | F1～F7、F8 的 exe 一侧（双环境整套配置）、`src/platform/desktop.ts`、F5（转发层 CORS 核对和收窄、`http.ts` 超额错误页处理）、抓包核对请求头 | **3.5～4**（外壳约 2.5～3，预览更新通道约 0.5～1；1.3） | Turnstile 不能用时另加 **2～3**（系统浏览器登录退路，要另过安全审查；5.10）。架构审定下的做法不改人日 |
| **运维**（单列，不进总数，R-204） | F9 desktop.yml（双环境构建、版本号同步、环境核对和反向搜索、预览 tag 自出哈希）、release-build.yml 出 `SHA256SUMS`；F10 `gen-tauri-key.ps1`、`publish.ps1 -Env preview -Desktop`（部署到预览 Pages 项目的 `desktop` 分支）、发布机签名工具选型并锁进 `tools/ci-tools.lock`；F11 五处；`rust-toolchain.toml` 锁 Rust 版本，8.6 本机开发环境清单补 Rust、VS Build Tools 两行；`check_backend.py` 的 CORS 规则 | 按 8.3a 的 **3～4**（脚本 2～2.5、CI 改只构建出哈希 0.5、exe 本机签名 0.5～1）；B0 已做的部分由运维开工时报数扣减；Q-A1 退路如果用上约 +0.25 | `publish.ps1` 第一版在 B0 已有，`-Ops`、`-Only functions` 已做（接手清单 OPS-deploy）；现在还没有 `-Env`、`-Desktop` 参数 |
| 前端 A | 只做接口：B1 的 426 横幅“更新”按钮、B2 的整页提醒入口，各留一个 `platform` 层的函数给 B 接（见第五节约定 3、4）；审 F5 ⑤ 的 `http.ts` 改动；合并 F12 | 在 B2 的开发里吸收，不另加 | 不改 exe 代码 |
| 后端 | 不涉及（Edge Functions 不加 CORS，Q-A3） | — | |
| 代码审查员 | ② 环：前端 / 后端 / 运维 / **exe** 四节；`gen-tauri-key.ps1`、`publish.ps1` 改动 | 在 25% 返工里 | 作者不自审 |
| 安全审查员 | ③ 环：S-B6、S-B6b；两个脚本和预览冻结副本；签名工具二进制；核对 AI 没接触私钥明文 | 同上 | |
| QA | ④ 环：TC-B6X-01～33 Windows 实测（33 条，其中 P0 12 条；进冒烟的自动 ★ 17 条、人工 ★人 4 条，01 / 02 二选一实际执行 3 条；测试用例 v4 统计表）。**交给 QA 装的一律是 CI 产物、经 publish.ps1 签名的那份**，本机编的只用来开发调试 | 在 25% 里；**排在主线该批 ④ 之后的空档**（开发计划第二节） | |
| UI-4 | ②b 环：确认 quick-add 打字框“瞬间出现、不加动效”（17.1），其余本批不涉及 | 在 25% 里，不单列 | |
| **产品负责人** | 第三节的本人步骤 | 合计约 1.5～2.5 小时，分 4～6 次 | 不是真机批次，没有 ⑤ 环，但第三节步骤卡签字 |

**合计**：开发 **3.5～4 人日**（照抄 1.3，已在 180.5～211 里；Turnstile 退路再 +2～3）；运维约 3～4（单列）；在副线上，**不占主线日历**。

### 2. 先后（依赖）

```
11-03 B1 签完 ──→ 开工
  D0  负责人 S1（装 Rust / VS Build Tools，本人点 UAC；Q-O4）
  D0～D1 前端 B：补完 TC-B0-65（壳 desktop/turnstile-probe 已有）── 负责人 S2（真 sitekey、交互题由人点）
           ├─ 能用 → 照原计划 auth 窗口登录；主持人随即告知负责人加正式 Turnstile 主机名（Q-O1、S5）
           └─ 不能用 → 架构师改 5.10、B6-exe +2～3 人日，正式和预览一起走退路，主持人告诉负责人
         前端 B：用 4.0.0-preview.1 实打一次 NSIS 包（M4）
  D1～D3 前端 B：外壳 F1～F7、F8 双环境配置（不依赖签名私钥，用开发版跑）
         运维：gen-tauri-key.ps1 → 代码审查 + 安全审查 → 冻结副本（同 Q-O3 做法）
                  ──→ 负责人 S3、S4 生成两把私钥（P2 ★ 当场提醒）
                  └→ 公钥（公开值）提交进仓库，F8 才能编双环境
  D3～D4 运维：desktop.yml、release-build.yml、publish.ps1 -Env preview -Desktop、签名工具、五处
              → 审查 → 预览冻结副本（Q-O3）
         负责人 S6：第一次预览签名（preview.1，部署到 desktop 分支；分支别名用不了就走退路）
                    第二次（preview.2）→ QA 测自动更新 TC-B6X-18～23
  之后  QA 在主线 ④ 的空档跑 Windows 实测；② ③ 签字（先签部分含 S-B6 全部不依赖主线的 P0）
  随批补测：TC-B6X-11（B2 签完后）、TC-B6X-13 / 30（B5 签完后）、TC-B6X-28（B4b-1 签完后）
           ── 4 条全部补完是 B7a 的进门条件（Q-O2）
  B4b-1 save_attachment：在 B4b-1 的 ②③ 做“S-B6 增量”核对（Q-A4）
  B7a   用最终页面重打 exe 再跑 Windows 必测、S-B6 全量复核；publish.ps1 整份冻结、演练
```

### 3. 依赖主线的三处

| 用例 | 依赖 | 现在怎么办 |
|---|---|---|
| TC-B6X-11 通知点开整页提醒 | B2 的提醒和整页提醒页 | B2 签完后补测；B6-exe 先测“通知能弹、点了能把 main 拉到前面” |
| TC-B6X-13（隐私记只输密码）、TC-B6X-30（多任务遮罩，P1） | B5 隐私记 | B5 签完后补测 |
| TC-B6X-28 `save_attachment` | B4b-1（命令本身由前端 B 在 B4b-1 做） | 按 1.3：B6-exe 没签完时用开发版测；签完后用 B6-exe 版本重测；安全核对在 B4b-1 的 S-B6 增量里做 |

这 4 条里没有 P0，所以先签不漏 S-B6 的 P0；4 条全部补完才能开 B7a（Q-O2）。

---

## 三、必须负责人本人做的步骤

> 这些步骤按安全规则 **AI 不能代做**：生成和保存私钥、设私钥密码、往 Google 密码管理器里存、粘贴私钥签名、在网页控制台改设置、临时生成令牌、点 UAC 管理员确认、完成人机验证（Turnstile 交互题）。具体命令和脚本名 **【待补】**：运维写好脚本、过完代码审查和安全审查并冻结后，由主持人把命令填进这里，再转给负责人。每一步做完在聊天里说一句“做完了”（不要贴任何值），主持人记进 `docs/03-评审/B6-exe/B6-exe-负责人操作记录.md`。

### S1　装编译 exe 要的工具（约 30 分钟，开工当天；Q-O4）

1. 打开主持人给的安装说明 **【待补：Rust 和 VS Build Tools 的官方下载页、勾哪些组件，运维按 8.6 写；Rust 版本由仓库的 `rust-toolchain.toml` 锁定】**。
2. 安装时 Windows 弹出“是否允许此应用更改你的设备”，**本人点“是”**（管理员确认，AI 不点）。
3. 装完在聊天里说“装好了”，前端 B 接着跑 `rustc --version` 核对版本。

### S2　Turnstile 在 exe 里能不能用（约 15 分钟，开工第 1～2 天）

1. 前端 B 编好验证用的小壳后，主持人给你一行启动命令 **【待补】**，在自己的 PowerShell 里运行。
2. 窗口里先选测试 key `3x00000000000000000000FF`，**本人点一下人机验证**（AI 不能代点验证码）。
3. 再选“自定义”，填预览站点的 sitekey（公开值，主持人给）；看能不能出题、能不能通过；出现错误码 `110200` 就截图。
4. 截图发给主持人（日志里只有令牌长度和前 8 位，没有秘密）。

### S3　生成 exe **预览**签名私钥（约 10 分钟）

1. **先关掉 Claude Code、Claude App**（生成和保存期间不开 AI 会话）；确认 S5 第 1 步（关剪贴板历史和跨设备同步）已经做过，脚本也会查。
2. 打开 passwords.google.com，准备好新建条目，名字建议“柠檬记 exe 预览签名私钥”。
3. 预览私钥**不用 U 盘**（负责人 11-03 定，Q-O7）。
4. 打开 PowerShell，按 `Get-FileHash` 核对脚本冻结副本的哈希和 iPhone 上存的一致 **【待补：冻结副本的路径和哈希】**，一致再运行 **【待补：如 `gen-tauri-key.ps1 -Env preview`】**。
5. 脚本提示时**本人设私钥密码**（自己想，不告诉任何人和 AI）。
6. 终端里不显示私钥。脚本提示“私钥已放进剪贴板”时，**本人在 Google 密码管理器那条里粘贴私钥，再把第 5 步设的私钥密码也填进去**，保存后回到 PowerShell 按回车，脚本清空剪贴板。如果脚本用了临时文件，它会接着删除并核对，打印“已删除”才算完（报错就停，告诉主持人“删除失败”，不要贴任何内容）。开发电脑上不留私钥。
   **⚠ 生成后马上存进 Google 密码管理器（passwords.google.com），这是它唯一的一份**。丢了就重新生成一把，已装的预览版 exe 要重装一次
7. 脚本最后打印的**公钥**是公开值，可以复制给主持人（或脚本直接写进仓库的公钥文件 **【待补】**）。
8. 关掉 PowerShell 窗口，回到聊天说“预览私钥存好了”。主持人等这句话再往下走（接手清单 P2 ★）。

### S4　生成 exe **正式**签名私钥（约 10 分钟）

同 S3，不同的几处：第 3 步**要插上你选的 U 盘（放在家里那个）**，脚本会把加密的私钥文件另写一份到 U 盘；第 4 步的参数换成正式 **【待补】**；条目名建议“柠檬记 exe 正式签名私钥”；做完拔下 U 盘再回聊天。
**⚠ 这一把丢了不能重来：生成后马上存进 Google 密码管理器（passwords.google.com）**。丢了它，以后装好的 exe 就没法自动更新。
两把私钥分开存、不能混用。

### S5　发布前的系统设置（一次，约 5～10 分钟）

1. Windows 设置 › 系统 › 剪贴板：**关掉“剪贴板历史记录”和“跨设备同步”**（8.3a，系统设置由本人改）。
2. **TC-B0-65 结论是“能用”且你同意 Q-O1 之后**：在 Cloudflare 控制台的**正式** Turnstile 站点主机名列表里加 `tauri.localhost` **【待补：照环境清单 Turnstile 一节写具体点哪里】**。只加在 Turnstile 控制台，我们函数里的 hostname 白名单不加（5.10）。

### S6　预览版 exe 签名和发布（每次约 5～10 分钟，B6-exe 期间约 2～3 次）

1. 主持人说“`v4.0.0-preview.N` 的 desktop.yml 跑完了”，把**这次 desktop.yml 运行的 Summary 页**链接发给你（预览 tag 不触发 release-build，哈希在 desktop.yml 的 Summary 上）。
2. **关掉 Claude Code、Claude App**。
3. **在你自己的设备上**（不在开发电脑上登录你的 GitHub）临时生成这次要用的两把令牌，都设 1 天到期、用完删：
   - GitHub 细粒度只读令牌：只管本仓库、只读 Actions（下载 CI 产物，Q-O5）**【待补：点哪里】**；
   - Cloudflare 预览用的“Pages: Edit”令牌（部署到预览 Pages 项目的 `desktop` 分支，Q-A1）**【待补：点哪里】**。
   没有别的网页操作。
4. PowerShell 里先 `Get-FileHash` 核对预览冻结副本和 iPhone 上的哈希一致，再运行 **【待补：如 `publish.ps1 -Env preview -Desktop -Tag v4.0.0-preview.N`】**，按提示粘贴两把令牌。
5. 脚本打印产物总哈希和提交 SHA，**用 iPhone 打开第 1 步那页 desktop.yml 的 Summary 对一遍**，一致才打“是”。
6. 脚本提示时，从 Google 密码管理器复制**预览**私钥和私钥密码粘贴进去（脚本读完会清空剪贴板）。
7. 跑完后到 GitHub、Cloudflare 网页上**删掉第 3 步的两把令牌**，回聊天说“preview.N 签好了”。
8. **只在第一次时**：如果脚本报“分支别名用不了”，主持人会问你是否同意改用退路（单独一个只放 desktop 的 Pages 项目，见第六节 Q-O8 的说明），同意后再继续。

### S7　私钥没被 AI 看到的检查（约 10 分钟，签字前一次；TC-B6X-26）

1. 关掉 Claude Code、Claude App，运行运维写的检查脚本 **【待补】**：按提示**从 Google 密码管理器**依次复制两把私钥粘贴进去（`Read-Host -AsSecureString` 读，每读完一把立即清剪贴板），脚本只按哈希在 AI 会话记录和 CI 日志里搜，不打印、不写文件。
2. 输出“没找到”就截图给 QA；有任何一处找到，立刻告诉主持人（两把私钥都要作废重来，S3、S4 重做，已装的预览版 exe 重装）。

### S8　Edge 安装版的 Windows Hello（约 5 分钟；TC-B6X-17）

Windows Hello 要本人指纹、人脸或 PIN（人员名单），QA 准备好后本人按提示验证一次。

---

## 四、风险

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | **TC-B0-65 还没在真 Tauri 窗口里测**（B0 只做了浏览器对照，本机没有 Rust） | 不能用就 +2～3 人日、另过安全审查 | 开工第一件事做；S1、S2 尽早；结论写回 5.10<br>**11-03 已关闭：TC-B0-65 在真 Tauri 窗口实测通过**（[实测记录](../03-评审/B6-exe/TC-B0-65-Tauri实测.md)），系统浏览器登录退路不用做 |
| R2 | **Pages 每次部署是整站快照**：deploy-preview.yml 每次推 `main` 都 `wrangler pages deploy dist/web --branch main`，`dist/web` 里没有 `desktop/`，预览的 `/desktop/latest.json` 一推就 404；反过来单独部署 `desktop/` 也会冲掉整个网站。**正式环境同样**：单独 `-Desktop` 或只重部署网页的回滚都会冲掉另一半 | 预览更新通道测不稳；正式回滚可能把 `/desktop/` 弄丢 | **已定（Q-A1）**：预览 exe 的更新地址放预览 Pages 项目的 `desktop` 分支（`desktop.<预览项目名>.pages.dev`），deploy-preview 照旧部署 `main` 分支，互不碰；`-Desktop` 只和 `-Env preview` 用；正式 Pages 的任何重新部署都带同一 tag 签好的 `desktop/`（F10）。分支别名第一次签名时实测，用不了走退路（Q-O8）。`pages.dev` 在中国大陆可能连不上，预览通道只在韩国测，接受 |
| R3 | 签名私钥丢失 | 正式私钥丢了，已装的 exe 永远收不到更新；预览私钥丢了，已装的预览版 exe 收不到更新 | 正式：Google 密码管理器 + U 盘两份（R-220）；预览：只存 Google 密码管理器（Q-O7），丢了重新生成，已装的预览版 exe 重装一次、预览通道从 `preview.1` 重测；S3、S4 的提醒（P2 ★） |
| R4 | 私钥经过 AI 所在的电脑 | 泄露后可给恶意更新签名 | 生成和签名时关 AI 会话；终端不打印私钥、开发电脑上不留（首选只在内存里，临时文件用完删除并核对，F10）；脚本不写别的文件、不进命令行参数、粘贴后清剪贴板；TC-B6X-26 检查（12 风险 21 已告知负责人） |
| R5 | B6-exe 期间 `publish.ps1` 还没冻结，负责人要用它签预览包 | 跑了没审过的脚本 | Q-O3（预览冻结副本） |
| R6 | 正式 Turnstile 不加 `tauri.localhost`，exe 的正式版登录页渲染不出验证 | exe 上线后登录不了 | Q-O1：TC-B0-65 出结论后告知负责人并请同意加 |
| R7 | 抓包发现 supabase-js 要的请求头不在白名单 | exe 某些接口跨域失败 | F5：`x-upsert`、`cache-control` 现在就删；抓包只为找表里没有的头，找到就补进 `cors.ts` 和 5.10 的表 |
| R8 | QA 一人、主线优先 | B6-exe 的 ④ 会排队，签字晚 | 自动用例尽量多（进冒烟的自动 ★ 15 条），人工项集中一次跑 |
| R9 | 没有代码签名证书（Authenticode），安装时 SmartScreen 提示“未知发布者” | 朋友安装时被吓住 | Q-O6（架构同意不买，0.48 补进 5.10 和 12 风险表；下载页文字归 B7b） |
| R10 | 依赖主线的用例（B2、B5、B4b-1）拖到后面 | B7a 卡住 | Q-O2：先签，4 条随批补测，补完才开 B7a |
| R11 | 预览版和正式版的 `identifier` 一样 | 预览版覆盖正式版，自启、单实例、托盘、卸载项串在一起 | F8：预览版用独立的 `identifier`、`productName`，A12 测并存 |
| R12 | MSI 不接受 `-preview.N` 版本号 | 预览包打不出来 | F1：只打 NSIS，开工第一天实打一次<br>**11-03 已实打**：NSIS 当前用户模式，`4.0.0-preview.1` 原样保留，1.79 MiB，装、启动、静默卸载都正常（[M4-NSIS实打](../03-评审/B6-exe/M4-NSIS实打.md)） |
| R13 | **`window.__TAURI_INTERNALS__` 一定存在**（Tauri 2 无论配置都注入，IPC 靠它）；`withGlobalTauri = false` 只去掉 `__TAURI__` | “页面里够不到 Tauri”不能当安全前提 | 能调哪些命令只靠 capabilities（auth 窗口零权限）和 CSP 管住；S-B6 逐窗口核 capabilities（11-03 前端 B 实测发现） |
| R14 | **卸载时 WebView2 数据目录 `%LOCALAPPDATA%\<identifier>\` 默认保留**，里面有 IndexedDB（本机缓存、离线队列） | 卸载后别人的数据留在电脑上 | 交架构师在 5.10 定：卸载时删不删、怎么提示（11-03 NSIS 实打发现） |

---

## 五、和主线 B2 的文件冲突

B2（前端 A ＋ 后端：日程待办、提醒、Web Push、液态玻璃三页）和 B6-exe 同时开工。可能两边同时改的文件：

| 文件 | B2 会改什么 | B6-exe 会改什么 | 冲突程度 |
|---|---|---|---|
| `package.json`、`package-lock.json` | 可能加依赖 | 加 `@tauri-apps/api`、各插件 JS 包、`@tauri-apps/cli` | **高**（lock 文件） |
| `src/sw/sw.ts`、`src/sw/routes.ts`、`src/platform/sw-register.ts` | 推送、通知按键、待处理按键（B2 重点） | exe 里不注册 SW，要在注册处加一个判断 | **高** |
| 提醒和整页提醒（B2 新建的 `src/features/` 下提醒相关文件） | 新建 | exe 通知点开整页提醒要接上 | 中 |
| 426 横幅（B1 建的版本横幅，在 `src/core` / `src/app` 下） | 可能调整横幅排队 | “更新”按钮在 exe 里交给 Rust | 中 |
| `src/styles/tokens.json`、`src/styles/skins/*.css` | 液态玻璃令牌和三页副本（B2 3.25～4.75 人日） | 只有 F12 的皮肤变量会碰 | **高**（所以 F12 只做脚本） |
| `supabase/functions/*/index.ts`、`supabase/functions/_shared/` | 新建 devices / 推送函数，改免查名单 | **不改**（Q-A3：Edge Functions 不加 CORS） | 无 |
| `build/check_backend.py` | 后端可能加规则 | 加“函数里不得出现 `Access-Control-Allow-Origin`” | 低（一条规则，合并前对一下） |
| `vite.config.ts` | 一般不改 | 加 `quick-add` 入口；按环境构建 | 低 |
| `src/platform/session.ts`、`src/platform/device-info.ts`、`src/platform/http.ts` | 推送订阅可能读设备信息 | secureStorage 适配；`http.ts` 超额错误页按同步失败处理（F5 ⑤，B 改、A 审） | 中 |
| `.github/workflows/*.yml`、`tools/ci-tools.lock` | 一般不改（运维的） | 新建 desktop.yml，改 release-build.yml；签名工具锁进 `ci-tools.lock`；deploy-preview.yml **不改** | 低（都是运维） |
| `preview.html`（架构 5.13 的附件预览沙箱页，不是开发预览页）、`desktop/src-tauri/scripts/stage-web.mjs` 的 `SKIP` / `PAGES` | B4b-1 接附件预览 | 现在 `stage-web.mjs` 把 `preview.html` 放在 `SKIP` 里，不进安装包。**B4b-1 接进 exe 以后，要把它从 `SKIP` 挪进 `PAGES`，并单独给它定 CSP**（沙箱页，不能沿用 main 的那套；复核 N2，11-03 记） | 中（B4b-1 时由前端 B 改，过安全审查） |
| `src/platform/supabase/client.ts`、`src/platform/session.ts`（`readSessionId`、`readSessionUserId`、`clearLocalSessionIf`）、auth 小窗口的 supabase 客户端 | 前端 A 接入 exe 会话存储（安全审查 F5-2）：exe 里 main、auth 两个窗口都用 `createDesktopSessionStorage()`，先 `await preload(desktopSessionKeys())` 再建客户端；同步读改用 `sessionStorageView(本存储)`；`clearLocalSessionIf` 在 exe 里改成对两个白名单键调 `session_remove`、失败要让调用方知道；加一条测试断言 exe 里 supabase 客户端的 storage 不是 `authStorage()`；存储对象只放模块作用域，不挂到 `window` / `globalThis` | 已交付接口：`src/platform/desktop.ts` 的 `desktopSessionStorage`、`desktopSessionKeys`、`sessionStorageView`、`createDesktopSessionStorage`、`onAuthDone`（M1、S2、S3 已改）；不改前端 A 的这几个文件 | 中（**A8 验收（TC-B6X-09、15）前、并且 CI 第一次打 exe 前必须完成**，完成后安全审查员复核；没接上以前 exe 的会话仍落在 WebView2 的 localStorage，auth 小窗口和 main 共用同一份） |
| `functions/_lib/cors.ts`、`functions/sb/` | 一般不改 | 删 `x-upsert`、`cache-control`，抓包后补头 | 低 |
| `docs/06-测试/测试用例-v4.md`、`docs/10-架构/架构设计-v4.md`、接手清单 | B2 返工常改 | B6-exe 结论要写回（架构 0.48 由架构师改） | 中（文档） |

**约定**：

1. **exe 的代码只放自己的地盘**：`desktop/src-tauri/`、`src/platform/desktop.ts`、`src/desktop/`（quick-add 页面），以及 `tools/keys/gen-tauri-key.ps1`、desktop.yml。B6-exe 不改 `src/features/`、`src/kit/`、`src/sw/`、`supabase/functions/` 里的任何文件。
2. **依赖单独提交**：B6-exe 加 npm 依赖用一个只改 `package.json` 和 lock 的小分支 `b6x/deps`，先和主持人约好合并时间；碰到 lock 冲突，不手合，在合并后的 `package.json` 上重新 `npm install` 生成 lock，再跑一遍 unit。
3. **SW 判断由 B2 的作者加**：前端 A 在 B2 里给 `sw-register.ts` 加一句“在 exe 里不注册”（读 `platform/env.ts` 的运行环境），B6-exe 不碰 SW 文件。B2 签完前 exe 的开发版即使注册了 SW 也不影响开发。
4. **通知和更新按钮走 platform 接口**：前端 A 在 B2 里给“打开某条的整页提醒”和 B1 横幅的“更新”各留一个 `platform` 层函数（网页版实现由 A 写）；前端 B 只在 `src/platform/desktop.ts` 里写 exe 实现。函数名和签名开工第一天由 A、B 对好、写进各自 PR 说明。
5. ~~Edge Functions 的 CORS 一次接完~~：Q-A3 定为 Edge Functions 不加 CORS，本条删去。
6. **皮肤不碰**：F12 只做 `build/check_contrast.py` 和 `build/contrast-pairs.json`，`tokens.json`、`skins/*.css` 等 B2 签完再说。
7. **分支名** `b6x/<主题>`（8.3 分支模型）；推之前本机跑 unit 那一套；合并前都过代码审查员。
8. **文档**：架构、开发计划、测试用例、接手清单、负责人待办的改动由架构师和主持人统一合；B6-exe 的结论先写在本单和 `docs/03-评审/B6-exe/`。**不碰 `docs/09-路线图/B2-任务单.md`**。

---

## 六、要拍板的问题

### 1. 交负责人（主持人转达，一次问完；回答写进拍板记录和需求记录）

| # | 问题 | 选项 | 推荐 |
|---|---|---|---|
| Q-O1 | **告知并请同意**：5.10 已定 exe 登录要在 Turnstile 控制台的主机名列表里加 `tauri.localhost`（只加控制台，我们函数里的 hostname 白名单不加；注册仍走系统浏览器）。预览站点 10-28 已加。**等 TC-B0-65 出结论后**，主持人告诉负责人“要在正式 Turnstile 站点加 `tauri.localhost`，请本人在控制台加”（S5 第 2 步），只问“同意吗” | 同意／不同意 | **同意**。TC-B0-65 结论是“不能用”时，正式和预览一起走系统浏览器登录的退路（+2～3 人日），这一问自然作废 |
| Q-O2 | B6-exe 什么时候签字（有 4 条用例依赖 B2、B5、B4b-1） | a 外壳做完就签：先签部分**包含 S-B6 全部不依赖主线的 P0**（依赖主线的 4 条里没有 P0，只有 TC-B6X-30 是 P1）；4 条（TC-B6X-11、13、28、30）写成“随批补测”，分别进 B2、B5、B4b-1 的 ④；**4 条全部补完是 B7a 的进门条件**，任何一条没补完 B7a 不开工／ b 等 B4b-1 签完再一次签 | **a**（架构同意）：B7a 只要求 B6-exe 签完；b 会让副线挂好几周、私钥和预览通道的问题晚暴露 |
| Q-O3 | B6-exe 期间用来签预览包的 `publish.ps1` 还没冻结（冻结在 B7a） | a 每次签名前，`-Env preview -Desktop` 用到的文件先过代码审查和安全审查，照 8.3a 做一份“预览冻结副本”（记在 `docs/03-评审/B6-exe/` 下），本人核对哈希再跑；改了就重审；它不等于 B7a 的冻结，B7a 时整份重审／ b 直接运行仓库里的工作副本（只签预览包） | **a**（架构同意）：脚本经手的是私钥，预览私钥泄露也能给预览 exe 推恶意更新；多花的是审查时间，不占负责人时间 |
| Q-O4 | 本机编 exe 要装 Rust 和 VS Build Tools（要管理员权限） | a 负责人本人点 UAC 装在开发电脑上（约 30 分钟），Rust 版本用仓库的 `rust-toolchain.toml` 锁定；本机编的只用来开发调试，交给 QA 和负责人装的一律是 CI 产物（经 publish.ps1 签名的那份）／ b 本机不装，只在 CI 的 windows-latest 上编 | **a**（架构同意）：外壳调试要本机编；b 每改一次等 CI 十几分钟，3.5～4 人日会明显超 |
| Q-O5 | 下载 CI 产物的只读令牌出自哪个账号（原定 B7a 演练前定，**预览签名提前用到了**） | a 负责人本人账号的细粒度令牌（只管本仓库、只读 Actions；每次在自己的设备上临时生成、**1 天到期**、用完删，只在发布时粘贴）／ b 另建开发账号 | **a**（架构同意）：0.31 第 30 条定 B0～B6 不建开发账号；R-220 本来就要求临时生成。8.3a 第 2 步原写“90 天到期”，架构师在 0.48 改成 1 天 |
| Q-O6 | 4.0.0 的 exe 要不要买代码签名证书（Authenticode；和更新签名私钥是两回事） | a 不买，接受 SmartScreen“未知发布者”提示，官网下载页写怎么点“仍要运行”并公布 SHA-256（下载页文字归 B7b）／ b 买证书（每年要花钱，还要本人做身份验证；架构师另估人日） | **a**（架构同意，0.48 补进 5.10 和 12 风险表）：只给朋友用；自动更新下载的包不经浏览器，一般不受这个提示影响（B6-exe 实测记一笔） |
| Q-O7 | 预览签名私钥要不要也存 U 盘 | a 照开发计划：两把都存 Google 密码管理器 + U 盘，**开发电脑上不留**／ b 预览那把只存 Google 密码管理器（丢了可以重新生成，代价是已装的预览版 exe 重装一次） | **a**（架构同意，不改规则）。另：负责人待办 B6-exe 两行原写“存在你本机和你选的 U 盘”“存你本机”，由主持人改成“U 盘 + Google 密码管理器，开发电脑上不留”；S3 第 6 步已改成脚本不打印私钥、由本人从 U 盘文件复制 |
| Q-O8 | **新增**：预览版 exe 的更新地址放在预览 Pages 项目的 `desktop` 分支，会在我们的 Cloudflare 账号下多出一个公开地址 `desktop.<预览项目名>.pages.dev`（只放预览安装包和 `latest.json`，不改任何 Cloudflare 设置、不新建项目、不加子域、不改 DNS）。同意吗？ | 同意／不同意 | **同意**。不同意就只能改用单独的 Pages 项目或 R2，步骤更多。补充：第一次预览签名时如果分支别名用不了，退路是单独建一个只放 desktop 的 Pages 项目（用它自带的 `pages.dev` 地址，可不绑子域；新建项目由运维用同一把令牌建，届时再问一次同意；要绑子域的话那一步由本人在控制台做，约 10 分钟） |

**拍板结果（负责人 11-03；已写进架构 0.48 末尾拍板表，需求记录由主持人编号）**：

| # | 负责人定 |
|---|---|
| Q-O1 | 待 TC-B0-65 出结论后再问 |
| Q-O2 | a：外壳做完就签，4 条随批补测，补完才开 B7a |
| Q-O3 | a：先审、做预览冻结副本、本人核哈希再跑 |
| Q-O4 | a：本人点 UAC 在开发电脑上装 Rust 和 VS Build Tools |
| Q-O5 | a：本人账号的细粒度只读令牌，每次临时生成、1 天到期 |
| Q-O6 | a：不买 Authenticode |
| Q-O7 | **b：预览签名私钥只存 Google 密码管理器，不存 U 盘**；正式私钥不变（U 盘 + Google 密码管理器）。S3、S4、S7、F10、A15、R3、R4 已按此改 |
| Q-O8 | 同意 `desktop` 分支地址 |

### 2. 交架构师的四条：已定（架构审第二节）

| # | 问题 | 架构定 |
|---|---|---|
| Q-A1 | 预览 `/desktop/` 放哪，避免被 deploy-preview 冲掉 | **预览 Pages 项目的 `desktop` 分支部署**：`publish.ps1 -Env preview -Desktop` 只把签好的安装包和 `latest.json` 放进一个目录，`wrangler pages deploy <该目录> --project-name <预览项目> --branch desktop`，固定地址 `https://desktop.<预览项目名>.pages.dev/latest.json`；deploy-preview 照旧 `--branch main`，**deploy-preview.yml 不改**。比任务单原推荐的“单独小 Pages 项目加子域”少一步（不新建项目、不加子域、不改 DNS）。正式环境：`-Desktop` 只能和 `-Env preview` 用，正式 exe 只随完整发布部署，正式 Pages 的任何重新部署都带同一 tag 的 `desktop/`。退路：分支别名用不了时，单独一个只放 desktop 的 Pages 项目（运维约 +0.25，单列）。要负责人同意的见 Q-O8 |
| Q-A2 | 来源用 http 还是开 `useHttpsScheme` | **维持 `http://tauri.localhost`，不开 `useHttpsScheme`，以后不改**。`*.localhost` 在 WebView2 里算可信来源，http 下功能不缺；改来源等于换源，本机数据全部读不到。只有实测发现 http 下某项能力确实不可用才改，且只能在 4.0.0 发布前、同一 PR 改全 |
| Q-A3 | Edge Functions 要不要各自加 CORS | **只在转发层做，Edge Functions 不加**：exe 的 CSP 连不到 `supabase.co`，所有调用都经 `/sb/`；预检在 `/sb` 本地回 204 不转发，实际响应经 `applyCors` 先删上游 `Access-Control-*` 再重写，函数自己加的头到不了客户端。顺带 `check_backend.py` 加“函数里不得出现 `Access-Control-Allow-Origin`”（F5 ④） |
| Q-A4 | `save_attachment` 在 B4b-1 做时要不要重开 S-B6 | **不重开 B6-exe 签字，但也不只等 B7a**：B4b-1 的 ② 代码审查（exe 一节）和 ③ 安全审查核这个命令，B4b-1 安全签字文件单列一节“**S-B6 增量**”，按 S-B6 口径核 capability 差异（只有 main 多了 `save_attachment`，auth、quick-add 不变，`remote.urls` 仍不开）和 5.13 第 4 点；B7a 用重打的 exe 再做 S-B6 全量 |

另定（架构审第一节 3.6）：**注册按钮**——auth 窗口发不带载荷的 `auth:open-signup`，main 用 Rust 里写死的地址调 `open_external`（F6）。

---

## 七、六环签字记录清单（`docs/03-评审/B6-exe/`）

每一环的记录存成文件，只在聊天里说过的算没签（人员名单第三节）。

| 环 | 文件 | 谁签 | 内容 |
|---|---|---|---|
| 任务单 | `B6-exe-任务单-架构审.md` | 架构师 | **已有**（有条件通过，M1～M8 已按本单修订） |
| ① 开发 | `B6-exe-开发自测-前端B.md`、`B6-exe-开发自测-运维.md` | 作者 | “已完成、自测通过”；本机测试和 CI 全绿；TC-B0-65 结论和截图；`4.0.0-preview.1` NSIS 实打结果 |
| ② 代码审查 | `B6-exe-代码审查-签字.md` | 代码审查员本人 | 前端 / 后端 / 运维 / **exe** 四节；`gen-tauri-key.ps1`、`publish.ps1` 改动、desktop.yml、签名工具单列 |
| ②b 动效 | `B6-exe-动效确认-UI4.md` | UI-4 本人 | quick-add 瞬间出现不加动效；其余“本批不涉及” |
| ③ 安全 | `B6-exe-安全审查-S-B6签字.md` | 安全审查员本人 | S-B6（P0）逐项打勾（含双环境清单和反向搜索）、S-B6b（P1）；两个脚本；签名工具二进制；AI 没接触私钥明文；publish.ps1 五处“已改、待 B7a 冻结复审” |
| 预览冻结 | `B6-exe-预览冻结副本.md` | 运维记录，代码审查员、安全审查员会签 | `gen-tauri-key.ps1` 和 `-Env preview -Desktop` 用到的文件、每个文件的 SHA-256 和总哈希、审查日期；改了就重记（Q-O3） |
| ④ QA | `B6-exe-QA测试报告.md` | QA 本人 | TC-B6X-01～30 结果；预览更新通道用的地址；哪几条“随批补测”、补在哪一批 |
| ⑤ 负责人 | 不是真机批次，没有这一环 | — | — |
| 负责人步骤 | `B6-exe-负责人操作记录.md` | 主持人记录 | 第三节 S1～S8 每步“做完了”的时间；**只写成败，不写任何值** |
| 拍板 | `B6-exe-拍板记录.md` | 主持人记录 | 第六节 Q-O1～Q-O8 的回答和日期（需求记录同步编 R 号） |
| 补测 | `B6-exe-随批补测.md` | QA | TC-B6X-11（B2 后）、13 / 30（B5 后）、28（B4b-1 后）的结果；全部补完才开 B7a |

另：B4b-1 的安全签字文件里单列“S-B6 增量”一节（Q-A4），不放在本目录。

---

## 八、交给主持人

1. 第六节交负责人的八条（Q-O1～Q-O8）：**11-03 已答 Q-O2～Q-O8**，Q-O1 等 TC-B0-65 出结论后再问；回答写进拍板记录和需求记录。
2. 架构 0.48（含拍板表）、开发计划、负责人待办 B6-exe 两行：架构师 11-03 已改。
3. 运维写完 `gen-tauri-key.ps1` 和 `publish.ps1 -Env preview -Desktop`、过审并做好预览冻结副本后，主持人把第三节的【待补】填上再转给负责人。
4. 负责人做 S3、S4 时主持人在场提醒（接手清单 P2 ★），等负责人说“存好了”再往下。
5. QA 开工时改 TC-B6X-25 的过时写法、按 A14 补环境核对（第一节第 2 小节注）。

## 修改记录

| 日期 | 改了什么 | 谁 |
|---|---|---|
| 2026-11-03 | 第一稿 | 架构师助理 |
| 2026-11-03 | 按架构审（有条件通过）改：M1 / Q-A1 预览更新地址改为预览 Pages 项目 `desktop` 分支，改 F8、R2、运维行、S6 第 3 步，新增负责人问题 Q-O8；M2 `-Desktop` 只配 `-Env preview`、正式重新部署带 `desktop/`（F10）；M3 双环境整套配置和反向搜索（F8、A14、R11）；M4 只打 NSIS、版本号同步、首日实打（F1、F9、R12）；M5 预览 tag 由 desktop.yml 自出哈希（F9、S6）；M6 发布机签名工具（F10）；M7 Q-A2～Q-A4 和注册按钮定案，删 Edge Functions CORS 和第五节约定 5，F3 补 main 不能导航到 `auth.html`，F5 写清超额错误页由 B 改 A 审、426 改为核对、`x-upsert` / `cache-control` 现在就删；M8 Q-O1 改为“告知并请同意”、Q-O2 补 P0 和 B7a 进门条件、Q-O7 附待办改法和 S3 不打印私钥；建议项：UI-4 在 25% 里、`check_backend.py` 规则、私钥生成前脚本冻结、TC-B6X-18 记地址；状态改为“已按架构审修订，待负责人拍板” | 架构师助理 |
| 2026-11-03 | 记负责人拍板（Q-O2～Q-O8，Q-O1 待 TC-B0-65），状态改为“已拍板”；Q-O7 选 b：预览私钥只存 Google 密码管理器，改安全红线、F10（私钥只在内存或临时文件、存好后删除并核对，正式另写 U 盘）、A15、S3、S4、S7（从密码管理器粘贴）、R3、R4、第八节 | 架构师 |
| 2026-11-03 | TC-B0-65 实测通过、R1 关闭；R12 NSIS 已实打；新增 R13（`__TAURI_INTERNALS__` 必在）、R14（卸载保留 WebView2 数据）；Q-O1 写进明早清单第 63 条 | 主持人 |
| 2026-11-03 | 验收表加 A19～A21（架构 0.50 第 9、11 条：卸载删本机数据、卸载界面中韩提示、启动画面认减少动态效果开关），对应 TC-B6X-31～33；依据和 QA 一行的用例范围改成 TC-B6X-01～33（33 条，P0 12 条，自动 ★ 17 条） | QA |
