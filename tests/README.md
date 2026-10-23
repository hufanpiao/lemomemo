# 测试说明

所有命令都在项目根目录 `D:\claude code\待办APP` 下运行。

## 一次跑完

```
node tests/run-all.mjs
```

依次跑 `tests/unit/` 下的全部单元测试，再跑架构检查自检。任何一项失败，退出码为 1。

## 1. 单元测试（Node 18+，不需要浏览器）

| 文件 | 测什么 |
|---|---|
| `unit/parse-quick.test.mjs` | 一句话解析：7 句必测 + 27 句其他说法 + 拆出来的步骤函数。“今天”固定为 2026-10-23（周五），预期值写死；v3 改解析规则时改对应行 |
| `unit/date.test.mjs` | `core/date.js` 日期工具；`core/clock.js` 的 tick / wake / 跨天事件（假 env 驱动） |
| `unit/sort.test.mjs` | `pickNext`“下一件事”、待办排序、`logic/items.js` 的判断、`logic/format.js` 的文案 |
| `unit/normalize.test.mjs` | 快照字段整理：类型、补零、长度、deletedAt、id 以文档 id 为准、坏数据不抛错 |
| `unit/write.test.mjs` | 写入层（接 mock-db）：软删除和撤销、失败回滚和重试、10 秒超时、batch、新建、连不上、断线重连 |
| `unit/adapter-contract.test.mjs` | 存储适配器契约：同一套用例跑 mock-db 和 claude-db（接 `mock/claude-stub.js`）。以后加 REST 适配器时，在 `ADAPTERS` 里加一项 |

单个文件可以单独跑，例如 `node tests/unit/write.test.mjs`。公共工具在 `lib/harness.mjs`：`loadApp()` 按构建时的方式把源码加载进 Node 的 vm，`fakeClock()` 固定“现在”。

## 2. 架构检查自检

```
python build/check_arch.py --self-test
```

`arch-fixtures/` 里每个文件都是一段**故意违规**的示例。文件头的 `@fixture 路径=… 期望=…` 说明它冒充哪个源码文件、应该被哪条规则拦住。自检时把它逐个加进检查，期望的规则必须报出来；W1（超过 250 行）由自检临时生成。规则说明见 `docs/10-架构/架构约定.md`。

## 3. 浏览器测试页

先构建：`python build/build.py`。构建会先跑架构检查，然后生成：

| 文件 | 用途 |
|---|---|
| `dist/test.html` | 使用模拟存储适配器 `mock-db`（`mock/mock-db.js`），不需要 claude.ai，日常调试用 |
| `dist/test-claude.html` | 与发布版完全相同的页面 + `window.claude` 桩（`mock/claude-stub.js`），验证 `claude-db` 适配器 |

- 两个测试页的示例数据都来自 `mock/sample-data.js`，按打开页面的日期和时间生成，刷新即重置。
- 外壳用的是 `harness/skeleton.html`（doctype、charset、viewport），模拟发布平台给单文件页面补上的那一层。

用预览工具启动 `D:\claude code\.claude\launch.json` 里的 `planner-test` 服务（端口 8770，根目录为项目根），然后打开：

- http://localhost:8770/dist/test.html
- http://localhost:8770/dist/test-claude.html

检查要求：手机宽度（375×812）和电脑宽度（1280×820）、浅色和深色都要看。页面能正常渲染、控制台无报错；新建、勾选、编辑、删除加撤销、改期都能走通；提示条能叠放，最多 3 条。
