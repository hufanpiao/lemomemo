# B2 代码审查：MOTION-②-low 与 kit Dialog 焦点还原（L4）

- 审查日期：2026-11-05
- 审查员：独立代码审查（只读，默认不通过）
- 来由：接手清单 `docs/09-路线图/B1-接手清单-来自B0评审.md` 第 266 行 MOTION-②-low；原审查 `B2-代码审查-FA-6②动效异步加载.md` 第 87～92 行 L2～L7
- 范围（工作区未提交）：
  - 动效：`src/motion/AppearList.tsx`、`src/motion/features.ts`、`src/motion/__tests__/features-async-cold-list.test.tsx`（新）、`src/motion/__tests__/appear-transform-end.test.tsx`
  - e2e：`tests/e2e/b2-motion-list.spec.ts`、`tests/e2e/b2-motion-focus-retry.spec.ts`（新）
  - 弹层：`src/kit/components/Dialog.tsx`、`src/kit/components/__tests__/Dialog.test.tsx`
- 不算问题（按委派说明）：L2 “带查询串重新 import”主持人已定不做；L7 真机装包耗时留负责人。
- 动效按 review-animations 的标准看：缓动、时长 ≤ 300 ms、只动 transform / opacity、prefers-reduced-motion、可打断。

## 结论：通过（各维度 ≥ 8）

没有高、中问题。下面 7 条低问题都可以留到以后，其中 L-1、L-2 建议下次改 Dialog 时一起做。

| 维度 | 分数 | 简评 |
|---|---|---|
| 动效规范（缓动、时长、属性、减少动态、可打断） | 9 | 这次没有新增动画，只给离开中的行加了 inert。原有参数合规：淡出 110 ms、淡入 220 ms，用 `--ease-out`，只动 opacity 和 layout 平移（FLIP）。减少动态效果时时长减半、不等待。撤销恢复时离开中的行会重新进场，可以打断 |
| Dialog 焦点还原是否正确 | 8 | Esc、回车取消、嵌套弹层都能回到正确的元素，和 Radix 不冲突。不足：关闭途中焦点先在 body 上停约 0.23 秒；打开按钮被禁用或被移走时，焦点没有退路（见 L-1、L-2） |
| 测试充分性 | 8 | 新增单测、e2e 都能拦住“去掉还原”“去掉 inert”“不打标记”“冷列表不判 cold”。有 3 个变异存活，其中 2 个等价或近似等价，只有 1 个是真的缺测试（见 L-3） |
| e2e 稳定性 | 9 | 两份 spec 在 4 个 worker 下重复 3 遍，54/54 通过。全量 e2e 用 4 个 worker 跑，没有 SW 超时 |
| 代码质量与注释 | 9 | 注释写清了原因和来由，改动小、只改该改的地方。eslint 和 `tsc -p tsconfig.app.json` 都是 0 错 |

## 一、逐条核对 MOTION-②-low

| 条目 | 结论 | 依据 |
|---|---|---|
| L2 失败以后的“再试”在浏览器里是否生效 | 已按实测记下 | `features.ts` 第 12～14 行写明 chromium、webkit 都把失败的 import 缓存住，要刷新才恢复。`b2-motion-focus-retry.spec.ts` 第 92 行把这个行为写成断言：不刷新不会再去取，刷新以后 chromium 能装上。webkit 只记在附件里，见 L-5 |
| L3 AppearItem 离开时加 inert | 已做 | `AppearList.tsx` 第 134 行。冷列表单测第 60 行断言了 inert；变异“去掉 inert”被拦 |
| L4 用键盘关弹层后焦点回到打开按钮 | 已做（改的是 kit Dialog，见第二节） | e2e 去掉了 test.fail，两种关法在两个浏览器里都通过 |
| L5 motionReady 改成等标记 | 已做 | `features.ts` 打 `<html data-motion="ready">`，e2e 等到标记后再等 3 帧。变异“不打标记”被拦 |
| L6 冷列表补单测 | 已做 | `features-async-cold-list.test.tsx` 断言了 leaving、inert、绝对定位、淡出以后才卸载，以及 entering、从 0 淡到 1。变异“冷列表不判 cold”被拦（落在 features-async.test.tsx） |
| M1 / M2 高负载偶发 | 已改，低负载下稳定 | 取样时间改用读样式那一刻的 `performance.now()`。M1 在头 200 ms 里取不到 2 帧就重做，最多 3 次，还取不到就判“没测到”、不放过。M2 靠 L5 的等标记。4 个 worker 下 M1、M2 两个浏览器各 3 遍，全部通过。我没有在满载下复现 |
| `appear-transform-end` 改假时钟（MOTION-n1-load-flaky） | 合理 | afterEach 先把排着的帧推完再切回真定时器，避免 Motion 的帧循环被假时钟吞掉，写法对 |

## 二、kit Dialog 焦点还原

实现：`Dialog.tsx` 第 51 行在 `open` 变成 true 的那一刻（useLayoutEffect）记下 `document.activeElement`；第 54 行 `restoreFocus` 先 `preventDefault`，再在元素还能聚焦时还给它；第 69 行把它挂在 `onCloseAutoFocus` 上。

核对 Radix 1.3.1 源码（`node_modules/@radix-ui/react-dialog/dist/index.mjs`、`react-focus-scope`）：

- modal Content 的 `onCloseAutoFocus` 用 `composeEventHandlers` 组合，使用方的处理先跑。这里已经 preventDefault，Radix 自己的 `triggerRef.current?.focus()` 就不再执行，不会冲突。
- FocusScope 卸载时在 `setTimeout(0)` 里派发事件。事件被 preventDefault 后，FocusScope 不会再去聚焦 `previouslyFocusedElement ?? body`。
- 结论：和 Radix 自带的行为不冲突，只是在 Radix 已经放弃的那一步补上。

各重点情况（探针在独立副本 `scratchpad/lemo-copy` 里跑，共享工作区没动）：

| 情况 | 结果 |
|---|---|
| Esc 关闭 | 回到打开按钮（单测，以及 e2e 两个浏览器各 3 遍） |
| 在“取消”上按回车关闭 | 同上 |
| 嵌套弹层（A 里开 B） | 关 B 回到 A 里的 openB，再关 A 回到 openA。Esc 只关最上面一层（探针通过） |
| 打开按钮在弹层开着时被卸载 | 不报错，焦点留在 body（单测第 3 条）。没有退路，见 L-2 |
| 打开按钮在关闭时变成 disabled | `canRefocus` 不还，焦点留在 body。`RemindNotice.tsx` 第 59、82 行就是这种情况：确认移除以后按钮进入 removing 状态，被禁用，见 L-2 |
| 退场途中又点开（第二次开的时候 Content 还没卸载） | 弹层重新出现，但焦点没有移进弹层（FocusScope 没有重新挂载，不会再自动聚焦）。这是 Appear 复用元素带来的老问题，不是这次引入的，见 L-4 |
| 关闭途中焦点在哪 | 真浏览器里退场时弹层带 inert，焦点先掉到 body，等卸载后才还回去。e2e 附件实测：chromium 在 body 上约 26～271 ms，webkit 约 61～376 ms，见 L-1 |

## 三、变异验证（独立副本）

| 变异 | 结果 | 说明 |
|---|---|---|
| 去掉 `onCloseAutoFocus={restoreFocus}` | 被拦（2 条失败） | |
| `useLayoutEffect` 改成 `useEffect` | 存活 | 近似等价：FocusScope 的 container 是 state，要等下一次提交的 effect 才把焦点移进弹层，所以 useEffect 记下的也是打开按钮。现在的写法更稳，不用改，只是没有测试钉住 |
| 去掉 `e.preventDefault()` | 存活 | 等价：Radix 自己会 preventDefault，再去聚焦空的 triggerRef，结果一样。保留是防御性写法，合理 |
| `canRefocus` 恒为真（只要是 HTMLElement） | 存活 | 真的缺测试：被移走的按钮 `focus()` 本来就不生效，所以“被移走”那条测不出来。“disabled”“body”两个分支没有用例，见 L-3 |
| AppearItem 去掉 inert | 被拦 | |
| 不打 ready 标记 | 被拦 | |
| 冷列表不判 cold | 被拦 | |

## 四、实际跑过的测试

- 单测（共享工作区，只读运行）：`npx vitest run src/kit/components/__tests__/Dialog.test.tsx src/kit/components/__tests__/Dialog-motion.test.tsx src/motion --exclude tests/build/gen-tauri-key.test.ts`，18 个文件、147 条全部通过。
- 冷列表单测在 e2e 并行（CPU 约 71%）时连跑 10 遍：10/10 通过。
- e2e 在独立副本里跑，端口都不和别人共用：服务 8795（LEMO_WS_PORT 同步改）、wrangler 调试端口 9234、假后端 9194/9195，状态目录 `.wrangler/state-e2e-review`。没有碰 8788、9230，也没有碰任何 Supabase 实例。
  - `b2-motion-focus-retry` 加 `b2-motion-list`：2 个 worker 跑 1 遍，18/18；4 个 worker 用 `--repeat-each 3` 跑，54/54，没有 flaky。
  - webkit 的 L2 用例用 1 个 worker 跑 3 遍：刷新后分别在 8、9、25 ms 内装上。
- 全量 e2e，4 个 worker：236 条，195 通过、36 跳过、5 失败。5 条失败都是 `b1-row-level`、`b1-sync` 的“只读仓库文件”守门：我的副本一开始没拷 `supabase/migrations`，报 ENOENT。补拷以后单独复跑，5/5 通过。**没有一条是 SW 30 秒等不到 ready**（`csp.spec.ts` 第 174、182 行那几条都通过）。
- **关于“12 个 worker 时 17 条挂在 SW ready”**：在 4 个 worker、低负载下没有复现，支持“机器满载导致”的判断。我没有再用 12 个 worker 去复现，以免拖慢别人。建议 e2e 本机并发上限按 4 个 worker 写进说明。

## 五、问题清单（都是低）

| 编号 | 问题 | 位置 | 复现 | 建议 |
|---|---|---|---|---|
| L-1 | 关闭弹层时，焦点先在 body 上停约 0.23 秒（webkit 最长约 0.38 秒），等 Content 卸载后才还回去。这段时间里按 Tab 会从页面开头走。e2e 只把时长写进附件，不断言 | `Dialog.tsx:54`、`b2-motion-focus-retry.spec.ts:68` | 跑 focus-retry 的 L4 用例，看附件“焦点轨迹” | 在 `open` 由 true 变成 false 的那一刻（useLayoutEffect，这时 Radix 的 `trapped` 已经是 false）就把焦点还回去；卸载时的 `restoreFocus` 只 preventDefault，焦点已经在原处就不再动。e2e 改成断言“body 上不超过 1 帧”或者干脆没有 |
| L-2 | 打开按钮被禁用或被移走时，焦点没有退路，掉到 body。实际界面里就有：提醒设置“移除它…”确认以后按钮变成 removing（禁用），之后换成“重新接上”；错过提醒“全部知道了”以后整个组件返回 null | `Dialog.tsx:43-46`；`RemindNotice.tsx:59、82`；`MissedReminders.tsx`（`items.length === 0 && !open` 时返回 null） | 探针“打开按钮关闭时被禁用”：关闭后 `activeElement` 是 BODY | 给 Dialog 加一个可选的 `returnFocus?: () => HTMLElement | null`（或者 `fallbackFocusRef`）。还不了的时候用它，例如所在区块的标题。RemindNotice 这处可以还给新出现的“重新接上”按钮或者通知标题 |
| L-3 | `canRefocus` 的 disabled、body 两个分支没有用例（变异“恒为真”存活） | `Dialog.test.tsx` 第三条附近 | 见第三节 | 加一条单测：打开按钮在关闭时变成 disabled，断言焦点不在它身上、也不抛错。如果做了 L-2，就断言焦点落在退路元素上 |
| L-4 | 退场途中又打开时，弹层出现了，焦点却还在弹层外面（这是老问题，不是这次引入的）。用键盘的人这时按 Esc 照样能关，但 Tab 要先绕一下 | `Dialog.tsx` 配合 `Appear`（同一个元素重新进场，FocusScope 不重新挂载） | 探针“退场途中又点开”：重开后“焦点在弹层里”为 false | 和 L-1 一起改：open 变成 true 时，如果焦点不在 Content 里，就手动聚焦 Content 里第一个可聚焦的元素。或者另开条目跟踪 |
| L-5 | webkit 的 L2 用例：4 个 worker 并行时，3 遍都是“刷新以后 15 秒没装上”；1 个 worker 时 8～25 ms 就装上。原因没查清，而且只记附件、不断言，webkit 在这条路径上出了回归也发现不了 | `b2-motion-focus-retry.spec.ts:123-130` | `--project webkit --workers 4 --repeat-each 3` 对比 `--workers 1` | 把这条用例标成 `test.describe.configure({ mode: 'serial' })`，或者单独放进一个 1 个 worker 的 project，然后对 webkit 也断言装上；或者在接手清单里留一条去查 webkit 并行时为什么装不上 |
| L-6 | 冷列表单测仍然按墙钟取样（5 次 `wait(16)` 看淡出）。我连跑 10 遍都过了，但它和刚修好的 MOTION-n1-load-flaky 是同一类写法，机器很忙、第一次 wait 就超过 110 ms 时会误报 | `features-async-cold-list.test.tsx:63` | 满载时有可能复现，我没有复现出来 | 改成 `appear-transform-end` 那样的假时钟按帧推进，或者用 MutationObserver 记下 opacity 的变化 |
| L-7 | 接手清单第 266 行的状态还写着“L4 … 在改”，和明早清单第 142 行“已全部做完”对不上；M1 的取样门槛从“头部 > 3 帧”放宽到“≥ 2 帧” | `B1-接手清单-来自B0评审.md:266`；`b2-motion-list.spec.ts:276` | 看文档 | 回填接手清单的状态和本审查的结论。放宽到 2 帧可以接受（取不到会重做，取不够就判失败），在注释里写一句为什么是 2 |

## 六、动效规范逐项

| 标准 | 结论 |
|---|---|
| 缓动 | 列表项用 `--ease-out`，弹层用 `--ease-drawer`，都从 tokens.ts 引用，没有随手写的曲线 |
| 时长 ≤ 300 ms | 淡出 110 ms，淡入、收拢 220 ms，弹层 `--dur-ui` 量级。新行要等 143 ms 才开始淡入，从点下到完全不透明约 363 ms。这是 FA-5 设计审查定的（为了等周围让开、不叠字），不在这次范围内，不扣分 |
| 只动 transform / opacity | 是：淡入淡出只动 opacity，收拢用 layout="position"（FLIP，只动 transform）。离开的那一项改成绝对定位是在开始离开那一刻一次到位，不做过渡 |
| prefers-reduced-motion | AppearList 用 `MotionConfig reducedMotion="always"`，让 layout 直接到位，时长减半、不等待；inert 不受影响 |
| 可打断 | 撤销恢复时同一个 key 回来，Motion 让离开中的元素重新进场，`present` 变回 true，inert 和 leaving 一起去掉（探针和 M2 e2e 都覆盖到） |
| inert 带来的副作用 | 用键盘删一行（焦点在那一行的 × 上）时，焦点会马上掉到 body。原来是等卸载时才掉，所以不算新问题；以后可以考虑删除后把焦点交给下一行（归到 L-2 一类） |
