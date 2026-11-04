# B2 代码审查 · FA-5 动效代码复审（只审逻辑正确性，不审手感）

- 审查人：独立代码审查员（只读，默认不通过，10 分制，8 分及以上才算通过）
- 日期：2026-11-04
- 上一轮：`docs/03-评审/B2/B2-代码审查-FA-5动效代码.md`（7.5 不通过，必改 M1）
- 本轮范围（工作区未提交的修改）：
  - 上一轮要求改的几条：`src/features/todos/__tests__/TodosPage-motion.test.tsx`、`src/features/today/__tests__/TodayPage-motion.test.tsx`（M1）；`src/core/upgrade.ts`、`src/core/__tests__/upgrade-busy-expired.test.ts`（U1）；`src/kit/hooks/__tests__/useHoldBusy.test.tsx`（StrictMode）；`src/kit/components/CheckCircle.tsx`（A3）；`tests/e2e/b2-motion-list.spec.ts`（A4）
  - 新修改：`src/motion/Appear.tsx`（进场播完清掉 transform）、新增 `src/motion/__tests__/appear-transform-end.test.tsx`
- 不在范围：`src/features/onboarding`、`src/app`、`src/features/reminders`（别的批次）。U2、U3、A1、A2 已定这次不改（接手清单 FA5-CR-low），不扣分。

## 结论：不通过，7.5 / 10

- 上一轮要求的五条（M1、U1、StrictMode 测试、A3、A4）**都已解决**，都做了反证：改坏源码以后，对应的测试会挂。
- 不通过的原因在这次新加的 `Appear.tsx` 上，有一条中问题 N1：“已停稳”状态没有复位。用户关上以后马上又打开，紧接着再关，退场会从“原位”起播，画面往回跳一下。sheet 实测从 33% 一下跳回 0.9%（整张弹层闪回全开），然后才往下收。
- 另有一条低问题 N2，同样是这次引入的：减少动态效果先开后关，已经停稳的 Appear 会从 scale(0) 放大到 1。

**通过条件：** 改掉 N1，并补一条“关→重开→没播完又关”的测试。N2 建议同一次一起改（改法几乎相同）。改完只复审 `Appear.tsx` 和它的测试。

## 一、上一轮问题核对

| 编号 | 结论 | 证据 |
|---|---|---|
| M1 测试依赖真实时间 | **已解决** | `TodosPage-motion.test.tsx:78-89`、`TodayPage-motion.test.tsx:40-51` 的 `recordStates()`：MutationObserver 的回调是微任务，React 提交以后马上执行，一定早于 Motion 的 rAF 帧和任何计时器，所以记下的是“提交当下”的状态。断言改成读记录（`TodosPage-motion.test.tsx:142`、`:150-151`、`:115`，`TodayPage-motion.test.tsx:80`），不再读 `act` 返回以后、动画走到哪儿算哪儿的状态。留住的那一拍只假 `setTimeout`（`:13`），推进完马上切回真计时器。**反证见第四节：四种改坏都会挂；在断言前人为多等 500 ms 模拟慢机器，仍然通过。** 结论：确实去掉了对机器快慢的依赖，也拦得住回退。 |
| U1 等着的更新遇到作废令牌 | **已解决，和主持人定的规则一致** | `upgrade.ts:189-192`：`reloadWhenIdle` 只看 `liveCount()`。`upgrade.ts:248-260` 的 `liveIdle(cause)`：正常令牌全没了、还有作废的、而且 `reloadPending`，这时 `released` 就载入，`expired` 就回到 idle 并设 `reloadArmed`（下次按直接载入）。`upgrade.ts:268-282`：释放时先走 `liveIdle('released')`，要等全部令牌（含作废的）都放了，才走自动载入那条路（`closed_for_upgrade`）。文件头 `:16-20` 写明了规则。测试 `upgrade-busy-expired.test.ts:35-51`（一个作废、一个按时，按时的那个释放就载入）、`:53-64`（只剩作废令牌时当场载入）、`:66-80`（正常令牌到点作废：回 idle，下次按直接载入）。三种反证都会挂。另外推了几种组合：两个正常令牌里先作废一个，再释放另一个，会载入；先释放一个，另一个到点作废，回 idle。都符合规则。 |
| StrictMode 令牌计数 | **已解决** | `useHoldBusy.test.tsx:38-57`：`<StrictMode>` 下 `holdBusy` 调了 2 次，最后剩 1 个令牌；重画后还是 1 个；卸载后是 0。反证：`useHoldBusy.ts:13` 不返回释放函数，这条和第 1 条都会挂。 |
| A3 CheckCircle 没人用的 `shown` | **已解决** | `CheckCircle.tsx:7-12` 已经删掉 `shown`。注释 `:3-4` 和实际用法一致（两页把 `shown(...)` 传给 `checked`：`TodayPage.tsx:64`、`TodosPage.tsx:102`）。`tsc -p tsconfig.app.json` 0 错误，没有别的调用方。 |
| A4 两个 `today-done-<id>` | **已解决** | `b2-motion-list.spec.ts:212-213`：用 `:not([data-state="leaving"] *)` 排除离开中的那一份。所有 e2e 里只有这一处按 `today-done-` 定位（已 grep 确认）。点下去以前只有一份，所以这里是预防性的，以后在打勾后再定位时也照这个写法。 |

## 二、新修改审查：`Appear.tsx` 播完清掉 transform

做法本身是对的：
- `transitionEnd: { transform: 'none' }` 只在进场正常播完时生效（`Appear.tsx:32`）。
- 停稳以后的退场改用两段关键帧（`:28`），避免从 `none` 起播变成 scale(0)。新测试 `appear-transform-end.test.tsx:59-76` 证明了这条正常路径上没有 scale(0)。
- `onAnimationComplete` 只在 `present` 时记“已停稳”（`:57-59`）。退场播完不会误记。
- 减少动态效果时本来就不带 transform，停没停稳参数都一样（测试 `:55`）。

实测（临时探针，用完已按原字节还原）：
- StrictMode：停稳、退场正常，第一帧是 `translateY(0px) scale(1)`，接着往外走，没有 scale(0)。
- 停稳后关、中途重开：能再次停稳（transform 回到 none）。
- 没停稳就关、马上重开、停稳后再关：起点正确。

问题出在下面两种情况。

### 中

**N1　“已停稳”只会置 true、不会复位：退场被打断、重新进场还没播完时再关，起点跳回“原位”**
- 位置：`src/motion/Appear.tsx:44`（`settled` 只有 `setSettled(true)`）、`:28`（`settled` 为 true 就用 `[p.animate.transform, p.exit.transform]`）。
- 场景：停稳（settled = true）→ 关（退场开始）→ 退场途中又打开（AnimatePresence 复用同一个实例，从当前值往回进场）→ 进场还没播完又关。这时 settled 仍是 true，退场第一帧被强制设成 `translateY(0)`，也就是全开的位置，然后才往终点走。
- 实测（jsdom，Motion 14.7.1）：
  - toast：`translateY(1.30px)` → `translateY(0px)` → `translateY(6.2px)`；
  - sheet（`Dialog.tsx:46` 用的就是它）：`translateY(33.4%)` → **`translateY(0.9%)`** → `translateY(30.1%)`，跑了两次结果相同。也就是弹层收到一半，突然闪回全开，再往下收。
- 触发条件：快速“关、开、关”，比如双击遮罩、连续点关闭按钮，或者 RemindHost 的 `showBar` 和 `note` 互相切换。不常见，但正是这次要防的“跳帧”。
- 建议改法（任选一种）：
  1. 把 settled 改成“现在 transform 是不是 none”的意思：`onAnimationStart` 时，如果 `present` 就置 false（重新进场一开始就不算停稳），`onAnimationComplete` 时如果 `present` 就置 true。退场的起点在 `present` 变成 false 的那一次渲染里定下来，之后不再变。建议用 ref 加“离开时冻结一次”，写法和 `AppearItem` 的 `popped` 一样。不要在退场途中改 state，否则 exit 参数会变，Motion 可能重新起播。
  2. 根本解法：presets 改用独立变换值（`y`、`scale`）。值回到默认时，Motion 自己会输出 `transform: none`，不需要 transitionEnd、关键帧，也不需要 settled。但这和 presets 文件头“写完整 transform 字符串走硬件加速（17.2 第 6 点）”冲突，要主持人决定。
- 必须补的测试：停稳 → 关 → 等 100 ms → 开 → 等 60 ms → 关。断言第二次关以后第一帧的 translateY 不小于关之前的值（不往回跳）。toast、sheet 各一条。

### 低

**N2　减少动态效果“先开后关”：已经停稳的 Appear 从 scale(0) 放大到 1（这次引入）**
- 位置：`Appear.tsx:32`。
- 场景：Appear 已停稳（transform 是 none）→ 系统的减少动态效果打开（`animate` 变成 `{ opacity: 1 }`）→ 再关掉。这时 `animate` 又带上了 transform，Motion 从当前值 `none` 起播，`none` 被换成全零变换。
- 实测：`scale(0.53)` → `0.82` → … → `1` → `none`，约 220 ms 的放大。换回 HEAD 版 `Appear.tsx` 跑同一个探针，没有任何 transform 变化，可以确认是这次引入的。
- 同一个根因的已有问题（不是这次引入，HEAD 版也复现了）：在减少动态效果下挂上，之后关掉减少动态效果，从 `scale(0)` 放大。
- 现在只有系统设置能触发（`src` 里还没有写 `data-rm` 的开关），所以列为低。以后设置里加了开关，就会变成很容易碰到。
- 建议：settled 以后 `animate` 不带 transform，只写 `{ opacity: 1 }`。探针里减少动态效果期间 `animate` 没有 transform，Motion 也没有去改 transform，可见去掉这个键不会触发回退。这样也顺带修好上面那个已有问题，因为减少动态效果下 `onAnimationComplete` 同样会置 settled。补一条测试：停稳 → `data-rm=1` → 删除 `data-rm`，记录到的 transform 里不出现 `scale(0.x)`。

**N3　退场一开始又带上 transform，fixed 子元素在退场期间又以外层为参照**
- 位置：`Appear.tsx:28`。
- 两段关键帧的第一帧就是 `translateY(0) scale(1)`，退场的 220 ms 里外层又成了 fixed 子元素的定位参照，横幅、按钮条会在退场第一帧跳到外层里面。进场期间本来就是这样。CacheTooNewScreen 一直 `show`，不受影响。
- 建议：写进文件头，说明“只保证停稳期间”。如果以后有带 fixed 子元素、又会退场的用法，那一处的 fixed 元素放到 Appear 外面。

**N4　测试小问题（不影响稳定性）**
- `TodosPage-motion.test.tsx:130` 用真实时间等 400 ms 再断言“没挪”。这是否定断言，机器慢只会更容易通过，不会随机变红，但机器慢时会漏查。可以改成推进假计时器，再等 `rec` 里没出现 `leaving`。
- `upgrade.ts:252-255` 的 `released` 分支直接 `deps.reload()` 就返回了，没有 `set({ busy: false })`。真载入时没有影响，记一笔就行。

## 三、评分

| 项 | 分 |
|---|---|
| 上一轮五条修复质量（含测试和反证） | 很好，没有扣分 |
| 新修改 `Appear.tsx` 的正确性 | N1（中）扣 1.5；N2、N3（低）共扣 0.5 |
| 测试覆盖 | 新测试没覆盖打断重进、减少动态效果切换，扣 0.5 |
| **总分** | **7.5 / 10，不通过**（只要 N1 改掉并补上测试，就可以到 8.5 以上） |

## 四、跑过的命令与结果

1. `$env:TZ='Asia/Seoul'; npx vitest run src/motion src/features/todos/__tests__/TodosPage-motion.test.tsx src/features/today/__tests__/TodayPage-motion.test.tsx src/core/__tests__/upgrade-busy-expired.test.ts src/kit/hooks/__tests__/useHoldBusy.test.tsx src/kit/components`
   - 21 个文件，174 条，全部通过。
2. `$env:TZ='Asia/Seoul'; npx vitest run src/features src/motion src/kit src/core`，连跑两遍：
   - 两遍都是 161 个文件、1638 条，全部通过，退出码 0。
3. `npx tsc -p tsconfig.app.json`、`npx tsc -p tsconfig.node.json`：都是退出码 0。
4. M1 反证（改 `src/motion/AppearList.tsx`，每种改完跑两个 motion 测试，跑完还原）：
   - 新行起点 `opacity: 0` 改成 1：撤销那条挂（`expected 1 to be +0`）；
   - 离开时 `position: 'absolute'` 改成 `relative`：待办打勾、今天页两条挂；
   - 不打 `entering`：撤销那条挂；
   - 不打 `leaving`：三条全挂；
   - 慢机模拟：在删除、撤销的断言前各多等 500 ms 真实时间，5 条全部通过（旧写法在这种情况下必挂）。
5. U1 反证（改 `src/core/upgrade.ts`）：
   - 正常令牌释放也不载入：第 2 条挂；
   - 到点作废也载入：第 4 条挂；
   - `reloadWhenIdle` 改回看 `busy.size`：第 3、4 条挂。
6. StrictMode 反证（`useHoldBusy.ts` 不返回释放函数）：两条挂。
7. Appear 探针：在 `appear-transform-end.test.tsx` 末尾临时加 P1 到 P7，得到第二节的实测数据；又把 `Appear.tsx` 临时换成 `git show HEAD:` 的版本做对照，证明 N2 是这次引入的。
8. 还原核对：
   - 动过的 6 个文件（`Appear.tsx`、`AppearList.tsx`、`upgrade.ts`、`useHoldBusy.ts`、`appear-transform-end.test.tsx`、`TodosPage-motion.test.tsx`）都从备份按原字节拷回，sha256 和开始时一致；本次范围内其余 5 个文件的 sha256 也和开始时一致。
   - 整体 `git diff` 和开始时不同，但不同的都是别人同时在改的文件：`App.tsx`、onboarding、`文件登记册.md`、接手清单、e2e 首屏、`pw8790.tmp.config.ts`，另外期间有人新提交了 `769128c`（check_arch）。这些文件我都没碰过。
   - 没跑 e2e，没构建，没连库，没 `git add`。

## 登记册（一行）
| FA5-CR2 | 2026-11-04 | FA-5 复审 7.5 不通过：M1、U1、StrictMode、A3、A4 已解决（均有反证）；新问题中 N1（Appear 退场被打断、重进后再关，settled 没复位，起点跳回原位，sheet 实测 33%→0.9%）；低 N2（减少动态效果先开后关，scale(0) 放大，这次引入）、N3、N4 | 前端 B | 改 N1 并补测试后只复审 Appear |

---

# 第二次复审（2026-11-04，前端 A 按 N1～N4 修改之后）

- 范围：`src/motion/Appear.tsx`、`src/motion/__tests__/appear-transform-end.test.tsx`、`src/core/upgrade.ts`、`src/core/__tests__/upgrade-busy-expired.test.ts`、`src/features/todos/__tests__/TodosPage-motion.test.tsx`。
- 变异验证全部在独立副本里做，没有改共享工作区：
  - 副本位置：`C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\lemo-copy`，里面是 `src`、`shared`、配置文件，`node_modules` 用联接。
  - 跑之前确认过：副本里这 5 个文件和 `useHoldView.ts`、`TodosPage.tsx` 与共享工作区逐字节一致；每次变异后都按原字节还原，并用 `cmp` 对照共享工作区确认。

## 结论：通过，8.5 / 10

- N1～N4 四条代码都改对了。
- 前端 A 的两处不同做法：第 1 处站得住。第 2 处断言本身的规则站得住，但它靠 jsdom 真实帧取样，回退大约四次里有一次拦不住（实测见下）。记为低问题 R1，写进接手清单，不挡这次通过。

## 一、N1～N4 核对

| 编号 | 结论 | 证据 |
|---|---|---|
| N1 退场被打断、重进后再关，起点跳回原位 | **已解决** | `Appear.tsx:50-60`：“已停稳”改成 ref。`present` 变成 false 的那一次渲染里，把当时是否停稳冻结进 `leftSettled`（`:57-58`）。离开途中又回来（`present` 变回 true，且 `leftSettled` 不为 null）时，冻结值和“已停稳”一起清掉（`:54-56`）。退场参数只读冻结值（`:60`）。新测试 `appear-transform-end.test.tsx:86-136`。<br>副本探针结果：<br>• 关、开、没播完又关，第二次退场从当前值往下走；<br>• 关上途中重开、等它重新停稳后再关，第一帧 `translateY(34.49%)`，接着 77%，是从原位正常起播；<br>• StrictMode 下停稳、减少动态效果切换、关开关、再停稳、再关，都没有 scale(0)，能重新停稳，退场正常。 |
| N2 减少动态效果先开后关，从 scale(0) 放大 | **已解决**（HEAD 版就有的那条也一起修了） | `Appear.tsx:38`：停稳以后 animate 写 `{ opacity, transform: 'none' }`，none 到 none 不插值。减少动态效果下 `onAnimationComplete` 同样会置“已停稳”（`:72-76`），所以“在减少动态效果下挂上、之后关掉”也不放大。测试 `:138-160`、`:162-182`。反证：把停稳以后的目标换回带 transform 的，这两条加参数那条，一共 3 条会挂，报错里能看到 `scale(0.5029) … scale(1)`。 |
| N3 退场期间 fixed 子元素又以外层为参照 | **已解决**（按建议写进注释） | `Appear.tsx:11-12`：写明只保证停稳期间外层没有 transform；带 fixed 子元素又会退场的用法，把 fixed 元素放到 Appear 外面。 |
| N4-1 待办测试用真实时间等 400 ms | **已解决** | `TodosPage-motion.test.tsx:121-140` 改成 `vi.runOnlyPendingTimers()` 跑完留住那一拍的计时器，并断言 `vi.getTimerCount() === 0`，再查整个过程里没有出现 `leaving`。反证：把 `useHoldView` 改成第二次点的时候重新拍快照（`setHeld({ v: latest.current })`），这条会挂。 |
| N4-2 `released` 分支载入前没解除 busy | **已解决** | `upgrade.ts:252-256`：先 `set({ busy: false })` 再 `deps.reload()`。测试 `upgrade-busy-expired.test.ts:39-54` 记下载入那一刻的 busy，断言是 `[false]`。反证：去掉 `set` 以后测试挂，报 `expected [ true ] to deeply equal [ false ]`。 |

## 二、前端 A 的两处不同做法

### 1. “已停稳”在渲染里、看到“离开以后又回来”时清，不在 onAnimationStart 里清：**站得住**

- 理由成立。停稳以后 animate 换成 `transform: 'none'`，Motion 会认为目标变了、再起一次动画，于是 `onAnimationStart` 会再触发一次。如果在那里清，就会出现“清掉 → 换回带 transform 的目标 → 从 none 起播 → scale(0)”，等于把 N2 又引回来。
- 在 `present` 期间，外层 transform 离开 none 只有一条路：退场途中被打断、重新进场。减少动态效果切换现在已经不会再带回 transform。所以只在 `present` 从 false 变回 true 时清，覆盖了所有情况。
- 渲染里改 ref 不算纯，但这两段分支都是幂等的：StrictMode 渲染两次结果一样，被丢弃的渲染也不会把状态记错。写法和 `AppearItem` 的 `popped` 一致，可以接受。
- 冻结值用 `boolean | null`，“还没离开”和“离开时没停稳”区分清楚了。

### 2. N1 测试的断言规则：**规则站得住，但取样不稳定，回退大约四次里有一次漏拦（低，R1）**

- **规则本身没问题：**
  - 允许关之后沿进场方向再走一帧，对应 Motion 晚一帧才起退场；
  - 最低点不低于关之前的一半；
  - 过了最低点以后单调不减；
  - 终点必须是 100% 或 12px。
  - 只要“闪回原位”的那一帧被取到，就一定挂（sheet 会到 0.9%，toast 会到 0.24px）。
  - 用 `attributeOldValue` 逐条记录，同一批里的中间值也不会漏，这一点是对的。
- **误报：没有。** 现版本 4 路并发、每路 3 遍，共 12 次在负载下跑，加上 4 次普通跑，全部通过。
- **漏拦：有。** 闪回原位只体现在退场的第一帧。jsdom 里 Motion 用真实的 rAF 和时间，退场第一帧有时落得晚，原位附近那一帧根本没写出来，序列看起来就是单调的。例如回退版本下的一次 sheet：`32.95 → 31.32, 34.49, 76.60 …`，起点其实已经跳回 0%，但没取到。
- 在副本里统计了回退以后，每次跑 sheet、toast 两条里至少有一条挂的次数：
  - 只去掉“回来时清‘已停稳’”那一行：10 次里 8 次；单看 sheet 那条，只有约 3/10；
  - 换回上一轮的 `Appear.tsx`：9 次里 6 次。
  - 合计大约 74%。
- 影响：`test:tz` 每次全量会在三个时区各跑一遍，回退在一次全量里漏过去的概率不高。但这条测试是 N1 唯一的守门，靠取样运气不合适。
- **建议（R1，低，进接手清单）：** 二选一。
  - 让帧可控：`vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout'] })`，每次推进 16 ms 走一帧（必要时配合 Motion 的 `MotionGlobalConfig.useManualTiming`）。这样序列每次都一样，再断言“第二次关以后，每一帧都不比上一帧小，最多只允许一帧沿进场方向的步长”。
  - 或者把“已停稳、冻结、清掉”这段状态转换抽成纯函数，单测输入序列“进场完成 → 离开 → 回来 → 离开”时，exit 用的是不是当前值。保留现在的帧测试，作为端到端的补充。

## 三、新问题

| 编号 | 级别 | 场景 | 建议 |
|---|---|---|---|
| R1 | 低 | N1 测试靠 jsdom 真实帧取样，回退大约四次里有一次漏拦（见上） | 让帧可控，或把状态转换抽成纯函数单测 |
| R2 | 提示 | 草稿目录 `scratchpad\mut.py` 被另一个 agent 的脚本覆盖了。那个脚本会直接改**共享工作区**的 `src/app/App.tsx` 和 `useReminders.ts` 做变异，不符合新规矩 | 我第一次误调用了它，但它的第一步是从备份拷文件，因为找不到备份文件就报错退出了，没写入任何文件。我之后改用自己的 `scratchpad\rev2\mut.py`，只改副本。请主持人提醒那个 agent 改到副本里做 |

没有新的高、中问题。

## 四、评分

| 项 | 分 |
|---|---|
| N1～N4 代码正确性 | 都已解决，探针和反证都对得上，不扣分 |
| 前端 A 的两处不同做法 | 第 1 处站得住，不扣；第 2 处规则对、取样不稳（R1），扣 0.5 |
| 测试覆盖（新增 N1 两条、N2 两条，加参数测试） | N1 唯一的守门靠取样运气，另扣 0.5 |
| 实现方式 | 渲染里改 ref 不算纯（目前幂等、StrictMode 实测没问题），以后改动容易出错，扣 0.5 |
| 文件头注释、N3 说明、N4 | 到位，不扣 |
| **总分** | **8.5 / 10，通过** |

## 五、跑过的命令与结果（都在副本里跑）

1. 基线：`npx vitest run --project unit` 加 `appear-transform-end`、`TodosPage-motion`、`upgrade-busy-expired` 三个文件：21 条，全部通过。
2. `src/motion`、`src/features/todos`、`src/core` 连跑两遍：两遍都是 67 个文件、652 条，全部通过。
3. `npx tsc -p tsconfig.app.json`：退出码 0。
4. 负载下的误报检查：4 路并发 × 3 遍跑 `appear-transform-end.test.tsx`，12 次都是 13/13 通过。
5. 反证：
   - 回来时不清“已停稳”：N1 测试 10 次里 8 次挂；
   - 停稳以后 animate 换回带 transform：N2 两条加参数一条挂；
   - 换回上一轮的 `Appear.tsx`：N1 测试 9 次里 6 次挂，N2 和参数测试每次都挂；
   - `released` 分支不解除 busy：N4 测试挂；
   - `useHoldView` 改成重新拍快照：待办“再点回去”那条挂。
6. 探针（在副本测试文件末尾临时加，跑完还原）：StrictMode 综合场景；关上途中重开、重新停稳后再关的起点；打印回退版本的帧序列，分析漏拦原因。
7. 每次变异以后副本都按原字节还原，并和共享工作区 `cmp` 一致。共享工作区的源码没有改过；没有 `git add`，没有构建，没有连库，没跑 e2e。

## 登记册（一行）
| FA5-CR3 | 2026-11-04 | FA-5 第二次复审 8.5 通过：N1～N4 已解决（都有反证）；前端 A 渲染里清“已停稳”站得住；N1 测试规则对，但靠 jsdom 真实帧取样，回退约 26% 漏拦（R1 低，建议让帧可控，进接手清单） | 前端 A | R1 进 FA5-CR-low |
