# B2 审查：Dialog 收尾（L-1～L-3、L-5、L-7）、REMIND-sub-low（N1、N2、L7）、MOTION-wallclock-tests

- 日期：2026-11-05；审查员：只读代码审查（默认不通过，满分 10，8 分算过，三批分开打分）
- 对象：工作区未提交改动（HEAD cfa142d），文件归属按盘点 `uncommitted-inventory.md` 第 5、8、9 批
- 原意出处：`B2-代码审查-MOTION-②-low与Dialog焦点.md` 的 L-1～L-7；`B2-代码审查-提醒接线设置日历.md` 第二轮 N1、N2、L7；`B1-接手清单-来自B0评审.md` 的 MOTION-wallclock-tests、REMIND-sub-low
- 怎么验的：
  - 单测：7 份相关文件 48/48 过；`src/motion` 3 份并发（每份 1 个 worker）各 166/166 过；改动文件 eslint、`tsc -p tsconfig.app.json` 都没报错。
  - 变异：在独立副本（scratchpad `mut-b2dlg`）里做了 23 个，主仓库没动。
  - e2e：在另一份副本（scratchpad `e2e-b2dlg`）里改到 8852 / 9292、假后端 9197 / 9198 跑 focus-retry、settings-sub-low、motion-list，chromium、webkit 各跑一遍；focus-retry 又加跑 `--repeat-each 3`。跑完端口都关了。
  - 另写了一个探针 `zz-probe-ariahidden`（只在副本里）：每帧看提前还回去的焦点是不是落在 aria-hidden 里。

## 一、总表

| 批 | 分数 | 结论 |
|---|---|---|
| 1 Dialog L-1～L-3、L-5、L-7 | **7.5** | **不通过**：L-1 提前还焦点，焦点会落进 Radix 还没撤掉的 aria-hidden 里（M1，读屏退步）；另有 3 个变异存活 |
| 2 REMIND-sub-low N1、N2、L7 | **8.5** | 通过：返回导航、焦点不抢、连点三处都对，12 个变异拦住 11 个，存活的 1 个近似等价 |
| 3 MOTION-wallclock-tests | **8.5** | 通过：5 个变异全拦住，并发连跑稳定，没有改坏原有断言 |

`returnFocus` 对提醒接线那批够用：`RemindNotice` 和 `MissedReminders` 两处用法我都按代码路径核对过，见第二节 2.3。

## 二、第 1 批：Dialog

### 2.1 各项原意对照

| 项 | 原意 | 现在 | 结论 |
|---|---|---|---|
| L-1 | 关的途中焦点不要在 body 上停 0.23～0.38 秒 | `open` 变成 false 的那次提交里，在 useEffect 里就把焦点还回去。这时 Radix FocusScope 的锁焦点监听已经在同一次提交的清理阶段摘掉了（Radix 1.3.1 里 `trapped = context.open`，被动 effect 先跑完所有清理再跑新的）。卸载时的 `onCloseAutoFocus` 只在焦点丢了才再还一次。e2e 断言焦点在 body 上不超过 1 帧，chromium、webkit 4 遍都过 | 时机对，**但带出 M1** |
| L-2 | 打开按钮被禁用或被移走时要有退路 | 加了可选参数 `returnFocus`，还的顺序是“打开前的元素 → 退路 → 留在 body” | 对 |
| L-3 | `canRefocus` 的 disabled、body 两个分支要有用例 | 新加 5 条单测；变异 D4（不看 disabled）、D5（不排除 body）都拦住了 | 对 |
| L-5 | webkit 并行时刷新以后装不上，查清原因、改成断言 | 查清是页面还没被 SW 接管就刷新了。现在刷新前先等 `serviceWorker.ready`，再断言页面已被 SW 接管、功能包已装上。webkit 4 个 worker 并行跑了 4 遍都过。`features.ts` 只改了注释，内容和诊断一致 | 对 |
| L-7 | 写清门槛为什么是 2 帧 | 只加了注释，理由充分 | 对 |

### 2.2 必改

- **M1（中）提前还焦点时，打开按钮还在 aria-hidden 里**
  - 原因：Radix `DialogContentModal` 的 `hideOthers(content)` 是只在挂载时跑一次的 effect（依赖为空），要等 Content 卸载才撤。我们给 Content 加了 forceMount，退场动画播的整段时间里，页面其余部分一直带着 `aria-hidden="true"`。
  - 实测（探针）：Esc 关上以后，焦点回到 `dialog-open`，但它在 aria-hidden 子树里。chromium 连续 16 帧（约 0.27 秒），webkit 8 帧，3 遍结果一样。
  - 后果：键盘用户受益了，读屏用户（iPhone VoiceOver）却可能听不到焦点回到了按钮。焦点落在被隐藏的元素上时，读屏不报；等 aria-hidden 撤掉，也不会补报。改动前是等卸载、aria-hidden 撤掉以后才还，读屏能报出来。所以这是 L-1 换来的一个退步，测试里也没有守着。
  - 改法（选一种，由主持人或前端 A 定）：
    - ① 卸载时（`restoreFocus`，这时 aria-hidden 已经撤了）如果焦点正停在提前还的那个元素上，就对它 `blur()` 再 `focus()`，让读屏重新报一次。
    - ② 关上那一刻让 Content 不再是 modal，让 hideOthers 提前撤掉（要验证退场动画和 inert 不受影响）。
    - ③ 保留现状，但写进 iPhone 实机验收清单，请人用 VoiceOver 确认能报出来。
  - 不管选哪种，都补一条 e2e 断言：焦点所在的元素不在 `[aria-hidden="true"]` 里。如果选 ①，就断言卸载以后不在里面。

### 2.3 returnFocus 对提醒接线那批够不够

- **RemindNotice**：点“确认移除”时，同一个点按里先 `setConfirm(false)`，`removeHolder` 再同步 `setRemove('removing')`，两次状态更新合在同一次提交里。所以提前还焦点的那一刻，打开按钮已经被禁用，焦点会走退路，落到说明段（`tabIndex=-1`）。等“重新接上”出现了，自己的 effect 再把焦点挪过去。路径是通的，`RemindSettings.test.tsx` 第 84 行有用例。
  - 剩一个边角：移除成功（`remove === 'ok'`）以后 InUse 整块卸掉，说明段跟着没了，焦点掉到 body。这一刻有 `role="alert"` 的结果文字会读出来，可以接受，记成低问题。
- **MissedReminders**：点“全部知道了”以后那一行没了，但 `tries > 0`，弹层组件还挂着，退路取 `main` 里的 `h1[tabindex="-1"]`，路径是通的。
- 结论：参数的形状（一个函数，在还焦点的那一刻才调）对两处都够用，不用再改。

### 2.4 低问题

| # | 问题 | 建议 |
|---|---|---|
| D-L1 | 变异 D2（去掉卸载时的补还）存活。jsdom 里被禁用的按钮不会失焦，“提前还的时候还不了、等卸载时才还得了”这条路径没有用例 | 补一条：关上时打开按钮被禁用，退场途中又恢复可用，卸载以后焦点在按钮上 |
| D-L2 | 变异 D6（关的途中用户已经把焦点放到别处，照样抢回来）存活，“不抢”这个分支没有用例 | 补一条：Esc 以后、卸载之前把焦点放到页面上另一个按钮，断言焦点没被抢走 |
| D-L3 | 变异 D7（退路排在打开按钮前面）存活。现有用例给退路的时候，打开按钮都处在还不了的状态 | 补一条：给了退路、打开按钮也正常，断言焦点回到打开按钮 |
| D-L4 | `giveBack` 调完 `focus()` 就算还成了。目标在 inert 里、被隐藏、或者是没有 tabIndex 的元素时，其实没聚焦上，也不会再试退路 | 改成看 `document.activeElement === el` 再返回 true |

## 三、第 2 批：REMIND-sub-low

### 3.1 各项原意对照

| 项 | 原意 | 现在 | 结论 |
|---|---|---|---|
| N1 | 直接打开二级页 → 进三层页 → 侧滑回来 → 点返回 → 前进 → 再点返回，会跳到首页 | 记号改成记“上一层的地址”。`entryAt` 记下本标签页每个深度现在是哪条地址；返回前对一下上一条，对不上就照样退一步，退到的那一条在 popstate 里原地换成上一层（这时 hashchange 还没派，不会先画出错的那一页） | 对。chromium、webkit 的 e2e 和单测都核对过：`history.length` 不变，再后退一次就是今天 |
| N2 | 入口晚出来时的焦点重试，会把用户已经挪走的焦点抢回来；R6、R14 没有测试 | 每次重试前先看 `focusIsFree()`：焦点在 body 上，或在 `tabIndex=-1` 的标题上，才挪。补了 R6、R14 的用例 | 对 |
| L7 | 快速连点入口会压两条历史 | 同一地址还在切换时，直接返回那一次的 Promise；回调里压之前再查一次地址 | 对。e2e 真浏览器验证过，同步连点两下只压一条 |

### 3.2 变异（12 个拦住 11 个）

- 拦住：R1（isSubEntry 恒真）、R2（popstate 里不换成上一层）、R3（连点不复用 Promise）、R4（回调里不再查地址）、R6（记号退回 true）、R7（replaceRoute 不记地址）、R8（三层页去掉 key，即原 R14）、S1（不看焦点是否被挪走）、S2（标题上的焦点不算空闲）。
- 存活：R5（hashchange 里不记地址）。在现有路径上近似等价：记的地址过时了只会让 isSubEntry 判成“对不上”，走的还是“退一步、落地再修正”那条路，落点照样对。

### 3.3 低问题（不阻塞）

| # | 问题 | 建议 |
|---|---|---|
| S-L1 | 刷新以后 `entryAt` 是空的，`isSubEntry` 只信记号，N1 那种走法中间刷新一次，照样会跳层。代码注释里写了这一点 | 记号是地址时，`backOrReplace` 一律挂上 popstate 修正（地址对得上时修正是空操作），刷新以后也不会跳层，还能省掉一个分支 |
| S-L2 | 修正用的 `{ once: true }` popstate 监听，只有 `goBack()` 真触发了 popstate 才会摘掉。理论上没派出 popstate 的话，它会留到之后某一次不相干的后退，把那一条换掉 | 修正里先比对一下“退之前的深度减 1”，或者设一个约 1 秒的超时自动摘掉 |
| S-L3 | `router-sub.test.ts` 依赖模块级的 `entryAt`，用例之间不清空，和用例顺序有关 | 导出一个只给测试用的 reset，在 beforeEach 里调 |

## 四、第 3 批：MOTION-wallclock-tests

- 改法和接手清单写的一样：appear-exit-from、features-async:107 改用 fake-frames 的假时钟按帧推；features-retry 在顶层先加载好 motion/react，等待改成 `advanceTimersByTimeAsync`。`fake-frames.ts` 没动。
- 原有断言没有放松：退场起点（两段关键帧，或者从当前值起播）、“重新进场还没播完”“退场在往下滑”“播完才卸载”“失败不 resolve 也不 reject”“下一次重新下载”都还在。
- 变异 5/5 拦住：A1（重新进场不清“停稳”）、A2（停稳后退场不用两段关键帧）、A3（冷挂上的不算停稳）、F1（失败后不清 pending）、F2（失败时 reject）。
- 稳定性：`src/motion` 3 份并发连跑，各 166/166。
- 低问题：
  - W-L1：features-retry 把 `vi.waitFor(loads === 1)` 换成了推完 30 ms 立刻断言。这靠的是 `advanceTimersByTimeAsync` 中间让出的真实宏任务够模块加载跑完，实测没红过；更保险的做法是这一句留着 `vi.waitFor`，它不受假时钟影响。
  - W-L2：features-async 第 69 行“还没到”那一组还有一处真时钟 `wait(50)`，不在这一条范围里，留给 L-6（冷列表按墙钟取样）一起处理。

## 五、范围外发现

- `b2-motion-list.spec.ts:318`（M2 撤销恢复，webkit）第一遍跑红了一次：松手后 261 ms，新行和“没有日期”组标题重叠了 16 px。单独重跑 3 遍都过。这批对它只改了注释，不是这批引起的；但同一时期工作区里有 K8 的 `--dock-bottom`、`TodosPage.module.css` 改动，请这批的负责人留意是不是偶发。

## 六、文件清单

- 第 1 批：`src/kit/components/Dialog.tsx`、`src/kit/components/__tests__/Dialog.test.tsx`、`src/motion/features.ts`（只改注释）、`tests/e2e/b2-motion-focus-retry.spec.ts`、`tests/e2e/b2-motion-list.spec.ts`（只改注释）；核对过的使用方：`src/features/reminders/ui/RemindNotice.tsx`、`MissedReminders.tsx`、`MissedSheet.tsx`
- 第 2 批：`src/app/router.ts`、`src/features/settings/ui/SettingsPage.tsx`、`src/app/__tests__/router-sub.test.ts`、`src/features/settings/__tests__/settings-sub-low.test.tsx`、`tests/e2e/b2-settings-sub-low.spec.ts`
- 第 3 批：`src/motion/__tests__/appear-exit-from.test.tsx`、`features-async.test.tsx`、`features-retry.test.ts`
- 审查用的副本、脚本和结果都在本会话 scratchpad：`mut-b2dlg/`、`mut-b2dlg-run.mjs`、`mut-b2dlg-result.txt`、`e2e-b2dlg/`（含探针 `tests/e2e/zz-probe-ariahidden.spec.ts`）、`e2e-b2dlg-result.txt`

## 七、第 1 批复审（11-05 晚，同一位审查员，同一尺度）

### 7.1 上一轮意见逐条核对

| 项 | 上一轮 | 现在 | 结论 |
|---|---|---|---|
| M1 | 提前还焦点时，打开按钮还在 aria-hidden 里 | 采用主持人定的第一种改法：提前还到的元素记在 `early`；卸载时（`onCloseAutoFocus`，这时 hideOthers 已经撤了）焦点还在它上面，就 `blur()` 再 `focus()` 一次。e2e 新加两条断言：卸载以后焦点不在 aria-hidden 里；打开按钮最后一次收到 focus 事件时，它已经不在 aria-hidden 里 | **已解决**。副本变异“不补报”被单测拦住；前端 A 自报 e2e 模拟“不补报”也拦得住 |
| D-L1 | 卸载时补还那条路径没有用例 | `Dialog-focus-return.test.tsx`：按钮在退场途中恢复可用，卸载时补还给它 | 已解决（变异 D2 拦住） |
| D-L2 | “不抢”分支没有用例 | 补了卸载这一侧的“不抢回”用例 | 部分解决：关上那一刻 effect 里的“焦点在别处就不动”那一行，去掉了还是存活。真实界面里 modal 弹层开着时，焦点很难跑到弹层外面，所以近似防御代码，降为低问题，不阻塞 |
| D-L3 | 退路优先级没有用例 | 补了“给了退路、打开按钮也正常，焦点回到打开按钮” | 已解决（变异 D7 拦住） |
| D-L4 | `focus()` 没生效也算还成了 | 改成看 `document.activeElement === el` 才算还成，不然接着试退路，有用例 | 已解决（变异拦住） |

### 7.2 验证

- 单测：`Dialog.test.tsx`、`Dialog-focus-return.test.tsx`、`RemindSettings.test.tsx` 在主仓库跑 32/32 过。
- 变异（副本 `mut-b2dlg`，脚本 `mut-r2.mjs`）：6 个里拦住 5 个（不补报、不核对聚焦、卸载时不补还、退路优先、不提前还），存活 1 个（effect 里的“不抢”，见上表 D-L2）。
- e2e：我这边 9198、9199 一直被别的会话占着，等了一会儿还是起不来假后端，**这一轮没有亲自跑 e2e**。e2e 结果用的是前端 A 自报的：chromium、webkit 各 2 遍，共 16 条全过，模拟“不补报”能拦住。
- 第五节 `b2-motion-list.spec.ts:318`：前端 A 在 HEAD cfa142d 的构建上也复现了（webkit 4 个 worker 20 遍红 17 遍），说明是已提交的 FA-5 老问题，不是这批引起的。同意单独登记。

### 7.3 分数

- 第 1 批：**8.5，通过**。
- 剩下的低问题（不阻塞）：effect 里“不抢”那一行没有测试守着；`blur()` 再 `focus()` 会给打开按钮多派一次 blur 和 focus 事件，现在的使用方都不监听这两个事件，以后有人加 onBlur 时要注意。
