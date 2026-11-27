# B2-UI-a 前端 A 代码审（令牌、输入框、按钮、返回按钮、Pressable）

- 审查人：独立代码审查员（只读，默认不通过）
- 日期：2026-11-07
- 依据：`docs/09-路线图/B2-UI-a-任务单.md`（U1、U2、U3-1～U3-5、U3-6 里 A 的两处、U4-4、V3～V6、R4、R7）；需求记录 R-351、R-352、R-354，以及 R-276、R-277（设置页按钮“看得见 38”）；`docs/03-评审/B2-UI-a/前端A-接口说明.md`
- 范围：工作区里还没提交的改动，只看前端 A 的文件：`tokens.json` 及其生成物、`Form.*`、`CheckCircle.*`、`EditShell.module.css`、`Pressable.*`、`src/features/reminders/ui/`、`AuthPage.module.css`、`TodoEditPage.*`、接口说明。前端 B、后端的改动不在范围内
- 已跑：
  - `npx vitest run`，覆盖 Pressable、kit、reminders、TodoEditPage、EventEditPage、`input-font-size`、auth、GlassBar：64 个文件、578 条全过；
  - `python build/tokens.py --check`，退出码 0（生成物和 `tokens.json` 一致）；
  - `python build/check_contrast.py`：275 次，不达标 0 次。但清单里**没有任何一项量 `--focus`**，见 M1；
  - `python build/check_arch.py`，退出码 0；
  - 另用一段独立脚本复算了聚焦框对比度（WCAG 相对亮度公式，玻璃按 alpha 叠在最坏底色上）。
  - 没起服务，没跑 e2e。

## 结论

**不通过，6.5 / 10。** 零件这一层的代码质量不错：令牌生成干净，旧的 `.act/.danger/.ghost/.dangerFill` 和 `.time` 的媒体查询删干净了，深色兜底的 `:where(...) button` 删了，编辑页也没有裸按钮。Pressable 禁用分支改得对，测试也补了。

不通过的原因有四条，都属于“没按任务单做到”或“需要负责人拍板却没拍板”：
1. 聚焦框在底栏“＋”上不到 3:1，而且 `check_contrast` 根本没量聚焦色；
2. 提醒页“移除它…”“取消”两个按钮的字重悄悄变了；
3. 接口说明让前端 B 把设置页按钮换成 FormButton，会把 R-276“看得见 38”的按钮变成 44 高的描边按钮；
4. 登录框在电脑上没按 U1-2、V3 的要求改成 15px。

这四条补齐后可以再审。

## 必改

### M1 `--focus` 在底栏“＋”上达不到 3:1，`check_contrast` 也没量聚焦色（V4、R4、R-352②）

复算结果。聚焦框是 2px 的 outline，按“框两侧相邻的颜色里至少一侧 ≥ 3:1”来判断：

| 位置 | 内侧相邻色 | 外侧相邻色（最坏情况） | 结果 |
|---|---|---|---|
| 浅色页签 `.tab` | 页签本身 | `box-shadow: 0 0 0 4px var(--bg)` 那一圈，`#141518` 对 `#E9EAEE` 是 15.2 | 过 |
| 深色页签 `.tab` | 页签本身 | `--bg` 那一圈，`#F2F3F5` 对 `#111215` 约 17 | 过 |
| 浅色“＋” `.fab` | 黄色“＋”（0.72 叠白），14.6 | 浅玻璃叠在最暗内容上，**1.40** | 过（内侧） |
| **深色“＋” `.fab`** | 黄色“＋”（0.86 叠深底），**1.61** | 深玻璃 `rgba(30,31,36,.44)` 叠白，**2.44** | **两侧都不到 3，不过** |
| 宽屏侧栏头像 `.me`（`outline-offset: 2px`） | 侧栏玻璃 | 侧栏玻璃叠内容，浅色最坏 1.40，深色最坏 2.44 | 最坏情况不过 |
| 编辑页、表单（`--panel`、`--panel-2`、`--bg` 上） | — | 13～16 | 过 |
| 深色主按钮 `.primary`（黄）+ `offset 2px` | 隔着 2px 的页面底色 | 页面底色，约 17 | 过（框不贴着黄色） |

前端 A 报的 1.41、2.46 和我复算的 1.40、2.44 一致，只是第二个数用了 `#F2F3F5`。另外，旧的蓝色 `#2F7BF5` 在深色玻璃上也只有 1.45，深色“＋”不是这次才变差的；浅色玻璃上则从 3.27 降到了 1.40。

要做的：
1. `build/contrast-pairs.json` 补上 `--focus` 的几组：对 `--bg`、`--panel`、`--inp-bg`、玻璃最坏底色（`--g-tint` 叠最暗 / 最亮）、`--g-fab-tint`。V4 明写“`build/check_contrast.py` 量四套皮肤（含底栏玻璃上的聚焦框）”，现在没做到。
2. 深色“＋”不达标，在 R4 的允许范围里解决不了：R4 只允许“改令牌取值或加粗”，而加粗、给“＋”加一圈 `--bg` 底色都要改 `GlassBar.module.css`，硬约束 1 禁止改；`--focus` 又只能有一个值。**必须由主持人转负责人定**，可选：
   - ① 接受为已登记的例外，写进 `check-contrast-accepted`；
   - ② 允许改一行 `GlassBar.module.css`，给 `.fab:focus-visible` 也加 `box-shadow: 0 0 0 4px var(--bg)`，和页签同一个做法，只在键盘聚焦时出现；
   - ③ 其他。

   不能默认通过。

### M2 提醒页“移除它…”“取消”的字重从 600 变成 400，任务单写的是“原样”（U3-2 映射表）

- 旧样式 `RemindSettings.module.css` 里 `.danger, .dangerFill, .ghost` 都是 `font-weight: 600`。
- 新的 `Form.module.css` 里 `.danger`、`.ghost` 没写字重，又加了 `font: inherit`，实际变成 400。只有 `.primary`、`.dangerFill` 保留了 600。
- 映射表里这两个按钮写的是“原样”。`font: inherit` 还把字体从浏览器默认的按钮字体换成了正文字体，这一处是改进，但同样是看得见的变化。
- 二选一：
  - 在 `.danger`、`.ghost` 上补 `font-weight: 600`。注意待办编辑页的“删除”原来是 400，补了以后它会变成 600，要一起在对照图里说明；
  - 或者保持 400，在提醒页对照图里单独写明“移除它… / 取消 字重 600 → 400”，请负责人看图确认。

### M3 接口说明让前端 B 把设置页按钮换成 FormButton，会违反 R-276、R-277（`前端A-接口说明.md` 第 3 节最后一句）

- R-276、R-277 定的是：“退出这台设备”“退出其他所有设备”、弹窗里的按钮**看得见 38**、`--panel-2` 实底、用 `::after` 把点击区扩到 44。代码在 `SettingsPage.module.css:200～222` 的 `.btn`。
- FormButton 每种 variant 都是看得见 44，而且 `secondary` 是描边、不是实底。照接口说明换过去，负责人亲自定过的两条外观就会被改掉。
- `SettingsPage.module.css` 的 `.btn` 现在还被 `ConfirmDialog.tsx`、`DataSection.tsx`、`DesktopSection.tsx`、`DevicesSection.tsx`、`RecentExport.tsx` 用着，任务单 U3-3 的“删掉不再用的 `.btn`”不成立。
- 要做的：
  - 接口说明里写明 R-276、R-277 的约束；
  - 要么给 FormButton 加一个紧凑尺寸（看得见 38、`::after` 扩到 44、`--panel-2` 实底），要么明确告诉前端 B 这几个按钮先不换；
  - 同时请主持人在任务单 U3-3 里注明这处冲突。

  目前前端 B 还没改 `DevicesSection.tsx`，所以还没有造成回退，趁现在改。

### M4 登录框电脑上固定 16px，没按任务单接进统一规则（U1-2、V3）

- U1-2 原文：“提醒时刻框 `.time`、**登录框复用这同一个类或同一条规则**”。V3：“电脑上 15px”。
- 现在 `AuthPage.module.css:69` 写死 `font-size: var(--fs-16)`，电脑上是 16，其他输入框是 15，不一致。注释里的理由是“登录页是单独入口、不引 kit 表单”。
- 我的判断：**应该接进去**。登录框底色、圆角已经用了同一组令牌，只剩字号这一项例外，界面上看得出来。V3 又要求触屏媒体查询全站只写在 `Form.module.css` 一处，登录页不能自己再写一条。
- 可行的做法：登录框在 `AuthPage.tsx` 里同时挂 `Form.module.css` 的 `.input`（只用于字号和触屏规则），`AuthPage.module.css` 里把会冲突的 `flex`、`padding`、`min-height` 覆盖回来；改完截图核对登录页版式。代价只是登录入口多带一份 CSS 模块的类名表，不进首屏。
- 如果主持人认为不值得，就要在任务单 U1-2、V3 里写明“登录框例外：电脑上也是 16”，留下书面记录。不能只靠注释说明。

## 建议（不阻塞）

1. **编辑页的圆圈勾选比列表里的小 2px**。`Form.module.css` 的 `.check input { width: 20px; height: 20px }`（权重 0,1,1）压过了 `CheckCircle.module.css` 的 `.check { width: 22px }`（0,1,0），编辑页“已完成”的圆圈环是 20px，打勾时的圆盘 `.fill` 是 22px，环和圆盘差 1px，和列表圆圈也不完全是“同一画法”。补一条 `.check .circleBox > input { width: 22px; height: 22px; }` 即可。
2. **圆圈勾选禁用时，旁边的文字不变淡**。`.check:has(> input:disabled)` 只认直接子元素，`look="circle"` 时 input 包在 `.circleBox` 里，选择器失效，只读编辑页“已完成”的文字还是正文色。改成 `.check:has(input:disabled)`。
3. **`RemindDnd.tsx` 为了过测试改了导入名**。它把 `Form.module.css` 起名为 `styles`、原来的模块改名 `rs`，只是为了让 `input-font-size.test.ts` 认得出来（注释里也这么写了），以后有人改名就会悄悄绕过这条检查。建议在测试里也认 `Form.module.css` 的其他导入名，或者在测试文件里写明这条约定。
4. **输入框高度电脑上 36、触屏上 44**：主持人 11-07 定的，没问题。对照图只有简洁皮肤，玻璃两套也请补一张。
5. **Pressable 只在按下时判断禁用**。按住期间按钮变成禁用的情况，pointerup 和 pointercancel 照样会复位，不会卡住。没问题，记一笔。

## 逐项核对

| 项 | 结果 |
|---|---|
| U1-1 令牌 | `--inp-bg`（四套都是 `var(--panel-2)`）、`--r-inp`（`var(--r-md)` = 14）进了 `tokens.json`，生成物 `tokens.css`、`skins/*.css` 一致（`tokens.py --check` 退出码 0）。表单、提醒时刻框、登录框都已改用 |
| U1-2 字号 | 触屏 16px 的 `any-pointer: coarse` 全站只剩 `Form.module.css:68` 一处，`RemindSettings.module.css` 那段删了，提醒时刻框改用 `.input`。登录框没接进来，见 M4 |
| U1-3 聚焦色 | 四套取值等于各自 `--text`（`#141518 / #F2F3F5 / #141518 / #F1F2F4`），说明里写了“`--text` 改了要同步”；全站没有 `#2F7BF5`；`CheckCircle` 改成 `--focus`；`GlassBar/`、`Settings/` 没有改动。对比度见 M1 |
| U1-4 主按钮 | `.primary` 用 `--accent` / `--on-accent`；清单里已有 `on-accent` 这一对，四套都过 |
| U2-2 标题框聚焦 | 1px 下边框加 1px 内阴影，共 2px，不挪版面；只有标题一项的卡片改用 2px 内阴影。符合要求 |
| U2-3 下拉 | `.select` 和 `.input` 一样 `flex: 1 1 0`。符合要求 |
| U2-4 圆圈勾选 | `Check look="circle"` 复用 `CheckCircle.module.css`，待办编辑页已改用。尺寸、禁用文字见建议 1、2 |
| U2-5 登录框 | 令牌、`font: inherit`、占位字颜色都改了；字号见 M4 |
| U3-1 FormButton | 五种 variant 都是 44 高、胶囊、`--focus` 聚焦框；老写法 `danger` 布尔值保留。字重见 M2，尺寸和 R-276 的冲突见 M3 |
| U3-2 提醒页按钮 | 6 个按钮按映射表换好了（打开通知、重新订阅 → primary；重新连接 → secondary；其余三个原样对应）；旧样式和对应的 `:disabled`、`:focus-visible` 删干净了 |
| U3-4 深色兜底 | `:where(...) button` 删了；编辑页只剩两处没带 class 的 `Pressable`，就是“更新”，`EditShell.module.css` 的 `.notice[data-tone='quiet'] > button`（权重 0,2,1）给了样式，两个编辑页都传了 `noticeTone` |
| U3-5 Pressable | `disabled`、`aria-disabled="true"` 时按下不进 pressed；新用例覆盖 `"true"`、布尔 true、`disabled`，以及反例 `"false"`。减少动态效果那一支依赖 pressed，自然也不会变淡 |
| U3-6 返回按钮 | `EditShell` 的 `.back`、整页提醒的 `.back` 用了同一段：15px、正文色、`font: inherit`、`::after` 扩到 44、`--focus`。接口说明第 4 节给了照抄的那段 |
| U4-4 圆圈点击区 | 外层改成 `label`，`::after` 扩到 44×44，input 用 `z-index: 1` 盖在扩展区上面。前端 A 已提醒前端 B 量扩展区会不会盖到标题按钮 |
| 硬约束 1 | `src/kit/components/GlassBar/` 没有改动 |

## 回报给主持人

- 结论：不通过，6.5 / 10。
- 必改：M1（聚焦框在深色“＋”上两侧都不到 3:1，`check_contrast` 补上聚焦色，然后请负责人定）、M2（提醒页两个按钮字重变了）、M3（接口说明和 R-276 冲突）、M4（登录框电脑上 16px，没按任务单接进统一规则）。

---

## 第二轮复查（2026-11-07）

- 审查人：同一位独立代码审查员（只读，默认不通过），评分尺度和第一轮相同
- 范围：前端 A 这一轮改的文件：`build/contrast-pairs.json`、`tests/build/check-contrast-accepted.test.ts`、`Form.tsx`、`Form.module.css`、新增的 `FormButton.test.tsx`、`RemindNotice.tsx`、`RemindDnd.tsx`、`AuthPage.tsx`、`AuthPage.module.css`、`src/app/__tests__/input-font-size.test.ts`、`前端A-接口说明.md`，以及新截图
- 已跑：
  - `npx vitest run`，覆盖 `input-font-size`、`check-contrast-accepted`、kit、reminders、auth、settings、Pressable、两个编辑页：100 个文件、978 条全过；
  - `python build/check_contrast.py`：4 套皮肤 × 79 项，共算 301 次，不达标 0 次，已接受的例外 12 次；
  - `python build/tokens.py --check`、`python build/check_arch.py`，退出码都是 0；
  - 看了截图 `登录框-后-邮箱框聚焦-简洁浅色.png`。
  - 没起服务，没跑 e2e。

### 结论

**通过，8.5 / 10。** 第一轮 M1～M4 四条必改全部解决，建议 1～4 也都处理了。剩下的只是任务单的文字记录要补，归主持人，不挡前端 A 合入。

### 第一轮必改逐条核对

| 项 | 结果 | 核对依据 |
|---|---|---|
| M1 聚焦框对比度 | **已解决** | `contrast-pairs.json` 新加 7 组：对 `--bg`、`--panel`、`--panel-2`、`--inp-bg`，“＋”内侧、“＋”外侧（只查深色），电脑版侧栏。四套皮肤实测：深色“＋”内侧 1.32 / 1.33、外侧 2.44 / 2.46，登记为例外 4 条，出处写的是 R-355（负责人 11-07 定“登记为例外，不改”）；`check-contrast-accepted.test.ts` 把这 4 条的数值、日期、R-355 都写死了，以后数值变化会报出来。其余各组 7.4～18.3，全部达标。“浅色‘＋’只看内侧”的写法，和第一轮按“框两侧任一侧 ≥ 3:1”的判断一致。侧栏 `focus-rail` 按“侧栏后面只有 `--bg`”来算，依据是宽屏下 `#root` 左边让出了 110px，这个前提写进了 `source`，我认可 |
| M2 按钮字重 | **已解决** | FormButton 新加 `strong` 参数，字重 600。“重新连接”“移除它…”“取消”都传了 `strong`，回到原来的 600；编辑页的“删除”“清掉”不传，仍是 400。`.strong` 在 `Form.module.css` 里写在各个 variant 后面，权重相同、后写的生效，不会被盖掉。`FormButton.test.tsx` 覆盖了五种 variant 的类名、老写法 `danger`、`strong` 是另外加的一个类 |
| M3 R-276 冲突 | **已解决** | 接口说明第 28 行写明：设置页按钮这一批不换，因为 R-276、R-277 要求看得见 38、`--panel-2` 实底、`::after` 扩到 44，并列出用 `.btn` 的 5 个文件；B2-UI-b 统一之前，要先给 FormButton 加一个紧凑尺寸。`DevicesSection.tsx` 的按钮都还是 `.btn`，没有改动 |
| M4 登录框字号 | **已解决** | `AuthPage.tsx` 的三个输入框同时挂了 `Form.module.css` 的 `.input`。现在电脑上 15px，触屏 16px 的规则全站仍只在 `Form.module.css` 一处。`AuthPage.module.css` 用 `input.input`（权重 0,1,1）把版式覆盖回来：`flex: none`，防止竖排的 `.form` 把框压扁；高 44；左右内边距 12。验证码框写成 `input.code`，22px 压过触屏的 16px。截图里聚焦框是深灰、跟着圆角走，版式没变 |

### 第一轮建议核对

| 项 | 结果 |
|---|---|
| 1 圆圈勾选尺寸 | 已改。`.check .circleBox > input` 改成 22×22，和列表里的圆圈、打勾圆盘一样大 |
| 2 禁用时文字变淡 | 已改。选择器改成 `.check:has(input:disabled)`，不带 `>`，嵌套的圆圈 input 也能匹配 |
| 3 测试认导入名 | 已改。`input-font-size.test.ts` 改成先找出文件里所有 CSS 模块导入，按导入的文件来认类名（例如 `form.input` 认 `Form.module.css`），没导入的对象不算；自测样例覆盖了两个模块和“没导入的对象”。`RemindDnd.tsx` 也改回直观的写法：`form.input` 加 `styles.time`。判断规则没放松：所有类在触屏上都没写字号的照样报错，任何一个类小于 16px 的也报错 |
| 4 玻璃皮肤截图 | 已补。新截图里玻璃皮肤 30 张，都已登记进文件登记册 |

### 还没解决的（归主持人，不挡合入）

1. **任务单还没记下这一轮的三处变化**，建议在 `B2-UI-a-任务单.md` 的修改记录里补上：
   - ① R-355：深色“＋”聚焦框是例外。V4 写的“全 App ≥ 3:1”要注明这一条例外；
   - ② `input-font-size.test.ts` 改了。第三节约定 5 写的是“本单不改”，这是主持人按审查建议同意改的；
   - ③ U3-3 正文（第 52 行）还写着“`DevicesSection` 换 `FormButton`”，修改记录里已经写了挪到 B2-UI-b，正文最好也同步，免得 B2-UI-b 的人照着正文去改。
2. **e2e 没跑**：V1 底栏像素断言、V5 点击区量数，要在八关的⑦环核对，本审不覆盖。

### 评分

和第一轮同一尺度：令牌、零件、测试都到位，任务单要求和负责人的决定都对得上；扣的 1.5 分是任务单的文字记录还没跟上，以及 e2e 没在本审里跑。
