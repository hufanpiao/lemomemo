# B3 前端 A 开发自测（六环 ①，FA-0～FA-4、S23、BUSY / REMIND 接线、Q3 守门）

- 日期：2026-11-13　作者：前端 A（B3）　代码基线：整合分支 `integrate-fa3b` 头 `fac53034`（前端 A 最后一个提交 `f91a48f5`，其后 `fac53034` 是主持人在它上面补的“第二轮复查续”）
- 依据：[B3 任务单](../../09-路线图/B3-任务单.md) 第四节“前端 A”FA-0～FA-5、Q3 守门测试 1～8、第八节六环 ①；[B3 剩余清单 11-10](../../06-测试/B3/B3-剩余清单-11-10.md)（11-13 版）。格式照 [B3 后端开发自测](B3-开发自测-后端.md)。
- 这是开发自测，不代替 QA 执行；QA 可以照“命令”一列原样复跑。
- 库：只用本机 lemo-e2e（127.0.0.1:55321 / 55322），跑完已停。没连 lemomemo（54322）、lemo-purgeit、preview、生产；没部署；真后端 e2e 里 ai-voice、ai-parse 的 Gemini 一律走回放桩或路由拦截，不联网、不用真密钥。
- 证据：本文“结果”一列引的是命令输出原文；11-13 在 `fac53034` 上的整轮结果由主持人本机按 `unit.yml` 跑出（见第二节第 1～7 行）。命令输出没有另存证据目录。

## 一、首屏 B3 前后两个数（任务单第八节要求）

| | 数 | 出处 |
|---|---|---|
| B3 前（首屏净增关卡现行基线） | **114294 B** | `build/first-screen-baseline.json` 的 `baseline`。来历：B3 前端开工前原基线 111404 B（主持人 11-09 量，当时 B3 前端净增 975 B）；之后按 R-379 换批、R-388（R-382 的 1231 B）和 R-397（141 B）两次例外调到 114294 B，额度 1024 B 不变 |
| B3 后（`fac53034`） | **净增 974 B / 额度 1024 B**（即 115268 B） | 主持人 11-13 在 `fac53034` 本机按 `unit.yml` 量得；前端 A 在 `f91a48f5` 上自测同为 974 B |

- 量法（仓库根目录）：`npm run build -- --mode preview`，再 `node build/check_size.mjs --mode preview`，读输出里那一行，原文“B4 首屏净增：974 B / 额度 1024 B（基线 114294 B）”（脚本按 R-379 的批次名打“B4”，数就是上面这个）。稳定口径，linux 镜像和本机 Windows 同一个数。
- FA-3 期间首屏的变化：合 main 时 `cb68ee75` 是 1004 B；第二轮第 7 条一开始把 `errName` 放进 `err-tag.ts`，首屏涨到 1006 B，改为放进首屏本来就有的 `platform/env.ts` 后降到 983 B（`54b56f0b`）；第二轮复查删掉 `useHoldBusy` 的 `active` 参数后为 974 B（`f91a48f5`）。
- 打字条、本机规则（`shared/logic/parse`）、`features/plus` 的界面都在懒加载块里，首屏只有 `app/plus-slot.tsx` 的接线和 `features/plus/index.ts` 的两个懒加载导出（`loadTypeBar`、`PlusSettings`）。

## 二、总表

| 项 | 内容（摘） | 主要提交 | 自测（测试文件） | 对应 TC | 结果 | 只能真机 |
|---|---|---|---|---|---|---|
| FA-0 | R-68 录音格式探测页：只在预览构建里出现，显示 `isTypeSupported` 和实际 `mimeType`，按住逐段上传 voice-probe；Blob 只在内存；Q-5 改用正式录音器，start 事件到了才显示 Recording | 3c482a9e、824aa4cf、fe1640fa | `src/platform/__tests__/voice-probe.test.ts`、`src/app/__tests__/voice-probe-keep.test.tsx`、`voice-probe-leave.test.tsx`、`src/features/settings/__tests__/about-probe-entry.test.tsx`；正式产物搜不到探测页：`tests/build/check-no-probe.test.ts` | TC-B3-01；新增“正式产物里搜不到页面和路径” | 过 | 负责人 iPhone 录 20 段（Q1）；Q-5 句首被吃待真机验 |
| FA-1 | 记录状态机（5.9 全部状态，超时按 5.11）；intent 穷举，不认识的当 `ai_failed`、退回本机规则、原话不丢；同一 `batch_id` 进 outbox；撤销；不写 `ai_status`；保存用 `capture-map.ts` | 74b3e02e、807a10f0（后经 FA-3 返工并入 `capture-state.ts` 的 `viewStep`） | `src/features/plus/__tests__/capture-state.test.ts`、`ai-outcome.test.ts`（不认识的 intent 退路）、`capture-save.test.ts`、`type-flow.test.ts` | TC-B3-04、05（保存部分）、10、44（保存一侧）；新增“不认识的 intent” | 过 | — |
| FA-2 | “＋”点一下打开打字条（M4）；本机预览、回车保存、下滑留草稿；日历页没说日子记选中那天、“展开编辑”带字（R-353）；首屏画完预先下载，离线冷启动显示“准备中”；提示条各状态、“已记下 N 条”逐条改撤、合并、全部撤销；过去日子的确认行（R-166）；额度用完每天提示一次；Ctrl+N、Ctrl+Z（S24）；接 ai-parse；Q-24 冷启动后第一次点“＋”当场聚焦；Q-8 原地聚焦 | 74b3e02e、807a10f0、f7e88be7、8cb01c12、b55b3167、691bc74a | `src/features/plus/__tests__/TypeBar.test.tsx`、`TypeBar-blank.test.tsx`、`TypeBar-mist.test.tsx`、`type-flow.test.ts`、`type-draft.test.ts`、`quota-notice.test.ts`、`saved-batch-undo.test.tsx`、`ai-parse-api.test.ts`；`src/app/__tests__/plus-slot.test.tsx`、`input-font-size.test.ts`；`src/features/calendar/__tests__/new-date.test.ts`；`src/kit/hooks/__tests__/useKeys.test.tsx`；e2e `tests/e2e/b3-plus-keys.spec.ts`、`b2-tabbar.spec.ts`（改写后）、真后端 `b3-ai-parse.real.spec.ts` | TC-B3-02、30、35～38、43、56、57、58、63；新增“＋”点一下打开打字条、日历页记选中那天、展开编辑带字、离线“准备中”、Ctrl+N / Ctrl+Z | 过；`b3-plus-keys` WebKit Q-8 一条加压偶发（见第五节第 3 条） | 键盘弹起贴键盘、安全区、点“＋”键盘当场弹（Q-24）、离线打字（P3-04） |
| FA-3 | 按住“＋”录音：`add.hold` 转发、350 ms、上拖取消、锁定区、波形计时、50 秒倒数 60 秒自动结束；说明卡后请求麦克风；离线按住直接提示；直传 ai-voice（带 `X-Projects`），上传超时 17～22 秒；AI 没回应可“重试”同一段（录音只在内存，最多 2 分钟）、“再说一次”；网络 10 分钟两次失败、额度用完、没开 AI 改走 Web Speech（在手势里 `start()`）；作废代号；切页时上传、整理的照常存完（第二轮第 11 条） | 742fac3a～f08f2b40（录音层）、032fbba8、9bd14fdb、13dfa32e、691bc74a；第二轮 39fbe21b、7ae2dac7、ea671917、54b56f0b、b6b459ed、f91a48f5；主持人 fac53034 | `src/features/plus/__tests__/RecordHost.test.tsx`（含 3 条切页用例、busy 用例）、`hold-input.test.ts`、`voice-flow.test.ts`、`voice-speech.test.ts`、`record-logic.test.ts`、`ai-voice-api.test.ts`、`capture-state.test.ts`；`src/platform/__tests__/recorder.test.ts`、`recorder-cancel.test.ts`、`recorder-level.test.ts`、`speech.test.ts`；e2e `tests/e2e/b3-plus-hold.spec.ts`、真后端 `b3-plus-hold.real.spec.ts`（503 后“重试”记下；上传中切到设置页照常记下） | TC-B3-01、03、08、11、56；P3-01～03 | 过；切页真后端用例在 main 上先红（服务器 todos 为空）、改后转绿 | 见第四节 |
| FA-3 后续（第二轮） | 超时重试抽成 `withTimeoutRetry` 一份；“存→问/好/失败”收成纯 TS 的 `createSavedBatch`（data/saved-batch.ts）；isObj、cutAiText、errName、AbortError 判断各留一份；识别语言只从界面语言往下换；card / note / locked 并进 `viewStep`；6 处 `hold.reset()` 改由 voice-sink 订阅；控制器拆成录音路（voice-rec.ts）和识别路（voice-speech.ts）；测试经 `session` 注入，删掉 reset 钩子；cache 的同名函数改名 `cacheErrKind` | 同上第二轮各提交 | 同上，加 `saved-batch-undo.test.tsx`（直接测工厂） | — | 过；plus 目录（不含测试）总行数 main 4598 → 4552 | 停录兜底 3 秒和 `requestData` 等真机日志再定 |
| FA-4 | 设置 › 语音与 AI（今天用了 N 次 / 共 50 次、恢复时刻、麦克风状态）、在 Claude 聊天里记事（连接码只显示一次、断开、最后使用时间）；只用 kit 设置行；后台时不显示连接码明文 | 9abed231、1efcc70f | `src/features/plus/__tests__/PlusSettings.test.tsx`、`PlusSettings-claude.test.tsx`、`ai-usage-api.test.ts`、`claude-link-api.test.ts` | TC-B3-21、29、55 | 过 | — |
| S23 麦克风 | `perm-mic.ts` 记最近一次结果；今天页被拒一行（MicDeniedNote）；麦克风说明卡（MicCard，第一次按住 / 被拒）；“＋”上方前 3 次小气泡（11-13 随 FA-3 打开 `PLUS_HINT_ENABLED`） | 42e63053、032fbba8 | `src/platform/__tests__/perm-mic.test.ts`、`src/features/plus/__tests__/MicCard.test.tsx`、`PlusHint.test.tsx`、`plus-hint.test.ts`、`src/features/today/__tests__/MicDeniedNote.test.tsx`、`today-mic-denied.test.tsx` | 新增：被拒时今天页说明、设置里显示状态、引导卡、前 3 次提示 | 过 | 系统麦克风授权弹窗；iPhone 主屏幕版每次会话 Permissions API 返回 prompt 会不会清掉“已拒绝”、今天页那一行出不出得来 |
| S16 / BUSY-wire / REMIND-wiring（录音部分） | 录着、上传中、整理中按控制器状态占住升级中心 busy（不随组件卸载放开，第二轮复查第 1 条）；`fac53034` 起确认行出着时也占；启动没好就开录时记 `voice busy skip no_boot`；令牌 30 分钟作废只解除横幅压制；录着时 `useHoldReminders` 压住提醒横幅 | 032fbba8、f91a48f5、fac53034 | `RecordHost.test.tsx`（按住时提醒横幅压住、松手放开；上传中切页 busy 一直占着、存完放开，先红后绿）；`src/core/__tests__/upgrade-busy-expired.test.ts`、`upgrade.test.ts`；`src/app/__tests__/update-banner-paused.test.tsx`；`src/kit/state/__tests__/remind-queue.test.tsx` | 新增“录音令牌 30 分钟作废后只解除横幅压制、录音中不会被重新载入” | 过 | 录音中真收到新版本（P3-03）：横幅等录完再出、不被重新载入 |
| Q3 守门（R-352 ④） | 第 1 条：`tests/e2e/visual/g-plus-hold.spec.ts` 0 像素比对（win32 本机基准，CI 不跑）；第 4 条：`GlassBar.tsx` 只多转发几行（约 20 行，代码审人工核）；第 5、6 条：结构不变和行为单测；第 3 条（基准 diff 为空）和第 4 条的 CI 步骤归运维 | 032fbba8 | `tests/e2e/visual/g-plus-hold.spec.ts`；`src/features/plus/__tests__/GlassBar-hold.test.tsx`；`src/kit/components/GlassBar/__tests__/GlassBar-taps.test.tsx`；`src/features/plus/__tests__/hold-input.test.ts` | Q3 守门 1、4、5、6 | 过（g-plus-hold 主持人 11-13 本机跑过） | 第 7 条：按住、上拖取消、锁定以后底栏和“＋”有没有变样、有没有残留按下的样子；切页过渡中点“＋”只打开打字条 |
| 进门条件 | OUTBOX-cross-tab（c64aa0e7）、UNSYNCED-retry-codes（代码审通过、关单） | c64aa0e7 | 见各自审查记录 | — | 已关 | — |

## 三、命令和结果

| # | 跑了什么 | 命令（仓库根目录） | 结果 | 谁、在哪跑的 |
|---|---|---|---|---|
| 1 | unit.yml 第一项全部步骤 | 照 `.github/workflows/unit.yml` 第一项逐步 | 18 步全过 | 主持人 11-13，`fac53034` 本机 |
| 2 | vitest 全量 | `npx vitest run --exclude tests/build/gen-tauri-key.test.ts` | 只有 `tests/build/publish-run*` 的 67 条红：这几条要求当前在 main 分支，非 main 本来就红，和 B3 无关 | 主持人 11-13，`fac53034`；前端 A 在 `f91a48f5` 上同为 5 个文件 67 条（9363 条里 9262 过） |
| 3 | e2e 全量 | `npm run e2e` | 387 过、71 跳过 | 主持人 11-13，`fac53034` |
| 4 | fastread | `npm run e2e:fastread` | 6 过 | 同上 |
| 5 | visual | `npm run e2e:visual` | 和 main 同样红 10 条，都是本机 win32 基准或 WebKit 不画模糊造成的；`g-plus-hold`（Q3 守门第 1 条）过 | 同上 |
| 6 | b3-plus-keys 单线程 | `npm run e2e -- tests/e2e/b3-plus-keys.spec.ts --workers=1` | 两边（main 与 `fac53034`）都全过 | 同上 |
| 7 | 首屏 | `npm run build -- --mode preview` 后 `node build/check_size.mjs --mode preview` | “B4 首屏净增：974 B / 额度 1024 B（基线 114294 B）” | 主持人 11-13 `fac53034`；前端 A `f91a48f5` 同数 |
| 8 | 类型检查 | `npm run typecheck` | 5 个 tsconfig 全过 | 前端 A，`f91a48f5` |
| 9 | lint | `npx eslint .` | “✖ 61 problems (0 errors, 61 warnings)”，和 main 一样；改到的范围里只有两个测试文件超 300 行（main 上已超） | 前端 A，`f91a48f5` |
| 10 | plus 单测 | `npx vitest run src/features/plus` | 25 个文件 358 条全过 | 前端 A，`f91a48f5` |
| 11 | 录音和打字 e2e 三遍 | `npm run e2e -- tests/e2e/b3-plus-hold.spec.ts tests/e2e/b3-plus-keys.spec.ts --repeat-each=3` | 59 过、12 跳过、1 红（WebKit Q-8 scrollY，见第五节第 3 条） | 前端 A，`f91a48f5` |
| 12 | 真后端 e2e | `npm run e2e:real:up` → `npm run e2e:real -- tests/e2e/b3-plus-hold.real.spec.ts tests/e2e/b3-ai-parse.real.spec.ts` → `npm run e2e:real:down` | “3 passed (8.4s)”；lemo-e2e 已停 | 前端 A，`f91a48f5` |
| 13 | 登记册 | `python build/check_registry.py` | “有文件没登记：无；登记了但文件不存在：无” | 前端 A，`f91a48f5` |

## 四、只能真机看的（电脑、模拟器证明不了）

1. 长按“＋”：iOS 系统长按菜单、放大镜会不会弹；竖着上拖会不会被当成滚动而发 `pointercancel`（P3-01；不行时走 D2，问负责人能不能加 `touch-action` / `-webkit-touch-callout`，不能先改 CSS）。
2. Q3 守门第 7 条：按住、上拖取消、锁定以后底栏和“＋”有没有变样、有没有残留按下的样子；切页过渡中点“＋”只打开打字条（负责人看，QA 记录）。
3. 录音面板的真实声波（音量条）、计时、50 秒倒数、60 秒自动结束。
4. MediaRecorder 在 iPhone 主屏幕版的真实格式和开录时延（P3-02，Q1 结论；Q-5 句首被吃待真机验）。
5. 出结果的耗时：60 秒录音 20 秒内出结果（1.3 验收）。
6. Web Speech 兜底在 iOS 主屏幕版能不能在手势里开起来、听不听得见（R6、R7）。
7. 麦克风授权：说明卡之后的系统弹窗；iPhone 每次会话 Permissions API 返回 prompt 会不会清掉“已拒绝”，今天页“麦克风被拒”那一行出不出得来（S23 剩余）。
8. 键盘：点“＋”键盘当场弹出（Q-24）、“改用打字”之后的键盘、打字条贴键盘和安全区、键盘弹起时底栏藏起。
9. 录音中真收到新版本：横幅等录完再出，不被重新载入（P3-03）。
10. 离线打字（P3-04）。
11. 停录兜底的 3 秒和 `requestData`：iOS 不发 stop 事件那种情况，等负责人的真机运行日志再定要不要改。

## 五、没做到的、还没到时候的

1. **FA-5 动效没做，review-animations 自查也没做**：按 R-376（11-10）挪到全部功能做完以后统一做，录屏给 ②b 同样延后。
2. **Q8 lamejs、MP3 那一路**：等 Q1 结论（负责人 iPhone 20 段、QA Edge 20 段），现在按直传做。
3. **WebKit Q-8 偶发**：`b3-plus-keys.spec.ts:71`（先滚到 y=800 再点“＋”，scrollY 不变）在加压、多线程时偶发红；11-13 对照：`f91a48f5` 上单跑 10 遍红 2 遍，改动前的 `b6b459ed` 上红 3 遍；主持人又在同等负载下交替跑了 main 和第二轮各 20 遍，main 也红 1 遍、第二轮红 3 遍（都是 Received: 856）；关掉残留进程、改单线程（--workers=1）后两边交替各 40 遍全过。结论：多线程抢资源时才红，main 上同样会红，不是 FA-3 第二轮带进来的，期望值没改（第三节第 6 行）。另外 R-374（Ctrl+N 后没聚焦）、Q-25 :141（记下后提示条没出）修复前加压各红过 1 次、没抓到日志，修复后同条件没再红；再红时先抓日志。
4. **打字条停在确认行时不占 busy**：负责人按“更新”或缓存进 `closed_for_upgrade` 时会被重新载入打断、等着选的那一条丢掉。录音那边 `fac53034` 已改成确认行也占；打字条是 B2 起的设计，没顺手改，留在剩余清单。
5. **探测页下线（BE-0 下线的前端部分）**：等 Q1 实测完，和 voice-probe 同一个 PR 删（函数 2026-11-17T15:00Z 起回 410）。
6. **K8-tab-broadcast**：待负责人定（主持人倾向挪到 B6）。**S20**（电脑全局快捷键打字框瞬间出现）：没核实，要在 exe 里实按，排 B6 复查。
7. **Q3 守门第 2、3、4 条的 CI 步骤**归运维；第 1 条是 win32 本机基准，CI 不跑，报告随 ②b 附上。

## 修改记录

| 日期 | 改动 | 谁 |
|---|---|---|
| 2026-11-13 | 新建 | 前端 A（B3） |
