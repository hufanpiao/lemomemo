# B6-exe 安全审查 · desktop.yml 与 release-build.yml（F9 流水线，只读审）

- 审查人：安全审查员
- 日期：2026-11-03
- 对象（运维交付，还没 git add）：
  - `.github/workflows/desktop.yml`（新）
  - `.github/workflows/release-build.yml`（追加 `desktop`、`bundle` 两个任务）
  - `desktop/src-tauri/deny.toml`（新）
- 参考：本目录《B6-exe-安全审查-外壳》（X-1～X-6、X-S1～X-S9，第九节复核）、`desktop/src-tauri/scripts/ci-guard.mjs`、`build/ci/desktop_scan.mjs`、`osv-scanner.toml`、`tools/release/publish.ps1`、`docs/08-发布/环境清单-v4.md`、架构 8.3 / 8.3a。
- 做法：只读；没有推送、没有触发工作流、没有连任何线上服务、没有读任何密钥值。本机跑过的命令和结果见第五节，草稿在 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\sec-desktop-wf\`。

---

## 结论：有条件签

**W-1～W-4 改完、由我复核以后**，才能用这两个工作流打**要签名、要发出去**的 exe（预览和正式都算）。只为试跑、产物不签名不分发的预览 tag，可以在改完 W-1 以后先跑。

做得对的地方：
- 两个文件顶层都是 `permissions: {}`，每个任务只给 `contents: read`；没有 `id-token`、`contents: write`、`actions: read`、`packages`、`attestations`。改成同一次运行里 `workflow_call` 以后，确实不需要 `actions: read` 去取别的运行的产物。
- 两个工作流**不引用任何 `secrets`**，也没有 `secrets: inherit`；签名私钥、updater 私钥都不在 GitHub（R-206、R-220），`tauri.conf.json` 里 `createUpdaterArtifacts: false`，整理产物那一步还会拦 `.sig`、`.zip`、MSI。
- 所有第三方 action 都钉了 40 位 SHA，和仓库里其他工作流用的是同一组（checkout v7.0.1、setup-node v7.1.0、upload-artifact v7.0.2、download-artifact v8.0.2）；`persist-credentials: false`。
- `github.ref_name`、任务输出、`vars.*` 进 `run:` 一律先放进 `env:` 再用 `"$TAG"`，没有 `${{ }}` 直接拼进脚本的地方；tag 校验（和 `VERSION` 比对，预览段必须是纯数字）在 web 任务里最先做，desktop 任务 `needs: web`，bundle `needs: [build, desktop]`，**tag 名在校验之前没有进任何 shell**。触发过滤本身也只放数字和点。
- `npm ci --ignore-scripts`、`cargo test/build --locked`、`cargo deny --locked`、`cargo install --locked` 加精确版本、Rust 工具链锁 `1.99.1`。
- X-3、X-4、X-S8 的检查都接上了，而且位置对（`ci-guard.mjs workflows` 在暂存页面之前，`ci-guard.mjs permissions` 在 `tauri build` 之后），本机跑通过（第五节）。
- F8 反向搜索（`desktop_scan.mjs`）在上传之前跑，失败就不出产物。
- `deny.toml` 满足 11-03 定的三个条件（逐项见第四节），本机按 Windows 目标复跑结果和运维说的一致。

---

## 一、必改

| 编号 | 问题 | 怎么改 | 什么时候前 |
|---|---|---|---|
| **W-1** | **`stage-web.test.mjs` 没有进任何流水线**。外壳审查第九节 X-3 的条件写的是 desktop.yml 落地时“编译前跑 `ci-guard.mjs workflows`，编译后跑 `ci-guard.mjs permissions`，**并跑 `node --test desktop/src-tauri/scripts/stage-web.test.mjs`**”。前两条接上了，第三条没有：`vitest.config.ts` 的 include 不含 `desktop/**`，`.github/` 下也没有任何地方跑它（已 grep）。这组测试钉住的是 CSP 注入、页面名单、`--skip-env-check` 在 CI 里拒绝、`ci-guard` 的扫描函数——也就是 X-1、X-4、X-S8 的回归保护，不跑就等于没有 | 在 desktop 任务里“暂存页面”之前加一步 `node --test desktop/src-tauri/scripts/stage-web.test.mjs`（必须直接点名这个文件，见该文件第 1～2 行的说明）；另在 `unit.yml` 里也跑一次，让平时的 PR 就能发现回归 | 任何 tag 跑之前 |
| **W-2** | **正式版 exe 里的页面不是 release-build 发布的那一份**。desktop.yml 的 web 任务在被调用时自己再 `npm run build -- --mode production` 一次，产物 `desktop-web-<tag>` 和 release-build `build` 任务的 `release-<tag>` 没有任何比对。架构 8.3 desktop.yml 一行写的是“`vite build --mode production`（**和网页同一份产物**）”。安全上的后果：① 负责人在 iPhone 上核的是 `release-<tag>` 的总指纹，**exe 里装的页面不在这次核对范围里**；② exe 里的页面没有经过 build 任务那一串门槛（`check_size`，以及同一份产物上的 typecheck / lint / 测试之后的构建）；③ Vite 产物里只要有一点不可重现（构建时间、插件顺序），两份就会悄悄不同，出了问题没法说清用户手里的是哪一份。预览版是自己建一份，问题小，不卡 | 正式路径用同一份产物：给 desktop.yml 加 `workflow_call` 输入（例如 `web_artifact`），release-build 的 `desktop` 任务加 `needs: build` 并传 `release-${{ github.ref_name }}`；desktop.yml 收到这个输入时跳过自己的页面构建，desktop 任务直接下载这一份。退一步的做法：仍各建各的，但 desktop 的 web 任务把 `dist_hash.py` 的总指纹作为输出交出来，bundle 里和 build 任务的总指纹比，不一样就失败。两种都要求：exe 里暂存的页面和网页产物逐字节同一份 | 第一次打正式 tag 前 |
| **W-3** | **bundle 的“核对”是自己核自己，换一份对得上的产物就绕过去了**。`bundle/desktop` 里的 `SHA256SUMS` 和 exe 是同一个产物包里带来的，`sha256sum -c` 只能发现传输损坏、多文件、少文件；如果整个包（exe 和它的 `SHA256SUMS` 一起）是另一份，检查照样通过。网页那一份 `release-<tag>` 在 bundle 里**完全没有核对**，Summary 也只给整包一个总指纹，负责人没法分别核网页和 exe。现在的信任边界是“同一次运行、产物不可改写（upload-artifact v4 起同名产物不能覆盖）”，所以实际风险不高；但这一步写的是“核对”，负责人会依赖它，必须让它名副其实 | 走一条不经过产物存储的通道把指纹带过来：desktop.yml 的 desktop 任务把安装包和 `latest.json` 的 SHA-256（以及 W-2 后页面的总指纹）设成任务输出，再通过 `on.workflow_call.outputs` 交给 release-build；build 任务把网页总指纹设成任务输出；bundle 把下载下来的文件逐个和这些输出比，不一致就失败。Summary 里分三行写：网页总指纹、exe 安装包 SHA-256、整包总指纹 | 第一次打正式 tag 前 |
| **W-4** | **cargo-audit、cargo-deny 在出安装包的那个任务里从源码编译**。`cargo install --locked cargo-audit/cargo-deny` 会在 desktop 任务里编译并执行这两个工具整棵依赖树的 `build.rs` 和过程宏（几百个 crate），它们对工作区、`~/.cargo`（可以写 `config.toml` 加 `rustc-wrapper`）、`target/` 都有写权限，而后面的 `tauri build` 正是在这个任务里出负责人要签名的 exe。负责人本机只核 `SHA256SUMS`，核不出“编译过程被动过”。这两个工具只是检查器，没有理由和发布产物共用一个任务；另外，架构 8.3 第 ⑤ 条要求 CI 的命令行工具按 `tools/ci-tools.lock` 锁版本和 SHA-256，这里是第二种做法，没写明偏离 | 把 `cargo audit`、`cargo deny` 拆成单独的任务（例如 `audit`，ubuntu 或 windows 都行，`deny.toml` 已按 Windows 目标过滤；不上传任何产物、只给 `contents: read`），desktop 任务 `needs: [web, audit]`。工具的装法二选一：仍用 `cargo install --locked` 加精确版本（只在 audit 任务里，可以接受），或者用官方发布的预编译包写进 `tools/ci-tools.lock`、走 `build/ci/install-tool.sh`。哪种都要在环境清单第七节写一句 | 任何要签名的 tag 跑之前 |

---

## 二、建议（不卡）

- **S-1**：`runs-on: windows-latest` 改成具体版本（例如 `windows-2025`），和 ubuntu 那边一样钉住，免得镜像换代时编译环境悄悄变了。
- **S-2**：tag 指向的提交必须在 `main` 上：预览、正式两条路都加一步 `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`（需要 `fetch-depth: 0` 或单独 fetch main）。现在任何有推送权限的人都能在一个没合并、没审过的提交上打 tag，CI 照样出包；预览 tag 这条路还不跑 typecheck、lint、单测。
- **S-3**：`PREVIEW_PAGES_PROJECT` 在拼 `latest.json` 的地址之前按 `^[a-z0-9][a-z0-9-]{0,57}$` 校验；`latest.json` 的 `url` 前缀再和 `env.rs` 里本环境的 `update_url` 所在主机比一次（`desktop_scan.mjs` 已经会读 `update_url`）。publish.ps1 `-Desktop` 落地时，签名前也要核一次 `url` 的主机。
- **S-4**：`deny.toml` 许可证名单的注释写“只放现在依赖树里出现的这几种”，但按 Windows 目标本机跑，`Apache-2.0 WITH LLVM-exception`、`BSD-2-Clause`、`ISC` 三项报 `license-not-encountered`。要么删掉，要么注释改成“含非 Windows 目标里出现的”。
- **S-5**：`osv-scanner.toml` 里 glib、proc-macro-error 三条豁免的理由写着“由 B6-exe F9 的 cargo audit / cargo deny 接管，这三条随之删掉”。**现在不能删**：OSV 扫 `Cargo.lock` 不分目标平台，删了 unit.yml 的 OSV 一步会失败。照旧留到 11-30 复查，复查时把这句改成“OSV 不分平台，只要 Linux 依赖链还在，这三条就要留着”。
- **S-6**：`deny.toml` 里 `unmaintained = "workspace"`，Windows 依赖树里“没人维护”的间接依赖不会让 CI 失败（`cargo audit` 只打印不失败）。可以接受；11-30 复查时用 `unmaintained = "all"` 本机跑一次，把结果记下来。
- **S-7**：`cache: npm` 在 tag 运行里会恢复 main 写下的缓存。npm ci 按 `package-lock.json` 的 integrity 校验，缓存被投毒也装不进去，所以不卡；想把这个面完全去掉，可以在 release-build 的 build 任务和 desktop.yml 里不开缓存（多一两分钟）。
- **S-8**：给工作流加一条静态守护（扩 `ci-guard.mjs workflows`，或在 `tests/build/` 加一个测试）：desktop.yml、release-build.yml 顶层必须是 `permissions: {}`、不得出现 `secrets.`、`secrets: inherit`、`id-token`、`contents: write`、`environment:`；这样以后有人改流水线时不会悄悄把权限加回去。
- **S-9**：仓库现在是公开仓库，GitHub 免费版的公开仓库可以用 Environments。环境清单第 21、155、174 行还写着“免费版私有仓库没有 Environments”，已经过时。这两个工作流不用任何机密，所以不影响本次结论；但 deploy-preview 用的仓库级预览机密，可以考虑挪进带部署规则的 `preview` 环境，缩小“任何分支的工作流都能读到”这个面（R-206 里写成已接受风险的那一条）。改不改交主持人。
- **S-10**（功能，不是安全）：`package.json` 里还没有 `@tauri-apps/cli`，desktop 任务在“安装依赖”那一步会按设计失败（fail-closed，方向对）。前端补上精确版本以后，`npm ci --ignore-scripts` 下 Tauri CLI 的平台二进制靠 optionalDependencies 装，不需要安装脚本；补的时候顺带确认一下 `rebuild-allowlist.sh` 不用加它。

---

## 三、逐项核对

### 3.1 权限

| 项 | 结果 |
|---|---|
| desktop.yml 顶层 | `permissions: {}` ✓ |
| desktop.yml / web | `contents: read` ✓（checkout 用；产物上传用的是运行时令牌，不需要 `actions` 权限） |
| desktop.yml / desktop | `contents: read` ✓ |
| release-build.yml 顶层 | `permissions: {}` ✓ |
| release-build.yml / build、bundle | `contents: read` ✓ |
| release-build.yml / desktop（调用方任务） | `contents: read` ✓。被调用工作流里各任务的权限只能小于等于调用方任务给的，这里两边都是 `contents: read`，以后调用方就算多给，被调用方的任务级声明也会把它压回去 |
| `id-token` / `contents: write` / `actions: read` / `attestations` | 都没有 ✓ |
| 能不能被别人调用 | `workflow_call` 在公开仓库里可以被别的仓库调用，但那时用的是调用方仓库的 `vars`、`secrets` 和令牌，拿不到本仓库的任何东西，不算问题 |

### 3.2 机密与环境

| 项 | 结果 |
|---|---|
| `secrets` 引用 | 两个文件都没有；release-build 调 desktop.yml 时没有 `secrets:`、没有 `secrets: inherit` ✓ |
| 签名私钥、updater 私钥 | 不在 GitHub，不进 CI；`createUpdaterArtifacts: false`；产物里有 `.sig`、`.zip`、MSI 就失败 ✓ |
| 日志里会不会打出机密 | 没有机密可打；Summary 和日志只写环境名、版本、哈希、提交 SHA；`vars` 只做空值判断不回显 ✓ |
| 预览 tag 能不能拿到正式机密 | GitHub 上**没有正式机密**（正式令牌每次发布时本机粘贴，R-220）；预览路径只读 `vars.PREVIEW_*`，正式路径只读 `vars.PROD_*`，都是公开值 ✓ |
| 预览 tag 能不能编出正式包 | 不能：正式环境只在 `TAG == v$VERSION` 时成立，预览 tag 永远带 `-preview.N`；desktop.yml 的 push 触发只匹配预览 tag；被别的分支、别的触发调用时 tag 对不上直接失败 ✓ |
| environment | 没用。因为没有任何机密，暂时不需要；见 S-9 |

### 3.3 供应链

| 项 | 结果 |
|---|---|
| action 钉 SHA | 全部钉 40 位 SHA，和其他工作流一致 ✓ |
| npm | `npm ci --ignore-scripts` + 白名单 rebuild ✓；Tauri CLI 用 `npx --no-install`，不会临时去网上下 ✓ |
| cargo | `cargo test --locked`、`tauri build ... -- --locked`、`cargo deny --locked` ✓；`deny.toml` 只许 crates.io、禁 git 源和别的源 ✓ |
| cargo-audit / cargo-deny 安装 | `cargo install --locked` + 精确版本，版本发布满两周 ✓；**但在出产物的任务里编译** → W-4 |
| Rust 工具链 | `rustup toolchain install 1.99.1 --profile minimal` ✓；runner 未钉版本 → S-1 |
| 依赖审计口径 | `cargo audit` 有漏洞就失败（警告不失败），`cargo deny` 按 Windows 目标、`unsound = "all"`、`yanked = "deny"`、漏洞不豁免 ✓ |

### 3.4 注入与 tag 校验

| 位置 | 进 shell 的方式 | 结果 |
|---|---|---|
| desktop.yml web「按 tag 定环境」 | `TAG: ${{ github.ref_name }}` → `"$TAG"` | ✓，且这是全流程第一个用到 tag 的步骤 |
| 预览构建的 `LEMO_BUILD_VERSION`、`SITE_ORIGIN` | `env:` | ✓ |
| desktop 任务 `LEMO_ENV`、`LEMO_VERSION` | 任务级 `env:`，取自已校验的 web 输出 | ✓ |
| `PREVIEW_PAGES_PROJECT` | `env:`，只做非空判断后拼进地址 | ✓（格式校验见 S-3） |
| 版本号写进 tauri.conf.json、latest.json | `node -e '...' "$LEMO_VERSION"`，走 argv，不拼进 JS 源码 | ✓ |
| Summary 里的 `$TAG` | `env:` | ✓ |
| `${{ github.ref_name }}` 出现在 `with: name:` | 不是 shell，只是产物名；tag 已被触发过滤限定为数字和点 | ✓ |
| release-build bundle | `TAG` 走 `env:`；`needs: build`，build 已校验 tag | ✓ |
| actionlint 1.7.12 + shellcheck 0.11.0 | 两个文件 0 报错 | ✓ |

### 3.5 产物完整性

| 项 | 结果 |
|---|---|
| bundle 能不能被不一致的产物绕过 | exe 包是自带 `SHA256SUMS` 自己核自己，整包替换能过；网页包没核 → **W-3** |
| desktop 另建一份网页、没和 release-build 的 dist 比 | **算安全问题**（负责人核的那份指纹不覆盖 exe 里的页面，且偏离架构 8.3“同一份产物”）→ **W-2** |
| 产物会不会被同名覆盖 | upload-artifact v7 同一次运行里同名产物不能覆盖；三个名字（`desktop-web-`、`desktop-production-`/`desktop-preview-`、`release-`、`release-bundle-`）互不冲突 ✓ |
| 整包 SHA256SUMS 和总指纹 | 先写到 `$RUNNER_TEMP` 再移回，总指纹不含 SHA256SUMS 自己 ✓；`dist_hash.py` 遇到符号链接直接失败 ✓ |
| `latest.json` | `signature` 留空、`pub_date` 用提交时间（可重现）✓；url 主机校验见 S-3 |
| publish.ps1 | 现在仍下载 `release-<tag>`、还没有 `-Desktop`；整包这一侧要等 F10、F11，届时我再审它怎么核 `release-bundle-<tag>` |

### 3.6 ci-guard 对新工作流是否生效

| 子命令 | 位置 | 结果 |
|---|---|---|
| `workflows` | desktop 任务，下载页面、暂存页面之前 | ✓ 扫 `.github/workflows/*.yml` 全部 5 个文件（含 release-build.yml 和 desktop.yml 自己）、`.github/actions/**`、`package.json` 的 scripts。release-build 每次都会调 desktop.yml，所以正式路径同样被查。desktop.yml 第 15 行注释用的是中文描述，没有写出参数原文，不会误报。本机跑：`流水线检查通过：workflows 5 个、actions 0 个文件和 package.json 的 scripts 里都没有 --skip-env-check`，退出码 0 |
| `permissions` | desktop 任务，`tauri build` 之后 | ✓ 用 `git status --porcelain --untracked-files=all`，未跟踪的新文件也算不一致；前面改的是 `tauri.conf.json`，不在被查目录里，不会误报。本机跑：`权限文件检查通过`，退出码 0 |
| 第二道 | `stage-web.mjs` 在 `CI`/`GITHUB_ACTIONS` 非空时拒绝 `--skip-env-check`（退出码 2） | ✓ |
| 回归测试 | `stage-web.test.mjs` 本机 16 项全过，但流水线没跑 | → **W-1** |

### 3.7 外壳审查各条在流水线上的状态

| 编号 | 和本次的关系 | 状态 |
|---|---|---|
| X-1、X-2 | 代码已通过；回归靠 `stage-web.test.mjs` 和 cargo test | X-2 由 `cargo test` 覆盖 ✓；X-1 的测试没进流水线 → W-1 |
| X-3 | 权限文件检查已接 | ✓（测试部分见 W-1） |
| X-4 | 流水线扫描已接 | ✓ |
| X-5、X-6 | 页面、提醒逻辑，与流水线无关 | 不变，照原记录 |
| X-S3 | 真机核对 iframe 通知权限，发布前必做 | 不变，仍未做；流水线不能替代 |
| X-S8 | `.github/actions/**` 和 `package.json` scripts 已纳入 | ✓ |

---

## 四、deny.toml 对照 11-03 的三个条件

| 条件 | 结果 |
|---|---|
| ① `unsound = "all"` | ✓ 第 25 行 |
| ② 现有 5 条警告按编号写明理由、11-30 复查 | ✓ 写在注释里（第 14～23 行，5 个编号逐条一句理由，“2026-11-30 复查”）。`ignore = []` 可以接受：按 `[graph] targets` 过滤以后这 5 条根本不在检查范围里，写进 ignore 反而会报 `advisory-not-detected`。我本机复核了运维的说法（第五节）：`cargo audit` 确实报这 5 条，`cargo tree --target x86_64-pc-windows-msvc -i` 对 proc-macro-error、zvariant、zbus_names、zvariant_derive、glib、zbus 都是 `nothing to print`（加 `--features preview` 也一样），对照 `-i webview2-com` 正常打印 tauri 依赖链 |
| ③ `[graph] targets = ["x86_64-pc-windows-msvc"]` | ✓ 第 6 行；`all-features = true` 把预览 feature 也纳入 |
| 真漏洞不豁免 | ✓ 没有任何 ignore；`yanked = "deny"` |

小点见 S-4（许可证名单）、S-5（OSV 豁免别删）、S-6（unmaintained 口径）。

---

## 五、本机核对记录

| 命令 | 结果 |
|---|---|
| `actionlint .github/workflows/desktop.yml .github/workflows/release-build.yml`（1.7.12，带 shellcheck 0.11.0） | 0 报错 |
| `node desktop/src-tauri/scripts/ci-guard.mjs workflows` | 通过，退出码 0 |
| `node desktop/src-tauri/scripts/ci-guard.mjs permissions` | 通过，退出码 0 |
| `node --test desktop/src-tauri/scripts/stage-web.test.mjs` | 16 项全过 |
| `cargo deny --offline --locked check advisories bans licenses sources`（cargo-deny 0.20.2，本机漏洞库 2026-11-02） | `advisories ok, bans ok, licenses ok, sources ok`，退出码 0；3 条 `license-not-encountered` 警告（S-4） |
| `cargo audit --no-fetch`（0.22.2） | 退出码 0，“5 allowed warnings”：RUSTSEC-2024-0370、2026-0370、2026-0371、2026-0372、2024-0429，和 deny.toml 注释一致 |
| `cargo tree --offline --locked --target x86_64-pc-windows-msvc -i <包>` | 5 个包加 zbus 都是 `nothing to print`；`-i webview2-com` 正常 |
| 去掉 targets 的对照跑 | 离线时缺 Linux 依赖源码，跑不起来（同 osv-scanner.toml 里第 ③ 点的现象），没做成 |
| `grep secrets\.\|id-token\|contents: write\|actions: \|environment:` | 新的两个文件里一处都没有（desktop.yml 第 5 行注释里的 `actions: read` 是说明文字） |

没有推送，没有触发工作流，没有连线上服务，没有读任何密钥值；只写了本文件。

---

## 记录

- 2026-11-03：安全审查员新建，只读审 desktop.yml、release-build.yml 新增两个任务、deny.toml。结论有条件签；必改 W-1（stage-web.test.mjs 进流水线）、W-2（正式 exe 的页面和网页产物同一份）、W-3（bundle 走任务输出核对，不自己核自己）、W-4（cargo-audit/cargo-deny 拆出出包任务）；建议 S-1～S-10。

## 采纳情况（主持人，11-03）

- W-1～W-4 全部交运维必改，改完由本审查员复核。
- W-2 和代码审查 M1 合并：采用本审查的首选改法。desktop.yml 加 workflow_call 输入，正式路径 `needs: build`，直接使用 `release-<tag>`，不再自己构建网页。这也满足代码审查 M1 的退路方案。
- S-5：保留 osv-scanner.toml 里 glib 的三条豁免，并把豁免理由里“F9 接管后随之删掉”一句改成“OSV 不分平台，不删除；11-30 复查”。
- S-9：改用 GitHub Environments 属于仓库安全配置，要负责人在聊天里同意，现在不动；环境清单里过时的说法先改准确。
- S-10：前端 B 已排定 11-04 21:20（首尔时间）以后装 `@tauri-apps/cli@2.12.4`；在此之前打 tag 会失败，属预期。
- 其余建议交运维本批一起改。许可证名单的处理和代码审查 S3 一样：保留，改注释。

## 复核（11-03）

**结论：签。** W-1～W-4 全部解决；建议里除了等到期再做的、明确不改的、运维还在补的几项，其余都已落地。用的是上一轮的尺度：要签名、要分发的 exe，能不能从这两个工作流出。只读复核，另外按主持人要求在 `osv-scanner.toml` 的三条新豁免上签了会签（见末尾）；没有推送、没有触发工作流、没有连线上服务、没有读任何密钥值。

这个结论只管流水线。外壳审查里的 X-5、X-6、X-S3（真机核对 iframe 通知权限）照旧按原记录办，发布前必须做完。

### 必改逐条复查

| 编号 | 结果 | 依据 |
|---|---|---|
| W-1 | **已解决** | desktop 任务在“暂存页面”之前跑 `node --test desktop/src-tauri/scripts/stage-web.test.mjs`；unit.yml 也加了同一步，平时的提交就能发现回归。本机跑 16 项全过 |
| W-2 | **已解决**（用的是首选改法） | desktop.yml 加了 `workflow_call` 输入 `web_artifact`、`expect_env`；release-build 的 `desktop` 任务 `needs: build`，传入 `release-${{ github.ref_name }}`、`production`。web 任务在被调用时不构建页面，并且校验三件事：`expect_env` 必须是 production、tag 算出来的环境也必须是 production、`web_artifact` 必须严格等于 `release-$TAG`。desktop 任务下载的正是 `release-<tag>`，装进 exe 的页面就是上线的网页，也是负责人核过指纹的那一份。直接用 push 触发时只接受预览 tag。输入走 `env:` 进 shell，没有注入面 |
| W-3 | **已解决** | 指纹不再走产物存储：desktop 任务把 `web_hash`、`exe_name`、`exe_sha256`、`latest_sha256` 设成任务输出，经 `on.workflow_call.outputs` 交出来；build 任务输出 `web_hash`。bundle 先校验格式（64 位十六进制，安装包名用正则，防路径穿越），再核对：① 下载的网页、build 任务、desktop 任务三方总指纹一致；② exe 产物里恰好只有 3 个文件；③ 安装包和 latest.json 的 SHA-256 和 desktop 任务的输出一致；最后再核一遍产物自带的 SHA256SUMS。Summary 分三段，每段标题写明负责人什么时候核哪一段。剩下的风险：如果 desktop 任务本身被攻破，它可以让任务输出和产物前后一致。这一点靠 W-4 和整条流水线不碰机密来兜，属于可以接受的根信任 |
| W-4 | **已解决** | 新加 `audit` 任务（ubuntu-24.04，`contents: read`，不上传任何产物）：只在这个任务里 `cargo install --locked` 编 cargo-audit、cargo-deny，然后跑 `cargo audit` 和 `cargo deny`。desktop 任务 `needs: [web, audit]`，出安装包的 Windows 机器上不再编这两个工具。和 8.3 第 ⑤ 条的偏离已写进环境清单第七节第 12 条。`cargo audit` 改成带 `--target-os windows --target-arch x86_64`：这个参数只滤掉公告里**自己写明**只影响其他平台的条目，不限平台的漏洞照样会让这一步失败，所以没有放松。本机复跑结果和不带参数时一样（0 个漏洞，5 条警告） |

### 建议逐条复查

| 编号 | 结果 |
|---|---|
| S-1 | **已改**：`runs-on: windows-2025` |
| S-2 | **已改**：desktop.yml 的 web 任务和 release-build 的 build 任务都用 `fetch-depth: 0` 拉全历史，再跑 `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`；build 任务里这一步在构建、上传之前 |
| S-3 | **前一半已改**：`PREVIEW_PAGES_PROJECT` 按 `^[a-z0-9][a-z0-9-]{0,57}$` 校验。**后一半运维还在补**：`desktop_scan.mjs` 拿 latest.json 的地址和 `update_url` 比主机。补完交代码审查核对即可，不影响本次结论；publish.ps1 `-Desktop` 落地时签名前也核一次主机，这一条照旧挂在 F10 |
| S-4 | **按主持人决定保留名单、改了注释**（写明名单是允许范围，不要求每项都出现）。可以接受 |
| S-5 | **已改**：glib 那三条豁免保留，理由里改成“OSV 不分平台、扫整个 Cargo.lock，不删除；2026-11-30 复查” |
| S-6 | 是 11-30 复查时要做的事，现在不用改；到时用 `unmaintained = "all"` 本机跑一次并记下结果 |
| S-7 | **没改**（`cache: npm` 还在）。npm ci 按 integrity 校验，是可选加固，不卡 |
| S-8 | **已加** `tests/build/workflow-permissions.test.ts`：检查两个工作流顶层 `permissions: {}`、每个任务只给 `contents: read`、`permissions` 出现的次数（防止藏在步骤里）、不能用 `secrets.`、`secrets: inherit`、`id-token`、任何 `: write`、`read-all`/`write-all`、`environment:`、`pull_request_target`/`workflow_run`、第三方 action 必须钉 SHA；还钉住了 release-build 调 desktop.yml 时传的两项输入、`needs: build`，以及 desktop.yml 只有预览 tag 和 `workflow_call` 两个触发。每一种违规都有合成样例证明拦得住。在 vitest 的 node 项目里（include 有 `tests/build/**`），unit 会跑到。本机和 desktop-scan.test.ts 一起跑，2 个文件 23 项全过。运维说的类型警告还在修，不影响守护效果 |
| S-9 | 按主持人决定现在不动 Environments；环境清单里“免费版私有仓库没有 Environments”的说法已在第一、四、五节改准确 |
| S-10 | 已知、属预期：`@tauri-apps/cli` 排在 11-04 装，在那之前打 tag 会在“安装依赖”一步失败（fail-closed）。两个工作流的文件头都写了 |

### 重写后另外看的几点（没有新的必改）

- 权限、机密没有回退：三个任务加上 build、bundle 都只给 `contents: read`，整条链不引用任何机密（S-8 的测试也钉住了这一点）。
- 新加的 `inputs.*`、任务输出进 shell 都走 `env:`；bundle 用到的任务输出都先校验格式再用。
- 顺序没问题：`ci-guard workflows` 和 stage-web 测试仍在暂存页面之前；页面总指纹在暂存之前算（暂存只是另拷一份去注入 CSP，不改 `dist/web`）；`ci-guard permissions` 仍在 `tauri build` 之后。
- 文件头写明不加工作流级 concurrency（理由是被调用时组名会撞上），这个说明对。
- publish.ps1 第 967 行只改了提示文字，告诉负责人现在只核“正式产物指纹”一段。和 release-build Summary 的三段标题对得上。

### 本机复核记录

| 命令 | 结果 |
|---|---|
| `actionlint -shellcheck=… .github/workflows/*.yml`（1.7.12 + shellcheck 0.11.0） | 5 个文件 0 报错 |
| `node desktop/src-tauri/scripts/ci-guard.mjs workflows` / `permissions` | 都通过，退出码 0 |
| `node --test desktop/src-tauri/scripts/stage-web.test.mjs` | 16 项全过 |
| `npx vitest run tests/build/workflow-permissions.test.ts tests/build/desktop-scan.test.ts` | 2 个文件 23 项全过 |
| `cargo audit --no-fetch --target-os windows --target-arch x86_64` | 0 个漏洞，5 条警告，和不带参数时一样 |
| `cargo deny --offline --locked check advisories bans licenses sources` | 四项都 ok |
| 解析 Cargo.lock：依赖 zbus 的包、探针锁文件里有没有这几个包 | 依赖 zbus 的只有 tauri-plugin-single-instance 2.5.4；探针的 Cargo.lock 里没有 zbus、zvariant、zbus_names、zvariant_derive |
| 本机 registry 里 tauri-plugin-single-instance 2.5.4 的 Cargo.toml | `[target.'cfg(target_os = "linux")'.dependencies.zbus]`，只在 Linux 上依赖 |
| `python -I -c "import tomllib; …"` 解析 osv-scanner.toml | 7 条豁免都能解析，`ignoreUntil` 都是 2026-11-30 |

### osv-scanner.toml 三条新豁免的会签

RUSTSEC-2026-0370（zvariant 5.15.1）、RUSTSEC-2026-0371（zbus_names 4.3.5）、RUSTSEC-2026-0372（zvariant_derive 5.15.1）：**同意，已在 `osv-scanner.toml` 签名**（把“会签：待安全审查员”改成了“会签：安全审查员 11-03”，并附上复核依据）。

理由：
- 三条都是“没人维护”类公告，不是漏洞。
- 引入路径和运维说的一致：Cargo.lock 里只有 tauri-plugin-single-instance 2.5.4 依赖 zbus 5.19.0，插件只在 `cfg(target_os = "linux")` 下依赖它；按 Windows 目标 `cargo tree -i` 这四个包都是 `nothing to print`，`-i webview2-com` 正常打印。正式外壳只出 Windows 版，exe 里没有这几个包。
- 只能在 OSV 里豁免：OSV 不分平台。
- 期限 2026-11-30，和 glib 那三条一起复查。复查时如果这三个包进了 Windows 依赖树，或者出了漏洞类公告，这几条豁免作废。

- 2026-11-03：安全审查员复核。W-1～W-4 全部解决，结论由“有条件签”改为“签”。S-3 后一半（desktop_scan 比主机）和 S-8 测试的类型警告运维还在补，交代码审查核对，不影响结论。会签 osv-scanner.toml 的 RUSTSEC-2026-0370、0371、0372 三条。

### 复核补充（11-03，S-3 后一半和 desktop.yml 新加的一步）

主持人通知运维已补完 S-3 后一半，所以补看这一部分。**结论不变：签。** S-3 两半都已解决。

- **`build/ci/desktop_scan.mjs` 的 `checkLatest`：通过。** 基准取自 `env.rs` 本环境的 `update_url`（去掉 `/latest.json`）。下面几条都会让它失败：
  - 不同源：主机、协议、端口任何一样不同；
  - 地址不是原样以 `<基准>/` 开头（端口写法、大小写、编码之类的变形都会被拦）；
  - 文件名不满足 `^[A-Za-z0-9._-]+-setup\.exe$`；
  - 带查询串或片段；
  - `platforms` 不是恰好只有一个 `windows-x86_64`；
  - version 格式不对，或者和环境对不上。

  我用 12 个对抗样例本机探了一遍（脚本在草稿目录的 `probe-latest.mjs`），下面这些全被拦下：`:443` 端口、主机大写、`..%2F`、`../`、反斜杠、`http://`、只带 `?`、只带 `#`、子目录、正式环境配预览版本号。能通过的只有正例和 `.-setup.exe` 这类同目录下的文件名，无害。加上运维测试里已有的反例（别的 Pages 项目、`pages.dev@evil.example` 用户名伪装、跨环境、多出 darwin），覆盖够了。
- **desktop.yml 新加的一步：可以接受，而且应该加。** 这一步虽然超出原来交代的范围，但它让比对真的在 CI 里跑，不只停在单测里。它跑 `node build/ci/desktop_scan.mjs --env "$LEMO_ENV" --latest out/latest.json`，位置在生成 latest.json 之后、上传产物之前，失败就不出产物。参数走 `env:`；actionlint 加 shellcheck 0 报错。这一步还顺带堵上了一处：工作流里用 `vars.PREVIEW_PAGES_PROJECT` 拼出来的预览地址，以前没有和 `env.rs` 里写死的预览更新地址比过，现在两者对不上就会失败。
- **S-8 测试的类型警告：** 我单独按 `--strict` 用 tsc 检查 `tests/build/workflow-permissions.test.ts`，没有报错。vitest 跑 `workflow-permissions.test.ts`、`desktop-scan.test.ts` 两个文件，23 项全过。
- publish.ps1 `-Desktop` 落地时，签名前也要再核一次地址的主机。这一条照旧挂在 F10，到时候我审。

- 2026-11-03：安全审查员复核补充。看了 `checkLatest` 和 desktop.yml 新加的 `--latest` 一步，S-3 后一半已解决；S-8 测试的类型检查无报错。结论仍是签。
