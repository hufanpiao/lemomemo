# B6-exe 安全审查：F10 签名密钥脚本

日期：2026-11-03　审查：安全审查员　被审：运维　记录：主持人照审查员回报落盘（审查员只读，没有写文件）

被审文件：`tools/keys/gen-tauri-key.ps1`、`tests/build/gen-tauri-key.test.ts`、`tests/build/gen-tauri-key-fake-signer.cs`、`tests/build/keys-guard-sync.test.ts`、`docs/00-团队/负责人-Tauri签名密钥-步骤.md`。全程只读，没有下载或运行任何外部程序。

## 结论：有条件通过

M1～M4 改完，才可以交负责人跑预览；M5 要在跑正式那次之前改完。

## 必改

| # | 问题 | 改法 |
|---|---|---|
| M1 | **空密码检测实际不起作用**。读了 tauri-cli 的 `signer/generate.rs`、`helpers/updater_signature.rs`，以及 rust-minisign 的 `keypair.rs`、`helpers.rs`、`secret_key.rs`：直接按回车时，`get_password` 不拒绝空密码，`encrypt` 照样跑 scrypt，`kdf_alg` 仍是 `Sc`。设了 `CI` 时密码是 `Some("")`，结果一样。所以真签名工具给出的空密码私钥标记仍是 `EdScB2`，脚本第 260 行判断 `Ed\0\0B2` 的分支永远走不到，空密码私钥会被当成“加密的”收下 | 空密码时 `get_password` 会往标准输出打印 `<empty>`，正好被收进 `$rawOut`。在 `Get-AfterLabel` 之前判断：有一行 Trim 后等于 `<empty>` 就 Fail（密码为空）。原来的 `Ed\0\0B2` 判断留着兜底。假签名工具、测试、帮助块、`Assert-CleanEnv` 的注释（“CI 会生成不加密的私钥”改成“会用空密码加密、不问密码”）、步骤文档第六节，都同步改。第一次用真签名工具跑 `-Practice` 时，故意按一次空回车，确认会被拦下 |
| M2 | **步骤文档让负责人在 iPhone 上粘贴、复制核对**（第三节第 4、5 步，第二节第 5 条）。电脑的剪贴板到不了 iPhone，除非打开跨设备共享、Phone Link，或者用聊天软件、邮件转一下。前两样脚本明确要求关掉，最后一种正是要防的事 | 只能在运行脚本的这台电脑的浏览器里打开 passwords.google.com 操作。另加一句：不要用微信、KakaoTalk、邮件、备忘录把私钥传到手机 |
| M3 | **浏览器里的 AI 扩展查不出来**。Google 密码管理器的页面上有私钥和“显示密码”，Claude in Chrome 一类的扩展能读页面、截图，`Assert-NoClaude` 只查进程 | 步骤文档第二节第 2 条加上：停用浏览器里的 Claude 扩展和其他 AI、读页面类扩展，或换一个没装扩展的浏览器配置。脚本放剪贴板前的提示语里也加一句 |
| M4 | **只有真放过私钥才该清剪贴板历史；测试不能清真机的剪贴板**。`Clear-Clip` 在 finally 里无条件执行，并调用 WinRT 的 `Clipboard::ClearHistory()`。开头检查一失败（比如“剪贴板历史开着”），负责人的整个剪贴板历史就被清掉，这是删用户数据。测试外壳只屏蔽了 `Set-Clipboard` 和 `Add-Type`，没屏蔽 `ClearHistory`；“-File 正常运行”那条用例会用真的 `Set-Clipboard` 和 `ClearHistory` 清掉开发机的剪贴板 | 加 `$clipUsed` 标志，第 389 行放过私钥之后才置真；finally 里只在它为真时清剪贴板、清历史。测试里把清剪贴板换成假的，第三条用例断言没有调用清剪贴板 |
| M5 | **（正式那次之前改）写 U 盘要真正落盘**。`WriteAllText` 写完马上 `ReadAllText` 读回，读到的很可能是系统缓存。负责人照提示马上拔盘，文件可能是坏的，而这是正式私钥两份副本之一 | 用 `FileStream(..., FileMode.CreateNew)` 写，顺带原子地拒绝覆盖；写完 `Flush($true)`；文档写“先在任务栏‘安全删除硬件’弹出 U 盘，再拔” |

## 建议（不卡交付）

- S1：放私钥时改用 `DataObject`，加 `ExcludeClipboardContentFromMonitorProcessing`、`CanIncludeInClipboardHistory`（DWORD 0）、`CanUploadToCloudClipboard`（DWORD 0）三个格式。就算历史或同步的检查漏了，也还有一层。
- S2：用 `[Console]::KeyAvailable` 轮询代替 `Read-Host`，120 秒没按回车就自动清空，并提示重来。
- S3：子进程的环境变量改成白名单，只留 `SystemRoot`、`windir`、`TEMP`、`TMP`、`USERPROFILE`、`LOCALAPPDATA`、`PATH`。
- S4：核哈希时用 `FileShare.Read` 打开文件，一直拿着句柄，到进程启动之后再关；`WorkingDirectory` 设成 exe 所在目录；文档写明这个文件夹里只放 `cargo-tauri.exe`，防止 DLL 劫持。
- S5：脚本自己打印的哈希不可靠。文档第三节第 1 步之前加一步：先单独运行 `Get-FileHash`，和审查记录核对。
- S6：测试开关 `LEMO_TEST_SIGNER=1` 要求 `-LockFile`、`-UsbRootForTest` 都在 `%TEMP%` 下，并在开头醒目地打印“测试模式”。
- S7：文档第六节“截图发给主持人”改成“复制报错文字，发之前确认里面没有一长串字母数字”。
- S8：私钥密码存在同一条记录的备注里，可以接受（拆成两条，安全收益很小）。密码用 4 个以上的随机词、手打，不用密码管理器生成再复制。
- S9：`-Practice` 加一个可选项，用要丢掉的钥匙走一遍“进剪贴板 → 存进去 → 复制回来核对”，确认 Google 密码管理器存得下约 348 个字符。
- S10：注释里的“八处”改成“九处”，等主持人定了再九个文件一起改。

## 对 7 个问题的判断

1. **剪贴板：可以接受。** 没有更好、负责人又能实际操作的做法：手打 348 个字符不现实；屏幕显示或二维码会暴露在屏幕和截图里；CSV 导入要先写明文文件。前提是改完 M2～M4，最好再加 S1、S2。剩下的风险是同一用户下的程序在那几秒里能读剪贴板，在文档里写明即可。
2. **Assert-NoClaude：推荐保留，只在这个脚本里保留。** 理由：其他脚本处理的是用完就删、能重新生成的令牌，这把是正式更新签名私钥，泄露后换不了；这是唯一会把私钥放进剪贴板的脚本，本机 Claude 会话确实有读剪贴板、截屏的能力；任务单 R4（11-03）晚于 R-223（10-29），而且专门针对这一件事。局限是查不到浏览器扩展（见 M3），也查不到 WSL 里跑的 Claude。最后由负责人决定（明早清单第 74 条）。
3. **环境变量：够用，建议改成白名单（S3）。** `generate` 只从 `CI` 读取 `--ci`，密码只从 `-p` 读，不读 `TAURI_SIGNING_*`。`ProcessStartInfo.EnvironmentVariables` 在 Windows 上不分大小写。
4. **U 盘：没有能用来伤害负责人的绕过办法。** 小缝有三处：先查后写不是原子的（M5）；读回证明不了已经落盘（M5）；中途换 U 盘不会再核对一次，可以接受。subst 盘、网络盘的类型不是 2，会被拒。
5. **遮盖：可靠。** 40 个字符以上的 base64 正则能盖住整个私钥。`$error`、报错位置信息、transcript、模块日志（开头已按策略拦下）、脚本块日志、AMSI、进程日志逐条看过，都不会漏。剩下的风险是字符串没法清零、页面文件里可能有残留，和 VAPID 那次同一种，接受。
6. **签名工具：推荐锁 exe，zip 也记下。** tauri-cli-v2.12.4 的发布页只有 `cargo-tauri-x86_64-pc-windows-msvc.zip`，页面上的 sha256 是 GitHub 上传时算的摘要，不是签名。做法：
   1. 下载 zip，核对发布页的摘要；
   2. 解压，算 exe 的 SHA-256；
   3. 安全审查员独立重做第 1、2 步，两人的值一致；
   4. 锁文件写 exe 的哈希；
   5. 另记 zip 的文件名、哈希和 release tag；
   6. 记下 `Get-AuthenticodeSignature` 的结果。
7. **步骤文档：有两处会诱导不安全的做法**，就是 iPhone（M2）和浏览器扩展（M3）；另有“截图”一处小问题（S7）。其余没有问题。

## 跑过什么

- `npx vitest run tests/build/keys-guard-sync.test.ts tests/build/gen-tauri-key.test.ts -t "静态检查|安全窗口检查"`：7 条通过，15 条跳过。会真正启动 PowerShell 的 15 条有意没跑，原因见 M4。
- 只读了公开源码和页面：tauri-cli 的 `signer/generate.rs`、`helpers/updater_signature.rs`；rust-minisign 的 `keypair.rs`、`helpers.rs`、`secret_key.rs`；tauri-cli-v2.12.4 的发布页。
- 待实测（真签名工具选定后跑 `-Practice` 时确认）：问密码的提示能在屏幕上看到；空回车被 M1 拦下；Google 密码管理器存得下约 348 个字符。

## 采纳情况（主持人，11-03）

- M1～M5 全部交运维必改，M4 最先改。改好之前，各组跑全量 vitest 时先排除 `gen-tauri-key.test.ts`，已通知前端 A、前端 B、后端。
- S1～S7、S9 交运维这次一起改；S10 等 BE-1 加 O-1 那一批提交以后再改。
- 第 2 点 Assert-NoClaude、S8 私钥密码存哪：写进明早清单第 74 条，由负责人定。
- 第 6 点：按推荐锁 exe、zip 也记下。下载签名工具要负责人同意，到时候另外问。

## 复核（11-03，同一审查员）

**结论：通过，没有必改。** 按 R-298 口径复核。可以做冻结副本、算哈希，再交负责人运行；正式那次前提：签名工具选好写进锁文件，并用真签名工具跑过一次 `-Practice -PracticeSave`。

M1～M5、S1～S7、S9 逐条对过代码和文档，都已落地（空密码 `<empty>` 判断、只在这台电脑浏览器操作、停用浏览器 AI 扩展、`$clipUsed`、`CreateNew`+`Flush`、三个排除标记、120 秒超时、环境变量白名单、`FileShare.Read` 句柄、先单独 `Get-FileHash`、测试路径限 `%TEMP%`、不截图、`-PracticeSave`）。R-298：`Assert-SafeWindow` 不调 `Assert-NoClaude`，keys-guard-sync 断言九个脚本都不调。

**剩余（建议，不卡结论）**
1. `Set-ClipSecret` 失败时提示“什么都没存”，正式那次 U 盘已写好，说法不对，改成分两种情况。
2. 待实测：三个排除标记在真机上是否被系统认出（第二层保护）。
3. 待实测：`Wait-Enter` 里按 Ctrl+C，finally 是否执行（练习时按一次）。
4. 从 Google 密码管理器复制回来核对的那一下不带排除标记，靠开头的历史、跨设备检查兜住，文档已写。

**跑过**：确认测试不碰真剪贴板后，keys-guard-sync 和 gen-tauri-key 34 条全过。只读。

**采纳（主持人，11-03）**：第 1 条交运维；第 2、3 条并入第一次真签名工具 `-Practice` 实测清单。

## 复核二（11-03，同一审查员）：F10 收尾

**结论：有条件通过。** 脚本三处改动都没问题（`Set-ClipSecret` 按 `$script:usbDir` 分两种说法、删 CI 半句、超时与对不上分开计数，作用域正确），剪贴板两个函数与上轮一致。选型说明第二节第 5 步不会暴露真私钥（只用 `-Practice` 练习钥匙，另开窗口只打印格式名和长度），但有两处必改：
1. 写成“脚本会查 Claude”不对（R-298 后不查），会让负责人以为有自动兜底；改成运行前自己退出 Claude、停用浏览器 AI 扩展。
2. “按 Win+V”验证不了，还可能诱导负责人在剪贴板放着私钥时打开历史；删掉，或写明“只会提示已关，不要点打开”。
建议：Ctrl+C 那步写明先看到绿色提示再查长度。

## 复核三（11-03，同一审查员）：release-build.yml 的 VAPID 公钥核对

**结论：通过，没有必改。** 位置、正则（与 set-vapid-keys.ps1、deploy-preview 一致）、只经 env 传值、报错只给长度都对。建议：① “不回显”只指脚本输出，Actions 的 Run 表头会展开 `env:`，vars 不遮，记录里别写成“日志里看不到”（deploy-preview 同）；② 长度正好 43 时提示“可能是私钥的 d”。
（注：代码审查复核另查出 `*kty*` 误伤约 0.025% 的真公钥，见工作流代码审查记录“复核二”，已交运维两处一起改。）

**跑过**：gen-tauri-key、keys-guard-sync、release-vapid-check、workflow-permissions 65 过 2 跳；先确认测试模式不碰真剪贴板。只读。

**采纳（主持人，11-03）**：必改 1、2 与代码审查复核三的文字问题合并交运维；建议都交运维一起做。
