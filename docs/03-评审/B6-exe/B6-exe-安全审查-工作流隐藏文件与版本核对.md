# B6-exe 安全审查：工作流的隐藏文件检查与 latest.json 版本核对

日期：2026-11-03　审查：安全审查员　被审：运维　记录：主持人照审查员回报落盘（审查员只读，没有写文件）

被审：`git diff HEAD` 里的 `.github/workflows/desktop.yml`、`.github/workflows/release-build.yml`、`build/ci/desktop_scan.mjs`、`tests/build/workflow-permissions.test.ts`、`tests/build/desktop-scan.test.ts`。对照上一轮的 [B6-exe-安全审查-desktop与release-build工作流.md](B6-exe-安全审查-desktop与release-build工作流.md)。

## 结论：通过

没有必改项。

## 建议（都不卡结论）

- **A-1 版本号比对其实是自己比自己。** desktop.yml 第 308 行已经用 `$LEMO_VERSION` 改写了 tauri.conf.json，latest.json 的 version 也来自 `$LEMO_VERSION`，所以 CI 里 `builtVersion` 和 `opts.version` 永远相等。真正能证明“编进去的版本等于 latest.json 的版本”的，是 shell 里新加的 `orig` 检查：Tauri 按合并后的 version 给 NSIS 安装包起名。建议在 workflow-permissions.test.ts 里加一条静态断言，钉住 `[[ "$orig" != *"_${LEMO_VERSION}_x64-setup.exe" ]]` 这段还在，而且在 `cp` 之前。
- **A-2** `orig` 只比了后缀，可以改成整名相等：正式是 `柠檬记_${LEMO_VERSION}_x64-setup.exe`，预览是 `柠檬记 预览_${LEMO_VERSION}_x64-setup.exe`。价值不高，因为环境扫描已经覆盖了这种情况。
- **A-3** `opts.files` 可以要求 out 目录里正好是安装包、latest.json、SHA256SUMS 三样，多出别的文件就失败。
- **A-4（遗留，不是这次引入的）** `desktop_scan` 扫的是 `target/release/*.exe`，不是最后分发的 NSIS 安装包。“安装包里装的就是被扫过的那个 exe”目前只靠同一次编译来保证。

## 逐点判断

1. **脚本注入：没有。** 新加的 4 个 run 步骤里没有 `${{ }}`，只用固定目录名；`orig` 检查用 env 传进来的 `$LEMO_VERSION`，加了引号，按字面比较。核对过 `_14.0.0_` 匹配不上 `*_4.0.0_x64-setup.exe`。
2. **权限：没有变宽。** 顶层还是 `permissions: {}`，新步骤不用机密。
3. **第三方 action：没有新增。** upload-artifact 仍钉在 `cf430e03…`（v7.0.2）。
4. **能不能防“发错包”：同一次运行里的错配防得住。** 四道关串起来：安装包正好 1 个；原名里的版本等于这次的版本；latest.json 的 url 指向改名后的文件；`checkLatest` 要求 url 的文件名就是 out 里唯一的安装包，并且和 env.rs 同源、同目录。跨运行的调包要靠 publish.ps1 按 Summary 里的 SHA256 核对，这一层没变。
5. **日志不会泄露。** 报错只打印点开头文件的相对路径。`find` 输出的每一行都以起始目录开头，不能以 `::` 开头，所以伪造不了工作流命令。目录不存在时，`bash -e` 会让这一步失败，不会放行。
6. **上一轮签过的安全性质没有回退。** 只读权限、W-3 产物交叉比对、W-2 复用网页、download-artifact 的路径都没动；每个上传步骤前都检查同一个目录，`if` 条件一致，没有打开 `include-hidden-files`。

## 跑过什么

- 5 个文件逐个看了 diff；tauri.conf.json、tauri.preview.conf.json、env.rs 没有未提交的改动。
- `npx vitest run tests/build/workflow-permissions.test.ts tests/build/desktop-scan.test.ts`：29 项全过。
- 没有跑 gen-tauri-key.test.ts，没有推送，没有触发工作流。

## 采纳情况（主持人，11-03）

- A-1：交运维，补静态断言，和代码审查的意见一起改。
- A-2、A-3：交运维，可以顺手做。
- A-4：记作遗留，放到 B6-exe 收尾时再看。

## 复核（11-03，同一审查员）

**结论：通过，没有必改。**
- A-1：版本证明挪进 `desktop_scan.mjs --package`，原名整名相等；静态测试钉住先 `--package` 再 `cp`、只有一个 `name=`、不另拼前缀、不许 `continue-on-error`；失败时退出码 1、标准输出空，bash `-e` 让这一步失败。
- A-2：产品名取自合并后的配置，整名等于 `<产品名>_<版本>_x64-setup.exe`；有 `tauri.windows.conf.json` 就失败；文件名只在 `setupName` 拼。
- A-3：out 目录只许安装包、latest.json、SHA256SUMS 三样。
- 注入、权限、日志：没有新的 `${{ }}` 进 run；`LEMO_VERSION` 已校验格式；报错只打印文件名。
- 待实测：第一次真跑 desktop.yml 时核对“柠檬记 预览”安装包原名。A-4 仍按原定放到 B6-exe 收尾。

**跑过**：workflow-permissions、desktop-scan 42 通过、2 跳过。只读。
