# B3 FA-3 代码审：底栏“＋”按住录音（点一下打字、按住说话）

- 审查人：独立代码评审员（子 agent，只读，只看代码和范围，不看台账和历史判断，默认不通过）
- 日期：2026-11-13
- 范围：第一轮 032fbba8 整块 → 复查一 9bd14fdb（对比 032fbba8）→ 第二轮重构 cb68ee75..b6b459ed（39fbe21b、7ae2dac7、ea671917、54b56f0b、b6b459ed）→ 复查二 b6b459ed..f91a48f5 → 主持人修改 fac53034（本记录核对）
- 依据：B3 FA-3 需求；A1 分层规则（data 层不 import React）；用户最高规则“每个大功能完成后独立评审看全局代码”（查屎山、更简单的写法、重复）；另查 bug、泄漏和测试漏洞
- 方式：全程只读，没有起服务，没有跑会写 node_modules 的命令，没有切分支

## 结论

**通过，8.5 分。没有必改项，可以合并。** 第一轮三条必改（取消或卸载后仍然存、stop 没兜底卡死面板、useVoice 577 行该拆）都已经解决。第二轮重构把重试、保存流程、错误名、语言映射几处重复收成了一套。复查二提出的 5 条里，fac53034 改了 4 条，我逐条核过，都改对了。第 5 条（换日子窗口）不改，可以接受。上一轮没核实的“换账号残留”这次核过，不成立，关掉。

## 各轮分数

| 轮次 | 范围 | 分数 | 能否合并 |
|---|---|---|---|
| 第一轮 | 032fbba8 整块 | 6/10 | 不能 |
| 复查一 | 9bd14fdb（对比 032fbba8） | 8/10 | 能 |
| 第二轮（重构） | cb68ee75..b6b459ed | 8/10 | 能 |
| 复查二 | b6b459ed..f91a48f5 | 8.5/10 | 能，没有必改项 |
| fac53034 核对 | fac53034 | 维持 8.5/10 | 能 |

## 一、第一轮（032fbba8，6/10，不能合并）

必改：

1. 取消或组件卸载以后，录音照样上传保存。→ 已改：9bd14fdb 引入作废代号（Attempt：id + AbortController + rec，begin / drop / end / alive），每个 await 之后都核对。
2. 停录（stop）没有兜底，MediaRecorder 或识别不回 onstop 时面板一直卡着。→ 已改：9bd14fdb 加 recorder.ts 的 REC_STOP_WAIT_MS、speech.ts 的 SPEECH_STOP_WAIT_MS（都是 3000 ms），超时按失败收尾。
3. useVoice 一个文件 577 行，状态、计时、上传、界面写在一起。→ 已改：9bd14fdb 拆成纯 TS 的会话工厂和薄 hook；第二轮又把控制器拆成三个文件（createCore、createRecRoute、createSpeechPath）。

建议（S4–S18）：

- S4 重试循环在两处各写一份。→ 第二轮 39fbe21b 收成 send-error.ts 的 withTimeoutRetry（超时、归类、只在 network 时自动重试 1 次、外部 signal 取消），语义和原来一致。
- S5 打字和录音两套保存流程。→ 第二轮 7ae2dac7 收成一套（后来在 f91a48f5 里定成纯 TS 的 createSavedBatch）。
- S6 isObj、cut 重复。→ 第二轮已合并成一份。
- S7 错误名取法散在 8 处。→ 第二轮 ea671917 收成 platform/env.ts 的 errName、isAbortErr，加上 err-tag.ts 的 errTag；服务器那边用 errNameOf。
- S8 语言映射写了 5 处。→ 第二轮 54b56f0b 收成一处。
- S9 状态机里有用不到的状态。→ 9bd14fdb 清掉大部分；剩下的 cancelled 走不到，在复查一提出，第二轮用 viewStep 统一以后解决。
- S10 在 setTimeout 里开识别，不在用户手势里，iOS 可能拒绝。→ 9bd14fdb 已改成在手势里同步开。
- S11 切页卸载时丢掉录音。→ 第二轮改成模块级保留（kept 录音跨挂载）。
- S12 吞 click 把“改用打字”也吞掉了。→ 9bd14fdb 已改。
- S13 合并时先撤后存，存失败会丢数据。→ 9bd14fdb 改成先存后撤。
- S14 重试连点会发两次。→ 9bd14fdb 加防重入。
- S15 走不到的分支、没用的 MIME_RE、hold.ts。→ 9bd14fdb 已删。
- S16 RecordHost 测试有漏洞（断言碰不到真分支）。→ 9bd14fdb 已补。
- S17 e2e 靠环境碰巧失败。→ 9bd14fdb 改成 page.route 拦截，假 MediaRecorder 记 track stop 次数（micCounts、expectMicClosed）。
- S18 hold-input 缺测试。→ 已补。

## 二、复查一（9bd14fdb，8/10，可以合并）

结论：1、2、3、9（只剩 cancelled）、10、12–17 已解决；4–8、11 有意留到第二轮，第二轮都做了。

新提的问题和处理：

- 失败文案“录音没开起来”在停录超时时也显示，误导。→ 13dfa32e 给兜底超时单独一句新提示。
- net、quotaOut 的计数不再跨挂载。→ 13dfa32e 改成网络计数跨挂载。
- 合并以后撤不掉的旧条会重复。→ 13dfa32e 已处理。
- 纪念日撤销一直按失败算。→ 13dfa32e 给“纪念日撤不掉”单独一句。
- stop 超时 3 秒偏紧。→ 维持 3 秒，配了新提示，可以接受。
- plus-slot 里游离的注释。→ 已删。
- cancelled 状态走不到。→ 第二轮 viewStep 统一时去掉。

## 三、第二轮重构（cb68ee75..b6b459ed，8/10，可以合并）

结论：4–8、11 和复查一的遗留（viewStep 把 locked、zone、card、note 一起管；hold.reset 解耦；控制器拆成三个文件）都已解决。withTimeoutRetry 的语义和原来的两份一致，没有改变行为。

新提 6 条和处理：

1. 回调在 hook 和会话之间来回跳，读不顺。→ f91a48f5 已改（保存流程抽成纯 TS 的 createSavedBatch，回调单向）。
2. busy 随组件卸载放开，升级中心可能趁这时 reload，把录音丢掉。→ f91a48f5 已改：busy 跟着会话状态走，不跟组件生命周期。
3. 为测试加的 reset 钩子留在产品代码里。→ f91a48f5 已改：测试经 session 注入，删掉 reset 钩子。resetPlusForTest 留着，理由基本成立（动态 import 的模块级缓存）。
4. 换账号以后模块级的这一批、kept 录音、quotaOut 会残留到新账号。→ 复查二没核实，这次核过，不成立，见第六节。
5. quotaOut 谁都能随手改。→ f91a48f5 已改：只经 markQuotaOut 改。
6. env.ts 文件头说明和内容不符。→ f91a48f5 已改文件头，并加上 cacheErrKind。

## 四、复查二（b6b459ed..f91a48f5，8.5/10，没有必改项）

结论：第二轮的 1、2、3、5、6 已解决；第 4 条当时没核实。

新提 5 条（都不挡合并）和处理：

1. useVoice 返回值用 `...s` 把整个对象摊开，dispose、bind 也一起交给界面，zone 靠覆盖先后决定。→ fac53034 已改。
2. saved-batch 的 choose 没防重入，连点两下会存两条。→ fac53034 已改。
3. busy 不含 confirming，停在确认行时升级中心可能 reload。→ fac53034 已改。
4. 没有 boot 时悄悄不占 busy，日志里看不出来。→ fac53034 已改。
5. useTypeBar 换日子的一瞬间，旧日子的保存可能落到新日子。→ 没改。主持人认为窗口极小，我也认为可以接受。

## 五、fac53034 核对（4 条都改对了）

1. confirming 占 busy（voice-session.ts busyNow）：现在是 `v.capturing || v.status === 'uploading' || v.status === 'organizing' || v.status === 'confirming'`。
   - 核对：confirming 只从 organizing 进来，中间 busy 一直占着，不会断开；选完后经 confirmed → organizing → done 放开；dismiss 经 cancel → idle 放开。
   - 有测试：“停在确认行…busy 照样占着…选完才放开”。
   - 附带一点：确认行一直不选（比如切页走了），busy 会一直占到升级令牌 30 分钟自动作废。不会卡死升级，可以接受。
2. choose 防重入（saved-batch.ts）：加了 `let choosing = false;`，开头 `if (!batch || !first || choosing) return; choosing = true;`，store 后面接 `.finally(() => { choosing = false; })`。
   - 核对：成功和失败都会复位，失败后可以再点。
   - 有测试“连点两下只存一条”，断言 flow.go 只调 1 次。
   - 小点：打字条那份 createSavedBatch 放在 useMemo（依赖 day）里，换日子重建时标记跟着丢。和第四节第 5 条是同一个极小窗口，可以接受。
3. 没有 boot 时留痕（voice-session.ts go()）：
   ```
   const boot = getBoot();
   if (!boot) rlog('voice busy skip no_boot');
   free = boot?.upgrade.holdBusy('recording') ?? (() => undefined);
   ```
   核对：行为不变（没有 boot 就没有升级中心，也就不需要占），现在全局运行日志里留一行，可查。
4. useVoice 显式列出要交的动作：返回 `...v, asking, notice, cancelZone, lockZone, elapsed, level, finish, retry, sayAgain, allowMic, closeCard, closeNote, cancelUpload, dismissConfirm, choose, undo, undoOne, merge, closeNotice, discard, typeInstead`。
   - 核对：不再交出 dispose、bind；zone 只来自视图状态 v，不再靠覆盖先后。
   - VoiceState 是 ReturnType，界面要是用了没交的动作，类型检查会拦。
   - 我在 fac53034 上 grep 了 RecordHost、RecordPanel、VoiceNotice 用到的 v.* 字段（allowMic、asking、cancelUpload、cancelZone、capturing、card、choose、closeCard、closeNote、closeNotice、discard、dismissConfirm、finish、lockZone、locked、merge、note、notice、path、retry、sayAgain、secs、status、typeInstead、undo、undoOne、why、zone），全部在列表里或来自 v。

## 六、换账号残留（第二轮第 4 条）：不成立，关掉

- 看了 src/platform/session.ts 的 goToAuth（约 470–495 行）。
  - exe（`isTauri() && accountUiShown`）：`sessionRemovalsSettled().then(() => sessionDropState()==='ok' ? reloadPage() : showExitIncomplete())`。会话删完才整页重新载入（486–489 行）。删不掉时显示“退出没完成”，整个界面换掉，不会再挂 RecordHost，等删成了再重新载入。
  - 网页版走 `void openAuth()`。src/platform/native-bridge.ts:127 转给当前平台实现；native-bridge.test.ts:65 的用例写明“整页换成登录页（replace，“返回”不回到主 App）”。
- 结论：模块级的这一批、kept 录音、quotaOut 都活在页面的 JS 环境里，退出时会随整页导航或重新载入一起清掉，到不了下一个账号。这条关掉。
- 说明：网页版 openAuth 的具体函数体我没有逐行读，是根据 native-bridge 的转发、测试用例名和 session.ts 注释，加上主持人的核对下的结论。

## 必改

无。

## 遗留（不挡合并）

1. useTypeBar 换日子窗口：旧日子的保存可能落到新日子，打字条 createSavedBatch 重建时 choosing 标记也会丢。窗口极小，主持人和我都认为可以接受。
2. 确认行一直不选时，busy 最长占 30 分钟（到升级令牌作废）。不会卡死升级，可以接受。
3. resetPlusForTest：理由成立，以后可以考虑换成 vi.resetModules，删掉这个测试出口。
4. 停录兜底 3000 ms：已配专门提示；如果真机上慢机经常触发，再按日志调。
