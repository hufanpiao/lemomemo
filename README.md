# 待办APP（日程与待办）

一个中文的个人「日程与待办」网页 App：一个页面同时管理日程（events）和待办（todos），支持一句话录入、项目颜色、“今天”视图和“没赶上”顺延区。Claude 也可以在聊天里直接往同一个数据库里记事。

- 线上地址（claude.ai 版）：https://claude.ai/artifact/MVXvnr3rFUxgFKZesXWGVT（仅本人可见）
- 数据：claude.ai 云端数据库，两个集合 `events`、`todos`，字段见 [数据字典](docs/05-数据字典/数据字典.md)
- 当前状态：v3 已发布；4.0.0（柠檬记）设计完成；第七轮整体检查整改中（R-92～R-105）；下一步交齐开工前 7 份文档（ADR-011～017 已交，还差需求澄清-v4、数据字典 v4、测试用例 v4、AI 句库、开发计划 v4、开工前备份）（见 [CHANGELOG](CHANGELOG.md)、[路线图](docs/09-路线图/路线图.md)）
- 下一版：4.0.0 柠檬记（Lemo / 레모，lemomemo.com），独立软件：iPhone 主屏幕 PWA、网页、Windows exe 三端共用一套前端（**React + TypeScript + Vite**，R-96、[ADR-017](docs/04-决策/ADR-017-前端用React与TypeScript.md)；v3 的原生 JS 代码不沿用），后端 Supabase 首尔节点 + Cloudflare，多用户邀请制、中韩双语（见 [架构设计-v4](docs/10-架构/架构设计-v4.md)、[ADR-007](docs/04-决策/ADR-007-目标形态PWA与独立服务器.md)）

## 目录说明

### 通用部分（两种形态共用）

| 路径 | 内容 | 负责人 |
|---|---|---|
| `src/` | 源码：`index.html`、`styles/`（tokens、base、layout、components）、`scripts/`（core、data、logic、ui、platform、app.js） | 程序员 1 |
| `src/scripts/data/` | 数据层适配器：UI 只调用统一接口，不直接碰具体数据库 | 程序员 1 |
| `tests/` | 模拟数据库、测试骨架页、一句话解析单元测试 | 程序员 1 |
| `archive/releases/` | 每个已发布版本的冻结源码，只读 | 程序员 1 |
| `docs/` | 全部文档（需求、设计、评审、决策、数据字典、测试、开发日志、发布、路线图） | 程序员 2 |
| `assets/reference/` | 设计参考素材（参考视频及说明） | 程序员 2 |
| `文件登记册.md` | 每个文件的路径、用途、来源、状态 | 程序员 2 |

### claude.ai 版（现行）

| 路径 | 内容 |
|---|---|
| `src/scripts/platform/`（claude 部分） | 接 claude.ai 的运行环境：`window.claude.use("db")` 拿云端数据库 |
| `build/build.py`、`build/manifest.json` | 把 `src/` 拼成单个 HTML（claude.ai 只接受单文件发布，见 [ADR-001](docs/04-决策/ADR-001-单文件发布.md)） |
| `dist/planner.html` | 构建产物，发布用；不要手改 |
| `dist/test.html` | 构建产物，本地测试用（接模拟数据库） |

### 独立服务器版（4.0.0 柠檬记，设计完成，目录以 [架构设计-v4](docs/10-架构/架构设计-v4.md) 第 2 节为准）

| 路径 | 内容 |
|---|---|
| `src/scripts/platform/`（web 部分，预留） | 接独立后端的接口、登录、Service Worker、Web Push |
| PWA 外壳（阶段 2 新增） | `manifest.webmanifest`、Service Worker、图标、离线缓存 |
| 后端（阶段 3 新增，技术待定） | 接口、数据库、登录、数据迁移脚本 |

> 旧目录 `v1/`、`v2/`、`测试/` 由程序员 1 迁移到 `archive/` 和 `tests/`，迁移完成后以 [文件登记册](文件登记册.md) 为准。

## 构建

```bash
python build/build.py                  # 默认 --target claude：输出 dist/planner.html 和 dist/test.html
python build/build.py --target claude  # 同上，显式写法
python build/build.py --target web     # 预留：独立服务器版（PWA），阶段 2 起实现
```

## 数据与备份

- 真实数据在 claude.ai 云端数据库；数据结构见 `data/schema/` 和 [数据字典](docs/05-数据字典/数据字典.md)。
- **每次做新版本前、每次发布前都要备份**（[ADR-009](docs/04-决策/ADR-009-每个版本前备份数据和源码.md)）：Claude 先把云端数据导出到 `data/backups/<日期>_<时机>/`，再运行：

```bash
python build/backup.py v3开发前
```

- 源码会打包到项目外的 `D:\claude code\待办APP-备份\源码\`；用 `git clone <bundle 文件> 待办APP` 就能完整恢复。
- **每天约 23:39 自动同步**一次云端数据到 `data/backups/<日期>_每日/`，保留 30 天（定时任务 `planner-daily-snapshot`，要求电脑上的 Claude App 开着）。
- `data/backups/` 是真实个人数据，不进 git。

## 测试

```bash
node tests/run-all.mjs                 # 全部单元测试（解析、日期、排序、整理、写入、适配器契约）
node tests/unit/parse-quick.test.mjs   # 只跑一句话解析
```

页面级测试：打开 `dist/test.html`（接 `tests/mock/mock-db.js` 模拟数据库），用 `D:\claude code\.claude\launch.json` 里的 `planner-test` 预览（端口 8770）。详见 `tests/README.md` 和 [测试记录](docs/06-测试/测试记录.md)。

> 以上命令以程序员 1 的实际结果为准，主持人最后核对。

## 发布

### claude.ai 版（现行）

1. `python build/build.py` 生成 `dist/planner.html`。
2. 本地用 `dist/test.html` 走一遍测试，控制台无报错。
3. 把 `dist/planner.html` 发布到同一个 artifact 地址（保持链接不变），线上版本号加 1。
4. 把这次发布的文件复制到 `archive/releases/vN/planner.html` 冻结。
5. 在 [发布记录](docs/08-发布/发布记录.md)、[CHANGELOG](CHANGELOG.md)、[文件登记册](文件登记册.md) 各补一条。

### 独立服务器版（规划中）

1. `python build/build.py --target web` 生成 PWA 版本（含 manifest 和 Service Worker）。
2. 部署到独立服务器（域名、HTTPS、后端技术待用户决定，见 [ADR-007](docs/04-决策/ADR-007-目标形态PWA与独立服务器.md)）。
3. 发布记录和冻结规则与 claude.ai 版相同，另记服务器版本号。

## 文档索引

- 需求：[需求记录](docs/01-需求/需求记录.md)
- 设计：[设计方案-v2](docs/02-设计/设计方案-v2.md)、[修改清单-v3](docs/02-设计/修改清单-v3.md)；4.0.0：[定稿线框](docs/02-设计/草图-v4/线框-v4-定稿.html)、[皮肤视觉稿](docs/02-设计/皮肤-v4/皮肤视觉稿.html)（视觉以皮肤视觉稿为准）
- 评审：[评审索引](docs/03-评审/评审索引.md)
- 决策：[docs/04-决策/](docs/04-决策/)（ADR-001 起）
- 架构：[架构约定](docs/10-架构/架构约定.md)、[架构设计-v4](docs/10-架构/架构设计-v4.md)
- 数据字典：[数据字典](docs/05-数据字典/数据字典.md)
- 测试：[测试记录](docs/06-测试/测试记录.md)
- 开发日志：[过程记录](docs/07-开发日志/过程记录.md)
- 发布：[发布记录](docs/08-发布/发布记录.md)
- 路线图：[路线图](docs/09-路线图/路线图.md)
