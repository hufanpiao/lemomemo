# M4：用 `4.0.0-preview.1` 实打一次 NSIS（B6-exe 开工第一天）

日期：2026-11-03　执行：前端 B　依据：B6-exe 任务单 F1、R12、D0～D1；架构审 M4；架构 8.5

## 结论：**能打、能装、能启动、能干净卸载**

带预发布段的版本号 `4.0.0-preview.1` 打 NSIS 没有问题，可以照 8.5 的 `4.0.0-preview.<run>` 走。

## 怎么打的

- 工程：把 `desktop/turnstile-probe/` 复制到临时目录（不动仓库），只改了 `productName`（Lemo NSIS M4 Probe）、`identifier`（com.lemomemo.nsis-m4-probe）、`version`（`4.0.0-preview.1`，Cargo.toml 同步）和 `bundle`（`active: true`、`targets: ["nsis"]`、`installMode: currentUser`）。正式的 `desktop/src-tauri/` 还没建，这次只验版本号和打包链路。
- 命令：`npx @tauri-apps/cli@2.12.3 build --bundles nsis`（CLI 没装进仓库，`package.json` 没改）。
- **没签名**：没有配置更新器，打包不需要任何签名钥；环境里没有 `TAURI_SIGNING_PRIVATE_KEY`，也没生成过测试钥，没有私钥文件落盘。
- 打包时 Tauri 自己下载了 NSIS 工具，并校验了哈希（日志里两次 `validating hash`）。CI 上同样会下载；运维锁工具版本时一并考虑（F9）。

## 结果

| 项 | 结果 |
|---|---|
| 安装包 | `Lemo NSIS M4 Probe_4.0.0-preview.1_x64-setup.exe`，**1.79 MiB**（1,876,226 字节），SHA-256 `fa68ea3376d36173b0cdc8d5a42fa2caa8830e47e6d9d49d560ed59ca628a305` |
| 编译 | 从零编译 release 约 1 分 12 秒（依赖已在本机缓存的情况下） |
| 静默安装 `/S` | 退出码 0；当前用户模式，**没弹 UAC**；装到 `%LOCALAPPDATA%\Lemo NSIS M4 Probe\`（主程序 8.6 MB + uninstall.exe） |
| 注册表 | `HKCU\…\Uninstall` 里 `DisplayVersion` = **`4.0.0-preview.1`**，原样保留预发布段 |
| 启动 | 装好的程序能启动，窗口加载 `http://tauri.localhost/`，标题正确 |
| 静默卸载 `/S` | 退出码 0；安装目录、卸载注册表项、开始菜单快捷方式都删掉了 |
| **卸载后残留** | **WebView2 数据目录 `%LOCALAPPDATA%\<identifier>\` 静默卸载时默认保留**（Tauri NSIS 只在用户勾“删除应用数据”时才删）。正式 exe 里这里会有 IndexedDB（本机缓存、离线队列）和会话以外的网页数据，卸载要不要删、提示怎么写，请架构师在 5.10 定（见回报） |

- 测试完已删掉这次的 WebView2 数据目录并核对不在。
- MSI 不接受 `-preview.N` 这一点这次**没有实测**（要另外下载 WiX）；任务单已定只打 NSIS，不影响。
