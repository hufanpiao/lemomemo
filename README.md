# 柠檬记 4.0.0（Lemo / 레모）

中韩双语的日程、待办、随手记 App：iPhone 主屏幕 PWA、网页、Windows exe 三端共用一套前端（**React + TypeScript + Vite**，[ADR-017](docs/04-决策/ADR-017-前端用React与TypeScript.md)），后端 Supabase 首尔节点 + Cloudflare，多用户邀请制。域名 lemomemo.com。架构见 [架构设计-v4](docs/10-架构/架构设计-v4.md)。

- **当前状态（2026-10-28）**：设计阶段结束，B0 前 7 份交付物全部签“通过”，今天开 B0（地基批）。需求到 R-211，架构到 0.29（续第 170 条）。工作量和日历以 [开发计划-v4](docs/09-路线图/开发计划-v4.md) 和架构 1.3 为准。各项决定见[需求记录](docs/01-需求/需求记录.md)（“状态”列标明哪些已被取代），版本和编号规则见 [ADR-020](docs/04-决策/ADR-020-编号与版本号规则.md)。
- **本仓库的来历**（R-211）：从 `D:\claude code\待办APP` 的开工前备份克隆而来，保留全部修改历史，去掉了 v3 的代码（`src/`、`tests/`、`dist/`、`archive/`、v3 构建脚本和数据结构）。v3 代码留在标签 `v3.0.0` 里，需要时 `git show v3.0.0:<路径>` 查看。v3 的数据按 R-208 不要了，不搬家、不发 3.0.1。旧文件夹 `D:\claude code\待办APP` 保留不动。

## 目录

开发开始后的目录以[架构设计-v4](docs/10-架构/架构设计-v4.md) 第 2 节和 8.2 为准；现在只有：

| 路径 | 内容 |
|---|---|
| `docs/` | 全部文档（需求、设计、评审、决策、数据字典、测试、开发日志、发布、路线图、架构、团队） |
| `assets/reference/` | 设计参考素材 |
| `build/` | 检查和备份脚本（见下） |
| `data/` | 只放说明；备份本身在 `E:\柠檬记-备份\`，不进 git |
| `文件登记册.md` | 每个文件的路径、用途、来源、状态 |

## 开发第一步：启用提交前密钥检查

每台开发电脑克隆或拿到仓库后，**先做这一步再写代码**（仓库根目录执行一次，不用管理员；各 worktree 共用这一项设置）：

```bash
git config core.hooksPath .githooks
```

启用后每次提交都会先用 gitleaks 扫暂存区，找不到 gitleaks 也会拒绝提交（`.githooks/pre-commit`，架构 8.2、S-B0b）。也可以 `npm run hooks:install`；没启用时 `npm run check:hooks`、`npm run deps:rebuild` 会打中文提示（B1 接手清单 C12）。用 `git config --get core.hooksPath` 核对，应输出 `.githooks`；输出为空就是没启用，TC-B0-58“本机提交被拦”在这台电脑上不成立（B0 QA D-09）。其余本机工具见 [B0 本机开发环境](docs/07-开发日志/B0-本机开发环境.md)。

## 检查脚本

```bash
python -I build/check_registry.py   # 文件登记册和实际文件一一对应
python build/req_index.py --check   # 需求记录的格式和“影响”列
python build/tokens.py --check      # 设计令牌和视觉稿一致
```

## 备份

每次开始新版本前、每次发布前备份一次源码（[ADR-009](docs/04-决策/ADR-009-每个版本前备份数据和源码.md)，R-209 不加密）：

```bash
python build/backup.py <时机>        # 例如 4.0.0开工前
```

bundle 和清单写到 `E:\柠檬记-备份\版本前\<日期>_<时机>\`，并当场做恢复测试。恢复：`git -c core.longpaths=true clone <bundle> 柠檬记APP`，再 `git -C 柠檬记APP config core.longpaths true`（仓库里有超长路径）。

## 文档索引

- 团队与流程：[人员名单](docs/00-团队/人员名单.md)、[产品负责人待办-v4](docs/00-团队/产品负责人待办-v4.md)
- 需求：[需求记录](docs/01-需求/需求记录.md)、[需求澄清-v4](docs/01-需求/需求澄清-v4.md)
- 设计：[定稿线框](docs/02-设计/草图-v4/线框-v4-定稿.html)、[皮肤视觉稿](docs/02-设计/皮肤-v4/皮肤视觉稿.html)（视觉以皮肤视觉稿为准）
- 评审：[评审索引](docs/03-评审/评审索引.md)
- 决策：[docs/04-决策/](docs/04-决策/)
- 架构：[架构设计-v4](docs/10-架构/架构设计-v4.md)
- 数据字典：[数据字典-v4](docs/05-数据字典/数据字典-v4.md)
- 测试：[测试用例-v4](docs/06-测试/测试用例-v4.md)、[iPhone 实机验收清单-v4](docs/06-测试/iPhone实机验收清单-v4.md)、[AI 句库-v4](docs/06-测试/AI句库-v4.md)
- 开发日志：[过程记录](docs/07-开发日志/过程记录.md)
- 发布：[发布记录](docs/08-发布/发布记录.md)、[功能说明-v4](docs/08-发布/功能说明-v4.md)
- 路线图：[路线图](docs/09-路线图/路线图.md)、[开发计划-v4](docs/09-路线图/开发计划-v4.md)
