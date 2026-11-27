# B2 FA-6 首屏减重：执行说明（前端 A）

- 起草：2026-11-04，前端 A
- 目标：首屏 JS ≤ 150 KB gzip（B2 任务单第 165 行，硬线）。做不到如实报数，不放宽口径。

## 一、首屏怎么量（主持人 11-04 定）

**口径：页面时钟。** 冷启动打开 `/app/#/today`（假会话、不连库），算“今天页出现之前开始下载的 JS”，按 gzip -9 计。

- 今天页出现的时刻：页面里用 MutationObserver 记下 `[data-testid="today"]` 第一次出现时的 `performance.now()`；
- 每个 JS 的开始时刻：`performance.getEntriesByType('resource')` 的 `startTime`；
- `startTime` 早于今天页出现时刻的，算首屏；晚于的不算（今天页画出来以后才开始下载）；
- 两个浏览器都量（chromium 390×844、webkit iPhone 15），取较大值；
- 和 e2e `tests/e2e/b2-first-screen-supabase.spec.ts` 比先后用的是同一口径。

**不再用的口径：** 测试进程里 `waitFor(today)` 返回的时刻（Node 时钟）。它比页面里晚一次往返，今天页出现后 10～50 ms 才开始下载的块也会被算进首屏。

`build/check_size` 以后按这个口径改（首屏压到 150 以内之后做）。

## 二、数字记录

| 日期 | 做完哪一步 | 首屏（页面时钟） | 备注 |
|---|---|---|---|
| 11-04 | ④ 告知页懒加载之后 | 没按页面时钟量 | 旧口径（Node 时钟）是 275.3；那时 supabase-js 在今天页之前下载 |
| 11-04 | ① 关口快读 + 推迟 wireSync、session 预加载等首屏画完 | **208.6** | supabase-js 53.1 和提醒那组约 14（前端 B ⑥）都挪到今天页之后 |
| 11-04 | ② motion 功能包异步加载 | **181.0** | 两个浏览器一样；功能包块 feature-bundle 30.5 在今天页出现之后才开始下载（chromium 今天页 792 ms、功能包 803 ms；webkit 2004 / 2049 ms）；motion 壳并进 components 一块（17.4，含 kit 组件） |
| 11-04 | ③ zod、同步那批代码、account-status 移出首屏 | **145.5** | 两个浏览器一样（低于硬线 150，余 4.5）；main 65.4 → 26.7；zod 25.1（块名 zod-jitless）、sync-net 2.5、sync-wiring 8.9、device-reg 1.4、rows 1.2 都在今天页出现之后才开始下载（chromium 今天页 696 ms；webkit 今天页 1970 ms、这批 1988 ms）；account-status 剩 1.0 仍在首屏（告知页关口要用的那一小块）。构建自带的 check_size 首屏口径 109.7。**复测（11-04，清单快照改成 .ts 以后）145.6**：main 26.9，check_size 109.8，其余同上；回报主持人时用的 145.5 是改 .ts 之前那次 |

208.6 的构成：doc-locale 70.9（react-dom 约 64.8）、main 65.1（zod 约 27.6）、motion 45.6、account-status 6.3、其余约 20。

## 三、后面几步（按顺序）

1. ~~③ zod 移出首屏~~（11-04 做完）。实际做法和原计划不同：读缓存行本来就不经 zod，不用拆“轻量检查 + 空闲补校验”；首屏上通到 zod 的只有五条静态 import，逐条断开：
   - zod 的 JIT：vite.config.ts 把裸的 'zod' 别名到 platform/zod-jitless.ts（先 z.config({ jitless: true }) 再转出），入口不再先 import 它，谁先用 zod 都已关好 JIT；
   - 本机库版本号：boot.ts 改引 core/schema-version.ts（不带 zod 的副本，测试核对和 rows.ts 一致）；
   - 数据清单：core/manifest-source.ts 改读 build/gen_manifests_snapshot.mjs 生成的快照 manifests.gen.ts（生成时照样经 defineManifest 校验；测试每次核对快照和源文件一致）；
   - 入队的严格校验：outbox-logic 第一次入队时才 import rows.ts（只一次；等加载期间设了闸照样拒收）；
   - 同步传输层、同步接线、设备登记、账号状态探测：main.tsx 在首屏画完、第一道换账号闸之后才 await loadAfterPaint() 下载，回来再过一次同一道闸；日志上传改 lazyLogUploader（第一次真上传才加载，失败回 retry）。
2. ~~account-status 动态引入~~（11-04 跟 ③ 一起做完）。
3. ~~② motion 功能包异步加载~~（11-04 做完，实际 −27.6：208.6 → 181.0）。手感对照见下面“② 的连续帧对照”。
4. ③ 做完实测 145.5 KB（预计约 148）；清单快照改成 .ts 后复测 145.6 KB。⑤ 先不做。

## 三之〇、③ 审查（7.0 不通过）以后的修改（11-04）

审查记录在 docs/03-评审/B2/B2-代码审查-FA-6③首屏瘦身.md。

- **M1 首屏后那批代码下载失败、一直挂着**：
  - SW 注册挪到下载之前：过了第一道换账号闸就注册，下载成不成功都有 SW 缓存和新版本提示；推送认领等 SW 注册好、上下文设好以后再做；
  - 下载改用 `startAfterPaint`（app/after-paint.ts）：每次最多等 15 秒，超时按失败算；失败以后按 2、4、8、16……秒退避，最长 5 分钟；恢复网络、切回前台时立刻再试；每次下载前、回来后都过换账号闸，闸不过就收手；超时以后那次如果后来到了，照样用；
  - 第一次失败就把推送认领上下文设成 null，点按认领当场回 claim_failed，下载成功以后再设；
  - 连续失败 3 次，顶部出现现有的 sync-paused 横幅（文案 update.syncPaused：“同步暂停，请稍后重新打开”，韩文同一条）。横幅 id 单独用 after-paint-failed，下载成功时只收掉这一条。点“重新打开”会整页重新载入，正好也绕开 L2。**文案沿用现成的（主持人 11-04 定方案 1，不加新文案、不碰 kit）；以后要是想换成更准确的说法，比如“同步没启动”，先问负责人。**
- **M2 rows 加载失败时 write.\* 抛错**：
  - outbox 入队时加载失败，抛 `OutboxCodeUnavailableError`，不写本机、不入队；
  - write.\* 把它归成 `local_unavailable` 返回 ok:false，编辑页照现有规则提示“没保存上”、保留输入，不会停在“保存中”；
  - loadAfterPaint 顺带预加载 rows（也解决了 L1：第一次写入不用等下载）。
- **M3 zod 回到首屏没人拦**：新增 tests/build/first-paint-graph.test.ts。从 src/app/main.tsx 出发只沿静态 import 走（`import()`、`import type` 不算），不许走到 zod（含子路径）、zod-jitless、shared/schema/\*\*、shared/manifests/\*\*。审查员的 M10、M11 两个变异在测试里直接模拟，确认拦得住。
- **L3**：src/core/__tests__/outbox-code-unavailable.test.ts 覆盖三件事——加载失败拒收（没有本机行、pending 为 0）、write.\* 和编辑页保存回 local_unavailable、下次再加载以后照常校验。
- **L5**：加了 `npm run check:manifests`，unit.yml 跟在 check:files-rules 后面跑一步；build_web.mjs 在 vite build 之前先跑 `--check`，快照过期就不构建，进不了预览。
- **L6**：startAfterPaint 有行为测试（src/app/__tests__/after-paint-retry.test.ts，用假时钟）；main.tsx 的接线照旧用源码核对（first-paint-wiring.test.ts）：SW 在下载之前、闸的写法、用到账号的调用都在 startSync 里、startSync 里没有 await。
- **这次不改、只记下来**：
  - L2：“失败以后下次再试”只在 vitest 的 mock 下验证过。真实浏览器的模块表可能把失败的动态 import 缓存住，同一个地址要刷新页面才能恢复。连续失败 3 次出“重新打开”横幅兜底；以后能在真实浏览器里验证时再看要不要换法子（例如换地址重新下载）。
  - L4：zod 别名的测试只核对配置和源码，不核对产物；vitest 不走这个别名。产物层面靠 e2e 的 csp-fixture（出现 CSP 违规就失败）兜底。
- **首屏**：改完以后实测 146.4 KB，chromium、webkit 一样，比改之前多 0.8 KB（重试的代码），离硬线还有 3.6 KB；check_size 110.4。

## 三之〇之一、首屏判断放宽与推送认领核对审查（7.5 不通过）以后的修改（11-04）

审查记录在 docs/03-评审/B2/B2-代码审查-首屏判断放宽与推送认领核对.md。

- **M1 N1 的 e2e 补帧让 seen 恒成立**（tests/e2e/b2-motion-list.spec.ts）：
  - 补帧（MutationObserver 那一刻）照旧留着，只用来垫不透明度历史（让之后 34 ms 窗口里的 rAF 帧按它算），样本打 patch 标记，**不计入 seen**；
  - 新增 ghostRun()：seen 为 0（一帧 rAF 都没取到看得清的）就从准备那一步整个重做，最多 GHOST_TRIES=3 次；3 次都取不到就挂，报“补帧不算，否则这条什么都没测”。压字明细前面带“第 i 次”；
  - 审查员的变异（独立副本：AppearList 的 layout="position" 改成 layout={false}，再在取样里模拟机器忙——0～70 ms 的 rAF 帧不取、补帧照旧）：N1 删除、N1 今天页两个浏览器都挂（报压字或报没取到帧）；N1 打勾两个浏览器都通过（这个变异下打勾那一条没压字；审查员只做 NM3 时也是 8/12 挂，没挂的 4 条是不是都是打勾没有核对；原因没细查，复审时请审查员看一下要不要给打勾另做变异）；
  - 工作区基线 b2-motion-list 两个浏览器各 5 遍：第一次 49 条通过，webkit 的一条 N1 没报结果就静默，6 分钟后被看门狗结束（不是断言失败，像四之一记的 webkit 卡住）；重跑一次 50/50 通过。
- **M2**：first-paint-wiring.test.ts 钉住 setPushClaimContext 里的 `currentUserId: () => readSessionUserId()`，main.tsx 里 currentUserId 只许出现两处，不许写成 `() => userId`。
- **L1**：sync-reload-race.test.ts 加两条，覆盖 sync-wiring.ts 另外两处补读（收到别的标签页“改了”的消息、非主页回到前台整份重读）：逐表读的途中设了换账号闸，不再读后面的表，刚读到的也不写回内存。
- **L2**：push-claim-run.ts 的 claimDeps 加 isCurrent；runPushClaim 用的是全局上下文时，核对会话主人前先看上下文还是不是开始时那一份，换了（设成 null 或别的）就当不是本人，不认领。
- **L3**：push-claim.ts 的 stillOwner 上方写明剩下的窗口：supabase-js 异步取令牌那几个微任务里换了账号，A 的提醒可能推到已经换成 B 的浏览器，直到重新载入、B 的启动认领拿回去为止，接受。
- **L4 外壳常驻 main 的守卫**：
  - 源码：first-paint-pages.test.tsx 扫 .ts 和 .tsx（去掉注释），认 JSX 的 `<main` 和 `createElement('main')`；main 只许出现在 PAGE_FILES 白名单的页面文件里，App.tsx 只许 ErrorView、FeatureOffView 两处；
  - 运行时：first-paint-fallback.test.tsx 加一条，顶部横幅亮着（同步暂停 + 有新版本）、页面分包还没到时，一个 main 都没有、首屏判断不触发；分包到了以后只有页面自己那一个；
  - **提醒（RemindHost 和按钮条）没有做运行时渲染**：它要真的数据层（集合、提醒计算、push-status），在这里搭替身测的是替身不是外壳；提醒那几个文件里有没有 main，由上面的源码白名单守着。
- **e2e-ports.test.ts:169**：照“本机默认不复用、设了 LEMO_E2E_REUSE=1 才复用”改了期望。
- **变异（独立副本 scratchpad/mut-copy）**：单测 6/6 拦住（L1 两处去掉闸、M2 改成闭包 userId、L2 不核对上下文、L4 横幅里加 `<main />`、横幅文件里 `createElement('main')`）；e2e 见 M1。
- **检查**：全量 vitest 6473 通过（gen-tauri-key 除外），typecheck 0 错误，eslint 0 错误。

## 三之一、FA-6 ② 之后的低问题（11-04，前端 A）

- FIRSTPAINT-nofeature（方案 A）：platform/first-paint.ts 的 APP_PAGE_SELECTOR 放宽成 main。靠不带 data-feature 的 main 触发的是 EditShell、FullReminderPage、开发版 CspLab；ErrorView、FeatureOffView 由前端 B 改成 main[data-feature="error" / "off"]。App 外壳不许放常驻 main：first-paint-shell.test.tsx（运行时）和 first-paint-pages.test.tsx（扫源码，名单 PAGES_WITHOUT_FEATURE）守着；first-paint-fallback.test.tsx 测出错页、关掉页。
- N3：reloadCollections 加 stop 参数，开读前、每张表读完各看一次换账号闸；sync-wiring 三处调用传 () => boot.switching。
- N4 / L9：sealForExit 末尾作废推送认领上下文；认领上下文加必填 currentUserId，订阅前、第一次认领前、补登记后第二次认领前各比一次会话主人。
- P7：补测试——说过“马上会设”又设成 null 以后，点按当场回 claim_failed，不挂计时器。
- MOTION-n1-load-flaky：单测 appear-transform-end 的“退场途中又开又关”改用假时钟按帧推进；e2e b2-motion-list 的 N1 加“退场进度 0”补帧——离开那一项一挂上 data-state="leaving" 就当场量它，对上一帧画出来的别的行、组标题（不能对它们此刻的位置：DOM 刚变时 Motion 的 FLIP 还没套上，那个样子不会画到屏幕上，第一次这样写在 chromium 上误报了 23 次）。临时配置 8796 上 12 个 worker 两个浏览器各 5 遍，N1 30/30；2 个 worker 各 3 遍 30/30。
- 高负载下另见 M1（打勾后“已完成”组不动，chromium 挂过 3 次）、M2（撤销恢复，webkit 挂过 1 次：新行不透明度 0.14 时压到“没有日期”3.9 px）偶发，取样方式和 N1 原来一样按墙钟，没在这次范围里改，留给 MOTION-②-low 一并看。

## 三之二、MOTION-②-low（FA-6 ② 审查 L2～L7，并入 b2-motion-list 的 M1、M2 偶发；11-04，前端 A）

审查记录在 docs/03-评审/B2/B2-代码审查-FA-6②动效异步加载.md。

- **L3**：AppearItem 离开途中加 inert（和 Appear 一致），键盘 Tab 不进正在淡出的行，读屏也不念。
- **L5**：功能包到了时，features.ts 给 <html> 打 `data-motion="ready"`（MOTION_READY_ATTR）。b2-motion-list 的 motionReady 改成等这个标记再等三帧，不再靠资源加载记录加固定 300 ms。
- **L6**：新增 src/motion/__tests__/features-async-cold-list.test.tsx。单独一个文件，因为 features-async.test.tsx 里的用例按“没到 → 到了”的顺序排着，插不进去。覆盖：列表在功能包没到时挂上，到了以后：
  - 删行：leaving、带 inert、绝对定位、淡出、播完才卸载；
  - 加行：entering、不接点按、从 0 淡到 1。
- **L4（实测查出 kit 的问题，没修，已报主持人）**：
  - 新增 tests/e2e/b2-motion-focus-retry.spec.ts。用键盘关掉 kit Dialog（在“取消”上按回车、按 Esc）以后，**焦点回不到打开按钮，一直停在 body**，chromium、webkit 都这样。
  - 原因：Radix 的 modal Content 关闭时 preventDefault 掉了 FocusScope 的“还给原来的元素”，改成 triggerRef.current?.focus()；kit Dialog 的使用方都不用 RD.Trigger，所以 triggerRef 是空的。
  - 对照组（试验页的 RD.Trigger 弹层）焦点回得去。这和 inert 无关，审查里说的“约 0.2 秒以后还回去”在 kit Dialog 上不成立。
  - 主持人 11-04 定了改 kit：见下面“三之三”，已修，test.fail 已去掉。
- **L2（实测，按审查建议只写注释）**：
  - 功能包下载失败以后，chromium、webkit 都把失败的 import 缓存住，下一个 LazyMotion 再调 import() 也不会再去取，要刷新页面才恢复。e2e 按实测行为写，哪天浏览器改了这条会挂。
  - 刷新以后：chromium 能装上；webkit 单独跑约 4 秒内装上，三个 worker 并行时 3 次都 15 秒没装上，原因没查清，只记进附件。
  - 后果只是没有动画，暂不换法子，写进了 features.ts 文件头。
  - 注意：第一版用例只拦了第一次请求，可 Vite 会先发 modulepreload、再 import，各取一次，chromium 因此“看起来能恢复”。改成拦下期间每一次都拦以后，chromium 也不再去取。
- **L7**：真机 iPhone 装包耗时要负责人本人量，留在明早清单。
- **并入的 M1、M2 偶发**：
  - 根因一：取样时间用了 rAF 回调的 now。那是这一帧开始的时间，机器忙的时候回调要晚几十毫秒才轮到，会把晚的样子记早，M1 因此误报“组动了”。改成读样式那一刻的 performance.now()。
  - 根因二：motionReady 的固定 300 ms 在机器慢的时候不够，功能包没装齐就开始测；M2 会把“组标题没走 FLIP、直接到位”的样子当成压字。改成等标记（L5）。
  - M1 头 200 ms 里取不到 2 帧就重做，最多 3 次，还不够就挂“没测到”。
  - chromium 用 CDP 降速复现：
    - 4 倍：旧取样 M2 挂 2/4，新的 0 挂；
    - 6 倍：旧的 M1 挂 1、M2 挂 2；新的第一版 M1 挂 3（早段一帧都没有，Received 0），加了重做以后 M1、M2 8/8 通过。
  - 产品变异（独立副本：useHoldView 的等待改成 0）：M1 4/4 挂。
- **变异（独立副本）**：单测 5/5 拦住，分别是 L3 去掉 inert、L5 不打标记、冷挂载的行不退场、删掉的行不移出文档流、加行不打 entering。e2e 见上。
- **检查**：
  - 工作区 b2-motion-list、b2-motion-focus-retry、csp 各 3 遍：138 通过、6 跳过、0 挂；
  - 全量 vitest 6494 通过，typecheck 0 错误，eslint 0 错误；
  - 首屏 146.7 KB（页面时钟口径，两个浏览器一样）。

## 三之三、主持人 11-04 晚的一批：kit Dialog 焦点、③ 复审 M3、两份复审的低问题（前端 A）

- **kit Dialog 焦点（MOTION-②-low L4，主持人定）**：
  - src/kit/components/Dialog.tsx：打开那一刻（useLayoutEffect，早于 FocusScope 在 useEffect 里移焦点）记下 document.activeElement；RD.Content 的 onCloseAutoFocus 里先 preventDefault（Radix 就不再去找空的 triggerRef），再还给记下的元素，要求它还在文档里、没被禁用。使用方不用改。
  - 单测（kit 的 Dialog.test.tsx）三条：Esc 关、在“取消”上按回车关，焦点都回到打开按钮；打开按钮在弹层开着时被移走，不报错。去掉修改以后前两条挂。
  - b2-motion-focus-retry 去掉了 test.fail。
- **L2 带查询串重新 import**：主持人定不做，保持 features.ts 里的说明。
- **③ 复审 M3（依赖图跟不进 import()）**：按主持人倾向的第 2 种做法，按构建产物查。
  - 新增 build/check_first_paint_chunks.mjs：用 Vite manifest 算“入口 + 今天页、告知页关口、告知页”的静态闭包（只跟 imports，不跟 dynamicImports）。闭包里不许有 zod、zod-jitless、shared/schema、shared/manifests、rows 的块；块的内容里也不许有 zod 的特征字符串（$ZodType、ZodError，防止 rolldown 把 zod 并进别的块以后按名字认不出）。
  - build_web.mjs 在体积检查之后、删掉 .vite 之前跑它，失败就构建失败。
  - 新增 tests/build/first-paint-chunks.test.ts（假 manifest 7 条，含接线）。
  - 副本里真构建做变异 R3（今天页引 rows.ts 的常量）：构建退出码 1，报出 _rows、_zod-jitless 两块和 $ZodType。check_size 照样是 110.7 KB，只看它是拦不住的。复原以后构建通过。
- **③ 复审 L-b、L-c**（first-paint-wiring.test.ts）：
  - L-b：钉住 swReg 就是那个三元式、registerServiceWorker() 只调一次、第一道闸和它之间没有新开的函数。审查员的写法（swReg 改成 Promise.resolve(null)，原来那段挪进没人调的函数）能拦住。
  - L-c：横幅 id 是 after-paint-failed，不是 sync-paused，pushBanner、dismissBanner 各一处、不写字面量。R14 能拦住。
- **首屏判断复审的低问题**：
  - 新 L1：e2e-reuse.test.ts 加一条，真跑 `node tools/e2e/run-watchdog.mjs --check-ports <占着的端口> -- node -e …`，期望退出码 125、命令没被拉起。U6（入口把 checkPorts 传丢）能拦住。
  - 新 L3：改了 first-paint-fallback.test.tsx 那条横幅用例前半段的注释（横幅和页面同一个 Suspense，分包没到时横幅也不在）。
- **main.tsx:175（watchAccount 的 currentUserId，K6 接线）**：
  - 副本里改成 `?? userId` 跑全量 vitest，挂掉的 24 个文件都和它无关：副本没同步 functions、supabase 造成的，加上别人正在改的文件。**原来没有测试守着这一处。**
  - 现在 first-paint-wiring.test.ts 加了一条：watchAccount 的参数里原样是 `currentUserId: () => readSessionUserId(),`，两处 currentUserId 后面都不许接 ??、||、三元。变异能拦住。
- **变异（独立副本）**：U6、L-b、L-c、K6、构建不跑首屏块检查、闭包不跟 imports，6/6 拦住；Dialog 去掉修改，2 条挂；e2e R3 真构建拦住。
- **检查**：
  - 全量 vitest 6517 通过；eslint 0 错误。
  - typecheck：中途一次报过 tests/edge/push-dispatch-*.ts 的 4 个错（别人正在改的后端测试），最后再跑 0 错误。
  - e2e：csp、b1-settings、b2-motion-focus-retry 在 4 个 worker 下各 2 遍，98 通过、6 跳过、0 挂。同一批加上 b2-motion-list 在 12 个 worker 下各 3 遍挂了 17 条：SW 30 秒等不到 ready、页面 30 秒没出来。当时机器上别人也在跑，按负载算，没有再查。

## 二之一、② 的连续帧对照（11-04）

同一个脚本对改前（dist/web-abold）、改后（dist/web-abnew）两份产物各跑一遍，chromium 390×844、webkit iPhone 15，每帧（rAF）记计算样式：

- 弹层（设置 › 退出登录，sheet + scrim 打开、关闭）：两边每段帧数相同或只差 1 帧。整条曲线平移不到一帧（chromium 0～3 ms，webkit 9～14 ms，是起录时刻和动画起点之间的相位差）以后，translateY 最大差 ≤ 2.4 px、opacity 最大差 ≤ 0.019；终点完全一样；打开后外层 style 都是 `opacity: 1; transform: none;`。
- 列表（待办页打勾 t3）：按“t3 开始离开”那一帧对齐以后，不动的行 top、opacity 差 0；收上来的 t4 top 最大差 ≤ 2.5 px；t3 本身（原位那一份和“已完成”组里新出现的那一份）top 最大差 9.4 px（chromium，约一帧的移动距离）/ 1.0 px（webkit），opacity 最大差 ≤ 0.055；离开那一份 opacity 最大差 ≤ 0.022。
- 冷启动今天页：两边每一帧行的 opacity 都是 1（没有停在透明的帧）。
- **取舍（主持人 11-04 定，可以接受）**：首屏画出到功能包装上之间，新挂上的元素（今天页首屏的行、启动时就显示的横幅、这段时间里加的行）直接是停稳的样子、没有入场；这段时间里删掉的行当场移除、没有淡出，下面的行直接跳上来。功能包到了以后一切照旧。
- **窗口多长**：
  - 本机（wrangler pages dev，不节流）：功能包在页面出现后 0～47 ms 开始下载、1 ms 内下完（chromium 0 ms，webkit 29～47 ms；各 10 次）。11～45 ms 是本机数字。
  - Fast 3G（Chrome DevTools 预设：下行 1.44 Mbps、往返 562.5 ms，关缓存，chromium 6 次）：功能包（传输 31.6 KB）在页面出现后 983～1023 ms 才下完，也就是**第一次访问又遇上弱网时，这段窗口约 1 秒，网络更差时会在 1 秒以上**（审查 L1）。再次访问时功能包在 HTTP 缓存 / Service Worker 里，窗口回到本机那样。
- **装包时主线程卡不卡**：量不到长任务。冷启动待办页、今天页各 5 次，每帧记 rAF 时刻，看功能包下完前 20 ms 到之后 400 ms 这段：chromium 的 longtask 观察器一条都没有（> 50 ms 的任务为 0），最大帧间隔 17 ms，和这段以外一样；webkit 最大帧间隔 22～32 ms，这段以外 30～31 ms（headless webkit 本来约 30 ms 一帧）。改前产物同一时刻：chromium 17 ms，webkit 21～47 ms。Fast 3G 下也没有长任务。
  - 更正：上一轮回报说“功能包刚到时 webkit 主线程会卡几十毫秒”，是从高负载下整套 e2e 的取样间隔推出来的，不对；改前在同样负载下间隔也一样大（见下一条）。
- **e2e 里 webkit 的 N1 用例**：b2-motion-list 的 N1 那几条在 webkit 下本来就不稳（取样跟不上 110 ms 的淡出）。低负载下（不和别的 e2e 同时跑）改前（HEAD 36f7c45 的 worktree）、改后各跑 webkit 5 遍：两边都是 25 条挂 5 条，分布一样（N1 打勾 3、N1 删除 1、N1 今天页 1），M1 两边都没挂。不是 ② 引起的，是 FA-5 就有的不稳定。
- 脚本：scratchpad 的 m2-longtask.mjs、m2-longtask-run.mjs；结果 m2-longtask.txt；e2e 对照日志 lowload-old.log、lowload-new.log。

脚本：scratchpad 的 m2-ab-run.mjs（起服务、录两份）、fa5cr-ab.mjs（弹层）、m2-list.mjs（列表、冷启动）、m2-shift-cmp.py、m2-align-cmp.py、m2-list-cmp.py；结果 m2-shift-cmp.txt、m2-align-cmp.txt、list-cmp.txt。

## 三之四、③ M3 第三轮、首屏瘦身 1/3/4、Dialog 低问题（11-05，前端 A）

- **首屏 e2e 预算（③ M3 第三轮第 1 项）**：tests/e2e/b2-first-screen-budget.spec.ts，口径同审查员 cr-r3-measure（SW block、今天页出现之前开始下载的 JS、gzip 9、zod 特征字符串），chromium、webkit 都跑；体积那条的 test.fail 已去掉（合起来 149.9 KB）。
- **名单（第 2 项）**：FIRST_PAINT_DYNAMIC 补到 6 项（含 MissedReminders、UnsyncedRemind、UnsyncedRemindMark）；first-paint-graph 加“名单和源码对得上”（从 main.tsx 出发收集首屏闭包里的 import()，每个都要归进首屏名单或 NOT_FIRST_PAINT）。新拆的 MissedSheet、push-claim、push、UpdateBanner、ExitIncompleteScreen 都归进了 NOT_FIRST_PAINT。
- **R3b（第 3 项，独立副本）**：构建检查退出码 1（报 _rows-、_zod-jitless-）；绕过构建单独验 e2e，zod 那条两个浏览器都挂，体积 154.1 → 180.5 KB。
- **首屏瘦身（主持人定 1、3、4 项，加 push-claim）**：153.5 → 149.9 KB（两个浏览器各 3 次一致）。
  - push-claim-run 认领本体按需下载；motion/gestures.ts 新出口（eslint 0.31 第 6 条、架构文档同步）；
  - push.ts 退出时按需下载：push-claim-key.ts（认领记录先删，不等下载）+ push-disconnect.ts（下载失败、断开抛错记 push_disconnect_fail，不挡退出）；
  - UpdateBanner 由 App.tsx 的 BannerGate 在有横幅要出时才下载（banner-kind.ts）；ExitIncompleteScreen 由 exit-screen.tsx 按需下载，取不到画 AppCrashFallback。
  - 按“每个模块单独 gzip”估的省量偏高：同一块里一起压缩，拆出去实际省得少（main 27.9 → 25.1）。还能省的：manifests.gen 约 2.8 KB、outbox 一族约 5 KB（今天不做）。
- **ease.press**：保留，tokens.json 的 desc 写明“不要用于按下那一段”，重新生成；motion/tokens.ts 注释原来写“按下”，改掉。
- **Dialog L-1～L-3**：open 变 false 那一次提交就还焦点（useEffect，这时 FocusScope 的锁已摘）；卸载时只在焦点丢了才补还；可选退路 returnFocus。单测 5 条；独立副本变异“关上时不还”“canRefocus 恒为真”都拦住。e2e 断言“焦点在 body 上最多 1 帧”。
- **L-5 查清**：webkit 页面没被 SW 接管时，刷新以后照样用内存缓存里上次被拦下的失败结果，功能包 import() 不发请求；4 个 worker 并行时 SW 装得慢、刷新时还没接管。12 遍里失败的全是没接管、成功的全是接管了。刷新前等 navigator.serviceWorker.ready 以后 12/12 通过，两个浏览器都改成断言。
- **L-6**：冷列表单测改假时钟按帧推。**L-7**：M1 门槛 2 帧的原因写进注释；接手清单那一行主持人已回填。
- **检查**：全量 vitest 6583 通过（--exclude gen-tauri-key）；typecheck、eslint 0 错误；整套无后端 e2e 4 个 worker 204 通过、36 跳过、0 失败；focus-retry + motion-list 4 个 worker 各 4 遍 72 通过。
- **端口**：e2e 用 8820、8821（inspector 9260、9261）；假后端端口只能在 9190～9199（fake-values.ts 限的），不在分到的 92xx 段里，用的是 9194～9197。

## 四、要记住的约束

- **MissedReminders 以后接进今天页时**，会把 useReminders、useRemindT 拉回首屏（约 14 KB）。到时要么等空闲再挂，要么拆一个只算条数的轻量入口。
- `src/platform/first-paint.ts` 和前端 B 的 ArmReminders 做的是同一件事，接手清单 REMIND-arm-firstpaint 记着，以后统一。
- 首屏画完的时限：挂上起算 15 秒长兜底；render 后起算的时限是告知页关口的 5 秒再加 1 秒（main.tsx 的 `startAppPaintLimit(GATE_LIMIT_MS + 1000)`）。这样关口慢时，同步也不会在关口还空白时先起。
- 快读分支的 e2e：`npm run e2e:fastread`（`playwright.fastread.config.ts`，带同源 /sb 地址的构建）；默认组没配地址，只能验证“直接放行、不下载”。

## 四之一、已知坑

- **整套 e2e 复用了跑了 7 小时的旧服务（11-04，③ 收尾时）**。经过：
  - 8788 上叠着三棵旧的 `wrangler pages dev dist/web --port 8788 --persist-to .wrangler/state-e2e`，分别是 09:43、10:08、10:45 起的，都没退；
  - 本机 `playwright.config.ts` 的 `reuseExistingServer` 在 CI 以外为 true，`npm run e2e` 直接用了旧服务；
  - 结果 66 条失败：chromium 一开始 files.spec 报 `{"code":"files_misconfigured"}`、b1-version-gate 挂 3 条，webkit 后半段大面积 `page.goto` 30 秒超时，还有一条 “Failure when receiving data from the peer”。
  
  为什么没拦住：
  - globalSetup 的产物指纹（tests/e2e/dist-fingerprint.ts）只比 /app/ 首页。旧服务读的是同一个 dist/web 目录，首页对得上，可是 Functions 的打包和环境是起服务那一刻的；
  - `run-watchdog.mjs --check-ports` 只在跑完以后看端口，跑之前不查。
  
  旧服务从哪来：多半是以前的 e2e 跑完或被打断以后，Playwright 只结束了 npx → cmd → wrangler 这条链的最外层，Windows 下子进程树留了下来。
  
  这次怎么处理的：
  - 主持人确认以后，关掉了 10:08 那一棵；
  - 另外两棵关的时候被权限规则拦下，留给负责人处理；
  - 整套 e2e 改用 scratchpad 里的临时配置跑：端口 8796、inspector 9238、持久化目录 `.wrangler/state-e2e-8796`、假后端 9195/9194、产物目录 `dist/web-e2e8796`，跑完把自己起的服务停掉。
- **已改（11-04，主持人定，照上面的建议）**：
  - 两个无后端配置（playwright.config.ts、playwright.fastread.config.ts）默认不复用；本机设 `LEMO_E2E_REUSE=1` 才复用，CI 设了也不复用，改了假后端端口照旧不复用。判断在 `tools/e2e/reuse-servers.mjs`，真后端配置照旧一律不复用。
  - 看门狗（`tools/e2e/run-watchdog.mjs`）起跑前先查 `--check-ports` 列的端口（只连一下）：有一个被占着就不拉起命令，打印是哪个端口，退出码 125；设了 `LEMO_E2E_REUSE=1` 时跳过这一步。跑完以后照旧再看一次。
  - 要复用已经在跑的服务：`LEMO_E2E_REUSE=1 npm run e2e`。改了 src 要先自己 `npm run build -- --mode e2e`；产物指纹检查照旧，作第二道检查。
  - 测试在 `tests/build/e2e-reuse.test.ts`：开关的几种写法、两个配置真加载出来的 reuseExistingServer、端口被占着时不拉起命令、设了开关照常拉起。

## b1-consent.real 真后端复跑

- 日期：2026-11-04；执行：前端 B（主持人转达负责人同意启停 lemo-e2e，用完已停）
- 目的：ConsentGate 改成懒加载 ConsentPage 以后，同意页的真后端用例照常通过（FA-6 ① 提交前的前置条件）
- 后端：只用 lemo-e2e（API 127.0.0.1:55321、Mailpit 127.0.0.1:55324）；前端 wrangler pages dev 8789，假后端 9197、9196；地址和 key 由 playwright.real.config.ts 经 `supabase status` 取本地演示值，没读 .env、没往仓库写密钥
- 命令：
  1. `npm run e2e:real:up`（只起 lemo-e2e，迁移全部应用、seed 完成）
  2. `npm run e2e:real -- tests/e2e/b1-consent.real.spec.ts`
  3. `npm run e2e:real:down`（`project_id_filter: lemo-e2e`，只停 lemo-e2e）
- 结果：**4 条全部通过**（chromium，4 个 worker，7.8 秒），退出码 0：
  - ① first：AI 同意默认不勾，不勾点“同意并继续”什么也不做，点“先不同意，直接用”进 App，服务器记下看过这一版、没有同意时间
  - ② 对照：勾上以后“同意并继续”能点，进 App，服务器记下同意时间
  - ③ updated：看过的版本低于 min_consent_ver，先显示“隐私说明更新了”、不画主界面；点“先不同意，直接用”进 App，记成当前这一版
  - ④ none：看过的就是当前这一版，不出告知页、不发 record_consent，consent_policy_ver 不变
- 浏览器：只跑了 chromium（本配置默认；没设 E2E_REAL_WEBKIT）
- 本机其他实例：前后各看一次 `docker ps`，supabase_*_lemomemo 8 个容器名单、状态前后一致，没碰；lemo-purgeit 没碰；停完以后没有 lemo-e2e 容器残留
