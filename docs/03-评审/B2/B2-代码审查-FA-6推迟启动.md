# B2 代码审查：FA-6 首屏减重 ① 第二步（推迟启动工作到首屏画完以后）

- 审查日期：2026-11-04
- 审查员：独立代码审查（只读，默认不通过）
- 范围：`src/platform/first-paint.ts`（新）、`src/app/main.tsx`、`src/platform/session.ts`、`src/platform/__tests__/first-paint.test.ts`（新）。
  告知页快读（consent-api.ts 等）只看和启动顺序的交互；App.tsx、reminders、motion、account-purge 不在范围内。

## 结论

**总分：7 / 10，不通过。**

`first-paint.ts` 本身写得干净：只挂一次、4 秒兜底从挂上起算、兜底计时器在“看到页面、等一帧”期间不清（隐藏标签页 rAF 不触发时也能放行）、回调互不影响、没挂过时当场执行（登录页、测试不受影响）。
本机写入、outbox、realtime 补拉这几条主路径推迟以后没有丢数据（见下面“逐项核对”）。

不通过的原因有两条中等问题：
1. 新加的 `await appPainted()` 打开了一个最长 4 秒的新窗口，窗口里可能已经在换账号、退出，但后面的设备登记、推送认领、SW 注册没有再看 `boot.switching`；
2. 测试拦不住入口接线的回退：删掉 `await appPainted()`、删掉 `watchAppPainted(...)`、把 session.ts 改回直接 `whenIdle`，三个变异全部存活。

---

## 高

无。

## 中

### M1　`await appPainted()` 之后没有再检查 `boot.switching`，换账号、退出过程中仍会登记设备、认领推送

- 位置：`src/app/main.tsx:202`（新加的 await）；受影响的是 `main.tsx:206-214`（createDeviceRegistrar）、`main.tsx:234-237`（setPushClaimContext）、`main.tsx:241-251`（registerServiceWorker → runPushClaim）。
  对照：同一个函数里 `main.tsx:184` 有 `if (boot.switching) return;`，那是 render 之前唯一一次检查。
- 场景：以前 render 和 wireSync 之间只有同步代码，`watchAccount` 不可能插进来。现在中间隔着一个最长 4 秒的 await（今天页分包慢、整屏提示、告知页关口空白都会拉长）。这段时间里：
  - 别的标签页退出或换了账号（storage 事件），或者本页收到 SIGNED_OUT → `watchAccount` 设闸（`boot.switching = true`、封库），
    按 FE-2 调 `disconnectBrowserPush()`：删认领记录、**退订推送**；
  - 然后 `appPainted()` resolve，main 继续往下：`wireSync` 自己看了 switching 会返回 null（没问题），但
    `setPushClaimContext({ userId: 旧账号 … })` 照样把上下文设回旧账号，`runPushClaim()` 走 `subscribePush` **重新订阅了刚退订的推送**，
    认领请求用的是 `transport`（当前会话令牌，可能已经是别的标签页刚登录的新账号）和 `readSessionId()`（新会话）。
    目前多半在 `ensureDevice` 那一步因为库已封存（`setMeta` 抛 CacheClosedError）回 `device_pending`，不会真的认领到错的账号，
    但这是碰巧挡住的：FE-2“换账号、退出时退订旧订阅”的保证被打破（浏览器里又多出一个订阅），推送状态也写回了旧账号的结果。
  - 设备登记 `createDeviceRegistrar` 同样拿着封存、即将删除的库和新会话的令牌在跑。
- 和原来比：原来这个窗口实际为零，是这次改动引入的退步。
- 建议改法：在 `main.tsx:202` 的 `await appPainted();` 后面紧跟一行
  `if (boot.switching) return;`
  （和 184 行同一种写法）；并补一条源码文字测试（同 `splash-release.test.tsx`、`log-channel.test.ts` 的做法），
  核对 `await appPainted()` 之后、`createSupabaseTransport()` 之前有这道检查。

### M2　入口接线没有测试，三个回退变异全部存活

- 位置：`src/app/main.tsx:113`（`watchAppPainted(el, nextFrame)`）、`src/app/main.tsx:202`（`await appPainted()`）、`src/platform/session.ts:172`（`afterAppPainted(() => whenIdle(...))`）。
- 场景：`first-paint.test.ts` 只测模块本身。这次改动真正要守住的是“同步、设备登记、SW 注册、supabase-js 预加载排在首屏之后”，
  任何一处被人改回去，`npx vitest run src/platform src/app` 都还是 774 条全绿（见下面变异 1～3）。
  反过来，如果有人把 `watchAppPainted` 挪到 `return` 之后或者删掉、只留 `await appPainted()`，也没有测试发现
  （那时 `afterAppPainted` 当场执行，功能上退回老行为，不会卡死，但优化悄悄没了）。
- 建议改法：
  1. 在 `src/app/__tests__/` 加一条源码文字核对（main.tsx 一 import 就启动，现有几条测试都是这么做的）：
     `watchAppPainted(el, nextFrame)` 出现在 `createRoot(el).render` 之前、`readSessionUserId()` 之前；
     `await appPainted()` 出现在 `render` 之后、`createSupabaseTransport()`、`wireSync(`、`registerServiceWorker()`、`setPushClaimContext(` 之前；
     后面紧跟 `if (boot.switching) return;`（M1）。
  2. 给 `onAuthUser` 加一条行为测试：`watchAppPainted` 挂上、还没画完时，`getSupabase` 没被调；画完（放行那一帧）且空闲后才调。
     现在 session.ts 里改回直接 `whenIdle` 没有任何测试会挂（变异 3）。

### M3　非主页标签页：推迟期间主页发来的 `changed` 提醒收不到，启动后也不补读

- 位置：`src/app/sync-wiring.ts:254-256`（`createTabLeader` 在 wireSync 里才建）、`sync-wiring.ts:242-252`（outbox 提醒、回前台兜底）；窗口由 `src/app/main.tsx:202` 拉长。
- 场景：已经有一个标签页在当主页同步，再开第二个标签页（或 exe 和网页同时开）。第二页 coldStart 把本机库灌进集合以后，
  到 wireSync 建 BroadcastChannel 之前，主页写了本机库（别的设备经 Realtime 来的改动、主页上用户的操作）发出的 `changed` 第二页收不到；
  wireSync 起来以后，非主页不做任何补读，只有等到“切到后台再切回来”（`life.onVisibility`）或下一次 `changed` 才重读。
  这段时间第二页显示的是旧内容，用户在旧内容上编辑可能撞冲突（数据本身不丢：本机写走 outbox，服务器有版本冲突处理）。
  同一窗口里第二页自己的写入不会发 `outbox` 提醒（`outbox.subscribe` 也是 wireSync 里才挂），主页要等每 30 秒一次的定时发送才发出去。
  这个缝原来就有，但只有几毫秒到几十毫秒；现在最长 4 秒，典型是今天页分包下载的时间。
- 主页这一侧没问题：引擎 `start()` 会 `kickSend()` + `pullAll()`（`src/core/sync/engine.ts:279-290`），按 lastPullAt 补拉，Realtime 晚连上也补得回来。
- 建议改法（任选其一）：
  - wireSync 建好 leader 以后，如果本页不是主页，马上做一次 `outbox.refresh()` + `reloadCollections(cache, null)`（和回前台兜底同一段代码），并 `leader.post({ type: 'outbox' })` 一次；
  - 或者把 `createTabLeader` 的“只收消息”那一半提前到 render 之前挂（lead 仍在画完后才允许），推迟的只是 supabase-js 相关的部分。

## 低

### L1　4 秒兜底从 `watchAppPainted` 挂上就开始算，冷启动慢时推迟直接失效

- 位置：`src/platform/first-paint.ts:38`；`src/app/main.tsx:113`（挂在 `coldStart` 之前）。
- 场景：本机库迁移、IndexedDB 慢、升级被别的标签页挡住（`CacheBlockedScreen`，可能挡几十秒）时，coldStart 自己就超过 4 秒，
  render 之前 `done` 已经是 true，`await appPainted()` 当场放行，supabase-js 又和今天页分包同时下载——正好是最需要减重的慢设备上没效果。
  不影响正确性（同步一定会起），只影响这次优化的效果。
- 建议：兜底时间改成从 render 之后算（例如 `watchAppPainted` 只登记 root 和 MutationObserver，计时在 render 后由入口调一次 `startPaintLimit()` 开始），
  或者把限额拆成“挂上后最长 N 秒 + render 后最长 4 秒”。另外注意告知页关口最长空白 5 秒（`root.tsx:51` 的 `GATE_LIMIT_MS`）大于这里的 4 秒，
  关口慢时同步会在关口还空白时起，也说明一下取舍。

### L2　“隐藏标签页里 rAF 不触发、只能靠兜底放行”这条路没有测试

- 位置：`src/platform/first-paint.ts:39-46`；测试 `src/platform/__tests__/first-paint.test.ts`。
- 场景：现在的实现是对的——看到功能页后不清兜底计时器，要等那一帧真跑了才清。但如果有人“顺手”在 `seen()` 里 `clearTimeout(timer)`，
  后台打开的标签页、exe 开机自启藏在托盘时 rAF 一直不跑，同步、设备登记、SW 注册就**永远不启动**。变异 5 证明现有 6 条测试拦不住这个改法。
- 建议：加一条测试：功能页已出现、`nextFrame` 排进去但从不执行，`advanceTimersByTime(4000)` 后回调执行。

### L3　推迟窗口里在设置 › 提醒点“打开通知 / 重新接上”会回 `claim_failed`

- 位置：`src/platform/push-claim-run.ts:48`（上下文为空回 claim_failed）；`src/app/main.tsx:234` 现在在 await 之后才设上下文。
- 场景：冷启动直接落在设置页（或首屏画完前用户就点进设置），4 秒内点按会提示认领失败。概率低，结果是“稍后重试”的提示，不会认领错账号。
- 建议：`setPushClaimContext` 不依赖 supabase-js 下载（只存函数），可以挪到 await 之前；真正发请求时 transport 才会去加载。
  但要和 M1 一起考虑：挪到前面以后，换账号时 watchAccount 的流程需要能把它设回 null（现在也没人设 null，见 push-claim-run.ts 文件头说“退出、换账号时设 null”，实际 grep 只有 main.tsx 一处调用，建议核实）。

### L4　会话被撤销、账号被停用的发现时间推后最多约 4 秒

- 位置：`src/app/main.tsx:202`、`src/platform/session.ts:172`。
- 场景：本机缓存的内容本来就是 render 时先画出来的（改动前后一样）；撤销、停用要靠同步引擎刷新令牌 / outbox 发送的回包，或 supabase-js 初始化时的 SIGNED_OUT 来发现。
  现在这几件都等首屏画完，发现时间多出“今天页分包下载”那一段，最长 4 秒。原来也要先下载 supabase-js（约 53 KB gzip）才能发现，实际多出的时间通常是几百毫秒。
  告知页快读不走 supabase-js、不检查会话是否被撤销（只看 JWT 没过期），这一点已由安全审查覆盖，这次没有让它变差。
- 结论：轻微退步，可以接受；建议在 `main.tsx:200` 的注释里写明“撤销、停用的发现最多推后 4 秒，缓存内容本来就先画”这一取舍，免得以后的审查重复问。

### L5　设备登记推后：新会话第一次打开时“已登录设备”里暂时没有本机这一行

- 位置：`src/app/main.tsx:208-214`。
- 场景：只影响全新会话的前几秒（原来也要等拿到同步锁、请求回来）；“退出其他设备”“会话被撤销”的判断按服务器会话走，不依赖本机设备行，不受影响。report_tz 跟着推后，无害。
- 结论：可接受，不用改。

### L6（范围外，供参考）　`app-remind-host.test.tsx` 在整组并行时不稳

- `npx vitest run src/platform src/app` 两次里有两次挂在 `src/app/__tests__/app-remind-host.test.tsx:265`（`expect(clear).toHaveBeenCalledWith(CAP_ID)`，该文件用时 13.6 秒），单独跑 11 条全过。
  这个文件和 App.tsx 是别人的改动，和这次推迟无关（App.tsx 不引用 first-paint）；记在这里，免得被误判成这次改动造成的。

---

## 逐项核对（审查要点 1～6）

1. **丢数据、丢事件**
   - 首屏画完之前的打勾、编辑：走本机库 + outbox（coldStart 里已建好），不依赖同步引擎；引擎 `start()` 时 `resetInflight` → `kickSend` → `pullAll`，积压的一次发出。**不丢。**
   - outbox 的 `removed` / `disabled` 事件只在发送时产生，发送只有引擎做，引擎起来之前不会有事件，`wireSync` 里晚挂 `outbox.onEvent` 不会漏。
   - Realtime 晚连：主页 `pullAll` 按 lastPullAt 补拉，连上时 `firstUp` 合并补拉。**补得回来。**
   - 非主页标签页的 `changed` 提醒：见 M3。
2. **不画功能页的情况**
   - 登录页：`src/auth/main.tsx` 不挂 watchAppPainted，`afterAppPainted` 当场执行；`main.tsx` 没登录分支在挂上之后 `goToAuth()` 离开，4 秒兜底到点无害。
   - exe 退出画面（`mountExitScreen`）：在 `watchAppPainted` 之前就 return，没人等。
   - 告知页关口：ConsentPage 是 `main[data-feature="onboarding"]`，算画完；关口空白期由 4 秒兜底兜住（L1）。
   - 离线：直接画 App，今天页出现即画完。
   - CacheTooNewScreen、CacheBlockedScreen、崩溃兜底页：没有 `main[data-feature]`，靠 4 秒兜底。
   - 换账号：`boot.switching` 在 render 前 return，不等；在等的期间换账号见 M1。
   - 隐藏标签页 / 托盘启动：rAF 不跑，兜底计时器没被清，4 秒（后台节流后约 4～5 秒）放行。实现正确，但没测试（L2）。
   - **结论：所有路径上 4 秒兜底都生效，不会永远不 resolve。**
3. **SW 注册推迟**：`watchServiceWorkerUpdate` 挂上时会看 `reg.waiting`（`sw-register.ts:43`），推迟期间装好的新版本不会漏提示；
   升级中心的 `updateServiceWorker` 用的是已有注册，不受影响；version_too_new 那条路仍在 render 前注册（`root.tsx:98`）。推送认领见 M1、L3。
4. **设备登记推迟**：见 L5；换账号窗口见 M1。
5. **会话安全**：见 L4（轻微退步，可接受）；M1 是窗口里对已失效账号继续做副作用。
6. **测试能否拦住回退**：模块内部的变异 4 个里拦住 4 个；入口接线 3 个变异全部存活；隐藏标签页兜底 1 个变异存活。见 M2、L2。

---

## 跑过的命令和结果

| # | 命令 | 结果 |
|---|------|------|
| 1 | `git status --short`、`git diff --stat`、`git diff src/app/main.tsx src/platform/session.ts src/core/upgrade.ts` | 看改动范围 |
| 2 | PowerShell：`$env:TZ='Asia/Seoul'; npx vitest run src/platform src/app` | 76 个文件 773 过、1 挂（`app-remind-host.test.tsx:265`，范围外，见 L6） |
| 3 | `npx vitest run src/app/__tests__/app-remind-host.test.tsx`（单独） | 11 条全过 |
| 4 | `npm run typecheck`（app、sw、shared、functions、node 五个 tsconfig） | 通过，0 错误 |
| 5 | `npx eslint src/platform/first-paint.ts src/app/main.tsx src/platform/session.ts src/platform/__tests__/first-paint.test.ts` | 无输出，通过 |
| 6 | PowerShell 复跑第 2 条 | 同样 1 挂（同一条，范围外） |

### 变异验证

改之前把三个文件备份到临时目录，每个变异跑完立即按备份原样复制回去；最后核对 SHA-256 与改前一致：

- `src/app/main.tsx` 5FFCFEC10E7B18E98B54C497352A08CE709EDBD9D76F4D324CA46454E103B759
- `src/platform/session.ts` 370DFDB7F31A68BBECC5943D4CCDD5C80588151B4A752431ED2E80A56E028E9E
- `src/platform/first-paint.ts` 36AE9636A28A29897CE1B6E5149F0FD679390672793B36959DED2977816A3538

| # | 变异 | 跑的测试 | 结果 |
|---|------|----------|------|
| 1 | 删掉 `main.tsx` 的 `await appPainted();` | `src/platform src/app`（774 条） | **全过，存活** |
| 2 | 删掉 `main.tsx` 的 `watchAppPainted(el, nextFrame);` | 同上 | **全过，存活** |
| 3 | `session.ts` 改回 `whenIdle(...)`，不经 `afterAppPainted` | 同上 | **全过，存活** |
| 4a | `first-paint.ts` 兜底计时器改成空操作 | `first-paint.test.ts` | 1 挂，拦住 |
| 4b | 看到功能页就 `finish()`，不等一帧 | 同上 | 4 挂，拦住 |
| 4c | 选择器放宽成 `main, div` | 同上 | 1 挂，拦住 |
| 4d | 没挂过也排队（去掉 `!armed`） | 同上 | 1 挂，拦住 |
| 5 | `seen()` 里提前 `clearTimeout(timer)`（隐藏标签页会永远不放行） | 同上 | **6 条全过，存活** |

注：变异 1～3 和 4、5 用 Git Bash 跑，`TZ` 传不到 Windows 版 node；这几条测试与时区无关，不影响结论。

## 通过条件（复审时核对）

1. M1：`await appPainted()` 后加 `if (boot.switching) return;`，有测试守着。
2. M2：入口接线的源码核对测试 + `onAuthUser` 的行为测试；复跑变异 1～3 必须挂。
3. M3：非主页启动后补读一次（或提前挂收消息），有测试。
4. L2 建议一起补（变异 5 必须挂）。

---

## 复审（2026-11-04，同一审查员，同一尺度）

**总分：7.5 / 10，不通过。** 上一轮的 M1、M2、M3、L1、L2、L4 都已解决，L6 这次没再出现。
但 M3 的修法引出一条新的中等问题（N1，已用探针复现）。L3 按主持人安排这一轮不看。

### 逐条复查上一轮意见

| 编号 | 结论 | 核对依据 |
|------|------|----------|
| M1 | **已解决** | `src/app/main.tsx:210` 的 `await appPainted();` 后紧跟 `if (boot.switching) { setPushClaimContext(null); return; }`（214-217 行；`setPushClaimContext(null)` 属于 L3，这次不评）。`createSupabaseTransport`、`createDeviceRegistrar`、`wireSync`、`setPushClaimContext`、`registerServiceWorker().then`、`runPushClaim` 都在检查之后（221-266 行）。变异 R2（检查改成 `if (false)`）被 `first-paint-wiring.test.ts` 拦住。遗留：`registerServiceWorker().then` 里的 `runPushClaim` 本来就是异步的，then 回调执行前又换账号的窗口是改动前就有的，不算这次的问题 |
| M2 | **已解决** | 新增 `src/app/__tests__/first-paint-wiring.test.ts`（源码顺序核对 5 条）和 `src/platform/__tests__/session-first-paint.test.ts`（行为 2 条）。我自己在独立副本里复跑上一轮存活的三个变异：删 `await appPainted()`（R1）、`session.ts` 改回直接 `whenIdle`（R3）都被拦住；删 `watchAppPainted` 由前端 A 的 M2-2 覆盖（日志 `mut-result.txt`），我读过对应断言（wiring 测试第 27-31 行），认可 |
| M3 | **已解决，但引出 N1** | `src/app/sync-wiring.ts` 频道建好后补读一次，非主页且有待发的才提醒主页；`sync-tabs.test.ts` 加 2 条。变异 R8（去掉补读）、R9（不看待发数）被拦住；R10（不看是不是主页）、R11（不看换账号闸）存活，见 N2 |
| L1 | **已解决** | `first-paint.ts` 分两段：挂上时 15 秒长兜底（`APP_PAINT_BACKSTOP_MS`），render 后 `startAppPaintLimit(GATE_LIMIT_MS + 1000)` 共 6 秒，比告知页关口的 5 秒多 1 秒。变异 R5（时限不生效）、R6（长兜底缩成 4 秒）被拦住。CacheBlockedScreen 挡住超过 15 秒时长兜底先放行，退回老行为，可以接受 |
| L2 | **已解决** | `first-paint.test.ts` 补到 11 条；变异 R4（`seen()` 里提前清兜底）被拦住 |
| L3 | 本轮不看 | 主持人安排，等前端 A 改完再补审 |
| L4 | **已解决** | `main.tsx:209` 注释写明了取舍 |
| L5 | 本来就是“可接受，不用改” | 主持人说的“L5：快读组 e2e”和我上一轮的 L5（设备登记推后）不是同一件事。按规矩我没跑 e2e，只读了日志：`fastread-e2e.log` 8 条全过（chromium、webkit 各跑两遍），`fa6b-e2e-all.log` 178 过、36 跳过。日志的结论我照录，没有亲自复现 |
| L6 | 这次没出现 | 共享工作区 `src/platform src/app` 794 条全过 |

**关于 eslint：** 上一轮的审查记录和回报都没说过 `main.tsx:49` 有 eslint 报错，上一轮写的是“eslint 无输出，通过”。这次在共享工作区重新跑了 8 个相关文件，退出码 0、没有输出，和前端 A 看到的一致。可能是转述的时候混了，这一条不成问题。

### 新问题

#### N1（中）　频道建好后的补读在主页上也跑，会把补读期间本机新增或更新的行从内存里删掉、覆盖回旧值

- 位置：`src/app/sync-wiring.ts` 新增的那段补读（`leader = make(...)` 之后的 `if (!boot.switching) { … reloadCollections(cache, null) … }`）；根子在 `src/core/sync/reload.ts:11-17`。
- 机理：`reloadCollections` 对每张表先 `await cache.allRows(table)` 拿到库里的快照，然后用**那一刻的内存快照**算 `gone`（内存里有、库快照里没有的就删），再把库快照里的 view 一律 upsert 回去。
  如果在 await 期间有一次本机写入（`outbox.enqueue` → 事务提交 → `notify` 把新行推进内存，`outbox-rows.ts:10-16`），或者主页引擎的首轮拉取（`applyServerRows`，同样是先提交再 `notify`）提交了：
  - 新增的行在库快照里没有、内存里有 → 被 `gone` 当成“已删”从内存里删掉；
  - 更新过的行被库快照里的旧 view 覆盖回去。
  库和 outbox 里的数据没丢，但界面上这一行消失或回退，要等这一行下次再被 `notify`（发送成功的回执、下一次拉取）才回来。**离线时会一直不回来，直到重新打开。**
  主页没有“回到前台整份重读”的兜底（那条只给非主页）。
- 为什么是这次引出来的：这个竞态在非主页的 `changed`、回前台重读里原来就有，但那两条只在非主页、而且要有触发才跑。现在**每个标签页每次冷启动都跑一次，包括主页**，时机正好是首屏刚画完：用户开始点、引擎 `start()` 的 `pullAll` 也在同时写库。
- 复现：在独立副本里写了一条临时探针测试（跑完已删）。用假主页（`isLeader: () => true`）跑 wireSync，让 `todos` 的 `allRows` 读完后停住；这时 `outbox.enqueue` 插一条 todo，确认它已经在内存里，再放行补读。结果：
  `AssertionError: 补读把刚加的一行从内存里删了: expected undefined to be truthy`。
  探针用人为延时把窗口放大了；真实窗口是每张表一次 IndexedDB `getAll` 的时间，表大时几十到上百毫秒。
- 建议改法（任选，推荐第一种，顺带修好原有的两条路）：
  1. 修 `reloadCollections`：await 之前先记下内存快照（id → 对象引用）；await 之后只删“读之前就在、读完也没变”的行，只 upsert 内存里那一行还是读之前那个对象（或者原来就没有）的行。读的期间被 `notify` 动过的行，以内存为准。
  2. 或者主页不做这次补读：补读放到确认不是主页以后再做（例如 tab-leader 拿锁失败的回调里），主页交给引擎的 `start()`（`kickSend` + `pullAll`）。
  无论选哪种，都把上面的探针整理成正式测试，主页、非主页各一条。

#### N2（低）　补读的两个分支条件没有测试

- 变异 R10（提醒主页前不看 `!leader.isLeader()`）、R11（补读不看 `boot.switching`）都存活。
  - R10 的后果小：主页给自己发 `outbox` 提醒，BroadcastChannel 不回送给自己，别的非主页收到也会忽略。
  - R11 的后果是：换账号清库期间补读可能把旧账号的行重新灌进刚清空的内存集合。页面随后会重新载入或回登录页，但这段时间旧账号的内容可能又闪一下。`reloadCollections` 只看 `cache.isClosed()`，封存但还没关库时照样读。
- 建议：`sync-tabs.test.ts` 各补一条：换账号中（`boot.switching = true` 后再 wireSync，或 wireSync 后马上设闸）不补读、内存集合保持清空；本页是主页时不发 `outbox`。

#### 等价变异（不算问题）

- R7（`finish()` 里不清 render 后的计时器）存活：`finish` 本身只执行一次，计时器到点也什么都不做，行为没变，不要求补测试。

### 复审跑过的命令和结果

| # | 命令（共享工作区，只读） | 结果 |
|---|------|------|
| 1 | `git diff src/app/main.tsx src/platform/first-paint.ts src/app/sync-wiring.ts src/platform/session.ts`，读新增的 3 个测试文件和 sync-tabs 的改动 | 核对改法 |
| 2 | `npm run typecheck` | 通过 |
| 3 | `npx eslint` 8 个相关文件（first-paint.ts、main.tsx、session.ts、sync-wiring.ts 和 4 个测试） | 退出码 0，无输出 |
| 4 | PowerShell：`$env:TZ='Asia/Seoul'; npx vitest run src/platform src/app` | 78 个文件、794 条全过 |
| 5 | 读日志：`mut-result.txt`、`fa6b-full-2.log`（446 个文件过、3 跳过，6287 条过）、`fa6b-e2e-all.log`（178 过、36 跳过）、`fastread-e2e.log`（8 过） | 照录，没有亲自复现 |

变异验证：只在独立副本里做，没有改共享工作区源码。副本位置：
`C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\fa6-rev2`
（robocopy 复制，排除 node_modules、dist、.git；node_modules 用联接）。复制时 main.tsx、first-paint-wiring.test.ts、push-claim-run.ts、sync-wiring.ts、first-paint.ts 已逐个和工作区比对，完全一致。
脚本 `fa6-rev2-mut.py` 每个变异跑完就按原字节写回，并用 SHA-256 断言还原。跑 4 个测试文件（first-paint、session-first-paint、first-paint-wiring、sync-tabs），基线 26 条全过。前后跑了两遍，结果一致：

| # | 变异 | 结果 |
|---|------|------|
| R1 | 删 `await appPainted()` | 拦住（wiring 测试文件整体挂） |
| R2 | await 后的换账号检查改成 `if (false)` | 拦住，2 条挂 |
| R3 | session.ts 改回直接 `whenIdle` | 拦住，2 条挂 |
| R4 | `seen()` 里提前清长兜底 | 拦住，1 条挂 |
| R5 | `startAppPaintLimit` 空操作 | 拦住，3 条挂 |
| R6 | 长兜底缩成 4 秒 | 拦住，2 条挂 |
| R7 | `finish` 不清 render 后的计时器 | 存活（等价变异） |
| R8 | 去掉频道建好后的补读 | 拦住，2 条挂 |
| R9 | 补读后不看待发数，一律提醒 | 拦住，1 条挂 |
| R10 | 补读后不看是不是主页 | **存活**（N2） |
| R11 | 补读不看换账号闸 | **存活**（N2） |
| 探针 | 主页补读期间本机新增一行 | **复现 N1**（探针文件已删） |

注：变异日志 `fa6-rev2-mut.txt` 里的中文标签被控制台编码弄乱了，结果按上表的顺序一一对应。

### 复审通过条件

1. N1：按建议修好补读竞态，探针整理成正式测试（主页、非主页各一条），修好以后探针必须过。
2. N2：补 R10、R11 对应的测试，复跑必须挂（建议一起做）。
3. L3：前端 A 改完以后补审。

---

## 第三轮复审（2026-11-04，同一审查员，同一尺度；含 L3 补审）

**总分：8.5 / 10，通过。** N1、N2 已解决，L3（方案 A）和安全复审的 L6 补审通过。没有新的高、中问题，剩两条低问题（N3、N4），不挡合并。

### 逐条复查

| 编号 | 结论 | 核对依据 |
|------|------|----------|
| N1（中） | **已解决** | `src/core/sync/reload.ts:17-29`：读库前对每张表记下 `before`（id → 对象引用）；读完只删“读前就在、库里没有了、内存里还是同一个对象”的行，只写回“内存里还是读前那个对象（或读前读后都没有）”的行。这依赖集合 `get` 返回存进去的那个对象引用，已核对 `src/core/store.ts:45` 是 `byId.get(id)`，成立。清库是先清 IndexedDB、再 `clearAllCollections`（`account.ts:309-310`），和这套判断不冲突。正式测试 `src/app/__tests__/sync-reload-race.test.ts` 覆盖主页、非主页的插入、patch、读库期间移出、读库期间替换，外加“无并发照旧删改”一条；上一轮我的探针场景已包含在内。变异 N1-a、b、c 都被拦住 |
| N2（低） | **已解决** | `src/app/sync-wiring.ts` 补读在建频道时、`outbox.refresh()` 回来后各看一次闸，提醒主页前看 `!leader.isLeader()`。`sync-tabs.test.ts` 补了“主页不提醒”“建频道时设闸”“wireSync 刚返回时设闸”。上一轮存活的 R10、R11 对应变异 N2-c、N2-b，这次都被拦住；新加的 refresh 后那道闸（N2-a）也被拦住 |
| L3（低） | **补审通过** | `src/platform/push-claim-run.ts`：`expectPushClaimContext()` 以后、`setPushClaimContext()` 之前，`runPushClaim()`（不传参）最多等 `PUSH_CLAIM_WAIT_MS`（10 秒）。到点或被设成 null 回 `claim_failed`，等的时候不调 `ensurePushSubscription`（不碰订阅）；显式传参的照旧不等。`main.tsx:187` 在 render 前那道换账号检查之后调 `expectPushClaimContext()`；`main.tsx:215-218` 换账号时 `setPushClaimContext(null)`，等着的认领立刻失败。<br>从 187 行到 249 行设上下文，中间只有换账号那一个 return，`appPainted()` 一定会放行（长兜底），所以不会有“说了马上会设、却永远不设”；`start()` 中途抛错时最多白等 10 秒，然后回 claim_failed，可以接受。<br>设置页点按等上下文的同时，启动认领随后也会跑，两者在 `lemo-push-claim:<userId>` 锁里串行，后一个读到“已认领”记录就不再调，不会重复认领。<br>变异 L3-a、b、c、e、f 都被拦住 |
| 安全复审 L6 | **补审通过** | `main.tsx:215`：`if (boot.switching \|\| readSessionUserId() !== userId)`，await 期间别的标签页换成了别的账号、但 watchAccount 还没设闸时，也不再用新会话的令牌替旧账号登记设备、认领推送。会话变成 null（别的标签页退出）同样 return，后续由 watchAccount 的 storage 监听接手。变异 L6 被拦住 |

### 新的低问题（不挡合并）

#### N3（低）　`reloadCollections` 按表循环，循环中途才设上的换账号闸只在循环开头看 `cache.isClosed()`

- 位置：`src/core/sync/reload.ts:16-17`。
- 场景：补读正在逐表读库时，watchAccount 或 wipeOnRemoved 设了闸。封存的库照样能读，关库要等清完才发生。某张表如果“读之前内存就是空的”（`before` 为空），读完以后 `untouched` 恒为真，晚到的旧库快照会在 `clearAllCollections` 之后被写回内存。
  影响只是页面跳走（回登录页、重新载入）之前旧账号的行在内存里多留几毫秒；别的表读前有行、清内存后对象引用已经变了，不会写回。
- 建议（可选）：`reloadCollections` 加一个 `stop?: () => boolean` 参数，每张表 `await` 之后看一次。sync-wiring 的三处调用都传 `() => boot.switching`。

#### N4（低，原来就有）　push-claim-run 的文件头说“退出、换账号时 setPushClaimContext(null)”，实际只有启动等待期那一处

- 位置：`src/platform/push-claim-run.ts:5`。全仓只有 `main.tsx:216` 一处 `setPushClaimContext(null)`；设置页退出（`platform/sign-out.ts`）、运行中被移除都不设 null。
- 影响：这两种情况页面都会离开（整页跳转或重新载入），模块状态随之没了，实际无害；只是注释比实现说得多，以后有人依赖这句话会出错。
- 建议：改注释，写成“启动等待期间换账号时设 null；其余退出流程靠整页离开清掉”；或者在 sign-out、wipeOnRemoved 的回调里也调一次。

### 等价变异（不要求补测试）

- N1-d（`gone` 改成从当前快照取 id）：后面还过滤了 `before.get(id) !== undefined && untouched(id)`，结果集合完全相同。
- L3-d（`setPushClaimContext` 不清 `expecting`）：设了非 null 以后 `ctx !== null` 先短路；设 null 只发生在页面马上离开的换账号分支。

### 第三轮跑过的命令和结果

| # | 命令（共享工作区，只读） | 结果 |
|---|------|------|
| 1 | 读 `reload.ts`、`push-claim-run.ts`、`sync-wiring.ts` 的 diff、`main.tsx` 180-266 行、`sync-reload-race.test.ts`、push-claim-run 和 sync-tabs 的测试名 | 核对改法 |
| 2 | `npm run typecheck` | 通过 |
| 3 | `npx eslint` 9 个相关文件（reload.ts、sync-wiring.ts、push-claim-run.ts、main.tsx、first-paint.ts 和 4 个测试） | 退出码 0 |
| 4 | PowerShell：`$env:TZ='Asia/Seoul'; npx vitest run src/platform src/app src/core` | 128 个文件、1281 条全过 |

前端 A 自报的全量 vitest、整套 e2e、e2e:fastread 结果我没有复跑（按规矩不跑 e2e），也没有逐条核对它的变异日志 `mut-result-l3.txt`、`mut-result-n1n2.txt`；结论以我自己在副本里跑的变异为准。

变异验证：只在独立副本里做：
`C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\fa6-rev2`
开始前用 robocopy /MIR 把 src、shared、tests、tools 和几个配置文件同步成工作区现状。脚本 `fa6-rev3-mut.py` 每个变异跑完都按原字节写回，并用 SHA-256 断言还原；日志 `fa6-rev3-mut.txt`（这次是 UTF-8，中文正常）。
跑 6 个测试文件（sync-reload-race、sync-tabs、push-claim-run、first-paint-wiring、first-paint、session-first-paint），基线 42 条全过。

| 变异 | 结果 |
|------|------|
| N1-a `untouched` 恒真（退回老算法） | 拦住（主页、非主页 2 条挂） |
| N1-b 删行不看 `untouched` | 拦住 |
| N1-c 写回不看 `untouched` | 拦住 |
| N1-d 删行改从当前快照取 id | 存活（等价） |
| N2-a 去掉 refresh 后的闸 | 拦住 |
| N2-b 建频道时不看闸 | 拦住 |
| N2-c 提醒前不看是不是主页 | 拦住 |
| L3-a 不等上下文 | 拦住 |
| L3-b 等待不超时 | 拦住 |
| L3-c 设上下文不叫醒等待者 | 拦住 |
| L3-d 设上下文不清 `expecting` | 存活（等价） |
| L3-e main 不调 `expectPushClaimContext()` | 拦住 |
| L3-f main 换账号分支不设 null | 拦住 |
| L6 去掉会话主人比对 | 拦住 |

### 结论

三轮下来 M1、M2、M3、L1、L2、L3、L4、N1、N2 都已解决，有测试守着。剩下的 N3、N4 是低问题，建议顺手改，不挡合并。**本条（FA-6 首屏减重 ① 第二步：推迟启动）代码审查通过，8.5 分。**
