# B3 前端探测页 FA-0 安全审查

- 审查员：独立安全审查员（只读，默认不通过）
- 日期：2026-11-09
- 对象（未提交）：src/app/dev/VoiceProbe.tsx、VoiceProbe.module.css、src/platform/voice-probe.ts 和它的单测；build/check_no_probe.mjs、tests/build/check-no-probe.test.ts；src/app/dev/CspLab.tsx、build/build_web.mjs、.github/workflows/release-build.yml 的改动。为了核对，还读了 src/app/App.tsx 的 devRoutes 和 src/platform/env.ts 的 isProduction。
- 依据：B3 任务单 Q1 第 ⑧ 条、R-68；后端 voice-probe 的安全审（B3-voice-probe-安全审.md）。

## 结论

**通过，9 / 10，没有必改项。**

## 前端 A 自述逐条核实

1. **请求头和超时：属实。**
   - 请求带 `authorization: Bearer <JWT>`、`apikey`（公开的 anon key）、`content-type`、`x-model`，`cache: 'no-store'`，30 秒后用 AbortController 中止。
   - 地址固定是 `${buildInfo.supabaseUrl}/functions/v1/voice-probe`，凭据只发往自家函数。
   - content-type 只取自 `labelsFor` 给出的几种固定标注，不在里面的才原样用浏览器报的类型（服务器会回 415）；x-model 只能选 PROBE_MODELS 里的两个。
   - 令牌先向 supabase-js 要（过期会自动换新），要不到再读本机存的令牌；都没有就不发请求。
2. **回包只取约定字段：属实。** `replyOf` 逐个取 model、mime、raw_type、bytes、gemini_http、gemini_ms、total_ms、result、transcript、error，字符串截长（转写 2000 字，其余 120 字），数字只认有限值，多出来的字段不看。页面用 React 渲染文本，不用 innerHTML，转写里就算有标签也只会当文字显示。
3. **录音只在内存，页面不显示账号信息：属实。**
   - 录音片段只放在局部数组里，停止时拼成 Blob，然后清空数组。
   - 页面状态 `segments` 只存 mime、大小、时长、模型和回包，不存 Blob；传完以后 Blob 没有引用，会被回收。
   - 没有 IndexedDB、localStorage、Cache 写入，不引 perm.ts（连麦克风授权结果都不记）。
   - 页面不读也不显示邮箱、user_id；出错只显示 `err.name: err.message`。
   - 页面上有一句提示：只念事先准备好的测试句子，不要说真实姓名、电话、地址。
4. **正式构建删掉探测页，并有两道检查：属实。**
   - 删除：CspLab.tsx 里 `import.meta.env.MODE === 'production' ? null : lazy(() => import('./VoiceProbe.tsx'))`，MODE 在构建时被替换成字面量，正式构建时这个动态 import 整个被删掉，VoiceProbe 和 voice-probe.ts 都不会生成代码块。
   - 检查一：build_web.mjs 在 `mode === 'production'` 时跑 check_no_probe。
   - 检查二：release-build.yml 构建后不论模式再跑一次 `--dir dist/web`。所以即使哪天正式构建换了模式名、导致常量没生效，这一步也会拦住。
   - check_no_probe 会扫目录下全部文件，搜 `voice-probe`、`VoiceProbe`、`Voice probe (R-68)` 三个标记，搜到就退出码 1；目录不存在时 readdirSync 会抛错，也是失败，不会因为没东西可扫而误判通过。函数地址字符串 `voice-probe` 压缩以后也会留在代码里，所以就算组件名被压缩掉，也搜得出来。

## 前端 A 顺带报的已有问题：CspLab 一直在正式产物里

- **风险等级：低。**
  - App.tsx 的 `isProduction` 是运行时判断（`buildInfo.env === 'production'`），打包时没被当成常量删掉，所以 CspLab 的代码块确实在正式产物里，但正式版不挂这个路由，用户通过任何地址都进不去。
  - 这一块里只有 Radix 对话框、弹层、动效的演示，不读数据、不发请求、没有凭据。攻击者最多能下载到这份 JS，执行不了任何东西。
  - 主要影响是多了一份没用的代码。另外，加了探测页以后，如果 CspLab 没有自己用构建期常量挡一下，探测页就会跟着进正式产物；这一次已经用 MODE 常量挡住了，check_no_probe 也兜着。
- **修法核实：方向对。** 把 App.tsx 的 devRoutes 改成按 `import.meta.env.MODE === 'production'` 这类构建期常量判断，打包时整条 `import('./dev/CspLab.tsx')` 会被删掉，和这次 VoiceProbe 的做法一样。改完请照 check_no_probe 的做法，在正式构建后加一条断言：产物里搜不到 CspLab 的标记（比如它的 testid 或标题）。我在这一轮只确认了方向，A 的改动出来以后可以顺带看一眼。

## 建议（不阻塞）

1. **离开页面时没有停麦克风。** 正在录的时候直接离开探测页（换地址、组件卸载），`startRecording` 没有收尾，麦克风会一直开着，直到 50 秒上限才自动停。建议在组件卸载时调 `cancel()`。这只是一次性的开发页，影响小。
2. 探测页和后端 voice-probe 写明同一个 PR 下线，下线时把 CspLab 里那段懒加载、check_no_probe 和 release-build 那一步一起删干净（文档的下线清单里已经列了）。
