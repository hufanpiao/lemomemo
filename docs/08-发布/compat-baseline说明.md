# 旧版客户端契约测试的基线：`compat-baseline` tag

- 日期：2026-10-28（B0，运维）
- 依据：架构 0.27 第 1 点“测试”、0.28 第 4 点；开发计划 v4 三之二“旧版客户端契约测试”一行；测试用例 v4 TC-B0-57、TC-B7a-21、TC-ALL-05
- 脚本：`build/compat_baseline.py`（只用标准库）；CI：`.github/workflows/ci.yml` 的 db 任务最后三步

## 一、这是做什么的

“旧版客户端打新数据库”：拿**某个旧提交**里的契约测试子集（`tests/compat/`），对**当前分支**的迁移（`supabase db reset` 以后）跑一遍。旧版能照常读写，说明这次改表是“先加后删”、没把旧版弄坏。

“某个旧提交”就是基线。4.0.0 上线前还没有发布 tag，所以先用一个内部 tag `compat-baseline` 顶上。

| 什么时候 | 基线是谁 | 失败了怎么办 |
|---|---|---|
| 4.0.0 发布 tag 打之前 | `compat-baseline` | **只报告、不拦**：CI 这一步标黄，任务照样算通过。上线前没有用户，开发期正常的改列改名不受“先加后删”约束（0.28 第 4 点） |
| 打了 `v4.0.0` 以后 | 当前提交能追溯到的**最新一个 4.x 发布 tag** | **必须通过**：改列名这类不兼容的改动被拦下（TC-B7a-21） |
| 两个都没有 | 跳过 | CI 打印提示：先打 `compat-baseline` |

v3.0.0 这类 4.0.0 以前的 tag 不算（它们没有 `tests/compat/`，也不是 4.x 数据库的客户端）。

## 二、什么时候打、什么时候挪

**谁打**：运维（架构 1.3b 0.30：机制归前端 B，样例迁移归后端，打 tag 归运维）。脚本只在本机打 tag、不推送，打完会打印推送命令；运维在自己的 worktree 里没有推送权限，所以**推 tag 由主持人执行**打印出来的那条命令（下面的命令按“运维打、主持人推”两步写）。

1. **第一次（B0）**：前端 B 把 `tests/compat/` 的机制和 `test:compat` 脚本、后端把第一批子集和“只加列”的样例迁移合进 main（架构 8.3 0.30：只有 main，没有 develop），并且 ci 的 db 任务是绿的以后，运维在 main 的**那个提交**上打、主持人推：
   ```
   git switch main
   git pull
   python -I build/compat_baseline.py tag
   git push origin refs/tags/compat-baseline
   ```
   然后按 TC-B0-57 验一遍：再开一个只做“改列名”样例的 PR，CI 的旧版契约那一步应该**标黄但任务通过**（只报告、不拦）。

2. **上线前每批签完挪一次**：某一批六环签完的当天，运维把 `compat-baseline` 挪到签字时的那个提交（主持人推），让“旧版”始终是上一批签过字的版本：
   ```
   python -I build/compat_baseline.py tag --move --reason "B1 签完"
   git push --force origin refs/tags/compat-baseline
   ```
   - **只在签字时挪**，平时不挪：基线里的测试必须是审过的。
   - 理由写进 tag 的说明里（`git show compat-baseline` 能看到），并在过程记录里记一句。
   - 别的电脑上要先 `git fetch --force --tags` 才能拿到挪过的 tag（CI 每次都是全新检出，不受影响）。

3. **打了 v4.0.0 以后**：不再打、不再挪 `compat-baseline`（脚本会拒绝）。基线自动换成最新的 4.x 发布 tag，并且必须通过。`compat-baseline` 这个 tag 留着当历史，不删。

脚本自己会挡住的情况：工作区有没提交的改动；`tests/compat/` 里还没有已提交的文件；已经有 4.x 发布 tag；已有 `compat-baseline` 但没写 `--move --reason`。

## 三、CI 里怎么跑

`ci.yml` 的 db 任务在其他数据库测试之后：

1. `python -I build/compat_baseline.py resolve`：选出基线，输出 `ref` 和 `strict`；
2. `python -I build/compat_baseline.py extract <ref> $RUNNER_TEMP/compat-base`：用 `git archive` 取出基线的 `tests/compat/`，不切分支、不动工作区；只接受普通文件和目录；
3. `npm run test:compat -- <取出的目录>/tests/compat`：用**当前**的本地数据库跑**基线**的测试。`strict` 不是 `true` 时这一步 `continue-on-error`。

## 四、要别人提供的（不在运维这里）

| 东西 | 谁 | 说明 |
|---|---|---|
| `tests/compat/` 的机制（目录约定、怎么跑基线） | 前端 B（架构 1.3b 0.30） | 运维的 `build/compat_baseline.py` 只负责找基线、取出、打 tag |
| `tests/compat/` 子集名单和用例 | 后端（契约测试）；QA 核对 | 不含和 `db.types` 逐字比对这类结构一变必然失败的用例（0.27 第 1 点） |
| `npm run test:compat -- <目录>` | 前端 B（架构 1.3b 0.30；脚本名是运维的提议，合并时确认） | 参数是基线测试所在的目录；用当前的本地数据库 |
| “只加列”“改列名”两个样例迁移 | 后端 | TC-B0-57 用；样例只放在测试分支或 `tests/compat/fixtures/`，不进正式迁移 |

## 五、自测记录（2026-10-28，运维，在临时仓库里测，没碰本仓库的 tag）

- 只有 v3.0.0：`resolve` 输出空，提示先打 tag ✔
- `tag`：打上；再 `tag` 不带 `--move`：拒绝 ✔；带 `--move --reason`：挪到新提交，打印 `--force` 推送命令 ✔
- `extract compat-baseline <目录>`：取出 2 个文件 ✔
- 打 `v4.0.0` 后 `resolve`：`ref=v4.0.0`、`strict=true` ✔
- 本仓库里 `resolve`：没有基线，跳过 ✔；`tag`：工作区不干净时拒绝 ✔
