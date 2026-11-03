# B6-exe 代码审查：工作流的隐藏文件检查与 latest.json 版本核对

日期：2026-11-03　审查：代码审查员　被审：运维　记录：主持人照审查员回报落盘（审查员只读，没有写文件）

被审：`git diff HEAD` 里的 `.github/workflows/desktop.yml`、`.github/workflows/release-build.yml`、`build/ci/desktop_scan.mjs`、`tests/build/workflow-permissions.test.ts`、`tests/build/desktop-scan.test.ts`

## 结论：有条件签，8 / 10

工作流本身没问题：隐藏文件检查、两处 if 条件、安装包原名里的版本号核对，在 CI 上都对，本机模拟也都拦得住。扣分是因为测试锁得不够紧，下面三条必改都是改测试或改几行代码，改完可以签 9 / 10。

## 必改

| # | 问题 | 位置 | 改法 |
|---|---|---|---|
| M1 | `checkUploads` 在整个文件里往前找检查步骤（`all.slice(0, i).reverse().find(...)`），有三个漏洞：① 检查步骤和上传步骤中间夹着别的步骤也算过；② 能跨任务匹配；③ 不查有没有 `exit 1`、有没有 `continue-on-error` | `tests/build/workflow-permissions.test.ts` 的 `checkUploads` | 要求上一步（同一任务内）就是检查步骤，里面必须有 `exit 1`，不许有 `continue-on-error`；补三条合成样例：中间夹一步、跨任务、没有 `exit 1` |
| M2 | 真正证明“编进 exe 的版本”的是 bash 里的 `[[ "$orig" != *"_${LEMO_VERSION}_x64-setup.exe" ]]`，可它没有任何测试守着；`opts.version` 比的两边都来自 `LEMO_VERSION` | `.github/workflows/desktop.yml:370-374` | 加静态断言：`id: pkg` 那一步有这句比较，而且排在 `cp "${setups[0]}"` 之前；或者把这段比较挪进 `desktop_scan.mjs`，再写正反例测试 |
| M3 | 上一轮遗留 3 的原意是“文件名和这次的版本号一致”，现在 `opts.files` 只比较“下载地址里的文件名 = out 里唯一的安装包”，两个名字都出自同一个 `$name`，等于自己比自己 | `build/ci/desktop_scan.mjs` 的 `checkLatest` | 加一条检查：文件名等于 `lemomemo[-preview]_${ver}_x64-setup.exe`，前缀和 desktop.yml 取自同一处；补一条“版本号对、文件名里的版本号不对”的反例 |

## 建议

1. `find` 不加 `-L` 就不会跟进符号链接，而 upload-artifact 会跟进。可以改成 `find -L`。这一条是按语义推的，本机没有实测。
2. Tauri 在 Windows 上还会合并 `tauri.windows.conf.json`。这个文件存在就失败，或者在 `builtVersion` 里一并读它。
3. 安装包原名的后缀可以收紧成整串相等（同安全审查 A-2）。
4. `::error::` 只显示第一行。可以先把文件列表打进日志，错误注解里只写数量。
5. 给检查脚本补一条行为测试：在临时目录里造嵌套目录、带空格和换行的文件名，直接跑这段 shell。

## 核对通过的项

- 嵌套目录、带空格、带换行的文件名都拦得下；目录不存在时失败即停（本机用 Git Bash 模拟）。
- ubuntu 任务用 `bash -e`，windows-2025 用 Git Bash，这次没有 pwsh 步骤；PATH 解析错、用上 Windows 的 `find.exe` 时也是失败即停。
- 四处检查的 if 条件和上传步骤一致，都紧挨在上传步骤前面；没有打开 `include-hidden-files`。
- 版本号前缀：`preview.3` 和 `preview.30` 互相拒，`4.0.0` 和 `14.0.0` 互相拒，带中文和空格的原名照常匹配（16 种组合实测）。
- 核对的是这次编译实际用的版本；预览配置里没写 version，有测试锁住。
- release-build 用 workflow_call 调 desktop.yml 的路径没有被破坏。
- `checkLatest` 遇到 0 个或 2 个安装包都拦下。

## 跑过的测试

- `npx vitest run tests/build/workflow-permissions.test.ts tests/build/desktop-scan.test.ts`：29 条全过。
- eslint：0 问题；actionlint：0 问题。
- 本机 Git Bash 模拟（脚本在会话临时目录 `hid\g.sh`）。
- 没有跑 gen-tauri-key.test.ts。

## 采纳情况（主持人，11-03）

- M1～M3 交运维必改，排在 F10 必改之后。
- 建议 1、2、5 交运维一起改；建议 3 和安全审查 A-2 合并，一起改；建议 4 可以顺手做。
- 安全审查的 A-1 和 M2 是同一件事，A-3 一起做。
- 改完由本审查员只看改动、复核签字。

## 复核（11-03，同一审查员，只看改动）

**结论：签，9 / 10。** M1～M3 都解决了，建议 1～5 也都做了，没有新的必改。

| # | 结论 | 核对情况 |
|---|---|---|
| M1 | 已解决 | `steps()` 先按任务切开再切步骤；`checkUploads` 要求上一步 `all[i-1]` 在同一任务里，含 `find -L <path> -name '.*'`、有单独一行 `exit 1`、没有 `continue-on-error`、if 条件相同。合成样例 5 种（中间夹一步、跨任务、没有 `exit 1`、带 `continue-on-error`、不带 `-L`）都拦下；两个真实工作流的 4 处上传都通过 |
| M2 | 已解决，比要求更好 | 比较挪进 `desktop_scan.mjs --package`：`checkPackage` 要求原名整名等于“合并后的 productName_版本_x64-setup.exe”，并核对编译配置的 version；上传文件名只从这条命令的输出取，前缀只在 `setupName` 写一处。正反例和命令行测试都有；静态测试锁住先 `--package` 再 `cp`。本机 `bash -eo pipefail` 实测核对失败时直接退出，`cp` 不执行 |
| M3 | 已解决 | `checkLatest` 要求下载文件名整名等于 `setupName(env, version)`，反例覆盖 `preview.30`、前缀不对、`14.0.0`；out 目录只许有安装包、latest.json、SHA256SUMS 三个文件 |

建议 1～5：`find -L`（符号链接行为测试只在 Linux 跑）；有 `tauri.windows.conf.json` 就失败；整名相等；文件列表先打日志、`::error::` 只写个数；从 desktop.yml 取出检查脚本在临时目录真跑。

**遗留（不挡签字）**
- Tauri 给 NSIS 安装包起名是否原样保留中文和空格（“柠檬记 预览_…”），本机证明不了；猜错的话 CI 在“整理产物”失败，不会放出错包。运维在第一次预览 tag 运行后核一眼原名。
- 带换行文件名、符号链接两条行为测试在 Windows 上跳过，要确认 unit 工作流（ubuntu）会跑 `tests/build/workflow-permissions.test.ts`。

**跑过**：两个测试文件 42 条通过、2 条跳过；eslint、actionlint 0 问题；`--package` 无安装包时退出码 1；参数混用退出码 2。没有跑 gen-tauri-key.test.ts，没有写文件。

**采纳（主持人，11-03）**：两条遗留记入 B6-exe 收尾核对；unit 工作流是否跑这条测试由主持人核对。

## 复核二（11-03，同一审查员）：release-build.yml 的 VAPID 公钥格式核对（接手清单 VAPID-prod-format）

**结论：有条件签，8 / 10**，改完 M1 可签 9。

| # | 问题 | 位置 | 改法 |
|---|---|---|---|
| M1 | `case … *kty*` 排在格式核对前面。本机生成 20000 把真 P-256 公钥，5 把（约 0.025%）恰好含 `kty`，合格也会被当成私钥 JWK 拦下，并提示“私钥已暴露、立刻换钥匙” | release-build.yml 第 86～106 行；deploy-preview.yml 的 B2 O-2 同一写法 | 先正则核格式，通过即放行；不通过时才判断 JWK（`{`、`"`、`kty`）；补“合格且含 kty”正例 |

建议：① 注释改成“脚本输出里不回显”（Actions 会把步骤 `env:` 打进日志折叠头）；② 补只带 `"`、只带 `{` 的用例；③ 脚本开头 `LC_ALL=C`。

核对通过：正则推导（65 字节未压缩点 → 87 字符，首字符 B、第二字符 A～P、末位下标为 4 的倍数），20000 把真公钥全匹配；各类失败即停、只报长度不回显；位置紧挨构建、同任务、无 if、无 continue-on-error，变量与构建注入同源；没有 secrets、没有 `${{ }}` 进 run；SLOW_NODE_TESTS 三行写法一致。

跑过：release-vapid-check、workflow-permissions、coverage 41 过 2 跳；actionlint、eslint 0 问题。

**采纳（主持人，11-03）**：M1 交运维，release-build.yml、deploy-preview.yml 两处一起改；建议 ①～③ 一起做。

## 复核三（11-03，同一审查员，只看 VAPID 改动）

**结论：签，9 / 10。** M1 和建议 ①～③ 都已解决，没有剩余必改。

- M1：两个工作流都先用正则核格式，合格就写 Summary 并 `exit 0`；不合格才判 JWK（`{`、`"`、`kty`），再判 43 字符（可能是私钥的 d），其余报格式不对。正例覆盖中间带 `kty`、开头 `BAkty` 的合格值。
- ① 注释改成“脚本输出里不回显”，写明 Run 表头会展开 `env:`。② 只带 `"`、只带 `{`、43 字符反例和 42、44 字符对照都有。③ `export LC_ALL=C` 是第一条非注释语句，有测试锁住。
- deploy-preview 开关：true 时变量为空失败，false 时只警告，两种都有测试。核对步骤紧挨构建、同任务、无 if、无 continue-on-error，变量与构建注入同源。
- 建议（不挡签）：登记册、接手清单里的旧文件名 `release-vapid-check.test.ts` 改成新名。**主持人已改。**

**跑过**：vapid-public-key-check、workflow-permissions、coverage 48 过 2 跳；actionlint、eslint 0 问题。只读。
