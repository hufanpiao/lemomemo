# B1 第 ②b 环“动效”确认（UI-4）

- **审查人**：UI-4（动效，独立评审，默认不通过）　**日期**：2026-11-03
- **对象**：main `ab00797`；改动范围是 B0 动效第二轮签字（`8c07819`）到 `ab00797` 之间和动效有关的提交（`git log 8c07819..ab00797 -- src/motion src/app/router.ts src/styles "src/**/*.css" src/index.html build/stylelint-rules tests/e2e/navigation.spec.ts`）：`711df40`（M1～M3）、`77c1d1a` / `1b775ac` / `830ae5d`（M4：L-1、L-3）、`fbf985f`（启动画面方向 B）、`ff310a1` / `eb37578`（启动画面状态栏、淡出不闪）、`36319a2`（设置 ↔ 注销页不跳：行按钮只变淡、顶栏 page-head 先出后入）
- **对照**：架构设计-v4 第 17.1～17.4 节（重点 17.2 第 1、3、5、6 点，17.3）；B0 两份动效确认（`docs/03-评审/B0/B0-动效确认-UI4.md`、`B0-动效确认-UI4-第二轮.md`）；`docs/09-路线图/B1-接手清单-来自B0评审.md` 第三节 M1～M5、SPLASH-font-sugg、SPLASH-device；`docs/03-评审/B1/B1-预览环境验收清单.md` R10、R14；`docs/00-团队/明早待确认-2026-10-29.md` 第 41 条
- **做法**：只读，没有改代码、没有提交
  - `npx vitest run src/motion src/app/__tests__/navigate.test.tsx src/app/__tests__/router.test.ts src/app/__tests__/splash-release.test.tsx src/features/settings/__tests__/settings-jump-css.test.ts tests/arch`：16 个文件、328 条全过
  - `npx vitest run src/platform/__tests__/splash tests/build/splash tests/arch/durations`：4 个文件、49 条全过
  - `CI=true npx playwright test tests/e2e/navigation.spec.ts tests/e2e/b1-settings.spec.ts`：15 通过、1 跳过（`b1-settings.spec.ts:229` 过渡中途逐帧那条只跑 chromium，webkit 的 Windows 版过渡期间不画起名元素的新图，用例里写明了）
  - 工作区里另有别人未提交的改动（QA 报告、用例表、三个迁移），和动效无关，没碰
  - review-animations skill 只能由负责人手动调用，我按它的“Never Ship”原则和架构 17.2、17.3 手工审
- **证据口径**：只认仓库里的代码、测试和已落盘的记录；真机结论以文档记录为准，没落盘的一律当“没确认”
- **结论**：**有条件通过**，7.5 分。B0 留下的代码项都落实了，有单测和 e2e 证明；不足在于两件只能真机证明的事（iPhone 侧滑返回不叠动画、切页期间吞不吞点按）没有任何落盘结论，另有 1 条 B0 起就挂着的“按下过冲”仍未定。详见第 4 节

## 1. 逐条核对（B0 留给 B1 的动效问题）

| 编号 | 问题 | 来源 | 落实 | 证据位置 | 结论 |
|---|---|---|---|---|---|
| N-1 / M1 ★ | iPhone 左边缘侧滑返回时系统动画和我们的 View Transition 叠两段 | B0 第二轮 N-1（B1 必改）；接手清单 M1 | `711df40`：`popstate` 里记 `hasUAVisualTransition` 和当时的地址，紧接着的 `hashchange` 地址对得上才跳过动画，直接 `commit(undefined, false)` 同步画新页面；两条历史 hash 相同只来 popstate 的情况也考虑了（标记留着但地址对不上，不误跳） | `src/app/router.ts:68-84`（onPopState / onHashChange）、`:86-100`（订阅时一起挂、最后一个退订时一起摘并清标记）；`src/app/__tests__/navigate.test.tsx:99-154`（4 条：为 true 跳过、只管紧接的一次、只有 popstate 没有 hashchange、false 或老浏览器照常） | **代码落实，真机未证**。逻辑我逐行看过，没有问题。但 iOS Safari 侧滑时 `hasUAVisualTransition` 到底是不是 true、跳过后是不是只剩系统那一段，只有 iPhone 能证明；B0 第二轮写了“上线前 iOS Safari 18 真机录屏时专门试一次侧滑”，到 `ab00797` 为止**没有任何落盘记录**（11-03 真机只看了启动画面；明早清单第 41 条⑤只确认了“侧滑回到设置页、不是主页”，并报告了“注销账号四个字跳一下”，修完后的复看停在“负责人说晚点看”）。列为条件 C1 |
| N-2 / M2 | 跳到当前页也起空 View Transition，约 0.25 秒吞点按 | B0 第二轮 N-2；接手清单 M2 | `navigate()` 地址没变直接返回；B1 新加的 `replaceRoute()` 同样先比地址 | `src/app/router.ts:115-121`、`:124-130`；`navigate.test.tsx:156-175`（2 条，含带参数） | **通过** |
| N-3 / M5 | 每个 `<Appear>` / `<SharedLayout>` 各挂一个 observer | B0 第二轮 N-3 | 按原定挪 B2（列表才会成批用） | 生产页面目前没有用 `Appear`、`SharedLayout`（只有开发版 CspLab） | **未到期**，B2 查 |
| N-4 | popLayout 绕变量拦不住 | B0 第二轮 N-4 | 原定不改 | — | 照旧，不算问题 |
| N-5 / M3 | 补一条真后退（`page.goBack()`）的 e2e | B0 第二轮 N-5；接手清单 M3 | 用 `addInitScript` 在页面脚本之前包住 `startViewTransition`，记次数和回调返回时的 `data-feature` | `tests/e2e/navigation.spec.ts:15-59`；本次 chromium、webkit 都跑过 | **通过**。只起 1 个 View Transition，回调里已经是 `today` |
| L-1 / M4 | 减少动态效果在 CSS 一侧只把 `--dur-press` 设 0，位移和缩放照旧 | B0 第一轮 L-1 | Stylelint 规则 `lemo/reduced-motion-override`，A24 禁止关规则；`Pressable`、`Dialog`、设置页 `.row .rowBtn` 两段覆盖都写了（`@media` 和 `:root[data-rm="1"]`），按下反馈改为瞬时变淡到 `--press-dim` | `src/motion/Pressable.module.css:13-31`；`src/kit/components/Dialog.module.css:29-41`；`src/features/settings/ui/SettingsPage.module.css:298-317`；`tests/arch/stylelint.test.ts`（本次跑过）；10-29 动效复审通过（接手清单 M4） | **通过** |
| L-2 | `Dialog` 的 transition 是死代码，弹层瞬间出现 | B0 第一轮 L-2 | 原定 B2；`Dialog.module.css:29-30` 已注明“B2” | — | **未到期**，B2 查（含遮罩时长在减少动态效果下减半） |
| L-3 / M4 | View Transitions 用浏览器默认 0.25s `ease`，没接令牌 | B0 第一轮 L-3 | `::view-transition-old/new(root)` 和 `(page-head)` 用 `--dur-sheet` + `--ease-standard` | `src/styles/base.css:74-80`；`src/motion/__tests__/view-transition-css.test.ts` | **通过**。`::view-transition-group(*)` 仍没接令牌（M4 复审已记，B2/B4 第一个具名共享元素上线前做）；`page-head` 的组已经 `animation: none`（`base.css:88-90`），B1 范围内没有会滑位置的组 |
| 记一笔 → 架构 17.1“0.33（UI-4 附记）” | `Pressable` 按下和松开共用 `--ease-spring`，按下时会过冲到 0.97 以下；B1 在 iPhone 上试过再定 | B0 第一轮“另外记一笔”；接手清单 M4 | **没定**。`Pressable.module.css:2-4` 仍是一条 `transition: transform var(--dur-press) var(--ease-spring)`；仓库里找不到 iPhone 上试过的记录。B1 只把设置页的整行按钮改成了只变淡（`36319a2`），别处的 `Pressable`（注销页“‹ 返回”、确认弹层按钮、版本横幅、语言切换等）照旧缩放并过冲 | `src/motion/Pressable.module.css:1-8` | **未落实**，见新发现 X-3 |
| M4 复审建议① | 真机验 380ms 切页手感时一并看 View Transition 期间吞不吞点按，明显再试 `::view-transition { pointer-events: none; }` | 接手清单 M4 | 验收清单 R14 一栏是空的；代码里没有这条样式 | `docs/03-评审/B1/B1-预览环境验收清单.md:95`；`src/styles/base.css` 全文没有 `::view-transition {` | **未落实**，见新发现 X-1 |
| M4 复审建议② | e2e 加一条 `getComputedStyle` 核对 0.38s | 接手清单 M4 | 没有直接核对 `animation-duration` 的 e2e；`b1-settings.spec.ts:228-275` 暂停动画、按 0～379ms 拨时间核对顶栏透明度，间接说明 page-head 的时长是 380ms，root 那一对只有源码级单测 | `tests/e2e/b1-settings.spec.ts:256-259`；`view-transition-css.test.ts` | 部分落实，记一笔，不单列 |
| SPLASH-device / SPLASH-font-sugg ① | 启动画面真机项 | 接手清单第 150、151 行 | 负责人 11-03 iPhone 真机：① 竖条动画顺 ② 深色先亮后暗可接受 ③ 字粗细和启动图一样 ⑦ 减弱动态效果正常 ⑬ 弱网冷启动没露白；④⑩⑪ 无设备跳过；⑤⑥⑧⑨⑫ 负责人定不补，B6 或上线前真机抽查时顺带看 | 接手清单第 150、151 行；代码 `src/styles/splash.css`、`src/platform/splash.ts`；`tests/build/splash-html.test.ts`、`src/platform/__tests__/splash.test.ts`、`tests/arch/durations.test.ts`（本次跑过） | **通过**（按负责人的决定，剩下 5 项不卡 B1）。代码这边我另查了：竖条只动 `scaleY`，4 轮后停；变暗只动 `opacity`；收起 `--dur-ui` + `--ease-out`、减少动态效果 120ms；`.is-leaving` 立刻 `pointer-events: none`，淡出途中不挡点按；`hideSplash()` 可重复调用、不依赖 `transitionend`；6 秒纯 CSS 兜底带 `visibility: hidden` 让出点击。有一处属性不合 17.2 第 6 点，见 X-4 |

## 2. B1 新增动效逐项看

| 动效 | 位置 | 时长和曲线 | 能否打断 | 减少动态效果 | 吞点按 / 叠加 | 只动 transform / opacity |
|---|---|---|---|---|---|---|
| 页面切换（整页交叉淡入淡出） | `router.ts` + `motion/index.ts:67-74` + `base.css:74-80` | `--dur-sheet` 380ms、`--ease-standard`，合规 | 能：新的 `startViewTransition` 会让旧的跳到结尾，`commit()` 每次都在回调里 flushSync 画完，不会留半截状态 | `transition()` 直接同步执行，不起 View Transition，合规 | 侧滑跳过见 N-1；**切页 380ms 期间点按会不会被 `::view-transition` 遮罩吃掉，没核实**（X-1） | 是（浏览器截图层只动 opacity） |
| 顶栏 page-head 先出后入 | `SettingsPage.module.css:18-26`、`base.css:82-140` | 同上一组令牌，靠关键帧 40% 分段；组不滑位置 | 同上 | 同上 | 两边标题不同时可见，e2e 逐帧证明（chromium）；中间约 0.15 秒顶栏是空的，负责人已被告知备选，复看没落盘（C1） | 是 |
| 设置页整行按钮按下变淡 | `SettingsPage.module.css:298-317` | `--dur-press` + `--ease-out`，合规 | `transition` 天然可打断 | 两种触发都关过渡，合规 | 修掉了“按下的缩放被截进旧画面”（`36319a2`），e2e `b1-settings.spec.ts:186` 证明字不挪 | 是 |
| 通用按下回弹 `Pressable` | `Pressable.module.css` | `--dur-press`，但按下也用 `--ease-spring`，**按下过冲**（X-3） | 能 | 合规（不缩放、瞬时变淡） | 注销页“‹ 返回”按下缩放后紧接 `goBack()`，同一类“缩放态被截进旧画面”的问题还在（按钮小，影响轻，X-3） | 是 |
| 启动画面 | `splash.css`、`splash.ts` | R-254 例外令牌，只在 splash.css 用（durations 测试锁住） | 收起可重复调用、同一个 Promise | 系统设置一路合规，负责人真机确认；`data-rm` 一路见 X-6 | 淡出途中不挡点按 | 竖条、浅色层、整屏都是 transform / opacity；**状态栏那条 `background-color` 动画例外**（X-4） |

“Never Ship”对照：没有 `transition: all`、没有 `scale(0)` 起步、没有 ease-in；没有写死的时长曲线（A24 和 durations 测试都过）；减少动态效果不是一刀切全关；只有 X-4 一处动了非合成属性。

## 3. 新发现

### 高
无。

### 中

| 编号 | 问题 | 依据 | 建议 |
|---|---|---|---|
| X-1 | **切页 380ms 期间点按会不会被吞，没人核实也没处理**。B0 第二轮 N-2 就是因为“空 transition 吞约 0.25 秒点按”才改的；现在每次真切页都有 380ms 的 View Transition，浏览器在过渡期间用 `::view-transition` 伪元素盖住整页、命中测试落在它上面，默认会把这段时间的点按吃掉。M4 复审 10-29 提了“真机看，明显就加 `::view-transition { pointer-events: none; }`”，验收清单 R14 至今空白，代码也没加。B1 已经有今天 ↔ 设置 ↔ 注销三段真实切页，B2 底栏切页会更频繁 | 接手清单 M4 复审建议；验收清单 R14（第 95 行，结果栏空）；`src/styles/base.css` 没有 `::view-transition` 规则 | 两条路任选：① 负责人 iPhone 主屏幕版连点“设置 → 注销账号 → ‹ 返回 → 别的按钮”，记下第二下有没有反应，落到 R14；② 不等真机，直接在 `base.css` 加 `::view-transition { pointer-events: none; }`（新 DOM 在回调里已经画完，点按落到新页面上是对的），加一条 e2e：过渡暂停在中途时点新页面上的按钮能触发。**放 B2，底栏切页上线前必须关掉** |
| X-2 | **两条只有真机能证的动效结论没有落盘**：① M1 侧滑返回只剩系统那一段动画（B0 第二轮写明 B1 必须处理、上线前真机专门试一次侧滑）；② `36319a2` 修完“注销账号四个字跳一下”后的复看。明早清单第 41 条停在“10-31 已部署到预览，负责人说晚点看”，此后没有结果；11-03 那次真机只覆盖启动画面 | `docs/00-团队/明早待确认-2026-10-29.md` 第 41 条；接手清单 M1 一栏只有“vitest 通过”；`tests/e2e/b1-settings.spec.ts:229` webkit 这条跳过，Safari 一侧只能靠真机 | 负责人下次在 iPhone 主屏幕版看三件事并回一句话落盘（明早清单第 41 条或验收清单新加一行）：a. 设置 → 注销账号 → “‹ 返回”，顶栏是不是先淡出再淡入、字不跳；b. 在注销页用左边缘侧滑返回，是不是只有系统那一段滑动、滑完没有再淡一次；c. 设置页往下滚一段再进注销页，顶栏不滑。b 不对就说明 iOS 上 `hasUAVisualTransition` 不可靠，要改成“popstate 来自触摸手势就不包动画”之类的兜底。**放 B2 第一次真机核对**（不卡 B1 签字，理由：代码路径有单测和 e2e，失败的后果是多淡一次，不丢数据） |

### 低

| 编号 | 问题 | 依据 | 建议 |
|---|---|---|---|
| X-3 | **按下过冲 B1 没定，而且“缩放态被截进旧画面”只在设置页整行按钮上局部修了**。`Pressable` 按下仍用 `--ease-spring`，会短暂缩到 0.97 以下（架构 17.1 0.33 附记写的是“按下用 `--ease-out`、`[data-state="idle"]` 上再用 `--ease-spring`”，B1 iPhone 试过再定，仓库里没有试过的记录）。`36319a2` 查清了根因：按下的 scale 还在回弹途中就起了切页，旧画面截在缩着的那一刻、淡出时定格；修法只写在 `.row .rowBtn`。注销页的“‹ 返回”（`DeleteAccountView.tsx:52`）是 `Pressable`、按下缩放、点完马上 `goBack()`，同样会被截进 `page-head` 的旧图（按钮小，偏移约 1px，肉眼不明显）；B2 底栏按钮会大面积遇到 | `src/motion/Pressable.module.css:2-8`；`SettingsPage.module.css:298-306`；架构 17.1 第一行 | B2 做底栏前在 `Pressable` 里统一处理，不再每处局部改：按下用 `--ease-out`、松开回 `--ease-spring`；再定一条规矩写进 17.2——“点了会切页的按钮按下只变淡”，或者 `Pressable` 收到会起切页的点击时先去掉过渡、瞬间复位再切。顺带在 iPhone 上定过冲，记进 17.1 |
| X-4 | **启动画面状态栏那条动画动的是 `background-color`**，不在 17.2 第 6 点“只动 transform 和 opacity”里，R-254 的例外只放宽了时长，没放宽属性。实际成本很小（一次 0.6 秒、只在 iPhone 主屏幕版深色、整屏被 `contain: strict` 的启动画面盖着，状态栏颜色本来也没法用 opacity 做），负责人真机看过“顺” | `src/styles/splash.css:205-219`（`lemo-splash-top-to-dark`）；架构 17.2 第 6 点 | 不用改代码，把这一条作为 R-254 的属性例外写进 17.2 第 6 点（只准 splash.css、只准这一条），免得以后有人拿它当先例。`--dur-splash-out-rm`（120ms）也一并写进那段例外令牌的清单，现在架构里漏了它（tokens.json 和 durations 测试里有） |
| X-5 | **`page-head` 是写死在 CSS Modules 里的 `view-transition-name`**，没走 `src/motion/vt.ts` 统一生成；开发版的重名检查（`vt.ts:13`）只扫内联 `style` 属性，查不到 CSS Modules 里起的名字。现在靠 `settings-jump-css.test.ts` 锁“整个 src 只有一处起这个名”，B1 范围内够用 | 架构 17.2 第 3 点“名字由 `src/motion/vt.ts` 统一生成……开发版里检查并在控制台报错” | B2/B4 加第一个具名共享元素时一起定：固定名字（page-head 这类页面骨架）在 `vt.ts` 里登记成常量、CSS 引用约定写进 17.2；重名检查改成读 `getComputedStyle(el).viewTransitionName`。和 M4 复审留下的“`::view-transition-group(*)` 接令牌”同一批做 |

### 记一笔（不算问题）

| 编号 | 内容 | 依据 | 建议 |
|---|---|---|---|
| X-6 | **“减少动态效果”开关在 B1 只走通了系统设置那一路**。架构 17.4 写“B1：`prefers-reduced-motion` 和‘减少动态效果’开关生效”，但批次表（架构第 1759 行）把开关放在 B6；生产代码里没有任何地方设 `<html data-rm="1">`（`grep -rn "data-rm\|reduce_motion" src` 只有注释和读取方）。`data-rm` 那一路的读取、CSS 覆盖、组件重渲染都有单测，开关接上就能用。另外，启动画面在 React 之前画，到 B6 接开关时 `data-rm` 必须在 `index.html` 外链的早期脚本里从本机读出来先设好，否则启动画面只认系统设置 | 架构 17.4、第 1759 行；`src/styles/splash.css:259-267` | 架构师把 17.4 的 B1 口径改成“系统设置生效、`data-rm` 一路就位有单测；开关本身 B6”，和批次表对齐；B6 接开关时把“启动画面也认开关”列进验收 |
| X-7 | 启动画面收起的定时器时长（`SPLASH_FADE_MS` 220、`SPLASH_FADE_RM_MS` 120）在 TS 里是写死的数字 | `src/platform/splash.ts:18-19` | 不用改：它们是兜底定时器，不是动画参数；`tests/build/splash-html.test.ts:70-72` 已经把它们和 CSS 的 `--dur-ui`、`--dur-splash-out-rm` 锁在一起 |

## 4. 给分和结论

| 维度 | 分 | 说明 |
|---|---|---|
| 时长和曲线合规（令牌、≤ 400ms、不用 ease-in） | 8.5 | 全部走令牌，A24 和 durations 测试守住；扣在按下过冲没定（X-3） |
| 可打断 | 8.5 | View Transition 互相打断后状态一致（每次回调里 flushSync）；按下用 CSS transition；启动画面收起可重复调用 |
| 减少动态效果 | 8 | 系统设置一路在 CSS、组件、函数、启动画面四处一致，负责人真机确认启动画面；`data-rm` 开关一路代码就位但生产无人设置（X-6，归 B6） |
| 不吞点按、不叠动画 | 6 | N-2 修好；侧滑跳过有代码有单测但无真机结论（X-2）；切页 380ms 期间吞点按没核实也没兜底（X-1） |
| 只动 transform / opacity | 8.5 | 只有启动画面状态栏一条 `background-color`（X-4） |
| 测试和证据 | 7.5 | 单测、e2e 本次重跑全过；Safari 一侧的过渡只能真机证，相关记录缺 |
| **总分** | **7.5** | |

**结论：有条件通过。**

B0 留给 B1 的 N-1、N-2、N-5、L-1、L-3 代码都落实了，单测和 e2e（chromium、webkit）本次重跑通过；启动画面按负责人 11-03 的 iPhone 真机结论通过。没有“高”。不直接给“通过”的理由：B0 第二轮把 N-1 定为“B1 必须处理”，它要证明的恰恰是 iPhone 上的观感，仓库里只有模拟事件的单测，没有一条真机结论；切页吞点按这件事从 M4 复审起就挂着，验收清单 R14 也空着。

条件（都不卡 B1 签字，放到下面写明的批次关掉；到期没关，那一批的动效确认直接判不通过）：

1. **C1（X-2，B2 第一次真机核对）**：负责人在 iPhone 主屏幕版看完 X-2 的 a、b、c 三件事，结果落盘到明早清单第 41 条或验收清单。b 不过就在 B2 改侧滑判断。
2. **C2（X-1，B2 底栏切页上线前）**：R14 写上真机结论；或者直接加 `::view-transition { pointer-events: none; }` 和对应 e2e。二选一，必须有落盘证据。
3. **C3（X-3，B2 做底栏前）**：`Pressable` 统一处理按下过冲和“缩放态被截进旧画面”，规矩写进 17.1 / 17.2。

X-4、X-6 是文档口径，请架构师顺手改；X-5 和 M4 复审留下的 `::view-transition-group(*)` 接令牌一起，在 B2/B4 第一个具名共享元素上线前做；N-3（M5）、L-2 按原定 B2 查。

UI-4（动效）　2026-11-03
