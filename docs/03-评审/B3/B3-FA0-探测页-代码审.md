# B3 FA-0 录音探测页、CspLab 移出正式产物：代码审

- 审查人：独立代码审查员（只读，默认不通过，没改代码，没有 git add）
- 日期：2026-11-09
- 范围：
  - 新增：src/app/dev/VoiceProbe.tsx、VoiceProbe.module.css、src/platform/voice-probe.ts、src/platform/__tests__/voice-probe.test.ts、src/app/__tests__/voice-probe-leave.test.tsx、build/check_no_probe.mjs、tests/build/check-no-probe.test.ts；
  - 改动：src/app/dev/CspLab.tsx、src/app/App.tsx、build/build_web.mjs、.github/workflows/release-build.yml、src/app/__tests__/first-paint-pages.test.tsx、src/platform/first-paint.ts（只改注释）；
  - 主持人追加：check-no-probe.test.ts 去掉多余的 `@ts-expect-error` 和两处 `as`。
- 依据：B3 任务单 FA-0、Q1 第 ⑧ 条；docs/09-路线图/B3-voice-probe探测函数.md 第二节；安全审已经通过（9 分），本审只看代码质量和正确性。

## 结论

**有条件通过，7.5 分。必改 2 条，都是“录音中途出错或连按时麦克风关不掉”，各改一两行就行。** 改完以后，复跑 voice-probe 的两份单测，并为每条必改各补 1 条用例。

## 核对结果

1. **App.tsx 改成构建期常量以后，各模式的 dev 路由**
   - `buildInfo.env = envOf(VITE_PUBLIC_ENV ?? MODE)`。各条流水线的组合是：
     - deploy-preview、desktop 预览版：`VITE_PUBLIC_ENV=preview`、`--mode preview`；
     - release-build：`production`、`--mode production`；
     - e2e、本机开发：没设 VITE_PUBLIC_ENV，就用 MODE 本身。
   - 所以 `MODE === 'production'` 和原来的 `isProduction` 在所有现有组合下结果一样：预览、开发、e2e 照常挂 `#/dev-csp`（csp.spec、b2-motion-focus-retry 用的那一页），正式版不挂。正式版 exe 由 release-build 调用、吃同一份产物，也一样。
   - 别处没有再用 `isProduction`：只剩 `platform/env.ts` 的导出本身，加上注释和测试注释里的提法。见建议 S4。
2. **首屏的数可信。** 我把工作区复制成两份放在草稿目录：A 份是现状，B 份撤回 FA-0（CspLab 换回 HEAD 版，删掉探测页三个文件，App.tsx 换回 `isProduction`）。两份按 check_size 的稳定口径各量一遍：

   | 模式 | A 份（现状） | B 份（撤回 FA-0） | 差 |
   |---|---|---|---|
   | preview | 112809 B | 112827 B | **−18 B** |
   | production（填假的公开值） | 112727 B | 112856 B | **−129 B** |

   和前端 A 报的一致。另外要注意：**整个工作区的 preview、e2e 稳定口径是 112809 B，比基线 111404 B 多了 1405 B，已经超过 B3 的 1 KB 额度**（check_size 当场就报了）。这不是 FA-0 造成的，FA-0 本身是减少的；超出来的是工作区里别的未提交改动，需要主持人另外定位。
3. **check_no_probe 有没有误报、漏报**
   - 正向：A 份的正式构建，check_no_probe 通过。B 份（试验页用运行时判断）的正式构建能拦下来：main 块、CspLab 块、sw.js、manifest.json 都报了。e2e 构建也能报出 VoiceProbe 块和 sw.js。
   - 误报：正式版 `sourcemap: false`，压缩后注释不留，标记词在正式源码里只出现在注释中（App.tsx、first-paint.ts），不会进产物。按 latin1 扫二进制文件，碰巧撞上的概率可以忽略。
   - 漏报：只扫文件内容，不看文件名。不过探测块里有页面标题和函数路径，sw.js 的预缓存清单里也有块名，实际上漏不掉。见建议 S5。
4. **录音的取消和 pagehide 清理**
   - 卸载或 pagehide 时取走 `rec.current`：如果录音还没开始，就等它开始以后再 `cancel()`；`cancel()` 会停掉 MediaRecorder 和所有轨道。卸载时不会上传。这一点有单测覆盖。
   - 但有两处会漏，见必改 M1、M2。
   - 上传进行中卸载：两次 `uploadProbe` 没有取消信号，会继续传完，并且对已卸载的组件 setState（React 18 下不报错）。录音本身已经结束，不算录音泄漏，但会多花当天的探测次数。见建议 S1。
5. **50 秒计时器和录音器的状态机**
   - 到 50 秒时录音器自己停下，并关掉麦克风；松手时 `stop()` 拿到同一个已经 resolve 的 done，照常上传。`stop` 事件里会清掉计时器，`cancel` 里也清。
   - 两个小问题：到点以后，界面仍显示“Recording… release to upload”，见建议 S2；还没拿到麦克风权限就松手，会立刻 stop，得到一段空录音或极短的录音，探测页上这样可以接受。
6. **对照接口约定第二节**
   - 一致的部分：Authorization、X-Model（两个模型、没有默认值）、Content-Type 按实际格式标两种，回包只取约定的十个字段，transcript 最多 2000 字，404、410、429 等状态照原样显示。
   - ogg 这类不在白名单里的格式，按实际 mime 传，服务器会回 415，这符合探测的本意。
   - iPhone 的 AAC 在 50 秒时可能超过 600 KB，服务器会回 413，页面没有提前提示。见建议 S3。
7. **主持人追加的 check-no-probe.test.ts 改动：属实。** 文件里已经没有 `@ts-expect-error` 和 `as`，`findProbe`、`PROBE_MARKERS` 的类型直接从 .mjs 推断出来。我逐份跑了 tsc：tsconfig.node、app、shared、functions、sw 都是 0 错误。tsconfig.base.json 只是给别的配置继承的基础配置，单独跑本来就会报错，和这次改动无关。这个文件的 9 条单测全部通过。

## 必改

- **M1 连按时，前一次拿麦克风失败，会把后一次的录音句柄清掉，麦克风最长要开 50 秒才关。**

  位置：`VoiceProbe.tsx` 的 `begin`，`p.catch` 里无条件执行 `rec.current = null`。

  会出事的顺序：
  1. 第一次按下，开始拿麦克风（p1 还在等）；
  2. 松手：`finish` 清空 `rec.current`；
  3. 再按一次：p2 开始，`rec.current = p2`；
  4. 这时 p1 才被拒：`rec.current` 又被置成 null；
  5. 再松手：`finish` 看到 null，直接返回，p2 没人去 stop；
  6. 卸载、pagehide 时也拿不到 p2，麦克风要等 50 秒的上限才关。

  改法：catch 里改成 `if (rec.current === p) rec.current = null`，`setRecording(false)` 也按同样的条件执行。补一条“p1 被拒发生在 p2 开始之后”的单测。
- **M2 `startRecording` 拿到麦克风以后，如果 `new MediaRecorder(stream)` 或 `rec.start()` 抛错，麦克风轨道不会关**，系统的录音指示一直亮着，直到页面关闭。

  位置：`voice-probe.ts` 的 `startRecording`。

  改法：把 getUserMedia 之后的步骤包进 try，catch 里先 `end()`（停掉所有轨道）、清掉计时器，再把错误抛出去。补一条“构造器抛错时，轨道被 stop”的单测。

## 建议（不挡合并）

- S1 卸载时，给正在进行的上传一个取消信号（`uploadProbe` 接收外部的 AbortSignal，或者组件卸载时标记“不再继续传第二种标注”），免得离开页面后还在花当天的 100 次额度。
- S2 50 秒到点以后，按钮文字改成“已到上限，松开上传”之类的提示，或者到点自动结束这一段并上传。
- S3 上传之前，如果 `clip.blob.size` 超过 600 KB，直接在页面上提示“超过 600 KB，服务器会回 413”。也可以把上限改成按字节估算（AAC 大约 40 秒）。
- S4 `platform/env.ts` 的 `isProduction` 已经没人用，可以删掉。CspLab.tsx 第 13 行的注释还写着“App.tsx 的 isProduction 是运行时判断”，已经过时，要改。
- S5 check_no_probe 可以顺带检查文件名（例如 `VoiceProbe-*.js`），再多一层兜底。

## 测试记录

- `npx vitest run tests/build/check-no-probe.test.ts src/platform/__tests__/voice-probe.test.ts src/app/__tests__/voice-probe-leave.test.tsx src/app/__tests__/first-paint-pages.test.tsx`：4 个文件，31 条，全部通过。其中 check-no-probe.test.ts 单独跑 9 条，全部通过。
- tsc：tsconfig.node、app、shared、functions、sw 都是 0 错误。
- 构建对照：工作区复制成 A、B 两份放在草稿目录，依赖目录用联接，构建出的东西只留在副本里，量完连同副本一起删掉了，没有动工作区的 dist/。另外为 e2e 构建临时建的 dist/web-rev8851 也已删除。

## 复核（M1、M2、S1～S4），2026-11-09

**结论：通过，9 分。M1、M2 已解决，S1～S4 已采纳，没有新的必改项。**

复跑 voice-probe.test.ts、voice-probe-leave.test.tsx、check-no-probe.test.ts：3 个文件，38 条，全部通过。tsc、eslint、check_arch、正式构建、首屏 −2 B 这几项是前端 A 自报，我没有重跑；本次改动只动了探测页的懒加载块，不会影响首屏。

| 编号 | 复核 |
|---|---|
| M1 | **已解决。** `p.catch` 开头加了 `if (rec.current !== p) return`：前一次失败时，不会清掉后一次的句柄，也不会改它的状态和报错文字。onCap 回调同样只认当前这次的 p。有单测覆盖“第一次按下失败发生在第二次开始之后”这个顺序，卸载时第二次能被 cancel |
| M2 | **已解决。** getUserMedia 之后，从建录音器、挂监听、设计时器到 `start()` 都包在 try 里；catch 先清计时器、停掉所有轨道，再把原错误抛出去。构造器抛错、start 抛错各有 1 条单测，都断言轨道被 stop |
| S1 | **已采纳。** 组件挂上时建一个 AbortController，卸载时 abort。`uploadProbe` 在取令牌前、取令牌后各检查一次，传输中也接着这个信号取消，取消后回 `cancelled`；页面这边的循环在每次传之前、传之后都检查，取消以后不再传第二种标注，也不再 setState。StrictMode 下 effect 跑两遍时，第二次挂上会换成新的控制器，不影响 |
| S2 | **已采纳。** 到 50 秒录音器自己停下时调 onCap，按钮显示“Max 50 s reached, release to upload”，松手照常上传 |
| S3 | **已采纳。** 录音器没有设分片，录音过程中拿不到大小，所以提示放在每一段录完以后：≥ 540 KB 显示“Close to”，> 600 KB 显示“Over”，并说明服务器会回 413。这样做合理 |
| S4 | **已采纳。** `isProduction` 已经从 env.ts 删掉，源码里没有引用了，只剩 App.tsx 的一句注释提到它，是在解释原因，可以留着。CspLab 的注释已经改成和现状一致 |

**关于“单测里用同名 Error 代替 DOMException”：可以接受，测得到真实浏览器的行为。** 按 WebIDL 规范，DOMException 的原型继承自 Error.prototype，Chrome、Edge、Safari、Firefox 里 `DOMException instanceof Error` 都是 true，所以浏览器里走的就是 `${err.name}: ${err.message}` 这一支。单测用 name 为 NotAllowedError 的 Error，走的正是同一支，断言的显示文字也一样。jsdom 的 DOMException 不继承 Error，只是测试环境的差异。platform 那边的单测（构造器抛错、start 抛错、取消）用的仍然是真的 DOMException，而且只比较是不是同一个对象，不依赖 instanceof，所以也没有问题。

建议（不挡合并）：页面的判断可以改成看 `name` 和 `message` 两个字段，不再用 `instanceof Error`。这样就不依赖原型链，单测也能直接用真的 DOMException。
