# 数据备份

**规则**：每次开始做新版本之前，以及每次发布之前，都要备份一次（[ADR-009](../../docs/04-决策/ADR-009-每个版本前备份数据和源码.md)）。

## 文件夹命名
`YYYY-MM-DD_<时机>/`，例如 `2026-10-23_v3开发前/`、`2026-10-24_v3发布前/`。里面有：
- `events/`、`todos/`、`logs/`：每条数据一个 JSON 文件（由 Claude 用 ArtifactData 的 `out_dir` 导出）

**R-105 起（2026-10-28）这里只是临时中转**：版本前备份加密后，这个文件夹里的明文会被删掉；正式的备份是 `E:\柠檬记-备份\版本前\<日期>_<时机>.7z`（7-Zip AES-256、`-mhe=on`），`清单.json` 在压缩包里（备份时间、线上地址、每个集合的条数、git 提交、bundle 的 SHA256、加密前恢复测试的结果）。

## 怎么备份（版本前、发布前）
1. 主持人用 ArtifactData `list` 把 `events`、`todos`、`logs` 导出到本文件夹的 `<日期>_<时机>/`；
2. 运行 `python build/backup.py <时机>`（只备份源码加 `--no-data`）：打 git bundle 并校验、从 bundle clone 做一次恢复测试，把 bundle、数据和 `清单.json` 放进暂存目录 `E:\柠檬记-备份\暂存\<日期>_<时机>\`。**脚本不加密**；
3. **负责人本人**在自己的 PowerShell 里运行脚本打印出来的那条命令（`build/backup_encrypt.ps1`）：7-Zip 会提示输入密码（密码存在负责人 iPhone 的“密码”App 里，不告诉 AI、不写进任何文件），打包、测试通过后自动删掉暂存目录和本文件夹里的明文；
4. 负责人把脚本最后输出的路径、大小、SHA256 发给主持人，记进 [发布记录](../../docs/08-发布/发布记录.md)。

## 怎么恢复
先由负责人用 7-Zip 解开 `.7z`（输入密码）到临时文件夹；源码用 `git -c core.longpaths=true clone <bundle 文件> 待办APP`（仓库有超长路径，不加会检出失败）。用完即删解开的明文。数据：把要恢复的 JSON 交给 Claude，用 ArtifactData `batch` 写回（已存在的文档要带 if_version）。迁到独立服务器时，用 [migrations/](../migrations/) 里的脚本导入。

本文件夹里除本 README 以外的内容都**不进 git**（真实个人数据）。
