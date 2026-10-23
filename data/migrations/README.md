# 数据迁移脚本

每次数据结构有不兼容的变化，或者要把数据从 claude.ai 搬到独立服务器时，在这里加一个脚本，文件名带序号和日期，例如 `001_2026-10-24_v3提醒字段.md` 或 `.py`。

- v3 新增的字段（remindMin、remindDays、snoozeAt、notifiedFor、deletedAt、待办的 note）都有默认值，由页面的 `data/normalize.js` 在读取时补齐，**不需要迁移脚本**。
- 阶段 3（独立后端）开始时，在这里写“claude.ai 备份 JSON → 新数据库”的导入脚本。
