# B6-exe 代码审查：F9 流水线（desktop.yml、release-build.yml 追加的两个任务、deny.toml）

日期：2026-11-03　审查：代码审查员　被审：运维　版本：工作区 11-03（三个文件都还没 `git add`；release-build.yml 看 `git diff`）

被审文件：
- `.github/workflows/desktop.yml`（新文件，298 行）
- `.github/workflows/release-build.yml`（追加 `desktop`、`bundle` 两个任务和头注释 5 行）
- `desktop/src-tauri/deny.toml`（新文件）

参考：`build/ci/desktop_scan.mjs`、`desktop/src-tauri/scripts/ci-guard.mjs`（任务里写的 `build/ci/ci-guard.mjs` 不存在，工作流用的是这一份）、`desktop/src-tauri/scripts/stage-web.mjs`、`build/ci/dist_hash.py`、`tools/release/publish.ps1`、`osv-scanner.toml`。

规矩依据：`docs/09-路线图/B6-exe-任务单.md` F9、A14；`docs/10-架构/架构设计-v4.md` 8.3 表（release-build.yml、desktop.yml 两行）、0.48 第 7、9 条、0.53、15.4 S-B6。

## 结论

| 部分 | 结论 | 分数 |
|---|---|---|
| desktop.yml、release-build.yml 追加部分、deny.toml | **有条件签**：M1 改完、由本审查员复核后签 | 8 / 10 |

做得好的：两个工作流顶层都是 `permissions: {}`，每个任务只给 `contents: read`；不引用任何 secrets，调用处也没有 `secrets: inherit`；所有 Action 固定 SHA，和仓库其他工作流用的是同一组 SHA；`${{ }}` 一处都没有直接写进 `run:`，tag、环境、版本号都经 `env:` 传进 shell 并加了引号；`checkout` 都关了 `persist-credentials`；预览、正式两条触发互不重叠，正式 tag 只编一遍；bundle 的核对逻辑在本机模拟过，多文件、改内容都能拦住；deny.toml 本机实跑通过，5 条 cargo audit 警告逐条核实确实不在 Windows 依赖树里。

自报要点核对：

| # | 自报 | 核对结果 |
|---|---|---|
| 1 | 正式 tag 改由 release-build 以 workflow_call 调用，预览 tag 直接触发；被调用时 `github.ref_name` 仍是正式 tag | **属实**。desktop.yml 的 `on.push.tags` 只有 `v[0-9]+.[0-9]+.[0-9]+-preview.[0-9]+`，另有 `workflow_call: {}`；release-build 只认 `v[0-9]+.[0-9]+.[0-9]+`（GitHub 过滤模式里 `.` 不是通配符，整串匹配，预览 tag 不会命中）。被调用的工作流里 `github` 上下文是调用方的，`ref_name` 就是正式 tag；`vars` 同仓库可读。`deploy-preview.yml` 只认 `branches: [main]`，不会被 tag 触发，没有重复构建 |
| 2 | bundle：下载两份产物 → 按 desktop 的 SHA256SUMS `--strict -c` 核对、文件一个不多一个不少 → 整包 SHA256SUMS、`dist_hash.py` 总指纹（不含 SHA256SUMS）→ Summary → 上传 `release-bundle-<tag>` 90 天 | **属实**（`release-build.yml:119-181`）。草稿目录模拟：正常时“一致”，多一个文件报“文件对不上”，改一个字节 `sha256sum -c` 失败。整包 SHA256SUMS 先写到 `$RUNNER_TEMP`，算完指纹才挪回来，指纹确实不含它。另外核实：`find | LC_ALL=C sort` 和 `dist_hash.py` 按 UTF-8 字节排序一致，`dist_hash.py` 拼的文本格式和 SHA256SUMS 逐字相同，所以**总指纹 = `sha256sum SHA256SUMS`**（模拟结果两者都是 `65c8f7d2…0e32`），以后 publish.ps1 用哪一种算都行 |
| 3 | desktop 只给 `contents: read`；deny.toml 许可证名单、`unsound = "all"`、`targets = ["x86_64-pc-windows-msvc"]`、`ignore = []`、5 条警告写在注释里 11-30 复查 | **属实**。调用处 `permissions: contents: read` 就是被调用工作流 GITHUB_TOKEN 的上限，被调用方只能再收紧、不能放宽；desktop.yml 两个任务各自声明的也是 `contents: read`，和上限相等，不会因“申请超过上限”起不来。deny.toml 各项和自述一致；5 条警告本机 `cargo tree --target x86_64-pc-windows-msvc -i <包>` 全是 `nothing to print`，`-i webview2-com` 正常打印。许可证名单有一处小出入，见建议 S3 |
| 4 | 前端还没交 `@tauri-apps/cli`，tauri build 会失败，加了缺包报错 | **属实**（`desktop.yml:183-186`，`npx --no-install` 不会去下载）。后果要讲清：在前端补上之前，**每个正式 tag 的 release-build 都会是红的**（desktop 失败、bundle 不跑），但 build 任务的 `release-<tag>` 和“正式产物指纹”照常出，现行 publish.ps1 只看那一段，不受影响。见建议 S1 |
| 5 | desktop 另构建一份正式网页，没和 release-build 的 dist 逐字节比对 | **属实，而且这一项应在本批补上**，见 M1 |

## 必改

| # | 问题 | 位置 | 改法 |
|---|---|---|---|
| M1 | **装进 exe 的页面和上线的网页没有任何核对**。架构 8.3 desktop.yml 行写的是“`vite build --mode production`（和网页同一份产物）”；现在正式 tag 下同一次运行里编了两份网页：release-build 的 `build` 任务（跑过 typecheck、lint、单元测试、`check_size`，指纹写进 Summary、负责人在 iPhone 上核对的是它），和 desktop.yml 的 `web` 任务（不跑测试、不查体积，产物 `desktop-web-<tag>` 直接进安装包）。两边的命令和变量现在抄得一样，但没有任何机器检查保证一直一样：以后谁改了其中一边的环境变量、构建参数或步骤，exe 里的页面就和审过、核过指纹的网页不是同一份，整包总指纹也照样算得出来，发现不了。补上的成本很低：两份产物在同一次运行里，`desktop-web-<tag>` 保留 7 天，bundle 任务直接能下载 | `release-build.yml:119-153`（bundle）；`desktop.yml:83-95`、`:125-131` | 首选（改动最小）：bundle 再下载一份 `desktop-web-${{ github.ref_name }}` 到 `$RUNNER_TEMP/desktop-web/`，用 `python3 -I build/ci/dist_hash.py` 分别算它和 `bundle/web/` 的总指纹，不相等就 `::error::` 失败（对不上时加 `--list` 输出两份清单，方便看是哪个文件）。这样比的是暂存前的 `dist/web`，stage-web 注入的 meta CSP 不影响比对。如果实测发现 Vite 两次构建不是逐字节一致（同一提交、同一锁文件、同一 runner 镜像下不应如此），就改成第二种：desktop.yml 加一个 `workflow_call` 输入（如 `web_artifact`），被调用时 `web` 任务跳过构建、改为下载 release-build 的 `release-<tag>`（调用处加 `needs: build`），真正做到“同一份产物”。无论哪种，都在 desktop.yml 头注释和 release-build 头注释里写一句 |

## 建议

- **S1 缺 Tauri CLI 的检查太晚**（`desktop.yml:179-186`）。它排在“安装 cargo-audit、cargo-deny”（Windows 上从源码编，约 5～10 分钟）之后，每个正式 tag 都要白等这一段才报错。建议把 `npm ci` 和这个检查挪到 Rust 工具链之前。另外前端交 `@tauri-apps/cli` 之前打的正式 tag，release-build 一定是红的；建议在环境清单或发布说明里写一句“4.0.0 正式 tag 前 `@tauri-apps/cli` 必须已入库”，免得负责人看到红色误以为网页产物也坏了。
- **S2 一张 Summary 上会有四段指纹**（正式 tag 时：build 的“正式产物指纹”、desktop 的 exe SHA256SUMS 和总指纹、bundle 的整包总指纹）。现行 publish.ps1（第 966 行）只叫负责人“核对文件数和总指纹”，没说核哪一段。对错段只会对不上、发布停下（不会放错东西过去），但会让负责人困惑。建议 bundle 的标题注明“F10/F11 改完前 publish.ps1 不核这一段，现在请核上面的‘正式产物指纹’”，等 publish.ps1 改成下载整包后再去掉，同时把 publish.ps1 的提示改成点名段落标题。
- **S3 deny.toml 许可证名单和注释不完全对得上**（`deny.toml:42-57`）。注释说“只放现在依赖树里出现的这几种”，本机按 Windows 目标实跑，`Apache-2.0 WITH LLVM-exception`、`BSD-2-Clause`、`ISC` 三项报 `license-not-encountered`（只是警告，不失败）。建议请主持人定：要么从名单里删掉这三项（以后真出现了再按“先问主持人”加），要么把注释改成“含 Linux 目标或常见间接依赖的几种，Windows 目标下未出现”。
- **S4 cargo audit 不分目标平台，和 deny.toml 的口径不一样**（`desktop.yml:207-209`）。现在 5 条都是警告、退出码 0，没事；但以后 Linux 才用的 GTK / D-Bus 链上出一条真正的漏洞（vulnerability），`cargo audit` 会失败，而按“漏洞不豁免”的规矩又没法加 ignore，正式发布就卡在一条和 Windows exe 无关的漏洞上。建议现在就定下处理办法：给 cargo audit 加 `--target-os windows --target-arch x86_64`，和 deny.toml 的 `[graph] targets` 对齐；或者保留现状，在注释里写明“遇到这种情况由安全审查员按 cargo tree 结果会签后再处理”。
- **S5 以后加 concurrency 要小心**。被调用时 desktop.yml 里的 `github.workflow` 是调用方的 `release-build`，`github.ref` 也相同。如果以后给 desktop.yml 加工作流级 `concurrency: ${{ github.workflow }}-${{ github.ref }}`，又给 release-build 加同名的，调用方和被调用方会互相排队或取消。现在两个文件都没有 concurrency，没问题；建议在 desktop.yml 头注释里写一句“不要加工作流级 concurrency；要加就只加在任务级，组名带固定前缀 `desktop-`”。
- **S6 被调用时没有显式锁定环境**。`web` 任务的 tag 判断在两种触发下是同一段代码，正式 tag 只会得到 `production`，现在是对的；但被调用时它其实也接受预览 tag（只是 release-build 永远不会带预览 tag 来调）。真出现时 bundle 会因为找不到 `desktop-production-<tag>` 而失败，是安全的一侧。想更明确可以加一个 `workflow_call` 输入 `expect_env: production`，`which` 步骤算出来的环境和它不一致就失败。
- **S7 runner 镜像**：ubuntu 任务锁在 `ubuntu-24.04`，Windows 任务用 `windows-latest`（任务单原文如此）。镜像升级时 MSVC、Windows SDK 会跟着变，重编出的 exe 可能不同。建议锁成具体版本（如 `windows-2025`），和 ubuntu 的写法一致；升级时作为一次显式改动。
- **S8 小处**：① release-build 头注释第 6～7 行“现状（B0）：本文件还只上传 dist/web”已经过时，建议并进下面 F9 那段；② cargo-audit、cargo-deny 每次从源码编，可以考虑以后改成锁哈希的预编译二进制（`tools/ci-tools.lock`），省时间也少跑一次第三方 `build.rs`，不急；③ 架构 8.3 表里 release-build、desktop.yml 两行没写“正式 tag 走 workflow_call”，请架构师补一句。

## 逐项核对通过

- **权限**：两个文件顶层 `permissions: {}`；release-build 的 `build`、`bundle`、`desktop`（调用处）和 desktop.yml 的 `web`、`desktop` 都只有 `contents: read`。调用处的 `permissions` 是被调用工作流 GITHUB_TOKEN 的上限；被调用方各任务申请的等于上限，不会失败也没有放宽。同一次运行里的产物下载走运行时令牌，不需要 `actions: read`。
- **secrets**：三个文件里没有 `secrets.`，调用处没有 `secrets:` / `secrets: inherit`；desktop.yml 只用 `vars.PROD_*`、`vars.PREVIEW_*`（公开值）。CI 里没有签名私钥、updater 私钥。
- **shell 注入**：`run:` 里没有任何 `${{ }}`；`TAG`、`LEMO_ENV`、`LEMO_VERSION` 都经 `env:` 传入并加引号；tag 字符集被触发模式限定成数字、点、`v`、`-preview.`。`node -e` 的版本号、URL 走 `process.argv`，不拼进脚本文本。
- **产物名**：`desktop-web-<tag>`（web → desktop）、`desktop-<env>-<tag>`（正式即 `desktop-production-<tag>`，和 bundle 下载的名字一致）、`release-<tag>`、`release-bundle-<tag>`，同一次运行里四个名字互不重复。
- **tag 判断**：release-build 的 build 任务和 desktop.yml 的 web 任务都要求 `TAG == "v$(VERSION)"`，两种触发下一致；预览 tag 还要求 `-preview.` 后面全是数字。
- **并发和重复构建**：正式 tag 只经 release-build 编一次 exe；预览 tag 只触发 desktop.yml；没有 concurrency 冲突（见 S5）。
- **desktop.yml 其余步骤**：编译前 `ci-guard.mjs workflows`（本机跑：5 个工作流文件都没有 `--skip-env-check`）、编译后 `ci-guard.mjs permissions` 只看 `desktop/src-tauri/permissions`，前面改 `tauri.conf.json` 的版本号不影响它；`tauri.conf.json` 的 `build` 只有 `frontendDist`，没有 `beforeBuildCommand`，tauri build 不会重编页面覆盖暂存的那份；`bundle.targets` 只许 `["nsis"]`、预览配置里不许另写 `version`；exe 路径和 `mainBinaryName`（`lemomemo` / `lemomemo-preview`）一致；只许正好 1 个 `*-setup.exe`，有 MSI、`.sig`、`.zip` 就失败；`latest.json` 的 `signature` 留空、`pub_date` 用提交时间；`cargo test` 两套 feature、`--include-ignored`；`tauri build -- --locked`。
- **deny.toml**：`[graph] targets` 只有 Windows MSVC、`all-features = true`；`unmaintained = "workspace"`、`unsound = "all"`、`yanked = "deny"`、`ignore = []`；漏洞在 cargo-deny 0.18 起恒为失败，没有豁免口子；只许 crates.io，`unknown-git = "deny"`；`[licenses.private] ignore = true` 对应 `Cargo.toml` 的 `publish = false`。注释里的 5 条和 `osv-scanner.toml` 的 glib 三条复查日期都是 2026-11-30。
- **release-build 原有部分**：`git diff` 只有头注释追加 5 行（第 8～12 行）和文件末尾追加 `desktop`、`bundle` 两个任务；`build` 任务和“产物指纹”一段一个字没动，属实。

## 跑过的测试

草稿目录：`C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\cr-desktop-wf\`

| 跑了什么 | 结果 |
|---|---|
| `actionlint 1.7.12`（带 shellcheck）`.github/workflows/desktop.yml .github/workflows/release-build.yml`，再对全部工作流跑一遍 | 0 个问题，退出码 0（含 `uses: ./.github/workflows/desktop.yml` 的调用检查） |
| `cargo deny 0.20.2 --locked check advisories bans licenses sources`（`desktop/src-tauri`） | `advisories ok, bans ok, licenses ok, sources ok`；3 条 `license-not-encountered` 警告（S3） |
| `cargo audit`（同目录） | 退出码 0，`5 allowed warnings`，正是注释里那 5 条 |
| `cargo tree --locked --offline --all-features --target x86_64-pc-windows-msvc -i <包>`：proc-macro-error、zvariant、zbus_names、zvariant_derive、glib；对照 webview2-com | 前 5 个 `nothing to print`；webview2-com 正常打印 `tauri v2.12.5` 链 |
| `node desktop/src-tauri/scripts/ci-guard.mjs workflows` | 通过（workflows 5 个、actions 0 个） |
| `node --test desktop/src-tauri/scripts/stage-web.test.mjs` | 16 / 16 通过 |
| `npx vitest run tests/build/desktop-scan.test.ts tests/build/db-types-ci.test.ts tests/build/deno-frozen-lock.test.ts tests/build/e2e-watchdog.test.ts` | 4 个文件 46 条全过 |
| 草稿模拟 bundle 两步 shell（`sim/`）：正常、多一个文件、改一个字节；再算整包 SHA256SUMS 和 `dist_hash.py` 总指纹 | 依次“一致 / 文件对不上 / 校验失败”；总指纹和 `sha256sum SHA256SUMS` 相同 |

没有推送、没有触发任何工作流、没有连真实服务；cargo deny 只联网取了 RustSec 公告库。

## 采纳情况（主持人，11-03）

- M1：和安全审查 W-2 合并，采用复用方案：desktop.yml 加 workflow_call 输入，正式路径直接使用 `release-<tag>`，不再自己构建网页（即本审查的退路方案，安全审查首选），改完由本审查员复核。
- S3：许可证名单是主持人定的，保留 3 项暂未出现的许可证，**改注释**，写明“名单是允许范围，不要求每项都已出现；license-not-encountered 警告可以接受”。
- S1、S2、S4、S6、S7、S8：交运维本批一起改。
- S5：在 desktop.yml 写注释说明，现在不加工作流级 concurrency。
- 等安全审查的结论回来后，和这些意见合在一起交给运维，避免审查期间文件变动。
- 任务说明里写错了 ci-guard.mjs 的路径（实际在 `desktop/src-tauri/scripts/`），这是主持人的笔误，已知悉。

## 复核（11-03）

复核人：代码审查员（和上一轮同一人，同一尺度）。复核范围：`.github/workflows/desktop.yml`（重写，含后补的 `--latest` 一步）、`release-build.yml`、`unit.yml`、`desktop/src-tauri/deny.toml`（只改了注释）、`osv-scanner.toml`（新加三条）、`tools/release/publish.ps1` 第 967 行、`docs/08-发布/环境清单-v4.md` 第 211 行、新文件 `tests/build/workflow-permissions.test.ts`、`build/ci/desktop_scan.mjs` 的 `checkLatest` 和 `tests/build/desktop-scan.test.ts` 新加的 2 条测试，以及架构 0.54 第 3 条和 8.3 表的两行。

### 结论

**签，9 / 10**（上一轮有条件签 8 / 10）。M1 已按复用方案解决，S1～S8 全部落实或按主持人的决定处理，这次没有新的必改。扣的 1 分在下面“遗留”两条：架构 8.3 表 desktop.yml 行的旧文字没有划掉；隐藏文件会让三方比对误报失败（失败只会停下，不会放错东西过去）。

### 逐条核对上一轮意见

| # | 上一轮意见 | 现在 | 结论 |
|---|---|---|---|
| M1 | exe 里的页面和上线网页没有核对 | 正式 tag：release-build 的 `desktop` 任务写了 `needs: build`，传 `web_artifact: release-<tag>`、`expect_env: production`；desktop.yml 的 web 任务在被调用时不构建页面，并核对 `web_artifact == "release-$TAG"`；desktop 任务直接下载 `release-<tag>` 装进 exe。另外加了三方比对：build 任务算的、desktop 装进 exe 前算的、bundle 下载后算的页面总指纹必须相同（`release-build.yml:188-193`）。本机在 Git Bash 下验证了 `sed` 能从 `dist_hash.py` 的 UTF-8 输出里取出 64 位指纹，`LC_ALL=C` 下也取得到 | **已解决**，而且比首选方案更彻底：exe 里装的就是同一份产物 |
| S1 | 缺 Tauri CLI 的检查太晚 | 挪到了 desktop 任务的第一步（`desktop.yml:256-263`）；cargo-audit、cargo-deny 也搬去了单独的 audit 任务；两个文件头注释都写了“4.0.0 正式 tag 前必须已有 `@tauri-apps/cli`” | 已解决 |
| S2 | 一页 Summary 上有四段指纹，不知道核哪段 | build 段标题写明“负责人现在核这一段”；bundle 分 ①②③ 三段，每段写明什么时候核、现在核不核；desktop 段按环境写不同的标题；publish.ps1 第 967 行改成点名“正式产物指纹”那一段 | 已解决 |
| S3 | 许可证名单和注释对不上 | 按主持人的决定只改了注释（`deny.toml:41-42`），名单不变；本机跑仍是 3 条 `license-not-encountered` 警告，和新注释一致 | 已按决定处理 |
| S4 | cargo audit 不分平台 | 改成 `cargo audit --target-os windows --target-arch x86_64`；注释如实写了这两个参数只按公告自己标注的平台过滤、不按依赖树过滤，Linux 链上将来出漏洞时还会失败，那时请安全审查员会签再处理。本机实跑：退出码 0，5 条警告照样列出 | 已解决（口径写清楚了，我能接受） |
| S5 | 以后加 concurrency 会冲突 | 两个文件头注释都写了，现在都没有 concurrency | 已解决 |
| S6 | 被调用时没有锁定环境 | 被调用时 `expect_env` 必须是 production，tag 算出来的也必须是 production；直接触发时只接受预览（`desktop.yml:106-124`），两种触发互不串 | 已解决 |
| S7 | `windows-latest` | 改成 `windows-2025` | 已解决 |
| S8 | 头注释过时、预编译工具、架构没写 workflow_call | ① release-build 头注释重写；② 继续 `cargo install --locked` 从源码编，但只在 audit 任务里编，不和出安装包的任务共用机器（W-4），对 8.3 第 ⑤ 条的偏离写进了头注释和环境清单；③ 架构 0.54 第 3 条和 8.3 表的两行已补 | 已解决；③ 有一处小尾巴，见遗留 1 |

### 这次新加的部分

- **权限和机密**：desktop.yml 三个任务（web、audit、desktop）、release-build 三个任务都只有 `contents: read`，顶层都是 `{}`；没有 `secrets.`、没有 `secrets: inherit`。workflow_call 的输入只是 `web_artifact`、`expect_env` 两个字符串，经 `env:` 进 shell，没有直接写进 `run:`；输出是指纹和文件名，bundle 用之前都按 64 位十六进制和 `^lemomemo_X.Y.Z_x64-setup\.exe$` 校验过格式。
- **tag 必须在 main 上**（安全审查 S-2）：build 任务和 desktop.yml 的 web 任务都用 `fetch-depth: 0` 检出，再跑 `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`。写法正确，checkout 全量拉取时有 `origin/main`。
- **bundle 交叉比对**：exe 产物必须恰好是安装包、`latest.json`、`SHA256SUMS` 三个文件，SHA-256 和 desktop 任务的输出相同，产物自带的 SHA256SUMS 再 `--strict -c` 一遍。不只信产物自己带的清单，这一点对。
- **`latest.json` 主机比对**（S-3，后补的 `desktop.yml:375-376`）：位置在“整理产物”之后、“写 Summary”之前，没有这一步 CI 不会跑这个比对，这次补上是必要的。`checkLatest` 按 `URL` 解析后比 origin，用户名伪装（`…pages.dev@evil.example`）、换目录、带查询串、跨环境、多出平台都能拦住。本机命令行实跑：正式草稿配 `--env production` 通过，配 `--env preview` 报主机不对、版本不对，退出码 1。这一步还顺带兜住了另一种情况：仓库变量 `PREVIEW_PAGES_PROJECT` 和 `env.rs` 里写死的 `lemomemo-preview` 不一致时，预览包在这里就会失败。
- **audit 任务放在 ubuntu 上**：`deny.toml` 的 `[graph] targets` 指定了 Windows，`cargo metadata` 不需要装 Windows 目标，放在 ubuntu 上是对的。
- **`workflow-permissions.test.ts`**：逐行查顶层 `{}`、每个任务只有 `contents: read`、`permissions` 出现的次数、没有 secrets / id-token / write / environment / 危险的触发方式、action 都钉了 SHA；另外核对 release-build 调用时传的两个值、desktop.yml 只有两种触发。合成反例 10 条都能拦住。`top[0]?.`、`block[0]?.` 已经改好，`tsc -p tsconfig.node.json` 没有报错。
- **unit.yml**：平时的提交也跑 `stage-web.test.mjs`（W-1），desktop 任务编 exe 之前再跑一遍。
- **osv-scanner.toml**：新加 zbus 一系三条，理由里的引入路径和我上一轮 `cargo tree` 的结果一致；“会签：待安全审查员”这一栏不归我签。
- **publish.ps1**：本次只审第 967 行的提示文字，改得对。这个文件同时还有 `Assert-NoPushStub`（B2 D1-S3）的改动，不在这次的范围里，我没审。

### 遗留（不卡签字）

1. **架构 8.3 表 desktop.yml 那一行的旧文字没有划掉**（`架构设计-v4.md` 第 4298 行）。0.54 那段是追加在后面的，前面还写着“① 构建页面 `vite build --mode production`；② 编译（windows-latest）：`cargo audit` / `cargo deny check` → …”，和现在的实现（正式版不另外构建页面、审计在 ubuntu 的 audit 任务、windows-2025）互相矛盾。请架构师把旧写法用删除线划掉，或者改成“见 0.54”。
2. **隐藏文件会让三方比对误报失败**。build 任务的指纹是对本地的 `dist/web` 算的，`upload-artifact` 默认不上传以点开头的文件；以后 `dist/web` 里一旦出现 `.well-known/` 之类的目录，bundle 的三方比对就会对不上而失败。失败只会停下，不会把错的东西放过去，而且现在 `public/` 里没有隐藏文件。建议到时候在 build 任务里检查“`dist/web` 下不许有以点开头的文件”，或者在上传那一步写上 `include-hidden-files`，并注明原因。
3. **小处**：`checkLatest` 只检查文件名形如 `*-setup.exe`，没有检查它和这次的版本号是否一致。现在 bundle 用 `exe_name` 的正则兜住了正式版；预览版没有 bundle，可以考虑让 `--latest` 再收一个期望的文件名。不急。

### 复核时跑的测试

草稿目录：`C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\cr-desktop-wf\`

| 跑了什么 | 结果 |
|---|---|
| `actionlint`（全部工作流，含 shellcheck；在 `--latest` 那一步加上之后又跑了一遍） | 0 个问题，两次退出码都是 0 |
| `node desktop/src-tauri/scripts/ci-guard.mjs workflows` | 通过（workflows 5 个） |
| `node --test desktop/src-tauri/scripts/stage-web.test.mjs` | 16 / 16 通过 |
| `npx vitest run tests/build/workflow-permissions.test.ts tests/build/desktop-scan.test.ts tests/build/deno-frozen-lock.test.ts tests/build/db-types-ci.test.ts` | 4 个文件 41 条全过；补测试之后又单跑了 workflow-permissions、desktop-scan 两个文件，2 个文件 23 条全过 |
| `npx tsc -p tsconfig.node.json --noEmit` | 没有报错 |
| `cargo audit --target-os windows --target-arch x86_64`（`desktop/src-tauri`） | 退出码 0，`5 allowed warnings` |
| `cargo deny --locked check advisories bans licenses sources` | `advisories ok, bans ok, licenses ok, sources ok`，3 条 `license-not-encountered` 警告（主持人已接受） |
| `node build/ci/desktop_scan.mjs --env production\|preview --latest <草稿>`（`latest/ok.json`） | 正式环境通过；配预览环境时报主机和版本不对，退出码 1 |
| 在 Git Bash 和 `LC_ALL=C` 下用 `sed` 从 `dist_hash.py` 的输出取总指纹 | 都能取到 64 位指纹 |

没有推送、没有触发任何工作流、没有连真实服务，cargo audit 和 cargo deny 只联网取了 RustSec 公告库。

### 复核后的采纳情况（主持人，11-03）

- 遗留 1：已改。架构 8.3 表 release-build.yml、desktop.yml 两行的开头注明“旧写法已被本格末尾的 0.54 一段取代”。
- 遗留 2（upload-artifact 默认不上传以点开头的文件）、遗留 3（预览 latest.json 没核对安装包文件名和版本号是否一致）：交运维，F10 做完以后一起改。
- publish.ps1 的 Assert-NoPushStub 属于 B2 运维 O-1，已在 B2-代码审查-运维O1至O3.md 审过、签了 9 分，和本记录无关。
- osv-scanner.toml 的三条豁免等安全审查会签。
