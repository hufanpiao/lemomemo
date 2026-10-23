# 数据备份

**规则**：每次开始做新版本之前，以及每次发布之前，都要备份一次（[ADR-009](../../docs/04-决策/ADR-009-每个版本前备份数据和源码.md)）。

## 文件夹命名
`YYYY-MM-DD_<时机>/`，例如 `2026-10-23_v3开发前/`、`2026-10-24_v3发布前/`。里面有：
- `events/`、`todos/`：每条数据一个 JSON 文件（由 Claude 用 ArtifactData 的 `out_dir` 导出）
- `清单.json`：备份时间、线上地址、每个集合的条数、对应的 git 提交

## 怎么备份
跟 Claude 说“备份一下”，或者在开始新版本、发布前由 Claude 自动执行：
1. 用 ArtifactData `list` 把 `events`、`todos` 两个集合导出到本文件夹；
2. 运行 `python build/backup.py <时机>`：写 `清单.json`，同时把源码打包到项目外的 `D:\claude code\待办APP-备份\源码\`；
3. 在 [发布记录](../../docs/08-发布/发布记录.md) 里记一笔。

## 怎么恢复
把要恢复的 JSON 交给 Claude，用 ArtifactData `batch` 写回（已存在的文档要带 if_version）。迁到独立服务器时，用 [migrations/](../migrations/) 里的脚本导入。

本文件夹里除本 README 以外的内容都**不进 git**（真实个人数据）。
