# B6-exe 代码审查：exe 外壳 F1～F4、F8，及周视图加待办

日期：2026-11-03　审查：代码审查员　被审：前端 B　版本：工作区 11-03 下午（`desktop/src-tauri/` 未入库；日历三文件看 `git diff`）

被审文件：
- `desktop/src-tauri/` 下的 `Cargo.toml`、`Cargo.lock`、`build.rs`、`tauri.conf.json`、`tauri.preview.conf.json`、`capabilities/*.json`、`src/*.rs`（main、lib、env、policy、session、credman、updater）、`scripts/stage-web.mjs`、`scripts/stage-web.test.mjs`
- `shared/logic/calendar/cal-items.ts`（抽出 `todoDate()`）、`shared/logic/calendar/week-view.ts`、`tests/shared/calendar/week-view.test.ts`

规矩依据：`docs/09-路线图/B6-exe-任务单.md` 第一节（F1～F4、F8，验收 A2、A5、A6、A8、A11、A14）、`docs/10-架构/架构设计-v4.md` 5.10、0.48 第 6～7 条、15.4 S-B6、15.6。

## 结论

| 部分 | 结论 | 分数 |
|---|---|---|
| exe 外壳 F1～F4、F8 | **有条件签**：M1～M4 改完、由本审查员复核后签 | 6.5 / 10 |
| 周视图加待办 | **签** | 9 / 10 |

做得好的：只打 NSIS、当前用户安装、`withGlobalTauri: false`、不开 remote、来源是 `http://tauri.localhost`，都和任务单一致；capabilities 按窗口分开，每个命令在 Rust 里再按窗口 label 核一遍；建窗口、关窗口的命令都是 async；会话键白名单、凭据名在 Rust 里拼，页面传不了任意名字；`external_url` 交给系统的是规整后的网址，不是页面原文；权限回调只放行 main 本地页面的通知；env.rs 让 identifier 和编译特性对不上时启动即失败；single-instance 锁在 2.5.4，`windows` 只有 0.62.2 一份。周视图直接复用 `todoDate()`，过滤规则只有一处，测试里拿 `dayEntries` 逐天对照，写法到位。

自报要点核对：

| 自报 | 核对结果 |
|---|---|
| 只打 NSIS、当前用户安装、来源 `http://tauri.localhost` | 属实（`tauri.conf.json:21`、`:28`，没有 `useHttpsScheme`） |
| capabilities 按窗口给、Rust 里再核 | 属实，但 `main_show`、`app_update` 两个命令没登记权限，页面调不到（M3） |
| 导航按窗口限制 | **不属实**：main 能用 `/app/auth`（不带斜杠）、`%61uth` 等写法打开登录页（M1） |
| open_external 拒绝本地地址 | **部分属实**：只拒 `tauri.localhost`（不带端口）和 `ipc.localhost`，`localhost`、`127.0.0.1`、局域网地址、`https://tauri.localhost` 都放行（S1） |
| 分段存储，头部最后写，段坏了当作没有 | **不属实**：写到一半失败时，能读回一份新旧拼接的会话（M2） |
| env.rs 用 feature 切换，启动时三者核对 | 核对本身属实；但 `--skip-env-check` 暂存出来的页面和正常暂存的分不出来，CI 里也没有拦（M4） |
| 建窗口的命令必须是 async | 属实（`lib.rs:67-134`） |
| single-instance 锁在 2.5.4 | 属实（`Cargo.lock`） |
| 和架构不同的三处 | 做法合理，比原文更收紧；请架构师在 5.10 里改成现行写法 |

## 必改

| # | 问题 | 位置 | 改法 |
|---|---|---|---|
| M1 | **main 能导航到登录页和打字框页**（验收 A5，P0）。`navigation_allowed` 拿 `url.path()` 原样做前缀比较，而 Tauri 2.12.5 取页面时会先百分号解码、去掉末尾斜杠，找不到再依次试 `<路径>.html`、`<路径>/index.html`（`tauri-2.12.5/src/manager/mod.rs:375-415`）。草稿实验用同样的解析规则复现：main 放行 `http://tauri.localhost/app/auth`、`/app/%61uth/index.html`、`/app/auth%2Findex.html`，实际拿到的都是 `app/auth/index.html`；`/app/desktop/quick-add`、`quick-add%2Ehtml`、`quick-add.html/` 拿到的都是打字框页。登录页的 meta CSP 放行 challenges.cloudflare.com，在 main 里打开就等于 Turnstile 的远程脚本拿到了 main 的权限（`session_get`、`open_external`）。现有用例“路径里绕的写法也拦得住”只测了 `..` 和 `%2e%2e`，这两种 url 库本来就会规整 | `src/policy.rs:56-78` | ① 路径含 `%` 的一律拒（本地页面的路径没有需要编码的字符）；② 按“去掉末尾斜杠后的路径”判断；③ main 改成白名单：只放行 `/app/`、`/app/index.html`，以及确实需要的 `/app/preview.html`，别的一律拒；auth 只放行 `/app/auth/`、`/app/auth/index.html`；④ 补用例：上面 6 种写法、`/app/AUTH/`、反斜杠写法，三个窗口各跑一遍 |
| M2 | **分段写到一半失败，会读回一份新旧拼接的会话**。“头部最后写”只防住了段数或总长度变了的情况。新旧会话段数和总长度一样时（刷新令牌后很常见，JWT 长度基本固定），第 1 段写成新的、第 2 段写失败，头部还是旧的，总长度对得上、UTF-8 也合法，`get` 返回旧的第 0 段、新的第 1 段、旧的第 2 段拼起来的字符串。草稿实验复现：旧值 A…B…C、新值 a…b…c 各 5500 字节，模拟第 2 段 `CredWriteW` 失败，读回的字符串开头是 A、中间是 b、结尾是 C。这不需要断电，`CredWriteW` 返回一次错误就够了；拼出来的会话可能拿旧的 access_token 配新的 refresh_token，Supabase 的刷新令牌复用检测会把整串令牌作废 | `src/session.rs:5-9`（注释）、`:39-52`、`:110-130` | 首选**两套段轮换**：头部写成 `lemo2;<代号 0/1>;<段数>;<总字节数>;<SHA-256 前 16 字节的十六进制>`，新值的第 1 段以后写到另一套代号的名字下（如 `<key>~b1`），最后写头部完成切换，再删掉旧代号的段；读时按头部的代号取段并核对哈希，对不上就返回 None。这样写一半失败时，读到的仍是完整的旧会话。最少也要在头部加内容哈希，读时核对。补用例：用会在第 i 段写失败的假存储，验证读回的要么是完整旧值，要么是 None，不会是拼接的 |
| M3 | **`main_show`、`app_update` 页面调不到**。这两个命令注册进了 `generate_handler!`，但 `build.rs` 的 `AppManifest::commands` 没列、`capabilities/main.json` 也没给。有 app manifest 时，Tauri 对没登记权限的应用命令一律拒绝（`tauri-2.12.5/src/webview/mod.rs:2080-2107`，报 `Command main_show not allowed by ACL`）。`src/platform/desktop.ts:64`、`:76` 已经在调：点通知时主窗口拉不到前台（藏在托盘时看不到整页提醒，A10），“更新”按钮永远 failed（A13 的 426 → Rust 更新检查） | `build.rs:5-18`、`capabilities/main.json:6-16` | `build.rs` 加 `main_show`、`app_update`；`main.json` 加 `allow-main-show`、`allow-app-update`；加一条构建期检查：`generate_handler!` 里的命令和 `build.rs` 的列表必须一致（可以在 `lib.rs` 里放一个命令名常量数组，build.rs 和单测共用） |
| M4 | **`--skip-env-check` 暂存的页面可以一路进到安装包**。跳过核对时照样写 `{"env":"production"}`，Rust 的 `check_env` 分不出来；“desktop.yml 里禁止用”只是注释，仓库里还没有 desktop.yml，也没有任何机器检查。这样“页面编的是哪套环境”这一环就被绕过了，三者核对只剩 identifier 和 feature 两样 | `scripts/stage-web.mjs:7`、`:91-109`、`:125`；`src/lib.rs:281-292` | ① 环境变量 `CI` 或 `GITHUB_ACTIONS` 有值时，带 `--skip-env-check` 直接退出码 2；② 跳过时 `desktop-env.json` 写 `{"env":…,"envCheck":"skipped"}`；③ `check_env` 在发布构建（`cfg(not(debug_assertions))`）里遇到 `envCheck` 不是 `"passed"` 就拒绝启动（正常暂存写 `"passed"`）；④ 补 node 用例：`CI=1` 加 skip 时失败 |

## 建议

- **S1 open_external 的“本地地址”只拦了两个主机名**（`src/policy.rs:101`）。草稿实验：`http://localhost:5173/`、`http://127.0.0.1/`、`http://0x7f.1/`（规整成 127.0.0.1）、`http://[::1]/`、`http://192.168.0.1/`、`https://tauri.localhost/`、`http://tauri.localhost:8080/`、`http://ipc.localhost./x` 都放行。架构只要求协议白名单，这条不算违规，但自报写的是“拒绝本地地址”。建议按解析后的主机判断：`localhost`、`*.localhost`（含末尾带点的）、环回、私网、链路本地、`0.0.0.0` 一律拒；如果决定不拦，就把自报和注释改成“只拦本 App 自己的两个来源”。另外 `mailto:` 可以带 `attach=` 参数（Outlook 不认，个别邮件客户端认），建议 mailto 只留 `to`、`cc`、`subject`、`body`。
- **S2 删旧段失败会留下孤段，退出登录也删不掉**（`src/session.rs:80-85`、`:126-128`、`:132-141`）。变短时删多余旧段中途失败，或第 0 段坏了（`existing_chunks` 按 1 段算），之后的 `remove` 只按头部段数删，含旧令牌片段的段会一直留在凭据管理器里。建议 `remove` 和 `set` 收尾时把 `~1`～`~32` 全删一遍（不存在算成功，最多 32 次调用），或用 `CredEnumerateW` 按 `lemomemo.session.<key>*` 过滤后删。A19 的卸载清理也要按**键名**过滤（如 `lemomemo.session.sb-preview-*`），不能按 `lemomemo.session.*` 删，否则卸载预览版会把正式版的会话一起删掉。M2 改成两套段轮换后，两套代号的段都要清。
- **S3 启动核对失败时用户什么也看不到**（`src/lib.rs:317-320`）。发布版没有控制台，`eprintln!` 看不到；`setup` 返回错误后 `.expect` 触发 panic，`panic = "abort"` 下直接退出。建议失败时先弹一个系统对话框（如 `MessageBoxW`）写明“安装包环境不一致，请重新下载”，再退出。
- **S4 quick-add 页还没有 meta CSP**（`scripts/stage-web.mjs:118-124`）。F3 要求三页都收紧 meta CSP，现在只处理 main 和 auth。页面入口还没加，可以理解；建议现在就把 quick-add 写进列表：文件不存在时先警告，等 `vite.config.ts` 加了入口改成直接失败。quick-add 不连服务器，`connect-src` 只给 `'self' ipc: http://ipc.localhost`。
- **S5 暂存时的环境核对只防了一个方向**（`scripts/stage-web.mjs:79-86`）。预览包里出现正式地址 `https://lemomemo.com` 或 `*.supabase.co` 不会报错；“产物里有本环境地址”用的是子串查找，帮助页链接之类也能满足。建议直接核对 Vite 编进去的 `VITE_PUBLIC_SUPABASE_URL` 那一个值（比如构建时把它写进 `dist/web/app/version.json`），反方向也查。反向搜索最终靠 desktop.yml 搜 exe，这里是提前拦。
- **S6 `cargo test` 会往真凭据管理器里写东西**（`src/credman.rs:372-400`）。`凭据管理器真机存取删_分段` 在任何 Windows 机器上跑 `cargo test` 都会写、删 `lemomemo.session.cargo-test-session-key*`。建议标 `#[ignore]`，在 desktop.yml 里用 `cargo test -- --include-ignored` 跑；本地需要时手动带参数。
- **S7 eslint 不查 `desktop/**`**（`eslint.config.*` 第 344 行附近的 ignores），`stage-web.mjs` 和它的测试都没被 lint。建议把 `desktop/src-tauri/scripts/*.mjs` 放回 lint 范围（`target/`、`gen/` 继续忽略）。
- **S8 联调提醒（转前端 A）**：`src/platform/session.ts:457` 的 `goToAuth` 和 `src/app/main.tsx` 没登录时都用 `location.replace('/app/auth/')`，在 exe 的 main 里会被导航策略取消，主窗口停在空白页。exe 里要改成调 `auth_window_open`。另外 `tsc -p tsconfig.app.json` 现在报 `src/platform/__tests__/desktop.test.ts(20,5)`、`(21,5)` TS1294（构造函数参数属性和 `erasableSyntaxOnly` 冲突），`npm run typecheck` 会失败，不在本次被审范围，请文件负责人改。
- **S9 周视图：电脑上全天那一行的 `itemIds` 分不出哪个是待办**（`shared/logic/calendar/week-view.ts:180-184`、`:313-314`）。日程和待办来自两张表，界面点开时要知道去哪张表找，也要知道哪个画空心圆。建议 `AllDay` 加 `kinds`（和 `itemIds` 一一对应），或单独给出 `todoCount`。手机布局已经有 `todos`，不受影响。
- **S10 小处**：`external_url` 先比长度再 `trim`（`policy.rs:88-91`），前后带空格的合法网址会被提前判超长，建议先 trim；`session_get/set/remove`、`open_external` 是同步命令，在主线程上跑，凭据管理器偶尔慢时会卡一下界面，可以改成 async（`SessionStore` 已有锁，安全）。

## 已知情况核对

- **分段竞态**：同一进程里 `SessionStore` 有一把锁，读、写、删互斥；同步命令本来也在主线程上排队。正式版和预览版是两个进程，但键名不同（`sb-lemomemo-…` / `sb-preview-…`），不会写到同一组凭据。单实例按 identifier 区分，同一环境不会有两个进程。所以没有进程内或进程间的竞态，问题在“写一半失败”（M2）。
- **导航判断的其他绕法**：大小写（`/app/AUTH/`）在 Windows 上 Tauri 的资源表区分大小写，拿到的是根 `index.html`，不是登录页；反斜杠、`./`、`..`、`%2e%2e` 会被 url 库规整；带端口、带账号、`https://tauri.localhost`、`tauri.localhost.`（末尾带点）都被拒。只有 M1 那几种能绕过。
- **三套环境核对**：identifier 和 feature 两两对不上时启动即失败（只用 feature 不带预览配置，或只带配置不用 feature，都会被拦）；CSP 在两个配置文件里写死，没纳入核对，但 CSP 和 meta CSP 取交集，配错只会连不上、不会放宽。能绕过的只有页面那一环（M4）。
- **周视图和月历的过滤**：都走 `todoDate()`（删掉的、已完成的、没有截止日的不放，截止日不换算时区），排序都用 `compareEntries`。手机 `todos` 和 `dayEntries` 逐天相等有用例；电脑并进全天那一行后，待办按 `kindRank` 排在全天日程后面，也有用例。src 里还没有 `buildWeek` 的调用方，`WeekItems.todos` 改成必填不影响现有代码。

## 跑过的测试

- `desktop/src-tauri` 下 `cargo test --locked -- --skip 凭据管理器真机`（正式版）：20 条全过，1 条按要求跳过（不往凭据管理器里写）。
- 同上加 `--features preview`：20 条全过，1 条跳过。
- `node --test desktop/src-tauri/scripts/stage-web.test.mjs`：5 条全过。
- `npx vitest run tests/shared/calendar`：4 个文件 82 条全过。
- `tsc -p tsconfig.shared.json`、`tsc -p tsconfig.node.json`：0 错误；`tsc -p tsconfig.app.json`：2 个错误，都在 `src/platform/__tests__/desktop.test.ts`，不在被审范围（S8）。
- `eslint shared/logic/calendar tests/shared/calendar`：0 错误；`desktop/src-tauri/scripts` 被 eslint 配置忽略（S7）。
- 草稿实验（会话临时目录 `cr-b6/probe`，单独的小 crate，用 `#[path]` 引入 `policy.rs`、`session.rs`，按 Tauri 2.12.5 `get_asset` 的规则模拟取页面）：复现了 M1 的 6 种绕法、M2 的拼接读回、S1 的本地地址放行。没有运行 exe，没有安装，没有往凭据管理器写东西。

## 采纳情况（主持人，11-03）

- 周视图加待办：已签，随推送替身那一批提交。
- M1～M4：交前端 B，和安全审查 X-1～X-4 一起改，M1 优先。改完由本审查员复核。
- S1、S2、S6、S7、S9 交前端 B；S3、S4 和安全审查的 X-S1、X-1 是同一件事。
- S8：交前端 A，exe 里未登录时改成调 auth_window_open；建议做成 platform 的 openAuth()，exe 一侧经 setNativeBridge 接入。
- desktop.test.ts 的 TS1294：交前端 B。
- 架构 5.10 按现行写法改：已派架构师写进 0.53。

## 复核（11-03）

复核版本：工作区 11-03 下午第二版。新增 `src/commands.rs`、`src/manifest_check.rs`、`scripts/ci-guard.mjs`、`src/platform/desktop.ts`（及 `native-bridge.ts` 的 exe 一侧接线、`src/app/main.tsx` 装桥）；`Cargo.toml` 多了 `sha2 0.10.9`。

### 结论

| 部分 | 结论 | 分数 |
|---|---|---|
| exe 外壳 F1～F4、F8（Rust、配置、暂存与流水线脚本） | **签** | 8.5 / 10 |
| 周视图加待办 | **签** | 9.5 / 10 |
| `src/platform/desktop.ts`（顺带审） | 通过，见 N1、N3 | — |

M1～M4 全部改到位，S1～S10 都改了。没给满分是因为两点：一是 F4 的页面一侧还没接（N1），会话现在还进不了凭据管理器；二是 `preview.html` 被排除在安装包外，理由写错了（N2）。这两条都不在本次被审的 Rust 代码里，不卡签字，但 **A8（TC-B6X-09、15）验收前 N1 必须做完**。

### 逐条核对

| # | 结果 | 依据 |
|---|---|---|
| M1 | 改到位 | `policy.rs:54-89`：三个窗口各自只认写死的路径（main：`/app/`、`/app/index.html`；auth：`/app/auth/`、`/app/auth/index.html`；quick-add 只有打字框页），按原样比较，路径里有 `%` 一律拒。用例 `审查复现的绕法三个窗口一律拒` 列了 20 种写法，三个窗口各跑一遍。用上一轮的草稿探针按 Tauri `get_asset` 的规则复跑：上一轮能绕过的 6 种写法全部被拒，auth 窗口的 `..%2F` 也被拒 |
| M2 | 改到位 | `session.rs:1-176`：两套段（`~a<i>` / `~b<i>`）轮换，头部 `lemo2;<a|b>;<段数>;<总字节数>;<SHA-256>` 最后写；读时核对总长度、哈希、UTF-8。逐步推演：写新段时失败，头部还指着旧那套，旧段一个没动；写头部时失败，同样读回旧值；切换后清理失败，残留的是另一套代号的段，下次写会覆盖、`remove` 会清掉。用例 `写到一半失败_读回完整旧值_不会新旧拼接` 让 4 次写各失败一遍，每次都读回完整旧值，恢复后能切到新值；`长度对得上但内容不同` 的情况被哈希拦下。同一进程里有锁，正式版和预览版的键名不同，没有竞态 |
| M3 | 改到位 | 命令名单只在 `src/commands.rs` 一处，`build.rs` 用 `include!` 读进来；`main.json` 加了 `allow-main-show`、`allow-app-update`。`manifest_check.rs` 有三条单测：`generate_handler!` 里的命令和名单一致；每个命令都有生成的权限文件；每个窗口只授予该给的命令、该给的都给了、不开 remote、插件权限只有那 5 条。`ci-guard.mjs permissions` 在编译后核对 `permissions/` 和已提交的内容一致 |
| M4 | 改到位 | `stage-web.mjs:136-139`、`:159-162`：`CI` 或 `GITHUB_ACTIONS` 有值时带跳过参数退出码 2；`desktop-env.json` 写 `envCheck`，带了跳过参数但核对本来就通过时如实写 `passed`。`lib.rs:309-322`：发布版只认 `passed`，debug 版才认 `skipped`，有用例。`ci-guard.mjs workflows` 在编译前搜流水线文件 |
| S1 | 改到位 | `policy.rs:99-163`：按解析后的主机判断，`localhost`、`*.localhost`、`*.local`、环回、私网、链路本地、运营商级 NAT、`0.0.0.0`、IPv4 映射的 IPv6 都拒，末尾带点的也拒；mailto 只收 `to`、`cc`、`bcc`、`subject`、`body`（参数名不分大小写，`%61ttach` 解码后同样会被拒）。另外新增 `new_window_external_url`：新窗口只转交 http、https，每秒最多 1 次。探针复跑：上一轮放行的本地地址全部被拒 |
| S2 | 改到位 | `remove` 先删头部，再把两套代号的 0～31 段和旧格式的 `~1`～`~32` 全删一遍；`set` 切换后清另一套和多出来的段。用例 `删除时清掉所有孤段` 覆盖了各种孤段，并确认不会删到另一个键。注释写明卸载清理要按“前缀 + 键名”找 |
| S3 | 改到位 | `lib.rs:342-354`：失败时写 `startup.log`（应用日志目录），弹固定文案的系统对话框，用固定退出码 78 退出 |
| S4 | 改到位 | `PAGES` 里加了 quick-add，CSP 只许本地脚本、`frame-src 'none'`、只连 IPC；有这个页面就注入。另外名单以外的 `.html` 现在直接失败 |
| S5 | 改到位 | 两个方向都查：预览包里出现 `https://lemomemo.com`（正则排除了 `lemomemo.com.evil` 这类）或 `*.supabase.co` 就失败。仍是子串查找，没有改成核对 `VITE_PUBLIC_SUPABASE_URL` 那一个值，可以接受，最终以 desktop.yml 反向搜 exe 为准 |
| S6 | 改到位 | 真机凭据用例标了 `#[ignore]`，desktop.yml 用 `--include-ignored` 跑。本次 `cargo test` 不带这个参数，确认被跳过 |
| S7 | 改到位 | `eslint.config.js:344-347` 只忽略 `target/`、`gen/`、`turnstile-probe/`，`scripts/*.mjs` 按 node 脚本规则检查 |
| S8 | 改到位 | `native-bridge.ts` 加了 `openAuth()`，`goToAuth` 走它；exe 里 `desktop.ts` 的 `openAuth` 调 `auth_window_open`，主窗口不导航；`main.tsx` 在读会话、`goToAuth` 之前先装 exe 桥。TS1294 已消失，`tsc -p tsconfig.app.json` 0 错误 |
| S9 | 改到位 | `AllDay` 加了 `kinds`，和 `itemIds` 一一对应；电脑布局的用例核对了 `['allDay','todo','todo']` |
| S10 | 改到位 | `external_url` 先 trim 再判长度（有用例）；会话三件和 `open_external` 改成 async |

### `desktop.ts` 顺带审

写法清楚，依赖都能注入，测试覆盖了更新结果折算、`main_show` 失败照样切页、通知替换和撤回、快速记录载荷校验。`quickAddText` 用码点计长度，和 Rust 的 `chars().count()` 一致；`onQuickAddText` 的监听、取消参数和 Tauri 2.12 的事件插件一致。

### 遗留（不卡这次签字）

- **N1 F4 的页面一侧还没接：会话现在进不了凭据管理器（A8 验收前必须做，转协调员定由谁做）**。`desktop.ts` 里没有 secureStorage 适配器，supabase-js 在 exe 里仍然用 localStorage；`readSessionUserId()`（`src/platform/session.ts:56`）是同步读 localStorage 的，改成凭据管理器后这一步要变成异步，或在装桥后先把会话读进内存。另外 src 里没人监听 `auth:done`：登录小窗口写好会话、关掉以后，主窗口不会重新读会话。架构 15.4 中 7 写的是“`platform/desktop.ts` 的 `secureStorage`”。这两件做完才算 F4 完整，需要前端 A 一起改启动流程。
- **N2 `preview.html` 被排除在安装包外，注释理由写错了**（`stage-web.mjs:12`、`:53`）。它不是“网页版的开发预览页”，是 5.13 第 3 点的附件预览沙箱（B4b-1 在这里接 pdf.js、docx-preview、SheetJS，`src/preview-frame/main.ts`）。现在还是占位，排除掉不影响运行；但 B4b-1 接上以后，exe 里的附件预览会打不开。建议把注释改对，并在任务单冲突表里记一笔：B4b-1 落地时把它加进 `PAGES`，单独定 CSP（不给 `allow-same-origin`，`connect-src` 只留 `'self'`）。
- **N3 小处**：`open_external` 改成 async 以后，`ShellExecuteW` 跑在没有初始化 COM 的线程上，微软建议先 `CoInitializeEx`（打开 http 链接一般没问题）。可以加一次初始化，或者用 `run_on_main_thread` 交回主线程执行。`set` 每次收尾最多要删 95 个名字，每小时刷新令牌时都会走一遍，现在没有问题，但可以只删上一个头部记的段数加上旧格式的段。`host_is_local` 没有拦解析到本机的公网域名（如 `localtest.me`），不查 DNS 就拦不住，可以接受。
- **N4 范围外**：`tsc -p tsconfig.node.json` 现在报 `supabase/functions/_shared/auth.ts` 的 3 个 TS2339（上一轮还是 0 错误），不是前端 B 的文件，请协调员转后端。另外 `node --test desktop/src-tauri/scripts/` 在本机的 Node 上把目录当成文件跑，会报 1 个失败；要按测试文件头注释写的那样，直接指定 `stage-web.test.mjs`。

### 复核时跑的测试

- `desktop/src-tauri` 下 `cargo test --locked`（正式版）：33 条通过，1 条按 `#[ignore]` 跳过（真机凭据，不写凭据管理器）。
- 同上加 `--features preview`：33 条通过，1 条跳过。
- `node --test desktop/src-tauri/scripts/stage-web.test.mjs`：11 条全过（含 ci-guard 的两个纯函数、仓库现有流水线里没有跳过参数）。
- `npx vitest run tests/shared src/platform`：54 个文件，663 条通过，1 条跳过。
- `tsc -p tsconfig.app.json`、`tsc -p tsconfig.shared.json`：0 错误；`tsc -p tsconfig.node.json`：3 个错误，都在 `supabase/functions/_shared/auth.ts`（N4）。
- `eslint desktop/src-tauri/scripts src/platform shared/logic/calendar tests/shared/calendar eslint.config.js`：0 错误，3 个警告（`push.test.ts` 两处非空断言、`sw-register.test.ts` 超过 300 行），都不在本次改动的重点里。
- 草稿探针（会话临时目录 `cr-b6/probe`）对改后的 `policy.rs`、`session.rs` 复跑：M1 的绕法和 S1 的本地地址全部被拒。没有运行 exe，没有安装，没有往凭据管理器写东西。
