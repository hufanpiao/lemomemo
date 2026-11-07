# B2-UI-a 任务单：界面底层零件统一

- 日期：2026-11-07　作者：计划起草人
- 状态：**已按架构审修订，负责人要定的事已全部定完，可开工**。架构审 [B2-UI-a-任务单-架构审](../03-评审/B2/B2-UI-a-任务单-架构审.md) 结论“有条件通过（6.5）”，P0 1～4、P1 5～10、P2 11～15 已按审查和主持人 11-07 的指示改进本单。负责人 11-07 先后定了六条（第六节）：现在就开工，不等 B2 签字；聚焦框浅色深灰、深色浅灰，全 App 一种，底栏和“＋”也跟着变；首屏 150 KB 不放宽，顺带瘦身 3～5 KB；**守住 1～2 天，设置行（U5）整体挪到 B2-UI-b**；空时间框不加“可不填”。
- 开工时机（负责人 11-07 定）：**B2-UI-a 现在就开工，不等 B2 签字**。B2 真机查出的问题照样在 B2 窗口里返工，不并进本批。B2 验收钉在指定 commit 上，本批照常合主干（见风险 R8）。
- 位置：路线图第 8 行 B2 → **B2-UI-a** → B3。负责人 11-06 选“折中”：B3 前用 1～2 天统一界面底层零件；整页细修放到 B5 以后的 B2-UI-b。负责人 11-07 定**守住 1～2 天**，本批只做：**设计变量、按钮、输入框、列表行、空状态、首屏瘦身**。
- 依据：
  - [路线图](路线图.md) 第 8 行；[B2 剩余清单 11-06](B2-剩余清单-11-06.md) 第 49、210 行；R-351（需求记录第 359 行）；
  - 待改清单：[B2 全站视觉审查 69659c1](../03-评审/B2/B2-全站视觉审查-69659c1.md)（A1～A8、B1～B27 和文末各段“追加”）；
  - 原话清单：[负责人观感要求清单](../06-测试/负责人观感要求清单.md)（G1～G12，本批主要对 G11；G1～G8、G10、G12 是“不许变”的底线）；
  - 视觉稿：`docs/02-设计/皮肤-v4/皮肤视觉稿.html`（UI-4 v34）第 135 行（主按钮 `.btn.pri` 用 `--accent`）、第 978 行（圆角三级：大面板 28、小卡片 20、**输入框 14**）、第 979 行（黄色只留给“该你动手”的主按钮和“＋”）；
  - 令牌来源：`docs/02-设计/皮肤-v4/令牌/tokens.json`（`build/tokens.py` 生成 `src/styles/tokens.css`、`src/styles/skins/glass.css`、`src/styles/skins/simple.css`，生成物不手改）。`--panel-2` 的令牌说明就是“输入框、未选中胶囊”。

## 硬约束（本单通篇适用）

1. **底栏和“＋”保持透明毛玻璃，不动**（G1、G8、G12，负责人原话“这个不要动”）。`src/kit/components/GlassBar/` 整个目录、`src/motion/glass-*.ts`、`src/styles/base.css` 里顶部和底部模糊相关的规则，本批一律不改文件。底栏和“＋”的键盘聚焦框跟着全 App 改成深灰 / 浅灰（负责人 11-07 定），**靠 `tokens.json` 里 `--focus` 的取值自动生效，不改 `GlassBar.module.css`**；底栏的透明、毛玻璃、外观都不动。底栏验收按 V1 的写法。
2. **首屏 JS 上限 150 KB 不放宽，一律按 e2e 页面时钟口径量**：`tests/e2e/b2-first-screen-budget.spec.ts`（冷启动打开今天页，“今天页出现之前开始下载的 JS” gzip 合计；chromium、webkit 各跑 3 次）。**基线：commit `2bcd692`，149.8 KB**（这个口径）。`node build/check_size.mjs` 只量“入口 + 静态 import”，本机约 127 KB，**只作辅助，不作验收**。负责人 11-07 定：本批顺带瘦身，签字时 e2e 口径 **≤ 145～147 KB**（腾出约 3～5 KB），见 U7。进首屏的零件改动净增 ≤ 0：新零件优先只做 CSS，要加 JS 就同一个 PR 里删掉被替换的重复代码抵掉；每个 PR 贴 e2e 口径前后数字。
3. **改完界面要过八关**：① 原话清单（逐条对 G1～G12）② avoid-ai-design（`detect.mjs` + 看图项）③ design-critique ④ 无障碍 ⑤ 设计系统（令牌、零件一致性）⑥ 动效（review-animations）⑦ 像素断言（e2e 视觉基准，含底栏 G1～G4、G7、G10、G12）⑧ 本人看图（负责人看对照图）。全过才算这一批做完；只改一处也要复查受影响的关。
4. **只统一零件，不重排整页**：不挪字段顺序、不合并页面、不改文案，不改哪一行放在哪张卡里。页面文件里只允许“把手写的控件换成零件”“删掉被零件替代的重复样式”。

---

## 一、范围清单（现状 → 目标）

行号按 2026-11-07 工作区（架构审已逐条核对）。“简洁”“玻璃”指两套皮肤，各有浅色、深色，共四套取值。

### U1 设计变量（令牌）

| # | 现状 | 目标 |
|---|---|---|
| U1-1 | 输入框底色、圆角没有专用令牌：`src/kit/components/Form.module.css:56` 用页面底色 `--bg`（简洁浅色 #E9EAEE、玻璃浅色 #EFEEE8）、`:55` 用 `--r-sm`（10px）；`RemindSettings.module.css:332～344` 的 `.time` 又用 `--panel-2`、`--r-sm`，两处不一样（B5） | `tokens.json` 加输入框专用令牌（如 `--inp-bg`、`--r-inp`）：底色取 `--panel-2`（令牌说明“输入框、未选中胶囊”），圆角取 **14（=`--r-md`），依据是视觉稿第 978 行的文字规则**，不按视觉稿里登录 `.inp` 16px、编辑页 `.fld .v` 12px 的示意 CSS；四套皮肤都给值。表单、提醒时刻框、登录框都只用这两个 |
| U1-2 | 输入字号靠每个文件自己写媒体查询：`Form.module.css:65～71`、`RemindSettings.module.css:346～350` 各写一遍 `@media (any-pointer: coarse)` 改 16px | **电脑 15px、触屏 16px，维持现在的做法，只统一写法**：输入框类基础字号引用 `--fs-15`，**`@media (any-pointer: coarse)` 改 `--fs-16` 只在 `Form.module.css` 写一处**；提醒时刻框 `.time`、登录框复用这同一个类或同一条规则，删掉 `RemindSettings.module.css:346～350` 那段媒体查询。提醒时刻框在电脑上从继承 `.timeLbl` 的 14px 变成 15px，属于统一零件，可接受。不新加 `--fs-inp`，电脑端字号不变大（不需负责人定）。`src/app/__tests__/input-font-size.test.ts` **不改**（它本来就认触屏媒体查询里的 `font-size`），继续全绿 |
| U1-3 | 聚焦框：`--focus` 蓝 #2F7BF5（`tokens.json:1755`，四套皮肤同值），全站 13 个 CSS 文件用 `var(--focus)`（含 `GlassBar.module.css:147、387`），`base.css:388` 是全局 `:focus-visible`；另外 `src/kit/components/CheckCircle.module.css:18` 聚焦框用黄色 `--accent`（白底上约 1.3:1，不过 3:1） | **前端 A 只在 `tokens.json` 里改 `--focus` 在四套皮肤的取值**：每套皮肤里**填和该皮肤 `--text` 相同的字面色值**（`tokens.json` 全是字面量，不写 `var(--text)`；以后 `--text` 改了要同步改 `--focus`，在令牌说明里注明），即浅色深灰、深色浅灰（和视觉稿登录 `.inp.focus{box-shadow:inset 0 0 0 2px var(--text)}` 一致），**各文件的 `var(--focus)` 引用一律不动**，`base.css:388` 全局规则和底栏、“＋”的聚焦框都自动生效（负责人 11-07 定：全 App 只用一种聚焦色）。`CheckCircle.module.css:18` 改成 `var(--focus)`（A 的文件）。聚焦框对相邻底色 ≥ 3:1，四套皮肤和“App 浅色 + 系统深色”都用 `build/check_contrast.py` 量，底栏玻璃上的聚焦框也要量 |
| U1-4 | 主按钮没走 `--accent`：“打开通知”等用 `.act` 的 `--chip-on-bg`（`RemindSettings.module.css:225～234`，B8）。`--chip-on-bg` 在两套玻璃皮肤已是柠檬黄 #F2DF4A，**只有简洁浅色（黑）和简洁深色（近白）不是黄** | 主按钮用 `--accent`（柠檬黄），依据视觉稿第 135 行 `.btn.pri`、第 979 行“黄色只留给该你动手的地方”和 `tokens.json` 里 `--accent` 的说明。**真正变色的只有简洁浅色（黑 → 黄）和简洁深色（近白 → 黄）**，玻璃皮肤看不出变化。不新造颜色 |

### U2 输入框（`src/kit/components/Form.tsx`、`Form.module.css`）

| # | 现状 | 目标 |
|---|---|---|
| U2-1 | `.input/.select/.area`（`Form.module.css:48～60`）底色、圆角见 U1-1；空的日期、时刻、项目框是一块块灰框（B5） | 换成 U1-1 的令牌、U1-2 的字号。**空时间框不加“可不填”**（负责人 11-07 定），零件也不为日期、时刻类型加占位字支持；文本框现有的 `placeholder` 参数（`Form.tsx:95～125`）保持原样 |
| U2-2 | 标题框聚焦是直角框（`Form.module.css:101～112` `.title` 无圆角，聚焦规则 `:114～120` 和别的框共用），一页里两种聚焦样式（B4） | 无框的标题框聚焦时下划线换成 `--focus` 色、**并从 1px 加粗到 2px**（只换颜色键盘用户不容易看出来），不画 outline，由无障碍关核对是否看得出；有框的输入框 outline 跟控件圆角走（`--r-inp`） |
| U2-3 | 下拉 `.select`（`:85～93`）已去掉原生凸边，但宽度随内容：时区占满整行、提醒只占半行（追加段） | 下拉在 `.control` 里用和 `.input` 一样的伸缩方式（`flex: 1 1 0`），宽度一致；不改成“行 + ›”（那是整页改法，留 B2-UI-b，B7） |
| U2-4 | 勾选框 `.check input`（`:147～151`）是方形系统复选框，打勾后是黄方块；和列表的完成圆圈不是一种（B6） | 零件层提供“圆圈勾选”外观（复用 `CheckCircle` 的画法或同一组令牌），`Check` 加一个外观参数；**“已完成”那一行挪到页底、新建时不显示属于整页改法，不做**（B2-UI-b） |
| U2-5 | 登录页 `src/features/auth/ui/AuthPage.module.css` 的 `.input`：圆角 `--r-md`、底色 `--panel`（白）、没有 `font: inherit`，占位字走浏览器默认等宽字体（B23） | 改用同一组令牌（底色、圆角、字号）、加 `font: inherit`，占位字跟正文字体；聚焦色随 `--focus` 自动变 |

### U3 按钮（`FormButton`，`Form.tsx:186～188`、`Form.module.css:162～195`）

| # | 现状 | 目标 |
|---|---|---|
| U3-1 | `FormButton` 只有普通、危险两种 | 升成 kit 通用按钮：保留 `FormButton` 名字和现有用法不变，加 `variant`：`primary`（`--accent` 实底、`--on-accent` 字，U1-4）、`secondary`（现 `.btn`）、`danger`（现 `.btnDanger`）、`dangerFill`（危险底色，确认框用）、`ghost`；高度一律 `--hit`（44） |
| U3-2 | **RemindSettings 的按钮没用 FormButton**：`.act` 3 处、`.danger` / `.ghost` / `.dangerFill` 各 1 处，样式在 `RemindSettings.module.css:225～285`，和 `FormButton` 重复（文末“前端 A 第三轮”第②条） | 全部换成 `FormButton`，逐个映射如下表；删掉 `RemindSettings.module.css` 里 `.act/.danger/.dangerFill/.ghost` 及其 `:disabled`、`:focus-visible` 规则（保留 `.dlgBtns` 排列）。**只换按钮，提醒设置的卡和行不动**（设置行整体在 B2-UI-b） |
| U3-3 | 设置页另有一套 `.btn/.danger`：`src/features/settings/ui/SettingsPage.module.css:170～198`，用在 `DevicesSection.tsx:50` | `DevicesSection` 的按钮换 `FormButton`；删掉 `SettingsPage.module.css` 里不再用的 `.btn`（`.danger` 还被 `AccountSection.tsx:72` 的整行按钮用着，那是设置行，留 B2-UI-b，本批不删）（**11-07 已改：本批不换**，DevicesSection 按 R-276“看得见 38”退回 `.btn`，U3-3 整体挪到 B2-UI-b，见修改记录） |
| U3-4 | 编辑页深色下没有自己 class 的按钮被 `EditShell.module.css:72～79` 的 `:where(...) button` 规则（注释从 67 行起）画成立体斜边框（追加段“主持人 11-06”） | 编辑页里所有按钮都是 `FormButton` 或有自己 class 以后，删掉这条兜底规则；删之前 grep 确认编辑页没有裸 `<button>` |
| U3-5 | **Pressable 在 `aria-disabled` 时仍播按压动效**：`src/motion/Pressable.tsx:30～33` 按下一律 `setPressed(true)`，`Pressable.module.css:8～11` 照样缩到 0.97；今天页只读行的 ×（`TodayPage.tsx:66`）、待办页（`TodosPage.tsx:152～161`）能看到（文末第③条） | `aria-disabled="true"`（以及 `disabled`）时不进 `pressed`；在已有的 `src/motion/__tests__/Pressable.test.tsx` 里**加用例**，断言 `aria-disabled` 时按下后 `data-state` 仍是 `idle`；减少动态效果的分支同样不变淡 |
| U3-6 | 返回按钮大小不一：设置首页“‹ 今天”40×19，二级页“‹ 设置”40×44（A7）。返回按钮分散在 `EditShell.module.css:23`、`FullReminderPage.tsx:72～73`（整页提醒的“‹ 返回”）、`SettingsPage.module.css:28、335`（`:335` 的 `.backBtn` 供 `SettingsSub.tsx:38`、`DeleteAccountView.tsx:52` 用）、`RecentlyDeletedPage.module.css:18`（`CalendarSettings.tsx` 没有返回按钮，顶栏和返回由设置页画） | 统一规则：点击区 ≥ 44×44（不够的用 `::after` 外扩，同 `Settings.module.css:223～231`），字号、颜色、“‹”写法一致，不挪位置。**按文件分**：`EditShell.module.css:23`、`FullReminderPage.tsx:72～73`（及其样式）归 A；`SettingsPage.module.css:28、335`、`RecentlyDeletedPage.module.css:18` 归 B（B 只动返回按钮，不动设置行）。A 在第一个半天把统一后的写法（一段 CSS）贴进接口分支说明，B 照抄到自己的文件 |

U3-2 的逐个映射（`.act` 3 处）：

| 位置 | 按钮 | 现在 | 换成 | 理由 |
|---|---|---|---|---|
| `RemindSettings.tsx:100` | 打开通知（`remind-enable`） | `.act` | `primary` | 这页唯一“该你动手”的操作（B8） |
| `RemindNotice.tsx:121` | 重新订阅（`remind-resubscribe`） | `.act` | `primary` | “要重新打开”提示里的唯一操作。要重新订阅时通知权限已是 granted，“打开通知”按钮不显示，两块黄不会同屏；万一同屏，这一个降为 `secondary` |
| `RemindNotice.tsx:63` | 重新连接（`remind-reconnect`） | `.act` | `secondary` | 移除别的设备以后的补救操作，不是主路径；和“移除它…”在同一位置交替出现 |
| `RemindNotice.tsx:70` | 移除它…（`remind-remove-holder`） | `.danger` | `danger` | 原样 |
| `RemindNotice.tsx:87` | 取消（`remind-remove-cancel`） | `.ghost` | `ghost` | 原样 |
| `RemindNotice.tsx:92` | 移除（确认框，`remind-remove-confirm`） | `.dangerFill` | `dangerFill` | 原样 |

变色范围：只有 `primary` 两个按钮在**简洁浅色**（黑 → 黄）和**简洁深色**（近白 → 黄）下变色，玻璃两套本来就是黄；`secondary` 的“重新连接”在四套皮肤里都从实底变成描边。

### U4 列表行（今天、待办、最近删除、日历当天列表）

| # | 现状 | 目标 |
|---|---|---|
| U4-1 | 三份几乎一样的 `.list/.row`：`src/features/today/ui/TodayPage.module.css:56、62`，`src/features/todos/ui/TodosPage.module.css:60、66`，`src/features/today/ui/RecentlyDeletedPage.module.css:40、46`（后者多了 `padding: 6px 0`） | 抽成 kit 共用 CSS（`src/kit/components/List.module.css`：`.list`、`.row`、`.lead`、`.title`、`.meta`、`.trail`），各页 import 同一份，页面私有文件里同名规则删干净；**只做 CSS、不加 JS 组件**。注意：今天页如果同时 import 共用和私有两份模块，类名表反而变大，PR 里贴 e2e 口径数字核对 |
| U4-2 | 同一列表左边不齐：今天页日程行标题 x≈70、待办行 x≈48（B17） | `.lead` 固定宽度（圆圈、时间都占同一格），标题起点一致。这是看得见的位置变化，对照图里单独标出 |
| U4-3 | 行尾 × 两份：`TodayPage.module.css:143`、`TodosPage.module.css:131` | 合进共用 `.trail` 按钮样式；点击区 44×44 保持 |
| U4-4 | 完成圆圈本身 22×22（`src/kit/components/CheckCircle.module.css:5`），没查到外扩点击区（A8 待核实） | 核实；没有就照 `Settings.module.css:223～231` 的 `::after` 写法扩到 44×44，不改圆圈大小（A 的文件） |
| U4-5 | 待办列表直接铺在灰底上，今天、设置是白卡片（B18；视觉稿“面板一律纯白”） | 共用 `.list` 提供白色面板外观（`--panel`、`--r-lg`），三页统一；只加底板，不改行顺序和分组。会改变底栏后面透出的内容，见 V1 |

### U5 设置行 —— **整体挪到 B2-UI-b**（负责人 11-07 定，守住 1～2 天）

原列的四项全部不在本批，记在这里供 B2-UI-b 直接接手：

- U5-1 日历设置、提醒设置换 kit 设置行：`CalendarSettings.module.css:19、27、130～149`，`RemindSettings.module.css:17、30、135～162`，`SettingsPage.module.css:49、58、273～310` 的旧 `.grp/.row/.rowBtn`（提醒设置 `RemindSettings.tsx` 173 行、样式 443 行，最重的一项）；
- U5-2 说明文字断行（B11）：`Settings.module.css:97～103` 的 `text-wrap: pretty`，规则拟为“中文去掉 `pretty`、用普通换行，韩文 `:lang(ko)` 加 `word-break: keep-all`”，`SettingsPage.module.css` 的 `.sn` 同改；
- U5-3 `SettingsEntryRow` 加 `danger` 外观，`AccountSection.tsx:72` 改用（届时连同 `SettingsPage.module.css` 的 `.danger` 一起删）；
- U5-4 “导出全部数据”一行加 ›（B24）。

本批对 `src/kit/components/Settings/*`、`CalendarSettings.module.css`、提醒设置的卡和行**不动**；聚焦色随令牌自动变不算改动。

### U6 空状态

| # | 现状 | 目标 |
|---|---|---|
| U6-1 | 四份写法：`TodayPage.module.css:219`（左对齐、上下 8）、`TodosPage.module.css:146`（居中、上下 24）、`RecentlyDeletedPage.module.css:87`（居中、上下 24）、`src/features/calendar/ui/CalendarPage.module.css:568` `.dayEmpty`（`DayList.tsx:107`）；最近删除页说明左对齐、空状态居中，两种对齐（B25） | 共用一份空状态样式（放进 `List.module.css`，只做 CSS）：一句主文 + 可选一行“下一步”提示位，对齐方式全站一种；各页换用，**现有文案不改** |
| U6-2 | `src/kit/components/Placeholder.tsx:9～15`（随手记、隐私记占位） | 有 `note` 时套同一套空状态样式；没 `note` 的开发占位不动 |
| U6-3 | 今天页“今天没有日程 / 今天没有安排”说两遍、没有引导（B13）；随手记没有“＋”（B19） | **不在本批**：要改文案和页面结构，留 B2-UI-b；本批只保证零件有“下一步”位可用 |

### U7 首屏瘦身（负责人 11-07 定）

| # | 现状 | 目标 |
|---|---|---|
| U7-1 | e2e 口径首屏 149.8 KB（commit `2bcd692`，`b2-first-screen-budget.spec.ts`），离上限只剩约 0.2 KB | 签字时 e2e 口径 **≤ 145～147 KB**（chromium、webkit 各 3 次），上限仍是 150 KB 不改 |
| U7-2 | 首屏里哪些可挪，还没逐项量 | 开工先按 e2e 口径列出“今天页出现之前开始下载”的每个块和大小，再挑候选：本批删掉的重复样式和类名表（U3、U4、U6）、首屏用不到却在今天页出现前就被下载的模块。**改成按需下载时，必须让它在今天页出现之后才触发**（只把静态 import 改成 `import()`、但仍在出现前触发，e2e 数字不变），并同步 `build/check_first_paint_chunks.mjs:22` 的 `FIRST_PAINT_DYNAMIC` 名单和 `tests/build/first-paint-graph.test.ts`。**不删功能、不改行为**，每项写进 PR 说明和前后数字 |
| U7-3 | — | **首屏词典（i18n）拆分不在本批**：属于首屏结构改动，可能带来首帧文字闪动（G10），留到以后单独排。如果包体分析证明其余几项凑不够 3 KB，停下来报主持人转负责人，不自己扩大范围 |
| U7-4 | — | 瘦身改动走和它相关的关（动效、像素断言、本人看图），确认按需下载没有带来首帧闪动或底栏位移（G10 冷启动逐帧） |

---

## 二、不在本批

- 底栏、“＋”的透明、毛玻璃、外观；顶部和底部模糊；切页过渡 V1（文末 11-07 前端 B 记的旧页快照透字）；底栏右边缘竖条（负责人 11-07 定不改）——文件全部不碰（聚焦色随令牌自动变，见硬约束 1）。
- **设置行 U5 全部**（负责人 11-07 定，挪到 B2-UI-b，见上）。
- 首屏词典拆分（U7-3）。
- 空时间框占位字“可不填”（负责人 11-07 定不加）。
- 整页细修，全部留 **B2-UI-b**（B5 签完后，逐页过八关、出效果图给负责人挑）：B6“已完成”挪页底、新建时隐藏；B7 下拉改“行 + 右边值 + ›”；B9 邮箱入卡；B10 设备名区分；B11 说明断行（随 U5-2）；B12 子页合并、下半屏空白；B13、B19 空状态文案和引导；B14 开始 / 结束两行；B15 找不到记录整页空状态；B16 倾斜高光说明；B20 时区写中文；B21 图例说明；B22 周视图今天行；B24 导出一行（随 U5-4）；B26 设备列表报错语气；B27 提醒一行排法；编辑日程标题卡下的分隔线；“下一件”卡时间尺（待设计定）；“要新版本”标记边框对比；周视图只读斜纹；今天页只读提示条盖住下一行。
- 挡使用 A1～A8 里已在 B2 修完的（A1 字号、A2 纪念日入口、A4 本机时间等）不重做，只在验收时回归；A5、B2（`color-scheme`、深色原生控件）如果 B2 已修，本批只核对新零件在深色下没有回退。
- 皮肤配色本身不改，只新增 U1 的令牌、改 `--focus` 的取值。

---

## 三、分工（按文件分，不重叠）

| 人 | 只改这些文件 | 内容 | 估算（人日） |
|---|---|---|---|
| **前端 A**（令牌、输入框、按钮线） | `docs/02-设计/皮肤-v4/令牌/tokens.json`（**唯一改令牌的人**）及生成物 `src/styles/tokens.css`、`src/styles/skins/*.css`；`src/kit/components/Form.tsx`、`Form.module.css`、`EditShell.module.css`、`CheckCircle.*`；`src/motion/Pressable.tsx`、`Pressable.module.css`、`src/motion/__tests__/Pressable.test.tsx`；`src/features/todos/ui/TodoEditPage.tsx`、`src/features/calendar/ui/EventEditPage.tsx`；`src/features/reminders/ui/` 下全部文件（`RemindSettings.*`、`RemindNotice.tsx`、`RemindDnd.tsx`、`ClockWrongNote.tsx`、`RemindShowTitle.tsx`、`RemindUpcoming.tsx`、`Remind.module.css`；本批只换按钮和时刻框）；`src/features/auth/ui/AuthPage.module.css`；`src/styles/base.css`（**只认领 `:388` 全局 `:focus-visible` 一段**；按 U1-3 的改法不用动它，模糊相关规则禁改） | U1 全部、U2 全部、U3-1～U3-5、U3-6 里 `EditShell`、`FullReminderPage` 两处、U4-4 | **1～1.5** |
| **前端 B**（列表、空状态、瘦身线） | 新建 `src/kit/components/List.module.css`；`src/kit/components/Placeholder.*`、`ReadonlyRow.module.css`、`UndoToast.module.css`；`src/features/sync-notice/ui/SyncNoticeHost.module.css`；`src/features/today/ui/TodayPage.*`、`RecentlyDeletedPage.*`；`src/features/todos/ui/TodosPage.*`；`src/features/calendar/ui/CalendarPage.module.css`、`DayList.tsx`；`src/features/settings/ui/SettingsPage.module.css`（**只动返回按钮 `:28、335` 和删 `.btn`**）、`DevicesSection.tsx`；`build/check_first_paint_chunks.mjs`、`tests/build/first-paint-graph.test.ts`；新写的量数 spec（V5） | U4-1～U4-3、U4-5、U3-6 里 B 的三处、U3-3（**使用** A 的 `FormButton`）、U6 全部、U7 主做、V5 的 44 点击区量数 spec | **0.75～1**（含瘦身 0.25～0.5、量数 spec 0.25） |
| 八关和返工 | — | 设计审查、无障碍、动效、像素断言（含 V1 基准更新）、AI 套路扫描、对照图（两套皮肤 × 浅深 + App 浅色系统深色）；按 B2 的记录每关至少两轮，再加负责人看图 | **0.75～1**（A、B 各分一半） |

**合计约 2.5～3.5 人日**（U5 挪走后按缩小的范围重算；原 3.75～4.75）。A、B 并行，八关两人各分一半，**日历约 1.5～2 天，守住负责人定的 1～2 天**。A 是关键路径（1～1.5 + 八关约 0.5）；B 的瘦身如果超出 0.5，先停下报主持人，不挤占工期。

`ReadonlyRow.module.css`、`UndoToast.module.css`、`SyncNoticeHost.module.css`、`Remind.module.css`、`base.css`、`GlassBar.module.css` 也有 `var(--focus)`，按 U1-3 的令牌改法**都不用改**；前五个写明归属，只是为了以后有需要时知道找谁，`GlassBar.module.css` 禁改。

**约定**：

1. **A → B 接口（第一个半天）**：A 把新令牌名（`--inp-bg`、`--r-inp`）、`--focus` 新取值、`FormButton` 的 `variant` 签名、返回按钮统一写法提交到一个小分支先合，B 再开始用。B 不改 `tokens.json`、不改 `Form.*`，需要新令牌找 A 加。
2. **B → A 接口**：B 换列表行、空状态时如果要 A 的零件出新外观（例如 `CheckCircle` 的点击区写法、`FormButton` 新尺寸），在 PR 说明里写清要什么，由 A 加、合了再用；B 不改 A 清单里的文件。U7 瘦身要动 A 的文件时同样由 A 改，B 提需求，算进 B 的人日。
3. 两人都不碰对方清单里的文件；清单外的文件要改，先在 PR 说明里写、主持人同意再改。
4. 分支名 `b2ui-a/<主题>`；每个 PR 贴 **e2e 口径首屏前后数字**（`b2-first-screen-budget.spec.ts`，chromium、webkit 各 3 次，`check_size` 只作辅助）、`detect.mjs` 前后数字、受影响页面的前后对照图（浅色、深色、App 浅色 + 系统深色三遍，同审查文的截法；简洁、玻璃两套皮肤）。
5. 本单不改已有的测试用例文件（含 `input-font-size.test.ts`）；新增的单测用例、像素断言、量数 spec 随 PR 提交，QA 在 ④ 环核对。（**11-07 例外**：`input-font-size.test.ts` 经主持人同意按代码审建议 3 改成按导入的文件识别，检查规则没有放松）

---

## 四、验收标准（全部满足才算过）

| # | 标准 | 怎么验 |
|---|---|---|
| V1 | 底栏和“＋”不变：**对照场景（`hideContent` / `solidBackdrop`）0 差**；**G1～G4 像素断言阈值全过**；“有字在后面”的基准截图（如 `G1-底栏-有字在后面-todos.png`）因 U4 改了后面的内容会变，**由负责人看图后更新**，不自行更新。`GlassBar.module.css` 没有改动 | `tests/e2e/visual/g-bottom-top.spec.ts` 等视觉基准；更新前后对照图交负责人；`git diff` 里 `src/kit/components/GlassBar/` 为空 |
| V2 | 首屏 e2e 口径上限仍是 150 KB；签字时实测 **≤ 145～147 KB**（基线 commit `2bcd692` 149.8 KB，U7） | `tests/e2e/b2-first-screen-budget.spec.ts`，chromium、webkit 各 3 次，每个 PR 和签字时贴数；`check_size`、`check_first_paint_chunks` 作辅助 |
| V3 | 触屏上所有可输入控件 16px，点任何框都不放大、不横移（A1、G11）；电脑上 15px（提醒时刻框 14 → 15）；触屏媒体查询全站只在 `Form.module.css` 一处 | `src/app/__tests__/input-font-size.test.ts` 不改、全绿；grep `any-pointer: coarse` 的字号规则只在 `Form.module.css`；负责人真机抽查编辑页、提醒时刻框、登录框 |
| V4 | 全站一种输入框外观（底色、圆角、字号、占位字体）和一种聚焦样式（形状跟控件圆角，标题框只变下划线）；聚焦框浅色深灰、深色浅灰，**全 App（含底栏和“＋”）没有蓝色聚焦框，也没有黄色聚焦框**，对相邻底色 ≥ 3:1 | grep 全站无 `#2F7BF5`、无其他蓝色取值作聚焦色；`CheckCircle.module.css` 不再用 `--accent` 作聚焦框；`build/check_contrast.py` 量四套皮肤（含底栏玻璃上的聚焦框）；键盘 Tab 走一遍截图对照（**例外 R-355**：深色“＋”键盘聚焦框内外两侧不到 3:1，登记为例外，见 build/contrast-pairs.json） |
| V5 | 本批涉及的按钮都是 `FormButton`，没有浏览器默认灰底、深色立体边按钮；本批涉及页面的按钮和可点处 ≥ 44×44（A6、A7、A8） | grep `RemindSettings.module.css` 无 `.act/.danger/.ghost/.dangerFill`、`SettingsPage.module.css` 无 `.btn`、`EditShell.module.css` 无 `:where(...) button` 兜底；**前端 B 新写 e2e 量数 spec**（如 `tests/e2e/hit-target.spec.ts`，逐页列出小于 44 的可点元素，报 0 个才过；仓库里目前没有现成的） |
| V6 | `aria-disabled` 的 Pressable 按下不缩放、不变淡 | `Pressable.test.tsx` 新用例；动效关卡逐帧看今天页只读行 × |
| V7 | 今天、待办、最近删除、日历当天列表共用一份行样式，标题左边对齐，列表都在白色面板上 | grep 三个页面样式里不再有自己的 `.row/.del/.empty`；对照图量标题 x 一致 |（**R-357**：只要求每页内部对齐，各页之间不强求一样）
| V8 | 空状态全站一种对齐和样式，现有文案一字不改 | 对照图；`git diff` 里 i18n 词典没有改动 |
| V9 | 页面结构不变：字段顺序、分卡、文案和改前一样（U4-2 标题起点变化除外，对照图已标出）；设置行没有改动 | 对照图逐页比；`git diff` 里 `src/kit/components/Settings/` 为空；审查员签“未重排” |
| V10 | 八关全过。本单的架构审放在 `docs/03-评审/B2/`（随 B2 目录）；**八关和六环记录新开 `docs/03-评审/B2-UI-a/`**，建目录时同时在 `文件登记册.md` 登记 | 见硬约束 3；第⑧关负责人看对照图点头 |
| V11 | 单测、e2e、`detect.mjs` 不比改前多 P0 / P1 | CI 全绿；PR 贴扫描前后数字 |

---

## 五、风险

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | **首屏 e2e 口径只剩约 0.2 KB**，今天页换零件稍一多就超 150 KB；还要腾出 3～5 KB | 不能合并；瘦身不够 | 列表、空状态只做 CSS；CSS Modules 的类名表也算 JS，共用一份比各页各一份更省，但页面不能同时留两份；U7 先按 e2e 口径列块再动手；每个 PR 贴 e2e 数字；B2 返工也可能加首屏字节，**以 B2 返工合入后的主干 e2e 数字为准**，本批负责签字时压到 ≤ 147 KB；分析后估计腾不出 3 KB 就报主持人转负责人 |
| R1b | 瘦身把首屏模块改成按需下载，冷启动出现闪动或底栏位移；或名单没同步 | 违反 G10；`check_first_paint_chunks`、`first-paint-graph` 挂 | U7-2 同步名单和测试；U7-4 冷启动逐帧和底栏视觉基准必过 |
| R2 | 改共用样式波及底栏（`base.css`、`Pressable` 被 GlassBar 用到） | 违反“这个不要动” | GlassBar 目录和模糊规则禁改文件；`Pressable` 只改 `aria-disabled` 分支，GlassBar 的按钮不带 `aria-disabled`；`--focus` 改值只影响键盘聚焦框（负责人已同意）；改后跑底栏全部视觉基准和 `src/kit/components/GlassBar/__tests__/` |
| R3 | “统一零件”滑成“重排整页”，或顺手做了 U5 设置行 | 超出 1～2 天、和 B2-UI-b 重复 | 第二节写死不在本批的清单；V9 由审查员单独签、`Settings/` 无改动；PR 里出现挪位置、改文案、改设置行的改动一律退回 |
| R4 | 深灰 / 浅灰聚焦框在 `--panel-2` 灰底输入框或底栏玻璃上对比度不够 | 无障碍关卡不过 | 四套皮肤用 `build/check_contrast.py` 逐个量 3:1；不够就在 `--text` 系里取更深 / 更浅一档或加粗到 2.5～3px，仍不用蓝；只改令牌，不改 `GlassBar.module.css`；取值写进 PR 说明 |
| R5 | 令牌只能经 `tokens.json` → `build/tokens.py` 生成，A、B 同时要改 | 生成物冲突 | 只有 A 改 `tokens.json`；B 要新令牌找 A；第一个半天先合接口分支 |
| R6 | `RemindSettings.module.css` 被 6 个 tsx 引用（ClockWrongNote、RemindDnd、RemindNotice、RemindSettings、RemindShowTitle、RemindUpcoming），换按钮可能漏一处 | 留下旧样式或某个按钮丢样式 | 删样式前 grep 全部引用；提醒相关单测和 e2e 全跑 |
| R7 | 简洁深色、App 浅色 + 系统深色下柠檬黄主按钮对比度不够 | 无障碍关卡不过 | `build/check_contrast.py` 加 `--accent` / `--on-accent` 这一对，四套皮肤都量 |
| R8 | **本批不等 B2 签字就开工**（负责人 11-07 定），B2 ④（TC-B2-01～88、冒烟、首屏和冷启动数字、视觉基准）还没开始 | B2 签字测的是“B2 + 半个 UI-a”，签字范围不清；B2 返工被本批的样式改动盖掉 | **定为**：① **B2 验收钉在一个指定 commit 上**（主持人开 B2 ④ 时写进 B2 测试报告），QA 只对那个 commit 签；② **B2 返工在主干上叠加**，每个返工 commit 单独补测，补测记录写进 B2 测试报告；③ **本批照常合主干**，不等 B2。视觉基准 PNG 二进制冲突不手合：**后合的一方整张重拍**，并在 PR 里附前后对照 |
| R9 | 做 B2 真机返工和本批的是同一批前端（A、B） | 人日不能直接相加，日历会更长 | B2 返工优先；第三节人日只算本批，日历按“两人全时做本批”估，被返工占用时按实际顺延并报主持人 |

---

## 六、负责人的决定（11-07，全部已定）

| # | 问题 | 负责人定 |
|---|---|---|
| D0 | 什么时候开工 | 现在就开工，不等 B2 签字；B2 真机问题照样在 B2 窗口返工（R8） |
| D1 | 聚焦框的颜色 | 浅色用深灰、深色用浅灰，不再用蓝色 `--focus`（#2F7BF5）；对比度要过无障碍。做法：只改 `tokens.json` 里 `--focus` 四套皮肤的取值，每套填和该皮肤 `--text` 相同的字面色值，不写 `var()`（U1-3、V4、R4） |
| D2 | 空的日期、时刻框要不要写“可不填” | **不加**。这一项关掉，零件也不用为它支持占位字（U2-1） |
| D3 | 首屏上限 | 150 KB 不放宽，本批顺带瘦身腾出约 3～5 KB；按 e2e 口径量，基线 `2bcd692` 149.8 KB（U7、V2） |
| D4 | 工期超出“1～2 天”怎么办 | **守住 1～2 天**：U5-1（提醒设置、日历设置整页换 kit 设置行）挪到 B2-UI-b；本批只做设计变量、按钮、输入框、列表行、空状态和首屏瘦身。设置行 U5-2～U5-4 不在这张清单里，一并挪走（第一节 U5）。人日按缩小后的范围重算为 2.5～3.5，日历 1.5～2 天 |
| D5 | 底栏和“＋”的键盘聚焦框要不要一起改 | **跟着改成深灰 / 浅灰，全 App 只用一种聚焦色**。底栏的透明、毛玻璃、外观都不动；靠 `tokens.json` 里 `--focus` 取值自动生效，**不改 `GlassBar.module.css`**（硬约束 1） |

不用问负责人：主按钮柠檬黄（视觉稿第 135、979 行）、输入框 `--panel-2`（令牌说明，视觉稿登录、编辑页示意）、输入框圆角 14（视觉稿第 978 行）。

---

## 修改记录

| 日期 | 改了什么 | 谁 |
|---|---|---|
| 2026-11-07 | 第一稿 | 计划起草人 |
| 2026-11-07 | 记负责人三条决定：现在开工不等 B2 签字；聚焦框浅色深灰、深色浅灰，不用蓝；首屏 150 KB 不放宽、顺带瘦身 3～5 KB；空时间框占位字仍待定 | 计划起草人 |
| 2026-11-07 | 按架构审（有条件通过 6.5）和主持人指示改：**P0** ① 首屏一律改 e2e 页面时钟口径、基线 commit `2bcd692`（硬约束 2、U7、V2、约定 4、R1）；② 聚焦框改为 A 只改 `tokens.json` 里 `--focus` 四套取值（取 `--text` 系），不逐个文件改引用，补 `CheckCircle.module.css:18`；③ V1 改为对照场景 0 差 + G1～G4 阈值全过 + “有字在后面”基准由负责人看图后更新；④ R8 定为 B2 验收钉 commit、返工在主干叠加并单独补测、本批照常合主干。**P1** ⑤ 输入字号固定 `--fs-16`、不用媒体查询、单测不动（U1-2）；⑥⑦ 返回按钮和 `base.css` 等无主文件按文件分给 A、B，补 B → A 接口约定；⑨ 首屏词典拆分移出本批，按需下载要同步 `FIRST_PAINT_DYNAMIC` 和 `first-paint-graph`；⑩ `.act` 三处逐个写明映射，写清只有简洁浅色、深色变色；⑧ 人日按审查重估。**P2** V4 grep 改全站；V5 指定由 B 新写量数 spec；R7 直接用 `check_contrast.py`；U5-2 写成中韩分别的断行规则；U1-1 注明圆角取视觉稿第 978 行、补玻璃 `--bg` 取值；行号小误（285、346～350、72～79、`Pressable.test.tsx` 已存在）；V10 写明评审目录关系；补主按钮、`--panel-2`、圆角 14 的视觉稿出处（第 135、978、979 行）；新增 R9 人员冲突 | 计划起草人 |
| 2026-11-07 | 记负责人第二批三条决定：① 守住 1～2 天，U5 设置行整体挪到 B2-UI-b（D4；第一节 U5、第二节、分工、V8/V9、R3），人日按缩小范围重算为 2.5～3.5、日历 1.5～2 天；② 底栏和“＋”聚焦框跟着改成深灰 / 浅灰，靠令牌自动生效、不改 `GlassBar.module.css`（D5；硬约束 1、U1-3、V1、V4、R2、R4）；③ 空时间框不加“可不填”，D2 关掉，零件不为它加占位字（U2-1）。状态改为“可开工” | 计划起草人 |
| 2026-11-07 | 按架构审第二轮复查（8.0）改：U1-2 改回电脑 15px、触屏 16px，媒体查询只在 `Form.module.css` 写一处，提醒时刻框和登录框复用，单测不动（V3 同改）；U3-6 返回按钮名单删 `CalendarSettings.tsx`、补 `FullReminderPage.tsx:72～73` 归 A（分工同改）；`--focus` 写明四套皮肤填和 `--text` 相同的字面色值、不写 `var()`（U1-3、D1）；U2-2 标题框聚焦下划线加粗到 2px，由无障碍关核对 | 计划起草人 |
| 2026-11-07 | 遗留（主持人定）：首屏瘦身安全审 S1——“更新”拿不到按需下载的代码（sw-lifecycle.ts）时回 failed，提示仍是“更新失败 · 联网后再试”，没有“重新打开”；挪到 B2-UI-b，和文案、韩文审校一起做 | 前端 B |
| 2026-11-07 | 遗留（主持人定）：U3-3 的 `SettingsPage.module.css` `.btn` 先不删——SettingsPage.tsx（退出登录）、RecentExport、ConfirmDialog、DataSection、DesktopSection 还在用，本批不动这 5 个文件；DevicesSection 的“退出其他所有设备”宽按钮（`.btn` + `.wide`）也不换。都挪到 B2-UI-b 设置行那批；DevicesSection 的“移除设备”“重试”也退回 `.btn`（主持人 11-07 定：R-276 负责人定的设置页小按钮看得见 38，`b1-settings` 那条断言不动），U3-3 这部分整体挪到 B2-UI-b，届时出对照图请负责人看。V5 里“`SettingsPage.module.css` 无 `.btn`”这一条本批不验 | 前端 B |
| 2026-11-07 | 首屏数字（V2，代码审 M2）：e2e 口径 `b2-first-screen-budget.spec.ts`，chromium、webkit 各跑 3 次，改前 149.89 KB、改后 148.8 KB（六次都是 148.8；今天页出现 chromium 约 0.7 s、webkit 约 2.0 s），在 150 KB 内，未到 145～147 的目标，按负责人 R-354 以 148.x 签。今天页 CSS 类名表：`TodayPage.module.css` 自己的类名 22 个减到 12 个（删 list、row、main、mainText、title、sub、time、del、unsynced、empty，加 lateTag）；新增共用的 `List.module.css` 12 个（待办、最近删除、日历也用这一份）。今天页首屏合计 22→24 个，多 2 个，JS 总量没涨 | 前端 B |
