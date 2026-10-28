# B0 第 ②b 环“动效”确认 · 第二轮（UI-4，只看改动）

- **审查人**：UI-4（动效）　**日期**：2026-10-28
- **对象**：main `8c07819`，改动范围 `git diff 14ae558..8c07819 -- src eslint.config.js tests/arch-fixtures`；返工登记见 `返工-前端A.md`
- **尺度**：和第一轮（`B0-动效确认-UI4.md`）一样。review-animations skill 只能由用户手动调用，我加载不了，按它的“Never Ship”原则和 animate skill 的原则对照
- **做法**：只读，没有改代码
  - `npx vitest run src/motion src/app tests/arch/eslint.test.ts`：7 个文件、115 条全过
  - `CI=true npx playwright test`：44 通过、2 跳过（预览环境那两条，和返工登记一致），chromium、webkit 的 CSP 用例（Motion 进出场、layoutId、kit Dialog）都没有报错
  - 另外在 scratchpad 写了一个小探针，用真的 chromium 和 webkit 走 `pushState` 两次、再后退和前进：每走一步都**只来一次** `hashchange`（前面一次 `popstate`），`hasUAVisualTransition` 都是 false。说明 `router.ts` 只监听 `hashchange`，前进后退时确实只起一个 View Transition
  - 没有启动 supabase、docker

## 1. 逐条复查

| 编号 | 结果 | 依据 | 说明 |
|---|---|---|---|
| **M-1** 减少动态效果两套判断 | **已解决** | `src/motion/reduced.ts:14-17`（唯一判断：`data-rm="1"` 或系统设置）、`:20-32`（订阅：`matchMedia` 的 change + `data-rm` 的 MutationObserver，卸载时两个都清）；`src/motion/useReducedMotionPref.ts:6-8`（`useSyncExternalStore`，subscribe 是模块级函数，引用稳定，不会每次渲染重订）；`src/motion/index.ts:5、12、20、47、62`（animateIn/Out、press、transition 改读同一份）；`src/motion/Appear.tsx:19-33`；`src/motion/SharedLayout.tsx:12-16` | ① 两套判断合成一套，函数和组件结论一定一致。② 设置开关改 `data-rm` 后，MutationObserver 在下一个微任务通知，组件重新渲染；系统设置切换走 change 事件，同步生效。测试 `reduced-motion.test.tsx:54-68` 把增、删 `data-rm` 和系统切换三种都走了一遍，卸载后监听数为 0。③ Appear 成立时只淡入淡出、时长减半，符合 17.2 第 5 点“更少更轻，不是全关”。④ SharedLayout 用 Motion 的 `reducedMotion="always"`，关掉的是 transform 和 layout 位移，opacity 保留，layoutId 衔接直接到位，符合要求。⑤ 两个组件都用 `'never'` 而不是 `'user'`：系统设置已经算在我们自己的判断里，用 `'never'` 不会和 Motion 自带的判断打架，是对的 |
| **M-2** navigate 没有 flushSync | **已解决** | `src/app/router.ts:49-61`（`commit()`：在 `transition()` 的回调里先同步改地址，再 `flushSync(notifyAll)`）、`:63-74`（`hashchange` 也走 `commit()`，监听器集中在模块里，只挂一个）、`:88-93`（`navigate` 用 `history.pushState`，不触发 `hashchange`，不会重复切换）；测试 `src/app/__tests__/navigate.test.tsx:165-214` | ① 回调返回时新页面已经画完，浏览器截“新画面”不会截到旧页面。② **一次切换只起一个 View Transition**：`navigate` 用 pushState 不发 hashchange；hashchange 的监听只有模块里那一个，不管多少组件订阅（测试 `:192-206`）。flushSync 本身不会再起 transition，`notifyAll` 只是让 `useSyncExternalStore` 重读 hash。③ **前进后退走同一条路**：浏览器后退前进时地址先变、`hashchange` 再到，这期间 React 没有被通知，屏幕上还是旧页面，正好被截成“旧画面”，然后在回调里 flushSync 画新页面，和 navigate 完全一样。我用真浏览器探针确认了 pushState 留下的历史在前进后退时也会发 `hashchange`、而且只发一次。④ 减少动态效果或不支持 View Transitions 时，`transition()` 直接同步执行同一个回调（测试 `:208-214`）。⑤ `<a href={hrefOf(...)}>` 这种点链接的方式，同样是 hashchange 那条路，没有漏 |
| **L-4** 三条 CSP 规矩没进 lint | **已解决** | `eslint.config.js:191-216`（`CSP_SYNTAX`：popLayout 的字符串、`{'…'}`、模板字符串；`X.Overlay` 和从 Radix dialog / alert-dialog 具名引入 Overlay；`DropdownMenu.Root` 没写 `modal={false}`；DropdownMenu 只准 `import * as`）、`:281`（并进每个作用域，没有开关）；违规样例 `tests/arch-fixtures/eslint/l4-*.tsx` 7 个、对照 `ok-l4-csp-safe.tsx`、`ok-l4-motion-modes.tsx`；`src/app/dev/CspLab.tsx:20` 带理由的单行豁免 | 三条都拦得住，测试只认 `message=CSP` 的报错，不会被别的规则凑数。还有一个拦不住的情况（见新问题 N-4），不影响结论 |

L-1、L-3 按第一轮定挪 B1，L-2 挪 B2，这一轮不查；“另外记一笔”（Pressable 按下也过冲）仍留给 B1 在 iPhone 上定。

## 2. 新问题

都是“低”或“记一笔”，没有“中”和“高”，都不卡 B0。

| 编号 | 级别 | 问题 | 依据 | 建议 |
|---|---|---|---|---|
| N-1 | 低 | **iOS 侧滑返回会动两次**：iPhone Safari 用手指从左边缘滑回上一页时，系统自己已经播了一段返回动画；现在 `hashchange` 一律再起一个 View Transition，会在系统动画之后再交叉淡入淡出一次，看着像闪了一下。用户主要用 iPhone，这条在 B1 一定会碰到 | `router.ts:63-65`；探针里桌面浏览器的 `popstate.hasUAVisualTransition` 都是 false，但 iOS 侧滑时会是 true | B1 接页面切换时：在 `popstate` 里记下 `event.hasUAVisualTransition`，紧接着来的 `hashchange` 如果是这种情况，就不包 View Transition，直接 `flushSync` 画新页面（还是同一个 `commit()`，只是跳过动画）。上线前 iOS Safari 18 真机录屏时专门试一次侧滑 |
| N-2 | 低 | **跳到当前页也起一个空的 View Transition**：`navigate()` 发现地址没变会跳过 pushState，但还是走 `commit()`，照样起一次 transition。画面没变，但页面切换期间点按会被吞掉约 0.25 秒，连点同一个底部标签时会觉得“没反应” | `router.ts:88-93` | 地址没变时直接返回，不调 `commit()`；补一条用例“跳到当前路由不调 startViewTransition” |
| N-3 | 记一笔 | 每个 `<Appear>` / `<SharedLayout>` 都各自挂一个 MutationObserver 和一个 matchMedia 监听。现在只有开发版的 CspLab 在用，没问题；B2 列表如果每一行都包 `<Appear>`，会有几十上百个监听 | `useReducedMotionPref.ts:7`、`reduced.ts:20-32` | B2 做列表时如果每行都用，把 `reduced.ts` 改成模块里只挂一份、内部转发给所有订阅者，对外接口不变 |
| N-4 | 记一笔 | popLayout 那条只认写在 `mode` 属性里的字面量，`const m = 'popLayout'; <AnimatePresence mode={m}>` 这种绕一道变量的写法拦不住 | `eslint.config.js:192-199` | 不用改。lint 本来就做不到追变量，CSP 的 e2e 用例还在兜底；返工登记里也写了 `X.Overlay` 按名字认的限制 |
| N-5 | 记一笔 | 前进后退的单测（`navigate.test.tsx:180-190`）是用 `replaceState` 加手动派发 `hashchange` 模拟的，不是真的后退。真浏览器的行为我这次用探针补证过（见开头），所以不算问题 | — | B1 接页面切换时，在 e2e 里加一条真的 `page.goBack()`，确认只起一个 transition、回调里已经是新页面 |

“Never Ship”对照：这批没有新的可见动画，没有新时长、新曲线；没有 `transition: all`、`scale(0)`、ease-in；减少动态效果是“只淡入淡出、时长减半”或直接到位，不是一刀切全关；动的只有 transform / opacity。都没问题。

## 3. 结论

**通过。**

第一轮的 M-1、M-2、L-4 都真正解决了，有测试证明，也没有带出新的“中”或“高”。我重点担心的三件事都查过了：`data-rm` 和系统设置改了以后，组件能马上跟着变；flushSync 不会让一次切换起两个 View Transition；浏览器前进后退和 `navigate()` 走的是同一个 `commit()`。新记下的 N-1、N-2 是“低”，在 B1 接页面切换时一起改（N-1 关系到 iPhone 侧滑返回，B1 必须处理）；N-3～N-5 只记一笔。第一轮挪走的 L-1、L-3（B1）、L-2（B2）照旧。

UI-4（动效）　2026-10-28
