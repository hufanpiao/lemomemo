# 测试说明

所有命令都在项目根目录 `D:\claude code\待办APP` 下运行。

## 1. 单元测试（Node 18+）

```
node tests/unit/parse-quick.test.mjs
```

- 测的是一句话解析 `parseQuick`，“今天”固定为 2026-10-23（周五），项目名单为 SignPlex、NEOX、SOIL STUDIO。
- 两类检查：
  - **固定用例**：7 句常用说法，预期结果取自 v2 线上版本的实际输出；
  - **与 v2 对照**：从冻结的 `archive/releases/v2/planner.html` 里抽出原版 `parseQuick`，和 `src/` 里的新版逐条比对（含 27 句额外说法）。
- 全部通过时退出码为 0，有失败为 1。

## 2. 浏览器测试页

先构建：

```
python build/build.py
```

会生成：

| 文件 | 用途 |
| --- | --- |
| `dist/test.html` | 使用模拟存储适配器 `mock-db`（`tests/mock/mock-db.js`），不需要 claude.ai，日常调试用 |
| `dist/test-claude.html` | 与发布版完全相同的页面 + `window.claude` 桩（`tests/mock/claude-stub.js`），用来验证 `claude-db` 适配器 |

两个测试页都套了 `tests/harness/skeleton.html` 外壳（doctype、charset、viewport），模拟发布平台给单文件页面补上的那一层。
示例数据按打开页面那天的日期和时间生成，刷新即重置。

用预览工具启动 `D:\claude code\.claude\launch.json` 里的 `planner-test` 服务（端口 8770，根目录为项目根），然后打开：

- http://localhost:8770/dist/test.html
- http://localhost:8770/dist/test-claude.html

建议检查：手机宽度（375×812）和电脑宽度（1280×820）、浅色和深色；页面能渲染、控制台无报错、点“＋”能打开弹出层。
