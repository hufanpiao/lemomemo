# 数据结构（JSON Schema）

- [events.schema.json](events.schema.json)：日程
- [todos.schema.json](todos.schema.json)：待办
- [logs.schema.json](logs.schema.json)：运行日志（v3）

和 [数据字典](../../docs/05-数据字典/数据字典.md) 是同一套定义：数据字典给人看，这里给程序用（测试、以后的服务器接口校验、迁移脚本）。改字段时两边一起改，并在数据字典里写明起始版本。标“v3”的字段在 v3 发布后才会出现在真实数据里。
