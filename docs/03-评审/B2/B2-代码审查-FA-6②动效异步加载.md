# B2 代码审查 · FA-6 ②（motion 功能包异步加载）和 MOTION-leaving-inert

- 审查人：独立代码审查员（只读，默认不通过，10 分制，8 分及以上才算通过）
- 日期：2026-11-04
- 范围：
  - `src/motion/features.ts`、新文件 `src/motion/feature-bundle.ts`、`src/motion/index.ts`（转出 `loadMotionFeatures`）
  - `src/motion/Appear.tsx`（没到时直接画成停稳；退场 inert）、`src/motion/AppearList.tsx`（没到时不打 entering）、`src/motion/SharedLayout.tsx`
  - 新测试 `features-async.test.tsx`、`features-retry.test.ts`
  - 先等功能包的 8 个测试：`appear-exit-from`、`appear-list`、`appear-transform-end`、`reduced-motion`、`TodayPage-motion`、`TodosPage-motion`、`Dialog-motion`、`remind-exit-click`
  - `tests/e2e/b2-motion-list.spec.ts` 的 `motionReady`
  - 连续帧对照：`B2-FA-6-执行说明.md` 的“② 的连续帧对照”一节，以及 scratchpad 里的 `m2-shift-cmp.txt`、`m2-align-cmp.txt`、`list-cmp.txt`、`mut-result-m2*.txt`
- 标准：按 review-animations 的要求看三件事：状态切换会不会出现透明卡住、缩放跳变或跳帧；打断和快速连点；减少动态效果。
- 验证方式：探针和反证都在独立副本里做，副本是 scratchpad 的 `lemo-copy`，源码从工作区同步过去，`node_modules` 用联接。共享工作区一个字节都没改。

## 结论：通过，8.5 / 10

- 没有高、中问题。
- 功能包到达前后的切换，没有发现透明卡住、从 scale(0) 或 0.35 放大、跳帧。inert 在重新进场、减少动态效果、快速连点这几种情况下，都能正确去掉。
- 8 个测试加“先等功能包”没有掩盖代码问题。去掉以后挂的 7 条，全是“没到之前就删、就关”的场景，没有动画本来就是设计行为，也就是负责人已经接受的那段。
- 有 7 条低问题，见第三节。其中 L1 需要负责人知道：本机 11～45 ms 的数字只代表“装过 SW 或网好”的情况；第一次访问又遇上弱网，这段时间会更长。

## 一、重点核对

### 1. 功能包到达前后的状态切换

| 场景 | 结果 | 依据 |
|---|---|---|
| 没到时挂上的 Appear | 一挂上就是 `opacity: 1; transform: none`，不卡在 initial 的透明里 | `Appear.tsx` 的 `cold` 加上 `initial={cold ? false : …}`，`settled` 初值等于 `cold`；`features-async.test.tsx:50-64` |
| 没到时挂上、到了以后才关 | 照常播退场：两段关键帧“原位 → 终点”，途中 scale 一直是 1，播完才卸载 | `features-async.test.tsx:78-109`；前端 A 的反证 M2-2（没到时不算停稳）会被拦住（`mut-result-m2b.txt`） |
| 没到时挂上的 Appear，到了以后快速“关、开、关、开、关”（间隔 10～50 ms） | 最后一次关处于退场中：leaving、inert；再打开能停稳到 `transform: none`；整个过程中没有出现 scale≠1 | 副本探针 Q4 |
| 没到时就关上，或者快速连点 | 当场移除，不会留一个带 inert 的空壳；连点以后只剩 1 个元素 | 副本探针 Q1。Motion 的 `PresenceChild`：没有 motion 子元素注册时，`!isPresent && !presenceChildren.size` 直接完成退场 |
| 没到时挂上的列表，删一行 | 当场移除（这就是已接受的取舍） | 副本探针 Q2 |
| **没到时挂上的列表，到了以后删行、加行**（今天页首屏走的就是这条路） | 删行：leaving、绝对定位、淡出，播完才卸载。加行：entering、从 opacity 0 淡到 1、播完去掉 entering。删掉的行再加回来也正常 | 副本探针 Q3。单元测试没覆盖这条，见 L6 |
| 下载失败期间挂上的列表，之后别处重试成功了，再往这个旧列表里加行 | 正常淡入，不卡在透明。功能是装在全局的，不依赖这个列表自己那个 LazyMotion 的加载状态 | 副本探针 B |
| 到了以后新挂上的 | 从 initial 起播；LazyMotion 拿到的是包本身（同步装上） | `features-async.test.tsx:111-136` |
| 设置功能包变量和各个 LazyMotion 装上功能之间的那一个微任务空档 | 碰不到。两件事挂在同一个 promise 链上，中间没有 React 渲染的机会 | 读码 |

连续帧对照（前端 A 在真实浏览器里录的，我复核了数据）：
- 弹层打开、关闭：按最贴合的平移对齐以后，translateY 最大差 ≤ 2.4 px，opacity 最大差 ≤ 0.019，终点一致。webkit 按“出现那一帧”对齐时差 18.2 px、scrim 差 0.17，原因是改后版本取到的第一帧更早（起录相位差），不是卡顿；平移对齐以后差 ≤ 2.4 px。
- 列表打勾：对齐以后 t3 最大差 9.4 px，约一帧的移动距离；没对齐时的 86.9 px 是相位差。
- 冷启动今天页：两份产物每一帧的 opacity 都是 1，没有透明帧。

### 2. inert

| 场景 | 结果 |
|---|---|
| 显示中、重新进场 | 不带 inert，`data-state` 也清掉（`features-async.test.tsx:138-161`） |
| 减少动态效果 | 关的时候带 inert；30 ms 后重开立刻去掉；停稳以后不带；关完卸载（副本探针 Q5） |
| 快速连点 | 见上面 Q4，最后的状态都对 |
| 前端 A 的反证 | “不加 inert”“一直 inert”都被拦住（`mut-result-m2.txt` M2-9、M2-10） |

### 3. 8 个测试加“先等功能包”是否掩盖真实问题

- 在副本里把这 8 个文件的 `await loadMotionFeatures()` 去掉重跑：5 个文件、7 条挂了。
  - 挂的是这几类：新加的行淡入、删的行先留着播退场、Dialog 打开滑入和关闭播退场、今天页和待办页打勾后旧行离开、减少动态效果下起始透明度为 0。
  - 这些测试都是挂上以后马上操作，正好落在“功能包还没到”那段，没有动画是设计如此，不是代码缺陷。
- 所以“先等功能包”没有掩盖代码问题，它把测试对准的是“到了以后的手感”，理由站得住。
- 漏掉的是另一件事：真实首屏走的是“没到时挂上 → 到了 → 再操作”这条路，单元测试里没有覆盖（只有 e2e 和我的探针 Q3 覆盖），见 L6。

### 4. webkit 装功能包时主线程卡几十毫秒

- 我没在浏览器里实测（按规矩不构建、不跑浏览器），只能按代码和数据判断：可以接受。理由：
  - 只发生一次，在首屏画完以后。这时候没有动画在播：没到时挂上的元素都是静止的停稳样子，所以卡顿不会落在动画上。
  - 装好 SW 以后，这个块从本机缓存读，只剩解析、执行的开销（约 100 KB 未压缩）。
  - 唯一的代价：用户恰好在这几十毫秒里点了一下，响应会晚这么一点（交互延迟，INP）。
- 建议在真机 iPhone 上，用 `performance.now()` 包住这次加载，量一次“执行加装上功能”的耗时，结果写进执行说明。超过 50 ms 的话，可以考虑放进 `setTimeout(…, 0)`，让出首屏之后的第一次交互。

## 二、做法评价

- 下载只做一次，到了以后改给同步包，这样新挂上的 LazyMotion 不必再等一轮 then，思路正确（前端 A 的反证 M2-5、M2-6 能拦住）。
- 没到时直接画成停稳，而不是挂起等它，是正确的取舍：宁可少一段动画，也不要卡在透明里。
- 功能包会在首屏画完以后开始下载，不论用户从哪一页进入：RemindHost 在登录以后一直挂着 `<Appear>`（show 为 false 时也会挂 LazyMotion），Dialog 的 Appear 也一直挂着。执行日志里，功能包在 803 ms 开始下载，RemindHost 在 808 ms。所以不存在“某一页要等用户第一次打开弹层才开始下载”的情况。

## 三、问题清单

### 高
无。

### 中
无。

### 低

| 编号 | 场景 | 建议 |
|---|---|---|
| L1 | 负责人接受的“11～45 ms”是本机数字。第一次访问时还没装 SW，弱网下载 30.5 KB 可能要几百毫秒到 1 秒以上。这段时间里打勾、删除，行都会当场消失、下面的行直接跳上来，弹层也没有进出场 | 把这个前提告诉负责人，写进执行说明。装好 SW 以后都从本机缓存读（workbox precache；我没逐条核对清单里有没有这个块，建议核一下），以后的冷启动只剩执行时间 |
| L2 | “失败不抛，下次再试”只在 jsdom 里用 `vi.mock` 验证过。真实浏览器的模块表可能会把失败的动态 import 缓存下来，同一个地址再 import 还是失败，要刷新页面才能恢复。没在浏览器里验证 | 在注释里写明“重试在部分浏览器里要刷新才生效”；或者监听 Vite 的 `vite:preloadError` 事件做提示。后果只是没有动画，所以是低 |
| L3 | MOTION-leaving-inert 只给 `Appear` 加了 inert。列表里离开中的行（`AppearItem`，data-state="leaving"，约 110 ms）没有 inert，键盘还能 Tab 到正在淡出的行里的 × 和打勾框 | 接手清单原来的范围就只有 Appear，这次不扣分。建议 `AppearItem` 离开时也加 `inert`，和 Appear 一致 |
| L4 | 退场开始时，如果焦点在弹层里面，比如用键盘按了弹层里的“取消”，inert 会让浏览器把焦点丢到 body，约 0.2 秒以后 Radix 的 FocusScope 卸载时再把焦点还给触发按钮。jsdom 不实现 inert 的焦点处理，我的探针验证不了 | 加一条 e2e：用键盘关弹层以后，焦点回到打开它的那个按钮。另外，Radix 的 hideOthers 在退场期间仍然让背景对读屏隐藏，加上弹层本身 inert，这约 0.2 秒里读屏什么都读不到，时间很短，可以接受 |
| L5 | e2e 的 `motionReady` 靠资源加载记录（resource timing），再固定等 300 ms。机器很慢时 300 ms 可能不够 | `loadMotionFeatures()` 到了以后打一个标记，比如 `document.documentElement.dataset.motion = 'ready'`，e2e 等这个标记再等一帧，不靠固定时间 |
| L6 | 单元测试没覆盖真实首屏的路径：没到时挂上的列表，到了以后删行要淡出、加行要 entering 并淡入 | 在 `features-async.test.tsx` 补一条，写法照探针 Q3：列表先挂上，再 `gate.open()`，然后删一行、加一行，断言 leaving、绝对定位、淡出以后才卸载，新行 entering 播完以后 opacity 是 1 |
| L7 | webkit 装功能包时主线程卡几十毫秒，没有真机数字 | 见 1.4，真机量一次再记下 |

## 四、评分

| 项 | 扣分 |
|---|---|
| 代码正确性（状态切换、inert、失败重试、单次下载） | 0（没有发现会出错的路径） |
| 测试（新测试和前端 A 的反证都到位；真实首屏路径缺单测 L6；重试只在 mock 下验证 L2） | −0.5 |
| 体验前提（L1 弱网首访冷窗口更长，没写进取舍说明；L3 列表退场行没有 inert；L4 焦点那条没有 e2e） | −0.5 |
| e2e 等待方式（L5）、真机数字（L7） | −0.5 |
| **总分** | **8.5 / 10，通过** |

## 五、跑过的命令与结果（都在独立副本里跑）

1. 把共享工作区的 `src`、`shared`、配置文件同步到副本，用 robocopy `/MIR`。
2. 探针 `zz-probe-fa6.test.tsx`（Q1～Q6）和 `zz-probe-fa6b.test.tsx`（失败后重试）：结果见第一节，跑完以后已从副本删掉。
3. 去掉 8 个测试里的 `await loadMotionFeatures()` 重跑：5 个文件挂，7 条失败、47 条通过（原因见 1.3）。跑完按原字节还原，并和共享工作区 `cmp` 一致。
4. `npx vitest run --project unit src/motion src/features/today src/features/todos src/features/reminders/__tests__/remind-exit-click.test.tsx src/kit/components`，跑了两遍：两遍都是 32 个文件、251 条，全部通过。
5. `npx tsc -p tsconfig.app.json`：退出码 0。
6. 读了 Motion 源码 `framer-motion/dist/es/components/AnimatePresence/PresenceChild.mjs`、`motion/features/animation/exit.mjs`，确认“没到时就关会当场移除”的机制。
7. 没有 git add，没有构建，没有连库，没跑 e2e，也没跑浏览器；共享工作区的源码没改过。

## 登记册（一行）
| FA6-2-CR | 2026-11-04 | FA-6 ② 动效功能包异步加载和退场 inert 审查 8.5 通过：没发现透明卡住、缩放跳变；inert 在重进、减少动态效果、连点下都正确；先等功能包不掩盖代码问题。低：L1 弱网首访冷窗口更长要告知负责人、L2 失败重试在真实浏览器未验证、L3 列表退场行没 inert、L4 焦点 e2e、L5 e2e 固定等待、L6 冷挂载列表缺单测、L7 真机耗时 | 前端 A | 低问题进接手清单 |
