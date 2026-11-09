# B2-UI-b 任务单：B2-UI-a 遗留项收尾

- 日期：2026-11-07　作者：计划起草人
- 状态：**已按架构审修订**。架构审 [B2-UI-b-任务单-架构审](../03-评审/B2-UI-b/B2-UI-b-任务单-架构审.md) 结论“有条件通过（7 / 10）”，必改 M1～M8 已全部改进本单，主持人核对即可开工。D4 按架构审定为 ②（登录页固定简洁皮肤），不再问负责人；D1、D2、D3、D5 负责人 11-09 已定，全选推荐（R-364），可以开工。
- 位置：本单只收 B2-UI-a（已提交 `e96d8e2`）留下来的几项，范围由主持人 11-07 指定；底栏和“＋”的样式不在本单（负责人正在看磨砂对照图，前端 B 正在照皮肤视觉稿改底栏玻璃，另起一单）。
- **开工时机和人手（M1）**：
  - **在底栏改动那一单签字之后开工**。前端 B 现在在做底栏，B2-UI-b 不和它并行；本单 V1 的基准也要等底栏签字版出来。
  - **不占前端 A 的 B3～B5 关键路径**：按路线图放在 B5 之后；主持人另定提前的话，也不能从 A 的 B3～B5 工作里切时间。
  - **开工第一件事重新量全部行号**：本单行号按 `e96d8e2`，B3、B4、B5 都会动设置页（B3 加“语音与 AI”“在 Claude 聊天里记事”两节，B5 加隐私记设置），W1、W4 的 grep 范围要包括这些新节、`SettingsHome.tsx`、`settings/data/sections.ts`；B3 若改过 `UpdateBanner.tsx`，W6 在它之后变基。
- 依据：
  - [B2-UI-a 任务单](B2-UI-a-任务单.md) 第一节 U5、U3-3 和修改记录最后一行（`.btn` 遗留）；
  - `docs/03-评审/B2-UI-a/` 下：[前端 A 代码审](../03-评审/B2-UI-a/B2-UI-a-前端A-代码审.md)、[前端 B 代码审](../03-评审/B2-UI-a/B2-UI-a-前端B-代码审.md)、[首屏瘦身安全审](../03-评审/B2-UI-a/B2-UI-a-首屏瘦身-安全审.md)（S1）、[视觉验收](../03-评审/B2-UI-a/B2-UI-a-视觉验收.md)、[前端 A 接口说明](../03-评审/B2-UI-a/前端A-接口说明.md)；
  - 需求：R-276、R-277（设置页按钮“看得见 38”、页底两行 44）、R-351、R-352、R-360；
  - [界面改动防返工规则](../00-团队/界面改动防返工规则.md)（第七节）；
  - 原话清单：[负责人观感要求清单](../06-测试/负责人观感要求清单.md)（G1～G12）。

## 硬约束（本单通篇适用，沿用 B2-UI-a）

1. **底栏和“＋”不动**：`src/kit/components/GlassBar/`、`src/motion/glass-*.ts`、`src/styles/base.css` 模糊相关规则不改。
2. **首屏 JS 上限 150 KB 不放宽**，按 e2e 页面时钟口径（`tests/e2e/b2-first-screen-budget.spec.ts`，chromium、webkit 各 3 次）。基线取开工时主干（底栏签字之后）上实测的数，开工第一件事量出来写进本单。本单进首屏的改动净增 ≤ 0；唯一例外是 W6 的退路，上限 0.3 KB，超了先报主持人。
   - **开工基线（前端 B 11-09 量）**：主干 `812f275`（底栏定稿锁定之后）加当时工作区，`b2-first-screen-budget.spec.ts` chromium、webkit 各 3 次都是 **134.1 KB**（今天页出现约 0.73 s / 1.98 s）。本单收尾时再量，净增 ≤ 0（W6 另计 ≤ 0.3 KB）。
3. **改完界面过八关**：① 原话清单 ② avoid-ai-design ③ design-critique ④ 无障碍 ⑤ 设计系统 ⑥ 动效 ⑦ 像素断言 ⑧ 本人看图；**另加防返工规则的“和参照稿并排对照”一关**（第七节）。每项的自验写在下面各项里；全过才签字。
4. **只换零件、不重排整页**：行的顺序、分卡、文案不改（W6 新增的提示文字、W5 换控件类型属于负责人定过的例外）。
5. **R-276、R-277 定过的外观不能被顺手改掉**：设置页小按钮看得见 38、`--panel-2` 实底、点击区 44；页底“退出登录”“注销账号”44 高。`tests/e2e/b1-settings.spec.ts` 里那条断言不动。
6. **令牌归属（M7）**：这段时间 `docs/02-设计/皮肤-v4/令牌/tokens.json` 和生成的 `src/styles/tokens.css`、`src/styles/skins/*.css` **归前端 A**，底栏改动要的令牌也经 A 加。**B2-UI-b 原则上不新增令牌**，只用现有的；确实要加，由 A 加，并在 PR 里写明。

---

## 一、范围清单

每项写：现状 → 目标、改哪些文件、验收（含八关自验）、人日、归谁。

### W1 设置行：日历设置、提醒设置换 kit 设置行（原 U5-1，R-352 挪来）

- **现状**：kit 设置行（`src/kit/components/Settings/Settings.tsx`、`Settings.module.css`）设置首页和账号、数据等子页在用；日历设置、提醒设置各留一份手写的卡和行：`src/features/calendar/ui/CalendarSettings.module.css:19、27、130～149`；`src/features/reminders/ui/RemindSettings.module.css:17、26、30、135～162`（`RemindSettings.tsx` 174 行、样式 375 行）；`src/features/settings/ui/SettingsPage.module.css:79、88、100、104、303～340` 也还留着旧的 `.grp/.row/.rowBtn`。
- **目标**：日历设置、提醒设置换成 kit 的 `SettingsCard` / `SettingsEntryRow` / `SettingsSwitchRow` / `SettingsSegRow`；行的顺序、分卡、文案不变；删掉三个文件里被替代的 `.grp/.row/.rowBtn` 和按下变淡规则。kit 缺的行变体（提醒设置的时刻框行、行内按钮行）由 B 在 `Settings.tsx` 里加，A 等 B 合了再用。B3、B5 新加的设置节一起 grep，确认用的是 kit 设置行、没用旧 `.row`。
- **顺带删 `text-wrap: pretty`（M8）**：A 在 W1 里删掉 `RemindSettings.module.css` 的两处（`:123` `.sn`、`:131`）；B 在 W1 里删掉 `CalendarSettings.module.css:120` 一处。
- **改哪些文件**：A：`src/features/reminders/ui/RemindSettings.tsx`、`RemindSettings.module.css`、`RemindDnd.tsx`、`RemindShowTitle.tsx`（用到旧行的几个提醒文件，开工 grep 确认）；B：`src/kit/components/Settings/Settings.tsx`、`Settings.module.css`、`src/features/calendar/ui/CalendarSettings.tsx`、`CalendarSettings.module.css`、`src/features/settings/ui/SettingsPage.module.css`（只删旧 `.grp/.row/.rowBtn`）。
- **验收**：grep 三个页面样式无私有 `.grp/.row/.rowBtn`；`b2-settings-remind.spec.ts`、`b2-settings-sub-low.spec.ts`、`b1-settings.spec.ts` 全绿；行高仍是 R-276 的 44（单行）；改前改后对照图（简洁浅深、App 浅色 + 系统深色）。**八关自验**：① 对 G11；② `detect.mjs` 不比改前多；③ 设计审看两页是否和设置首页一个样；④ 读屏：每张卡一个看不见的标题、开关 `role="switch"`、说明挂 `aria-describedby`（kit 已有，换过去不能丢）；⑤ 只引用令牌；⑥ 整行按下变淡不缩放、减少动态效果下不变淡过渡；⑦ 设置子页视觉基准；⑧ 负责人看两页对照图；并排对照见第七节。
- **人日**：A 0.5～0.75（提醒设置）、B 0.5～0.75（kit 两种新行变体 + 日历设置 + 删旧样式 + 改 e2e）。
- **补记（前端 B 11-09 开工复量，主持人同意方案 ①）**：`SettingsPage.module.css` 的旧 `.grp/.row/.rowBtn` 删除挪到 W4 收尾，原因：`AccountSection`、`DataSection`、`DesktopSection`、`DevicesSection`、`RecentExport` 五页仍在用；W3、W4 动这五个文件时顺带换成 kit 行，再一次删干净。W1 只删日历设置自己那一份。kit 新加 `SettingsCard` 的 `showTitle`/`note`、`SettingsChoiceCard`、`SettingsTimesRow`、`SettingsActionRow`，提醒设置可直接用。

### W2 设置说明文字断行（原 U5-2，B11）

- **现状**：`Settings.module.css:102`、`SettingsPage.module.css:153` 的 `text-wrap: pretty` 让中文提前换行，拆开“之后”“能不能”。提醒设置、日历设置里的另外三处在 W1 里删（见上）。
- **目标**：中文去掉 `text-wrap: pretty`，用普通换行（行尾排满，标点不出现在行首，浏览器默认禁则）；韩文 `:lang(ko)` 加 `word-break: keep-all`，按词断不拆词（`src/platform/doc-locale.ts` 已把 `<html lang>` 设成界面语言，`:lang(ko)` 能用）。
- **改哪些文件**：B：`Settings.module.css`、`SettingsPage.module.css`。
- **验收**：**自动检查（M8）**：新加一条单测或 e2e 断言，中文时设置说明（`.meta`、`.sn`）的计算样式 `text-wrap` 不是 `pretty`，韩文时 `word-break` 是 `keep-all`；另截中韩两种语言的设置首页“倾斜高光”、账号页说明，375、440 两种宽度。**八关自验**：① 对 B11 原截图；⑤ 只改断行属性；⑧ 负责人看中韩对照图。
- **人日**：B 0.25。
- **补记（11-09）**：Chromium 的 `pretty` 只调最后几行，本机 WebKit 不支持 `text-wrap-style`，模拟不出 B11 原问题；**真机 Safari 效果待负责人在预览版上看**（对照图 `docs/03-评审/B2-UI-b/W2-说明断行-改前改后.png`）。韩文 `keep-all` 由 `base.css` 的 `:lang(ko) body` 继承，未另写规则。

### W3 危险整行按钮和“导出全部数据”（原 U5-3、U5-4，B24）

- **现状**：`AccountSection.tsx:69～72` 的“退出 / 注销”整行按钮用页面私有 `.rowBtn` + `.danger`（`SettingsPage.module.css:228`）；数据页“导出全部数据”一行没有 ›，看不出能点。
- **目标**：`SettingsEntryRow` 加 `danger` 外观（危险色字，不加边框），账号页那一行改用它；“导出全部数据”能直接换成 `SettingsEntryRow` 就换（带 ›），要动页面结构就不做、记下。`.danger` 等 **W4** 做完一起删。
- **改哪些文件**：B：`Settings.tsx`、`Settings.module.css`、`AccountSection.tsx`、`DataSection.tsx`。
- **验收**：`b1-settings-account-row.spec.ts` 全绿；**八关自验**：④ 危险行读屏名不变；⑦ 设置子页基准；⑧ 对照图。
- **人日**：B 0.25。

### W4 设置页按钮换 kit 按钮（原 U3-3，R-276、R-277）

- **现状**：设置页按钮用 `SettingsPage.module.css:200～238` 的 `.btn`（看得见 38、`--panel-2` 实底、`::after` 扩到 44）、`.wide`（整行宽）、`.signOut`（R-277 页底 44 高）；用在 `SettingsPage.tsx:41`（退出登录）、`DevicesSection.tsx`（移除设备、重试、`:138` 退出其他所有设备 `.wide`）、`RecentExport.tsx:72`（`.wide`）、`ConfirmDialog.tsx`、`DataSection.tsx`、`DesktopSection.tsx`。FormButton 每种都是看得见 44、`secondary` 是描边，直接换会改掉 R-276 的外观（前端 A 代码审 M3、接口说明第 28 行）。
- **目标**：先由 A 给 `FormButton` 加一个合 R-276 的紧凑尺寸（如 `size="compact"`：看得见 38、`--panel-2` 实底、`::after` 扩到 44）和整行宽参数（如 `block`），只用现有令牌；B 再把用 `.btn` 的文件换成 FormButton，删掉 `SettingsPage.module.css` 里的 `.btn`、`.btn::after`、`.btn:disabled`、`.danger`（W3 之后）、`.wide`、`.signOut`。**替换清单开工时重新 grep**，不能只按上面六个文件（B3 新加的“生成连接码”“断开连接”按钮和确认弹窗如果先合，也会用 `.btn` 或 `ConfirmDialog`）。外观见第六节 D1，推荐“外观一模一样，只换实现”。
- **改哪些文件**：A：`src/kit/components/Form.tsx`、`Form.module.css`（第一个半天出接口）；B：`SettingsPage.tsx`、`SettingsPage.module.css`、`DevicesSection.tsx`、`RecentExport.tsx`、`ConfirmDialog.tsx`、`DataSection.tsx`、`DesktopSection.tsx`，以及 grep 出来的 B3、B5 新文件。
- **验收**：`b1-settings.spec.ts` 里 R-276“看得见 38”那条断言不改、全绿；**设置页按钮区域视觉基准单独用 `maxDiffPixels: 0`**（选 D1 ① 时；不用全局 0.002 的余量）；`hit-target.spec.ts` 设置页 0 个小于 44；grep `SettingsPage.module.css` 无 `.btn`；**八关自验**：① 对 R-276、R-277；④ 按钮读屏名、禁用状态不变；⑤ 按钮全站只剩 FormButton 一套；⑥ 按下回弹和 B2-UI-a 一致；⑦ 设置页视觉基准；⑧ 负责人看对照图。
- **人日**：A 0.25（紧凑尺寸、`block`）、B 0.5。

### W5 “重要”“全天”的方框勾选（视觉验收第 70、124 行）

- **现状**：待办编辑页同一行里“已完成”是圆圈（`Check look="circle"`，`TodoEditPage.tsx:126`），“重要”是方形系统勾选框（`TodoEditPage.tsx:127`）；编辑日程“全天”也是方框（`EventEditPage.tsx:133～139`）。同一行两种勾选样式。
- **目标**：按第六节 D2 定的样式统一。推荐：“重要”“全天”改成开关（`role="switch"`），圆圈只留给“完成”，不让“重要”看着像第二个完成圈。**开关画法共用（M4）**：B 在第一个半天把设置行 `.toggle` 的画法抽成 kit 共用的 `src/kit/components/Switch.module.css`（或同名零件），设置行和 `Check look="switch"` 都用它；这份文件归 B，A 只用、不复制。A 在 `Check` 上加 `look="switch"`。
- **改哪些文件**：B：新建 `src/kit/components/Switch.module.css`、`Settings.module.css`（改成引用共用样式）；A：`Form.tsx`、`Form.module.css`、`TodoEditPage.tsx`、`EventEditPage.tsx`。
- **验收**：读屏念出“开关，已打开 / 已关闭”；勾选状态、禁用（只读行）样式和现在一致；`TodoEditPage.test.tsx`、编辑页 e2e 全绿，**编辑页 e2e 里按 `getByRole('checkbox')` 找这两个的改成 `switch`，QA 核**；设置页开关像素不变；**八关自验**：① 对 G11（编辑页观感）；② 不出现第二种勾选样式；④ 开关 `role="switch"`、键盘空格能切；⑤ 开关全站只有一份画法；⑥ 切换动效和设置页一致、减少动态效果下直接切；⑦ 编辑页、设置页视觉基准；⑧ 负责人看对照图（三种样式备选图见 D2）。
- **人日**：A 0.25～0.5；B 0.1（抽共用开关）。

### W6 “更新”拿不到模块时的退路（首屏瘦身安全审 S1；M6）

- **现状**：B2-UI-a U7 把 SW 生命周期改成按需下载，`src/platform/sw-register.ts:100` 的 `updateServiceWorkerLazy` 拿不到模块时回 `failed`。页面没被 SW 接管但已有旧注册时，如果启动那次下载失败，有的浏览器会缓存失败的动态 import，之后每次按“更新”都立刻 `failed`，用户卡在旧版本直到手动重开。界面上 `UpdateBanner.tsx:77～78`、`CacheTooNewScreen.tsx:35～36` 只显示 `update.failed`。不绕版本门、概率低，主持人定为遗留。
- **目标**（按架构审第四节 D3）：
  1. **退路放在 `updateServiceWorkerLazy` 里面，只返回结果**，返回值沿用现在的约定（`reloading` / `no_update` / `failed` / `takeover_timeout` / `unsupported`），**退路自己不调 `location.reload()`**，什么时候重载由调用方决定（调用方重载前有自己的忙碌检查：编辑中、B3 的录音 `holdBusy`、内存里的录音 Blob，退路自己重载会绕过这些、丢东西）。
  2. 做法**优先试“换个地址再 `import()` 一次”**：同一个 chunk 地址后加查询串，绕开浏览器对失败动态 import 的缓存，不用在首屏复制一份 SW 生命周期逻辑。
  3. 还不行，再用内联的最小版：`navigator.serviceWorker.getRegistration()` → 有 `waiting` 才发 `SKIP_WAITING`，返回 `reloading` 交给调用方。
  4. “最多重载一次”的会话标记**由调用方记**。
  5. 都不行回 `failed`，提示文字带“请完全关闭后重新打开柠檬记”的一步说明（新词条，中韩各一条，韩文标 `REVIEW(ko)`）；`UpdateBanner`、`CacheTooNewScreen` 两处都改。
- **改哪些文件**：B：`src/platform/sw-register.ts`、`src/app/UpdateBanner.tsx`、`src/app/CacheTooNewScreen.tsx`、i18n 词典（新增一条）、`src/platform/__tests__/sw-lazy.test.ts`。
- **验收**：新单测：① 第一次 import 被拒、换地址那次成功 → 照常走更新；② 两次都被拒、有 `waiting` → 发了 `SKIP_WAITING` 并回 `reloading`；③ 都不行 → 回 `failed`，界面显示新提示；④ **退路不绕过调用方的忙碌检查**：调用方忙时，`updateServiceWorkerLazy` 返回后不发生重载；⑤ `updateServiceWorkerLazy` 内部没有 `location.reload` 调用（源码断言）。版本门测试（`upgrade.ts` 相关）不改、全绿；首屏 e2e 增量 ≤ 0.3 KB；**安全审查员复审 S1**（不绕版本门、`SKIP_WAITING` 只发给同源注册）；**八关自验**：① 不涉及原话，记“不适用”；④ 提示 `role="alert"` 能读到（**11-09 主持人同意改为 `role="status"` 礼貌播报，原因：进度、失败共用同一个元素，中途换 role 读屏不一定念**）；⑥ 重载前不闪白（冷启动逐帧，G10）；⑧ 负责人看失败提示图。
- **人日**：B 0.5～0.6。

### W7 登录页玻璃皮肤 —— **移出本单（M2，D4 已定 ②）**

现在全 App 没有换皮肤的功能：`src/index.html:2`、`src/auth/index.html:2` 都写死 `data-skin="simple"`，代码里没有地方改它，也没有“本机记住的皮肤”可读。视觉验收看到的“玻璃皮肤登录页没样式”是截图时强行设成玻璃才出现的，产品里不会出现。**登录页固定简洁皮肤**；等做“换皮肤”那一批时，登录页、启动画面、`index.html` 的开页前设皮肤一起做。本单 0 人日。

### W8 随手记占位页顶部安全区 —— **已做，只核对（M3）**

`src/kit/components/Placeholder.module.css` 在 `e96d8e2` 里已改成 `padding: max(var(--safe-top), 24px) 16px 24px`（注释“视觉验收 11-07”；变量名是 `--safe-top`）。本单只核对：模拟 62pt 顶部安全区截一张，补进视觉基准，并在八关 ① 对 G5。**人日**：B 0.05（或并进八关）。

### W9 e2e 夹具 `csp-fixture.ts` 收尾（前端 B 代码审最后一节）

- **现状**：跨文档累计已修（有条件通过 8 / 10），遗留：M1 要贴 chromium、webkit 全量 e2e 跑通记录；建议 1 新测试第一条断言偏弱；建议 2 后退缓存恢复没有测试；建议 3 文件头没写同源 iframe 的限制；建议 4 关掉遗留登记。
- **目标**：补齐以上四条，测试断言改成“第二页单独数出的个数 + 第一页 = 累计数”，补“A → B → 后退”用例，文件头写限制，登记处写明已修。
- **改哪些文件**：B：`tests/e2e/csp-fixture.ts`、`tests/e2e/csp-webkit-select.spec.ts`。
- **验收**：两浏览器全量 e2e 跑通记录存进 `docs/03-评审/B2-UI-b/`；不改产品代码，八关不适用（只过代码审）。
- **人日**：B 0.25。

### 八关和返工

两人各自交、审查员每关至少两轮（B2、B2-UI-a 的记录），加并排对照一关和负责人看图：**1.5**（M8，原 1）。

---

## 二、不在本单

- **底栏和“＋”的样式**：负责人正在看磨砂对照图，前端 B 正在改，定了另起一单。本单所有改动不得让底栏视觉基准变化。
- **登录页玻璃皮肤（W7）**：随以后“换皮肤”那一批做。
- **全站视觉审查的整页细修**（B2-UI-a 任务单第二节列的 B6、B7、B9、B10、B12～B16、B20～B22、B26、B27、“下一件”卡时间尺、编辑日程分隔线、只读斜纹和提示条等）：路线图原把它们放在 B2-UI-b，但这次主持人指定本单只收 B2-UI-a 遗留项。放哪一批待负责人定（第六节 D5）。
- 首屏词典拆分（B2-UI-a U7-3）：仍不做。
- 前端 A 代码审建议 ③（B2-UI-a 任务单 U3-3 正文同步）：文档事，主持人改，不占人日。

---

## 三、分工（按文件分，不重叠）

| 人 | 只改这些文件 | 内容 | 估算（人日） |
|---|---|---|---|
| **前端 A** | `tokens.json` 及生成的 `tokens.css`、`skins/*.css`（只在确实要加令牌时，见硬约束 6）；`src/kit/components/Form.tsx`、`Form.module.css`；`src/features/reminders/ui/` 下用到旧设置行的文件（`RemindSettings.*`、`RemindDnd.tsx`、`RemindShowTitle.tsx` 等）；`src/features/todos/ui/TodoEditPage.tsx`、`src/features/calendar/ui/EventEditPage.tsx` | W1 提醒设置（含删两处 `pretty`）、W4 FormButton 紧凑尺寸和 `block`、W5 `look="switch"` 和编辑页 | **1～1.5** |
| **前端 B** | `src/kit/components/Settings/*`、新建 `src/kit/components/Switch.module.css`、`Placeholder.module.css`（只核对）；`src/features/calendar/ui/CalendarSettings.*`；`src/features/settings/ui/` 下 `SettingsPage.*`、`AccountSection.tsx`、`DataSection.tsx`、`DevicesSection.tsx`、`RecentExport.tsx`、`ConfirmDialog.tsx`、`DesktopSection.tsx` 及 B3、B5 新加的设置节文件；`src/platform/sw-register.ts`、`src/app/UpdateBanner.tsx`、`src/app/CacheTooNewScreen.tsx`、i18n 词典新增一条、`src/platform/__tests__/sw-lazy.test.ts`；`tests/e2e/csp-fixture.ts`、`csp-webkit-select.spec.ts`；W2 的断行检查用例 | W1 kit 变体和日历设置（含删一处 `pretty`）、W2、W3、W4 替换、W5 抽共用开关、W6、W8 核对、W9 | **2.5～2.85** |
| 八关和返工 | — | 见第一节末 | **1.5** |

**合计约 4.9～6 人日**（原 4.6～5.6；按架构审第三节：W1 B 侧加 0.25、W5 B 侧加 0.1、W7 归 0、W8 改 0.05、八关 1 → 1.5）。A、B 并行，日历约 3～3.5 天，在底栏签字之后、不占 A 的 B3～B5 关键路径。

**约定**：

1. **A → B（第一个半天）**：A 先合 FormButton 的 `size="compact"`、`block` 接口（W4），B 再换设置页按钮。
2. **B → A（第一个半天）**：B 先合 ① kit 设置行新变体（W1 提醒设置要的时刻框行、行内按钮行）和 ② 共用开关样式 `Switch.module.css`（W5），A 再换提醒设置和编辑页；A 不改 `Settings.*`、`Switch.module.css`，B 不改 `Form.*`。
3. **令牌**：只有 A 改 `tokens.json`；B 要新令牌找 A，本单原则上不新增（硬约束 6）。
4. 每个 PR 贴 e2e 口径首屏前后数字、`detect.mjs` 前后数字、第七节要求的并排对照图。
5. 八关和并排对照的记录存 `docs/03-评审/B2-UI-b/`（目录已有），新文件登记进 `文件登记册.md`。
6. 分支 `b2ui-b/<主题>`；B2-UI-a 的 R8 做法照用（别的批次验收钉 commit，本批照常合主干）。

---

## 四、验收标准（汇总）

| # | 标准 | 怎么验 |
|---|---|---|
| V1 | **底栏和“＋”0 像素差（M5）**：底栏区域视觉基准 `maxDiffPixels: 0`，基准取**底栏改动那一单的签字版**；`git diff` 里 `src/kit/components/GlassBar/`、`src/motion/glass-*.ts`、`src/styles/base.css` 模糊相关规则都为空 | 视觉基准（Chromium）；`git diff` |
| V2 | 首屏 e2e 口径 ≤ 150 KB，比开工基线净增 ≤ 0（W6 例外 ≤ 0.45 KB（11-09 主持人定：采纳安全复审建议、含文案，CI 审查员实测 423 B）） | `b2-first-screen-budget.spec.ts` 两浏览器各 3 次 <br>**收尾实测（前端 B 11-09）**：共用工作区（主干 807a10f 加当时全部未提交改动，含前端 A 的工作）`b2-first-screen-budget.spec.ts` chromium、webkit 各 3 次都是 **134.7 KB**（开工基线 134.1 KB；今天页出现约 0.75 s / 2.0 s）。工作区里混着别人的改动，这个数分不出本单多少，按主持人定由 CI 审查员按稳定口径复量。本单能单独量的部分（稳定口径，同一份工作区只换本单文件比）：W3、W4 +2 B；开关并进 Form.module.css（删 Switch.module.css，主持人 11-09 定）−25 B；W1、W5 原来多出的约 25 B 里还剩约 3 B，出在几个设置子页的预加载清单各多两项依赖，不复制样式省不掉，主持人 11-09 认可不再省。 |
| V3 | 设置页全部用 kit 设置行和 FormButton，相关页面样式无私有 `.grp/.row/.rowBtn/.btn/.wide` | grep（含 B3、B5 新加的设置节） |
| V4 | R-276、R-277 外观不变：设置页按钮区域 `maxDiffPixels: 0`（选 D1 ① 时） | `b1-settings.spec.ts` 不改、全绿；设置页按钮区域单独基准 |
| V5 | 全站 ≥ 44 点击区 | `hit-target.spec.ts` 0 个 |
| V6 | 编辑页勾选只剩两种用途分明的样式（完成圆圈 + D2 定的样式），开关画法全站一份 | 截图；读屏；grep |
| V7 | “更新”拿不到模块有退路，退路不自己重载、不绕调用方忙碌检查、不绕版本门 | W6 单测 ①～⑤；安全审查员复审签字 |
| V8 | 设置说明断行：中文非 `pretty`、韩文 `keep-all` | W2 自动检查 + 截图 |
| V9 | 八关全过 + 每项有并排对照图，记录在 `docs/03-评审/B2-UI-b/` | 第 ⑧ 关负责人看图点头 |
| V10 | 单测、e2e 全绿；`detect.mjs` 不比改前多 P0 / P1 | CI |

---

## 五、风险

| # | 风险 | 应对 |
|---|---|---|
| R1 | 设置页按钮换成 FormButton 时顺手改掉 R-276、R-277 定过的外观 | 硬约束 5；`b1-settings.spec.ts` 断言不动；按钮区域 0 像素差 |
| R2 | 提醒设置换行零件时丢了读屏结构（卡标题、开关描述） | W1 八关 ④ 逐项核；`b2-settings-remind.spec.ts` |
| R3 | W6 退路绕过版本门，或绕过调用方忙碌检查丢掉编辑中、录音中的内容 | 退路只返回结果、不自己重载（单测 ④⑤）；只在拿不到模块时走；重载次数由调用方记；安全审查员复审 |
| R4 | W6 退路进首屏，超 150 KB | 优先“换地址再 import 一次”，不复制 SW 逻辑；上限 0.45 KB（11-09 主持人定：采纳安全复审建议、含文案，CI 审查员实测 423 B），超了先报；必要时只做提示文字（D3 ②） |
| R5 | 底栏改动签字后视觉基准整体换版，本单按旧基准验 | V1 基准取底栏签字版；开工前确认基准已更新 |
| R6 | B3、B5 先加的设置节用了旧 `.row` / `.btn`，W1、W4 漏掉 | 开工重新 grep，范围写进 W1、W4 |
| R7 | A 被 B2-UI-b 占走时间，拖慢 B3～B5 | 开工时机写死在 B5 之后、底栏签字之后（M1） |
| R8 | 整页细修放哪一批没定，后面排期空着 | D5 和底栏一起问负责人 |

---

## 六、要负责人定的事（推荐项放第一；等负责人看完底栏以后一并问）

| # | 问题 | 选项 |
|---|---|---|
| D1 | 设置页按钮（退出这台设备、退出其他所有设备、移除设备、弹窗按钮等）换成通用按钮以后长什么样 | **① 外观一模一样，只换实现**（FormButton 加紧凑尺寸，看得见 38、灰色实底，R-276、R-277 不变；推荐，负责人定过的样子不动；架构审同意）／② 改成和编辑页一样的 44 高描边胶囊（全站按钮一个样，但推翻 R-276，要出对照图） |
| D2 | 待办“重要”、日程“全天”用什么勾选样式 | **① 开关（和设置页开关一样）**（推荐：圆圈只表示“完成”，“全天”切了会收起时刻框、“重要”是一个状态，都是开关的意思；架构审同意）／② 也用圆圈（和“已完成”一样，但两个圈意思不同）／③ 维持方框 |
| D3 | “更新”拿不到模块时怎么办 | **① 先自动再试一次（换个地址再下载；有新版本在等就切过去），还不行再提示“请完全关闭后重新打开”**（推荐，首屏最多多约 0.3 KB；架构审同意，做法按 W6）／② 只改提示文字，不自动再试（不占首屏，但用户要自己重开）／③ 不改（接受现状） |
| D5 | 全站审查里的整页细修（“已完成”挪页底、下拉改行式、子页合并、空状态引导等约 20 项）放哪一批 | **① 另开一单，排在底栏签字之后、B2-UI-b 收完遗留项后接着做，逐页出效果图给你挑**（推荐：整页截图都含底栏，底栏没定先修整页会白截一遍；架构审同意）／② 并进本单（本单人日要再加约 5～8，粗估）／③ 和底栏那一单一起做（不推荐：会拖慢底栏这件单独的事） |

**D5 整页细修待收项（本单做的过程中发现，记进 D5 那一单，到时逐页出效果图给负责人挑）**：

- 编辑日程“日期”一行：W5 把“全天”从方框（宽 20）换成开关（宽 48，R-364 D2）后，同一行的日期框跟着窄了约 28px（Chromium 440 宽实测）。主持人 11-09 定先不调，D5 时一并看。对照图 `docs/03-评审/B2-UI-b/W5-编辑页开关-改前改后并排.png`。
  - 375 宽补核（Chromium 375×812，简洁皮肤浅深，11-09）：中文日期框 148 → 127 宽，“2026/11/09”刚好放下、没有余量，不换行；**韩文日期框 113 → 92 宽，日期被截成“2026/11”**（改前用方框时就已截成“2026/11/0”，W5 截得更多），也不换行（行高 44 不变）。韩文是“하루 종일”比“全天”长。对照图 `docs/03-评审/B2-UI-b/W5-日期框-375宽-改前改后.png`。注意 Chromium 的日期格式跟浏览器语言走，iPhone Safari 的样子还要另看

**已定、不再问**：

| # | 问题 | 定为 |
|---|---|---|
| D4 | 登录页要不要支持玻璃皮肤 | **② 登录页固定简洁皮肤**（主持人 11-07 照架构审定）：现在全 App 没有换皮肤功能，登录页随以后“换皮肤”那一批做；W7 移出本单 |

---

## 七、防返工要求（照 [界面改动防返工规则](../00-团队/界面改动防返工规则.md)）

1. **唯一参照稿**：每一项开工前，在 PR 说明里写明它对照的唯一参照稿，只认这一份，其他试验页、对比页不作验收依据：

   | 项 | 唯一参照 |
   |---|---|
   | W1、W2、W3 设置行、断行、危险行 | `docs/02-设计/皮肤-v4/皮肤视觉稿.html` 的设置页（视觉）＋定稿线框（交互）；两者冲突时以需求记录里编号最新的一条为准 |
   | W4 设置页按钮 | R-276、R-277 定的外观，即**改前（开工基线）的设置页截图**（D1 选 ① 时要求 0 像素差） |
   | W5 开关 | 设置页现有开关（`Settings.module.css` 的 `.toggle`）；编辑页布局照视觉稿编辑页 |
   | W6 失败提示 | 现有 `UpdateBanner` / `CacheTooNewScreen` 的提示样式（只加一句文字，不改样式） |
   | W8 随手记占位 | 视觉稿主页签页面顶部起点 |

2. **并排对照**：每一项交付的对照图里，**App 截图和参照稿截图并排**，画面相同、皮肤相同；一律用 **Chromium 或真机**截（本机 Playwright WebKit 不画 `backdrop-filter`，不能用来判断模糊、透明）。主持人本人看过实际效果、在图上标出每个对照点，再发给负责人；只报“测试通过”不算交付。
3. **负责人原话原样传下去**：主持人派给开发、审查员的说明，**原样粘贴负责人的原话**，不能只写转述；原话出处写需求编号（如 G11“你自己看这些是不是丑爆了”（11-06）、R-276、R-277、R-352）。原话里有位置、范围的说法，开工前先出一张标好位置的示意图请负责人确认。
4. **出处要带编号**：代码注释、令牌说明里凡写“负责人定 / 负责人说”，必须带 R-xxx。
5. **大一点的改动上预览版**：W1、W4 改动面大，部署到预览版请负责人在手机上看；部署前先问负责人。

---

## 修改记录

| 日期 | 改了什么 | 谁 |
|---|---|---|
| 2026-11-07 | 第一稿 | 计划起草人 |
| 2026-11-07 | 按架构审（有条件通过 7 / 10）改：M1 写明开工在底栏签字之后、不占前端 A 的 B3～B5 关键路径、开工重新量行号并把 B3、B5 新设置节纳入 grep；M2 W7 移出，D4 定为 ②（登录页固定简洁皮肤），不再问负责人；M3 W8 改为已做只核对，变量名改 `--safe-top`；M4 开关画法由 B 抽成 kit 共用 `Switch.module.css`，写进约定；M5 V1 收紧为底栏区域 0 像素差、基准取底栏签字版、diff 范围含 `glass-*.ts` 和 `base.css` 模糊规则；M6 W6 退路放进 `updateServiceWorkerLazy`、只返回结果不自己重载，优先换地址再 import，加“不绕调用方忙碌检查”单测；M7 加硬约束 6：`tokens.json` 和皮肤文件归 A，本单原则上不新增令牌；M8 W3 改“等 W4”、W2 写清三处 `pretty` 由 A、B 在 W1 删并加自动检查、人日改为 4.9～6（八关 1.5）。D1、D2、D3、D5 保留推荐，等负责人看完底栏一并问。新增第七节防返工要求（引用《界面改动防返工规则》：唯一参照稿、Chromium 或真机并排对照、原样粘贴负责人原话） | 计划起草人 |
| 2026-11-09 | 收尾（前端 B）：V2 写明收尾实测数和原因；W5 的共用开关按主持人定从 `Switch.module.css` 并进 `Form.module.css` 的 `.switch`（只动开关那一段，Switch.module.css 已删）；W4、W8 的视觉基准建在 `tests/e2e/visual/b2-ui-b-lock.spec.ts`（Chromium，CI 新加一步跑）；W9 跑通记录在 `docs/03-评审/B2-UI-b/W9-csp夹具收尾-e2e跑通记录.md`；W3、W4 八关自验在 `docs/03-评审/B2-UI-b/W3W4-八关自验.md` | 前端 B |
| 2026-11-09 | 代码审（有条件通过 8 分）的修改和 R-366 一起做（前端 B）：锁定用例加 R-276、R-277 数值断言，补锁确认框那一对按钮和导出行；R-366 账号页“退出其他所有设备”改描边，FormButton 加 outline（只配合 compact）；对照图 `docs/03-评审/B2-UI-b/R-366-退出其他设备描边-改前改后.png` | 前端 B |
