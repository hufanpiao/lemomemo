# B2 代码审查 · FA-5 动效代码（只审逻辑正确性，不审手感）

- 审查人：独立代码审查员（只读，默认不通过，10 分制，8 分及以上才算通过）
- 日期：2026-11-04
- 范围（`git diff HEAD` 加新文件）：
  - 升级中心：`src/core/upgrade.ts`、`src/core/__tests__/upgrade-busy-expired.test.ts`（BUSY-wire）
  - 占用令牌：`src/kit/hooks/useHoldBusy.ts`、`src/kit/components/EditShell.tsx`、`src/kit/hooks/__tests__/useHoldBusy.test.tsx`
  - 列表动效：`src/motion/useHoldView.ts`、`src/motion/AppearList.tsx`
  - 其他动效：`src/motion/vt.ts`、`index.ts`（`reportDuplicateVtNames`）、`presets.ts`、`tokens.ts`、`Appear.tsx`（sheetExit）、`components.ts`
  - 页面：`src/kit/components/CheckCircle.tsx`、`src/features/today/ui/TodayPage.tsx`、`src/features/todos/ui/TodosPage.tsx`
  - 测试：`src/motion/__tests__/*`、`TodayPage-motion.test.tsx`、`TodosPage-motion.test.tsx`
  - e2e：`tests/e2e/dist-fingerprint.ts`（产物比源码旧的检查）、`tests/build/e2e-dist-fingerprint.test.ts`
- 不在范围：App.tsx、router.ts、reminders、shared、supabase、settings、ConsentGate.tsx

## 结论：不通过，7.5 / 10

产品代码本身的逻辑没有发现高、中问题：
- BUSY-wire 不会让升级永远卡住，任何时候用户都有手动的出路；
- 自动重新载入不会在编辑中途发生；
- 令牌在 StrictMode 下配对正确；
- 停一拍期间不会泄漏内存，最多显示旧数据 220 ms。

不通过只因为一条中问题：`TodosPage-motion.test.tsx` 的“删除 / 撤销”用例依赖真实时间。全量跑时失败了一次，单独跑三次都通过。它进了 CI 会随机变红，必须改。改完这一条、其余低问题写进交付说明，就可以直接算通过，不用再整体复审。

### 运行结果
- 范围内 vitest（加 `--exclude tests/build/gen-tauri-key.test.ts`）：
  - 全量一次：438 个文件，3 条失败。其中两条不在范围内（`src/app/__tests__/app-remind-host.test.tsx`、`cal-same-page.test.tsx`，都是 5 秒超时，机器负载高）。在范围内的一条是 `TodosPage-motion.test.tsx`“删除：先淡出（leaving）再卸载；撤销恢复：淡入（起点透明）”，用时 413 ms，不是超时，是断言没过。
  - 这个文件单独跑了 3 次，`src/features`、`src/motion`、`src/kit` 一起跑了 1 次（1136 条），都通过了。
- eslint：范围内 0 问题。

## 协调者点名的问题

### 1. BUSY-wire（`upgrade.ts` 第 176～280 行）：会不会让升级永远卡住，会不会在编辑中途换版本

**会不会永远卡住：不会。** 设想最坏的情况：有一个令牌漏了释放，作废以后一直留在 `busy` 里。这时四条路分别是：
- 横幅：`state.busy` 只看没作废的令牌（`liveCount`），作废以后 required、new_version、sync_paused 这些横幅都会出来。
- 用户按“更新”：`reloadWhenIdle` 只看 `liveCount`，没有别的令牌就马上载入。如果已经进入 `reloadArmed`，再按一次，也是马上载入。
- 别的标签页升级了本机库（`onCacheVersionChange`）：不会自动载入，状态进入 `closed_for_upgrade`，那条横幅上有“重新打开”，用户可以手动载入。这是 BUSY-wire 有意的取舍。
- 结论：漏放的令牌会挡住所有自动载入，但每条路都给用户留了手动出路。

**会不会在编辑中途换版本：**
- **自动载入的路都不会。** `onCacheVersionChange`、别的令牌释放，现在看的都是 `busy.size`（包括作废的令牌）。测试第 1 条验证了：作废以后别的标签页升级本机库，不载入；真释放了才载入。
- **用户自己按“更新”会。** 编辑页开了超过 30 分钟，令牌已经作废，用户按横幅上的“更新”，会马上载入。这是有意的设计（“作废的不挡用户自己的决定”），编辑页也会自动保存，风险可以接受。但这条规则和下面 U1 的行为不一致。
- StrictMode 双挂载时的副作用见 U2。

### 2. `useHoldBusy`、`EditShell`：挂上、卸载、重复挂载时令牌怎么配对，StrictMode 下会不会漏放或多放
- 每一次 effect 拿一个令牌，清理函数就是这个令牌的释放函数，配对是一对一的。释放函数里有 `released` 标记，调两次也只算一次。
- StrictMode：挂上（令牌 1）→ 模拟卸载（释放 1）→ 再挂上（令牌 2），最后只剩一个令牌，不漏放也不多放。
- 重画时依赖 `[reason, active]` 不变，不会重复拿令牌，测试也覆盖了。
- 副作用：模拟卸载那一次释放是真的释放。如果这时正好在 `closed_for_upgrade`，或者有等着的“更新”，会触发 `deps.reload()`。这只发生在开发版，见 U2。
- 启动还没完成时（`getBoot()` 是 null）挂上的编辑页，之后不会再补拿令牌，因为 effect 依赖里没有 boot，见 U3。

### 3. `useHoldView`、`AppearList`：停一拍期间数据又变了会不会显示错的行，会不会内存泄漏
- **显示：** 停一拍（`--dur-ui` = 220 ms）期间，画的是按下之前那一份快照。这期间同步覆盖、别的设备删除，最多晚 220 ms 才显示出来，之后换成最新的，不会一直错。
  - 删除之前先 `release()`，所以删除不会被拖住。
  - 撤销没有 release，恢复的那一行要晚至多 220 ms 才出来，可以接受。
  - 连续打勾时每次都重新计时，快照可以一直留到用户停手。这期间点快照里已经被别处删掉的行，会进入一条已删除的待办，或者对它打勾，窗口很小，见 A2。
- **内存：** 计时器在卸载时清掉；`release` 清计时器；`picked` 只在留着的期间累积，下一次打勾时如果不在留着的状态就清空；`AppearItem` 没有全局状态。**没有泄漏。**
- **`AppearItem`：** 位置是在渲染时读的（`popped`），只量一次。如果同一个 key 在退场途中又被加回来（motion 会复用同一个实例），再次离开时会用上一次量的旧位置，见 A1。

### 4. 其他动效
- `vt.ts` 和 `reportDuplicateVtNames`：只在开发版运行，放在 View Transition 的回调里。router 用 `flushSync` 画完新页面再检查，时机是对的。新页面是懒加载、还没加载完时，查的是 Suspense 的占位，不会误报，只会漏查。每次切页都要对全部元素算一遍计算样式，只是开发版变慢，可以接受。
- `presets`、`Appear.tsx` 的 sheetExit：退场的时长曲线写在 exit 目标里，减少动态效果时同样减半，逻辑对。
- `CheckCircle`：真正接收点按的是那个 checkbox，叠在上面的圆盘和勾号都是 `aria-hidden`。两个页面都把 `shown(...)` 直接传给了 `checked`，组件自己的 `shown` 参数没有人用，见 A3。
- 今天页：key 改成 `e:`、`t:` 前缀，事件和待办的 id 不会再撞。一条“没赶上”的待办打勾以后，退场和进场会短暂同时存在，这时有两个 `today-done-<id>`，e2e 如果用严格定位可能偶发失败，见 A4。

### 5. `dist-fingerprint.ts` 的过期检查
- 逻辑正确：只比 `src/`、`shared/` 里（跳过 `__tests__`）的修改时间和产物 `index.html` 的修改时间，比产物新就警告，不中断。产物由 Vite 写出（不是复制），每次构建修改时间都会更新，不会一直报。
- 指纹比对先失败时不会走到这里，所以 `statSync` 不会因为没有产物而抛错。
- 已知查不出、注释里也写明了的：`functions/`、`VERSION`、`build/` 改了不会提醒；`git checkout` 改了修改时间会误报。可以接受。
- 测试有覆盖（`tests/build/e2e-dist-fingerprint.test.ts` 第 93～115 行）。

## 问题清单

### 高
无。

### 中（必改）

| 编号 | 位置 | 现象 | 建议 |
|---|---|---|---|
| M1 | `src/features/todos/__tests__/TodosPage-motion.test.tsx` 第 116～130 行 | 用的是真实时间：点完撤销后，马上断言 `opacity < 0.5` 和 `data-state === 'entering'`。淡入会在约 143 ms 后开始、220 ms 播完，机器一慢，`act` 返回时动画可能已经过了一半甚至播完，断言就会失败。全量跑时失败了一次（413 ms，不是超时），单独跑都通过，是典型的时序不稳定。`TodayPage-motion.test.tsx` 的写法类似，也要一起看。 | 改用 fake timers，并手动推进 Motion 的帧（或者 mock `requestAnimationFrame`）；或者只断言“起点”，即撤销同一次提交里的 `initial`（可以读 `itemMotion()` 的参数，或者把 Motion 的 frameloop 停住）。不要依赖真实时间里的中间状态。 |

### 低

| 编号 | 位置 | 现象 | 建议 |
|---|---|---|---|
| U1 | `src/core/upgrade.ts` 第 245～253 行（`liveIdle`） | 规则说“作废的令牌不挡用户自己的决定”，但用户在“有一个没作废、一个已作废”时按了“更新”，等那个没作废的释放后，不会载入，而是回到 idle、再按一次才载入（测试第 2 条正是这样断言的）。反过来，用户在“只有作废令牌”时按，会马上载入。同一个用户决定，两种时机结果不一样，转圈会默默停掉。 | 二选一，并写清楚：① `liveIdle` 里如果 `reloadPending` 而且 `liveCount() === 0`，直接 `deps.reload()`，和 `reloadWhenIdle` 保持一致；② 维持现状，在文件头写明“等待中的更新不自动越过作废令牌”，横幅回到 idle 时给一句提示。 |
| U2 | `src/kit/hooks/useHoldBusy.ts` 第 9～14 行 | 开发版 StrictMode 模拟卸载时的那次释放，碰上 `closed_for_upgrade` 或有等着的更新，会触发真的 reload。生产版不受影响。 | 写进注释即可；或者在 `holdBusy` 的释放里把自动载入推迟一个微任务，等的时候如果又有人拿了令牌就不载入。 |
| U3 | 同上 | `getBoot()` 是 null 时挂上的编辑页不会补拿令牌。正常路径下编辑页在启动完成之后才出现，碰不到。 | 写进注释，或者订阅 boot 就绪。 |
| A1 | `src/motion/AppearList.tsx` 第 117～121 行 | `popped` 只在第一次离开时量。同一个 key 在退场途中被加回来（复用同一个实例），再离开时会用上一次的旧位置。 | `present` 时把 `popped.current` 复位成 undefined。 |
| A2 | `src/motion/useHoldView.ts` 第 30～35 行 | 连续打勾时快照可以一直留着，这期间点快照里已经被别处删掉或改掉的行，操作的是旧数据，窗口很小。 | 可以接受，写进注释；或者给留着的时间设一个上限（比如最多 3 × `--dur-ui`）。 |
| A3 | `src/kit/components/CheckCircle.tsx` | `shown` 参数没有人用，两个页面都直接把显示值传给了 `checked`，注释里描述的用法和实际不一样。 | 删掉 `shown`，或者让页面改用它（真实的 checkbox 跟数据走，圆圈跟 `shown` 走）。 |
| A4 | `src/features/today/ui/TodayPage.tsx` 第 63、89～95 行 | 一条“没赶上”的待办打勾以后，退场和进场同时存在约 110 ms，`today-done-<id>` 会出现两个。 | 退场中的那一项 testid 加后缀，或者 e2e 定位时排除 `data-state="leaving"`。 |

## 测试覆盖
- 已覆盖：
  - 作废以后自动载入被挡住、真释放后才载入；一个作废、一个按时释放；
  - `useHoldBusy` 挂上、重画、卸载，启动前不报错；
  - `useHoldView` 的留住、重新计时、release、减少动态效果；
  - `AppearList` 的进出、文档流、参数；
  - vt 重名检查（计算样式、内联、只在开发版、CSS 登记）；
  - 指纹和过期检查的纯函数。
- 缺：
  - StrictMode 双挂载下 `useHoldBusy` 的令牌计数（建议加一条：在 `<StrictMode>` 里挂上，最后 holdBusy 2 次、释放 1 次）；
  - U1 那种情况“用户的决定”该怎么走的明确断言；
  - 停一拍期间 live 数据变化（同步删掉一行），release 后显示最新的。

## 通过条件
改 M1（让动效测试不依赖真实时间），然后全量跑两次都通过。U1～U3、A1～A4 同批改，或者写进交付说明。改完只复审 M1。

## 登记册（一行）
| FA5-CR | 2026-11-04 | FA-5 动效代码审查 7.5 不通过：必改 M1（TodosPage-motion 测试依赖真实时间、全量跑偶发失败）；低 U1（等着的更新遇作废令牌回 idle 与直接按不一致）、U2、U3、A1～A4 | 前端 B | 改 M1 后复审 |
