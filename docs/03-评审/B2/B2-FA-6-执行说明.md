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

208.6 的构成：doc-locale 70.9（react-dom 约 64.8）、main 65.1（zod 约 27.6）、motion 45.6、account-status 6.3、其余约 20。

## 三、后面几步（按顺序）

1. ③ zod 移出首屏（约 −27）：wireSync 和同步引擎画完后再动态引入；读缓存行先做轻量的结构检查，完整的 zod 校验挪到空闲时补做。zod-jitless 的 import 在 main.tsx。
2. account-status 动态引入（约 −6）。
3. ~~② motion 功能包异步加载~~（11-04 做完，实际 −27.6：208.6 → 181.0）。手感对照见下面“② 的连续帧对照”。
4. ③ zod（约 −27）、account-status（约 −6）做完以后预计约 148 KB。⑤ 先不做。

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

## 四、要记住的约束

- **MissedReminders 以后接进今天页时**，会把 useReminders、useRemindT 拉回首屏（约 14 KB）。到时要么等空闲再挂，要么拆一个只算条数的轻量入口。
- `src/platform/first-paint.ts` 和前端 B 的 ArmReminders 做的是同一件事，接手清单 REMIND-arm-firstpaint 记着，以后统一。
- 首屏画完的时限：挂上起算 15 秒长兜底；render 后起算的时限是告知页关口的 5 秒再加 1 秒（main.tsx 的 `startAppPaintLimit(GATE_LIMIT_MS + 1000)`）。这样关口慢时，同步也不会在关口还空白时先起。
- 快读分支的 e2e：`npm run e2e:fastread`（`playwright.fastread.config.ts`，带同源 /sb 地址的构建）；默认组没配地址，只能验证“直接放行、不下载”。

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
