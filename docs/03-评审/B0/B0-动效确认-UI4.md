# B0 第 ②b 环“动效”确认（UI-4）

- **审查人**：UI-4（动效）　**日期**：2026-10-28
- **对象**：main 最新版（`da31033`）的动效地基：`src/motion/`（tokens.ts、index.ts、components.ts、presets.ts、Appear / Pressable / SharedLayout / Celebrate、vt.ts、features.ts）、`src/styles/tokens.css`、`src/motion/__tests__/tokens.test.ts`、`src/kit/components/Dialog.tsx` / `Popover.tsx`、`src/app/router.ts`
- **对照**：架构设计-v4 第 2.0、17.1～17.4 节；`docs/02-设计/皮肤-v4/令牌/tokens.css`、`tokens.ts`（`tokens.json` 生成）；`docs/07-开发日志/B0-验证-CSP下Radix与Motion.md`
- **做法**：只读。逐值比对令牌；跑了 `python -I build/tokens.py --check`（退出 0）和 `npx vitest run src/motion`（16 条全过）；检查生产路由里有没有用到动效组件。review-animations skill 只能由用户手动调用，我没法加载，按 17.2、17.3 写明的规则审。
- **结论**：**有问题**。没有“高”，2 条“中”、4 条“低”，都是地基里给以后留的接口和规矩没写全，**不影响 B0 交付**。线上用户现在看不到任何动画，B0 本身确实不涉及动效。建议 B1 做按下回弹、页面切换、减少动态效果开关时一并改掉（见下面第 2 节）。

## 1. 核对结果

### 1.1 令牌数值：一致

| 令牌 | 视觉稿 tokens.css / tokens.ts（四套皮肤） | src/styles/tokens.css | src/motion/tokens.ts |
|---|---|---|---|
| --dur-press / ui / sheet | 120ms / 220ms / 380ms | 同 | 0.12 / 0.22 / 0.38 |
| --dur-drop / glass | .55s / .3s | 同 | 0.55 / 0.3 |
| --ease-standard | (.2,0,0,1) | 同 | 同 |
| --ease-spring | (.34,1.32,.64,1) | 同 | 同 |
| --ease-out | (.23,1,.32,1) | 同 | 同 |
| --ease-drawer | (.32,.72,0,1) | 同 | 同 |
| --ease-drop / gel / press | (.34,1.45,.5,1) / (.3,.9,.4,1) / (.3,1.5,.5,1) | 同 | 同 |
| 弹簧 | 架构 17.2：刚度 380、阻尼比 0.78、质量 1 | — | stiffness 380、damping = 2·0.78·√380 ≈ 30.4、mass 1，**阻尼比 0.78 ≥ 0.72** |

- 链路：`tokens.json` → `build/tokens.py` → 视觉稿 tokens.css / tokens.ts 和 `src/styles/tokens.css`；CI（`.github/workflows/unit.yml`）跑 `tokens.py --check`，手改会被拦。
- **比对测试是真的在比**：`tokens.test.ts` 读 `src/styles/tokens.css` 的第一个 `:root{}`，按 `cssVarOf` 逐项把 CSS 的时长换成秒、曲线拆成四个数，和 TS 常量比；还反查 CSS 里每个 `--dur-*`、`--ease-*` 在 TS 里都有对应（漏一个就失败）。两条减少动态效果的规则和弹簧阻尼比 ≥ 0.72 也有断言。弹簧那条是 TS 常量和写死的 380 / 0.78 比，因为弹簧不在 tokens.json 里，只在架构文字里，这样写可以接受。

### 1.2 CSP 结论对动效的限制：不卡以后的动效

| 规矩 | 现在的写法 | 对动效的影响 |
|---|---|---|
| Radix Dialog 不用 `Overlay` | `Dialog.tsx` 自己画遮罩 `<div class="scrim">`，滚动锁用 `html.scroll-locked` | 遮罩不归 Radix 管，进出场要自己做：用 `<Appear>`（AnimatePresence）包遮罩，或常驻 DOM 只切 `data-state`。都能做，不受限 |
| DropdownMenu 用 `modal={false}` | 还没装 DropdownMenu | `modal` 只管滚动锁和外部点击，和动画无关。注意 Radix 的 Presence 只等 CSS **animation**（@keyframes）播完才卸载，不等 **transition**；Radix 内容要做退出动画时，用 `data-state="closed"` + @keyframes，或者 `forceMount` + `<Appear>` |
| 不准用 `AnimatePresence mode="popLayout"` | `Appear.tsx` 用默认的 sync 模式，注释写明 | 退出中的元素还占着位置，列表删除不能靠 popLayout 让后面的行补位。架构 17.2 第 6 点本来就规定“先 transform 再一次性移除”，B2、B4 照这个做就行，wait / sync 两种模式和 `layoutId` 都能用 |
| Motion 写样式 | 走元素的 style 对象（CSSOM），e2e 在 chromium、webkit 下都是 0 条 CSP 报错 | 不受限 |

### 1.3 用户看得到的动画：没有

- 用到 `Appear`、`Pressable`、`SharedLayout`、`Dialog`、`Popover` 的只有 `src/app/dev/CspLab.tsx`，`App.tsx` 在正式版里不挂它（`isProduction` 时 `devRoutes = []`）。
- `router.ts` 的 `navigate()` 包了 `transition()`（View Transitions），但目前没有任何地方调用。
- 生产页面里没有 `transition` / `animation` / `@keyframes`（`base.css` 只有 focus 描边）。
- 所以没有可以按 review-animations 逐条审的成品动画，**本批确实不涉及页面动效**。问题都在地基接口上，列在第 2 节。

### 1.4 prefers-reduced-motion 的口子：留了，但没留全（见问题 M-1、L-1、L-2）

- 已有：`tokens.css` 在 `@media (prefers-reduced-motion: reduce)` 和 `:root[data-rm="1"]` 下把 `--dur-press` 设 0；`index.ts` 的 `prefersReducedMotion()` 两条都认，`animateIn/Out` 减少动态效果时只淡入淡出、时长减半，`press()`、`transition()` 直接跳过。
- 没留全：React 组件那一侧只认系统设置；CSS 那一侧只管 `--dur-press`。

## 2. 问题

| 编号 | 级别 | 问题 | 依据 | 建议 |
|---|---|---|---|---|
| M-1 | 中 | `Appear.tsx` 用 Motion 的 `useReducedMotion()`，**只认系统设置，不认设置里的开关 `<html data-rm="1">`**；`SharedLayout` 的 layoutId 弹簧完全不看减少动态效果。和 `index.ts` 的 `prefersReducedMotion()` 两套判断不一致：开关打开后，非 React 的 `animateIn` 只淡入，`<Appear>` 照样滑 | 17.2 第 5 点：“为 true 时 `<html data-rm="1">`，效果和系统设置一样” | 在 `src/motion/` 里做一个 `useReducedMotionPref()`：系统设置或者 `data-rm="1"` 任一条成立就算（`data-rm` 变了也要能重新渲染）。`Appear`、`SharedLayout` 统一用它；或者在动效模块外包一层 `MotionConfig reducedMotion`，开关值从这个 hook 来。B1 做开关时补，并加一条用例 |
| M-2 | 中 | `router.ts` 的 `navigate()` 在 `startViewTransition` 回调里只改 `location.hash`；React 要等异步的 `hashchange` 才重新渲染，**回调结束时新页面还没画出来**。截“新画面”的时机全靠事件和微任务碰巧赶在下一帧之前，可能截到旧页面，结果切换看起来是硬切，或者闪一下 | 17.2 第 3 点：“`router.ts` 调 `motion.transition()` 包住 React 的状态更新（`flushSync` 保证新页面在回调里画完）” | B1 接页面切换时，回调里同步更新路由状态并用 `flushSync`（例如 `history.pushState` 加 `flushSync(() => setRoute(...))`，或者在回调里手动派发并 flush），浏览器的前进 / 后退走同一条路。上线前在 iOS Safari 18 和 WebView2 上各录一次 |
| L-1 | 低 | 减少动态效果在 CSS 这一侧只把 `--dur-press` 设 0。`Dialog.module.css` 里的 `--dur-sheet` 滑入、`--dur-ui` 淡入，以后 CSS 写的位移动画，开了减少动态效果**还会照样位移**；`Pressable` 的 `scale(0.97)` 也只是变成瞬间缩放，没有关掉 | 17.2 第 5 点：“关掉位移和缩放，只保留淡入淡出（时长减半）或直接切换” | 定一个统一写法给 B1 起所有 CSS Modules 用，例如约定组件写 `:root[data-rm="1"] .x, @media (prefers-reduced-motion: reduce){ .x }` 里去掉 transform；或者在 tokens.py 里多生成一个 `--motion-scale`、`--motion-shift` 之类的开关令牌（这两个文件是生成的，只能改生成器）。写进 17.2 并加一条 stylelint 样例 |
| L-2 | 低 | `Dialog.tsx` 里写的过渡都不会生效：遮罩是 `{open ? … : null}` 条件挂载，没有起始状态；`.content[data-state="open"]` 的 `transition: transform` 也没有起点（打开时元素才出现，直接就是 `translateY(0)`）；Radix 关闭时直接卸载 Content。**现在弹层是瞬间出现、瞬间消失**，CSS 里的 transition 是死代码，容易让人以为已经有动效 | 17.1“弹层进出：从底部滑入，`--dur-sheet`；背景遮罩淡入”（B2）；17.2 第 2 点 | B2 做弹层时改：Content 用 `forceMount` 加 `<Appear kind="sheet">`，遮罩用 `<Appear>` 淡入淡出；或者用 `data-state` 加 @keyframes 让 Radix Presence 等退出动画。在那之前，建议把这两条不起作用的 transition 删掉或注明“B2 补” |
| L-3 | 低 | View Transitions 没有接令牌：项目里没有 `::view-transition-old/new(root)` 的样式，一旦触发就是浏览器默认的 0.25s `ease` 交叉淡入淡出，**不是** `--dur-sheet` + `--ease-standard` | 17.2 第 1 点（时长、曲线只用令牌）、17.3（`--ease-standard` 只留给页面切换） | B1 在全局样式里加 `::view-transition-old(root)`、`::view-transition-new(root)` 的 `animation-duration: var(--dur-sheet)`、`animation-timing-function: var(--ease-standard)`，减少动态效果时由 `transition()` 直接跳过（现在已经这样做） |
| L-4 | 低 | 三条 CSP 规矩（不准用 `Dialog.Overlay`、不准用 `mode="popLayout"`、DropdownMenu 要 `modal={false}`）**只写在文档和注释里**，ESLint 和 check_arch 都没拦。以后有人顺手写 `mode="popLayout"`，只能靠 e2e 的 CSP 用例事后发现，而且前提是那个页面被 e2e 覆盖到 | 2.0、B0 验证记录“以后写代码要守的规矩” | 在 `eslint.config.js` 的 no-restricted-syntax 里加三条：`JSXAttribute[name.name='mode'][value.value='popLayout']`、`JSXMemberExpression[property.name='Overlay']`（Radix Dialog / AlertDialog）、DropdownMenu.Root 没写 `modal={false}`；违规样例放进 `tests/arch-fixtures/` |

**另外记一笔，不算问题**：`Pressable.module.css` 按下和松开共用一条 `transition: transform var(--dur-press) var(--ease-spring)`，按下时也会有一点过冲（会短暂缩到 0.97 以下）。17.1 写的是“按下用 `--dur-press`，松开用 `--ease-spring` 弹回”。B1 调手感时，建议按下改用 `--ease-out`（或 `--ease-press`），`[data-state="idle"]` 上再用 `--ease-spring`，在 iPhone 上试过再定。

## 3. 签字

动效地基的令牌数值、比对测试、CSP 结论都核对过了，没有问题；生产环境里没有用户看得到的动画。上面 6 条（2 中 4 低）留给 B1、B2 处理，不卡 B0。

UI-4（动效）　2026-10-28
