# B2-UI-b 任务单架构审

- 日期：2026-11-07　审查人：架构师（独立审查，只读，默认不通过）
- 审查对象：[docs/09-路线图/B2-UI-b-任务单.md](../../09-路线图/B2-UI-b-任务单.md)（11-07 第一稿）
- 对照：[B2-UI-a 任务单](../../09-路线图/B2-UI-a-任务单.md)和它的架构审、[B3 任务单](../../09-路线图/B3-任务单.md)第四节文件归属、需求 R-276、R-277、R-351、R-352、R-353；代码按 `e96d8e2` 加当前工作区（`git status` 里有别人未提交的 motion、`src/app/main.tsx` 改动）抽查：`src/kit/components/Placeholder.module.css`、`Settings/Settings.module.css`、`src/features/settings/ui/*`、`src/features/reminders/ui/RemindSettings.module.css`、`src/platform/sw-register.ts`、`sw-lifecycle.ts`、`src/auth/main.tsx`、`src/index.html`、`src/auth/index.html`、`TodoEditPage.tsx`、`EventEditPage.tsx`
- 背景（主持人转达）：前端 A 正在做 B3；前端 B 正照皮肤视觉稿改底栏玻璃，B2-UI-b 不碰底栏。

## 结论

**有条件通过，7 / 10。**

范围收得干净：只收 B2-UI-a 遗留，不扩到整页细修，硬约束沿用得对，R-276、R-277 守得住，A / B 的文件清单本身不重叠。扣分在五处：① **W8 已经做完**（`Placeholder.module.css` 在 `e96d8e2` 里已让开 `--safe-top`），任务单还按没做写；② **D4 的前提不成立**：全 App 现在根本没有换皮肤的功能，`data-skin` 在 `src/index.html`、`src/auth/index.html` 都写死 `simple`，代码里也没有任何地方改它，也没有“本机记住的皮肤”可读；③ **什么时候做没写清**：抬头写“B5 之后”，行号却按 `e96d8e2`，而且没说和前端 A 的 B3 关键路径、前端 B 的底栏改动怎么错开；④ W5 要“复用 kit 设置行 `.toggle` 的画法”，那份 CSS 是前端 B 的文件，A 拿不到，归属没定；⑤ V1 底栏验收比 B2-UI-a 还松，而且底栏改动一合，基准就会变。M1～M8 改完可以开工，主持人核对即可。

---

## 一、范围核对

| 项 | 核对结果 |
|---|---|
| W1 | 对（原 U5-1，R-352 ① 挪来）。行号抽查：`SettingsPage.module.css` 的 `.grp` 79、`.row` 88、`.rowBtn` 303～340 对得上。缺一句：**B3 前端 A 会在设置里加“语音与 AI”“在 Claude 聊天里记事”两节**（B3 任务单文件表），B5 还会加隐私记设置；W1 开工时要把这些新节一起 grep 进来，确认它们用的是 kit 设置行，没用旧 `.row` |
| W2 | 对。漏了一处：`RemindSettings.module.css` 除了 `.sn`（123 行）还有第 131 行一处 `text-wrap: pretty`，W1 换零件时这个文件归 A，W2 只列了 B 的两个文件，要写明“A 在 W1 里删掉 `RemindSettings.module.css` 的两处、`CalendarSettings.module.css:120` 由 B 在 W1 删”。韩文用 `:lang(ko)` 可行：`src/platform/doc-locale.ts` 已把 `<html lang>` 设成界面语言 |
| W3 | 对。笔误：“`.danger` 等 W5 做完一起删”应是 **W4**（W4 删 `.danger`） |
| W4 | 对，D1 ① 是正确方向。`.btn` 的引用方核对过：`SettingsPage.tsx`、`DevicesSection.tsx`、`RecentExport.tsx`、`ConfirmDialog.tsx`、`DataSection.tsx`、`DesktopSection.tsx` 六个文件和任务单一致。**B3 新加的两节**（“生成连接码”“断开连接”按钮、确认弹窗）如果先合，也会用 `.btn` 或 `ConfirmDialog`，W4 的替换清单开工时要重新 grep，不能只按这六个 |
| W5 | 方向对，**文件归属有缺口**（M4） |
| W6 | 方向对，**退路的落点要改**（见第四节 D3） |
| W7 | **前提不成立**（M2、D4） |
| W8 | **已做**：`src/kit/components/Placeholder.module.css` 现在是 `padding: max(var(--safe-top), 24px) 16px 24px`，注释写着“视觉验收 11-07”。另外变量名是 `--safe-top`，不是任务单写的 `--inset-top`。改成“只核对 + 补一张 62pt 截图进视觉基准”，人日 0.1 → 0.05 或并进八关 |
| W9 | 对，只改测试夹具，八关不适用，写得清楚 |

“不在本单”一段合理；首屏词典拆分不做、文档同步不占人日，都对。

---

## 二、文件冲突

### 和 B3 前端 A

- **人手冲突大于文件冲突**：B2-UI-b 给 A 派了 1.25～2 人日（W1 提醒设置、W4 接口、W5、W7），而 A 是 B3 的关键路径（B3 前端 A 核定 3.25～4.25）。任务单抬头写“B5 之后”，那就不会撞；但要写明，**B3～B5 期间不从 A 身上切时间做 B2-UI-b**。
- **会撞的文件**（如果 B2-UI-b 提前做）：`src/kit/components/Form.tsx`、`Form.module.css`（B3 打字条要用输入框零件，W4、W5 要改它）；`src/features/settings/ui/` 下 B3 新加的两节和 `ConfirmDialog.tsx`（W4 要换按钮）；`SettingsHome.tsx`、`settings/data/sections.ts`（B3 在 `voiceAi` 一节挂内容；B2-UI-b 没列这两个文件，没有直接冲突，但 W1、W4 的 grep 要覆盖）。
- `src/app/UpdateBanner.tsx`：W6 要改；B3 的 S16“版本横幅等录音结束再出”多半落在 `holdBusy` 和 `banner-kind.ts`，如果 B3 也改了 `UpdateBanner.tsx`，W6 在 B3 之后变基。
- 都在 B5 之后做就没有并行冲突，但**行号全部要重新量**：B3、B4、B5 都会动设置页（B5 加隐私记设置）。

### 和底栏改动（前端 B 正在做）

- 底栏改动会碰 `src/kit/components/GlassBar/`、`src/motion/glass-*.ts`、`src/styles/base.css` 的模糊规则，多半还有 `tokens.json` 和生成的 `skins/glass.css`（玻璃材质令牌）。B2-UI-b 硬约束 1 禁改前三样，对。
- **`tokens.json` 只能一人改**（B2-UI-a 的约定）：B2-UI-b 的 W4（紧凑按钮）、W5（开关）可能要新令牌。要写明这段时间 `tokens.json` 归谁；建议仍归 A，底栏改动要的令牌也经 A 加，或者底栏改动期间 B2-UI-b 不新增令牌、只用现有的。
- **人手**：B2-UI-b 给 B 派了 2.35～2.6 人日，B 现在在做底栏。要写明 B2-UI-b 在底栏那一单签字之后开工。
- **视觉基准**：底栏改动签字后，G1～G4、G7、G10、G12 的基准会整体换一版。B2-UI-b 的 V1 必须以**底栏那一单签字后的基准**为准（顺带提醒：B3 的 `g-plus-hold` 守门基准也要跟着换，B3 任务单写的是“B2-UI-a 签字版”，底栏一改就要改成“底栏改动签字版”，这一条转 B3 主持人）。
- W7 让登录页加载 `skins/glass.css`，底栏改动会让这份 CSS 变大，登录页包体跟着变；D4 按我的建议选 ② 就没有这个问题。

### A、B 之间

清单本身不重叠，两个“第一个半天先交接口”的约定也对。缺一处：**W5 的开关画法**在 `Settings.module.css`（B 的文件），A 的 `Form.module.css` 不能 import 它，复制一份又违反第 ⑤ 关“设计系统”。要定：B 第一个半天把开关画法抽到 kit 共用的 `src/kit/components/Switch.module.css`（或同名零件），设置行和 `Check look="switch"` 都用它；归 B，A 只用。

---

## 三、人日

| 项 | 任务单 | 建议 | 理由 |
|---|---|---|---|
| W1 | A 0.5～0.75、B 0.5 | A 0.5～0.75、**B 0.5～0.75** | kit 要加两种新行变体（时刻框行、行内按钮行），还要保住读屏结构，加日历设置和删三个文件的旧样式，再改 e2e，0.5 偏紧 |
| W5 | A 0.25～0.5 | A 0.25～0.5，**B +0.1**（抽开关零件） | M4 |
| W7 | A 0.25～0.5 | **0**（D4 选 ②） | 没有换皮肤功能 |
| W8 | B 0.1 | **0.05**（只核对、补基准） | 已做 |
| 八关和返工 | 1 | **1.5** | B2-UI-a 的架构审估过“八关两轮、两人各交”的实际成本明显高于计划；本单 9 项、两人、每关两轮，加负责人看图，1 天不够 |
| 合计 | 4.6～5.6 | **约 4.9～6** | A 1～1.5、B 2.5～2.85、八关 1.5 |

---

## 四、对 D1～D5 的意见

| # | 意见 |
|---|---|
| D1 | **同意推荐 ①**（外观一模一样，只换实现）。R-276、R-277 是负责人看真机定的，没有新理由不该推翻；② 等于重开已定的事。条件：V4 写成“设置页按钮区域视觉基准 0 像素差”，比对用单独的 `maxDiffPixels: 0`，不用全局 0.002 的余量 |
| D2 | **同意推荐 ①**（开关）。“全天”切了会收起时刻框，“重要”是一个状态，都是开关的语义；圆圈只留给“完成”最清楚。条件：开关画法按 M4 抽成共用零件；编辑页 e2e 里按 `getByRole('checkbox')` 找这两个的要改成 `switch`，QA 核 |
| D3 | **同意做 ①，但改落点和做法**：退路放在 `updateServiceWorkerLazy` 里面，返回值沿用现在的约定（`reloading` / `failed` 等），**由调用方决定什么时候重载**，退路自己不直接 `location.reload()`。理由：调用方在重载前有自己的检查（录音、编辑中要等，B3 的 `holdBusy`；B3 起还有录音 Blob 在内存里），退路自己重载会绕过这些，丢东西。做法优先试“换个地址再 `import()` 一次”（同一个 chunk 地址后加查询串，绕开浏览器对失败的动态 import 的缓存），这样不用在首屏复制一份 SW 生命周期逻辑；不行再用内联的最小版（`getRegistration` → 有 `waiting` 才发 `SKIP_WAITING`）。“最多重载一次”的会话标记由调用方记。② 的提示文字两种情况都要做。安全审查员复审 S1 照任务单 |
| D4 | **不同意推荐 ①，建议选 ②**（登录页固定简洁皮肤，写明，0 人日）。理由：现在全 App 都没有换皮肤的功能，`data-skin` 写死 `simple`，没有“本机记住的皮肤”可读；为一个还不存在的设置先改登录页，是提前做、而且做了也测不到真实场景。等做“换皮肤”那一批时，登录页、启动画面、`index.html` 的开页前设皮肤一起做。这个问题可以不问负责人，任务单写成“现在没有换皮肤功能，登录页随换皮肤那一批做”即可 |
| D5 | **同意推荐 ①**（另开一单，收完遗留接着做、逐页出效果图）。补两点：① 那一单要排在**底栏改动签字之后**，整页细修的截图都含底栏，底栏没定就修整页会白截一遍；② 选项 ③“和底栏一起做”不建议，底栏是负责人正在看对照图的单件事，混进 20 项整页修改会拖慢它 |

---

## 五、必改项

| # | 必改 |
|---|---|
| **M1** | 写明开工时机和人手：B2-UI-b 在**底栏改动签字之后**、并且**不占前端 A 的 B3～B5 关键路径**（按抬头“B5 之后”，或主持人另定）；开工第一件事重新量全部行号，W1、W4 的 grep 范围包括 B3、B5 新加的设置节 |
| **M2** | W7 的前提改正：现在没有换皮肤功能，`data-skin` 写死 `simple`；D4 改成建议 ②，W7 移出本单（0 人日），记到做换皮肤的那一批 |
| **M3** | W8 改成“已做（`e96d8e2`），只核对并补 62pt 截图进基准”；变量名改成 `--safe-top` |
| **M4** | W5 的开关画法归属：B 第一个半天抽出 kit 共用开关样式（`Switch.module.css` 或零件），设置行和 `Check look="switch"` 共用；写进第三节约定 |
| **M5** | V1 改成：底栏区域 `maxDiffPixels: 0`，基准取**底栏改动签字版**；`git diff` 里 `GlassBar/`、`src/motion/glass-*.ts`、`base.css` 模糊规则为空（不只 `GlassBar/`） |
| **M6** | W6 按第四节 D3 改：退路放在 `updateServiceWorkerLazy` 里，只返回结果、不自己重载；优先“换地址再 import 一次”；加单测“退路不绕过调用方的忙碌检查” |
| **M7** | 写明这段时间 `tokens.json` 和生成的皮肤文件归谁（建议仍归 A；底栏改动要的令牌经 A 加），B2-UI-b 不新增令牌为好 |
| **M8** | 小处：W3“等 W5”改“等 W4”；W2 写清 `RemindSettings.module.css` 两处、`CalendarSettings.module.css` 一处由谁在 W1 里删；W2 加一条自动检查（中文设置说明的计算样式不是 `pretty`、韩文是 `keep-all`），不只靠截图；人日按第三节更新，八关和返工 1 → 1.5 |

## 修改记录

- 2026-11-07：架构师独立审查第一稿（只新建本文件并在文件登记册加一行）。
