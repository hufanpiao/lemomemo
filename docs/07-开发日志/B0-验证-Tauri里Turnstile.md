# B0 验证：Tauri 里 Turnstile 能不能用

日期：2026-10-28　负责：前端 B　对应：架构 5.10、测试用例 TC-B0-65

## 结论（截至今天）

**还没有结论，只完成了一半。**

- 已做：在浏览器里做了对照测试。页面套用 5.10 的 CSP 时，Turnstile 能加载、能出题，测试 key 也能通过。
- 没做：真正在 Tauri 窗口（`http://tauri.localhost`）里跑。原因是这台机器没有 Rust 和 MSVC Build Tools，装它们需要管理员权限，任务要求不装。

所以 TC-B0-65 现在是"待办"，不能算通过。

## 工程文件

位置：`desktop/turnstile-probe/`。这只是验证用的最小壳，正式的 exe 在 B6 做。

| 文件 | 作用 |
|---|---|
| `dist/index.html` | 验证页面：选 sitekey、渲染小部件、显示日志。meta CSP 和 5.10 一样，只是把 `style-src` 收紧到 `'self'` |
| `dist/probe.js` | 记录页面来源、`__TAURI__` 是否存在、CSP 拦截，以及 Turnstile 的各个回调。令牌只记长度和前 8 位 |
| `dist/probe.css` | 样式 |
| `src-tauri/Cargo.toml` | tauri 2.12.5、tauri-build 2.7.4 |
| `src-tauri/tauri.conf.json` | 窗口标签 `auth`；`withGlobalTauri: false`；CSP 用 5.10 的原文；不打包 |
| `src-tauri/capabilities/default.json` | 只给 `auth` 窗口，权限为空 |
| `src-tauri/src/main.rs`、`build.rs` | 最简启动，没有命令也没有插件 |
| `src-tauri/icons/icon.ico` | 占位图标（tauri-build 必须要有） |

## 浏览器对照测试（已完成）

做法：用 `python -m http.server 8791 --bind 127.0.0.1` 打开 `dist/`，在内置浏览器里访问 `http://127.0.0.1:8791/index.html`。

| 测试 sitekey | 预期 | 实际结果 |
|---|---|---|
| `1x00000000000000000000AA` | 直接通过 | 通过。令牌长度 21，前 8 位 `XXXX.DUM` |
| `3x00000000000000000000FF` | 出交互题 | 小部件出现，等人点击（自动化没有替人点，符合预期） |
| `2x00000000000000000000AB` | 直接失败 | 没有测，留到 Tauri 里一起测 |

- 整个过程中 CSP 没有拦截任何东西。
- `window.__TAURI__` 不存在。

**这只能说明 5.10 的 CSP 本身不会挡住 Turnstile，不能说明 WebView2 加上 `tauri.localhost` 也没问题。**

## Tauri 里怎么验证（请产品负责人或有权限的人来做）

1. **装工具链**（需要管理员权限）：
   - 装 Rust：`rustup`，用 stable 和 `x86_64-pc-windows-msvc`；
   - 装 Visual Studio Build Tools，勾选"使用 C++ 的桌面开发"；
   - WebView2 在 Windows 11 自带，不用另装。
2. **启动**：在 `desktop/turnstile-probe/src-tauri` 下运行 `npx @tauri-apps/cli@2 dev`。第一次编译大约要 5–10 分钟。
3. **确认来源**：日志第一行应显示页面来源是 `http://tauri.localhost`，并且 `__TAURI__` 不存在。
4. **测三把测试 key**：
   - `1x…AA` 应该通过；
   - `2x…AB` 应该报错；
   - `3x…FF` 应该能手动点过。
   每一把都要截图保存日志。日志里不能出现 "CSP 拦截"。
5. **用真 sitekey 测**：
   - 测试 key 不检查域名，所以这一步不能省。
   - 产品负责人在 Cloudflare 控制台里，给 Turnstile 小部件的 Hostname 加上 `tauri.localhost`。
   - 然后在页面里选"自定义"，填入真 sitekey。sitekey 是公开的；secret 不交给 AI。
   - 如果报错码 `110200`，说明这个域名没有被允许，Turnstile 不接受 `tauri.localhost`。
6. **服务端校验**：
   - 测试 secret 是 `1x0000000000000000000000000000000AA`，用它和测试令牌一起发给 `https://challenges.cloudflare.com/turnstile/v0/siteverify`。
   - 命令：`curl -X POST -d "secret=…&response=…"`。
   - 返回里应该有 `success:true`。
   - 真 secret 的校验由后端在预览环境里做。
7. **提交 lock 文件**：第一次编译成功后，把生成的 `src-tauri/Cargo.lock` 一并提交（8.3 要求 `--locked`）。

## 结果怎么分（TC-B0-65）

- **能用**：exe 里的登录照原计划，在 `auth` 窗口内完成 Turnstile。
- **不能用**（比如 `110200`，或者 WebView2 里一直加载不出来）：改成用系统浏览器登录，再回跳到 exe。预计多花 2–3 人日。由架构师决定，并更新 5.10。

## 待办

- [ ] 装好工具链后，按上面第 2–6 步跑一遍，把结果补进本文件
- [ ] 提交 `Cargo.lock`
- [ ] 真 sitekey 的 Hostname 设置（产品负责人）
