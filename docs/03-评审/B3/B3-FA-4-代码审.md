# B3 FA-4 代码审：设置 › 语音与 AI、在 Claude 聊天里记事

- 审查人：独立代码审查员（只读，默认不通过，没改代码，没有 git add）
- 日期：2026-11-10
- 范围：工作区里还没提交的 FA-4 改动（S23 已在 42e6305 提交，不算在内）
  - 接线：plus/index.ts、settings 的 SettingsHome、SettingsSub、SettingsPage、settings 词条和两份测试、first-paint-graph；
  - 数据层：ai-usage-api.ts、claude-link-api.ts、PlusSettings.tsx、usePlusSettings.ts 和对应测试；
  - 其他：TypeBar.module.css 的 .code、.meter、.meterFill、.plainAct，plus.set.* 词条，ConsentRoute.tsx 和 consent-wiring.test.tsx。
  - vite.config.ts、build/check_preload.mjs、check_size.mjs 的预加载表去重属于 B2-UI-b V2，不在本审范围；它会影响首屏的数，所以在第三节一并说明。
- 依据：R-368、R-369；定稿线框 s13；架构 15.5 第三轮安全 X5；token-admin 的 core.ts

## 结论

**通过，8.5 分。没有必改项，有 6 条建议。** 首屏额度要不要改成 1083，建议等预加载表去重定下来以后，按实际提交的树重量一次再决定，见第三节。

测试：`npx vitest run src/features/plus src/features/settings src/features/onboarding tests/build/first-paint-graph.test.ts tests/build/preload-dedupe.test.ts tests/build/check-preload.test.ts`，61 个文件，749 条，全部通过。

## 一、三处重点

1. **Claude 开关的语义：对。**
   - 开关的状态就是 `view.state.connected`，判断条件是“没吊销而且建了不到 180 天的码至少有一个”，和 token-admin 的 `activeCount` 口径一致（`claude-link-api.ts:43-56`，`token-admin/core.ts:79`）。
   - 打开调 `create`，生成一个码，明文只放在 hook 的 state 里，不存，也不做成链接（`PlusSettings.tsx:138`）。关掉调 `disconnect`，把所有还有效的码全部吊销，刚生成的明文也一起清掉（`usePlusSettings.ts:109-123`）。
   - 读不出来、或者正在处理时，开关灰掉（`PlusSettings.tsx:125`）。
   - 服务器最多同时 5 个有效码，所以开关只有在关着（0 个有效码）时才能打开，正常情况下碰不到 409 too_many。
2. **AI 整理开关：对。**
   - 打开一律调 `navigateSub('onboarding','ai')`，不分情况，也不直接写 ai.enabled（`usePlusSettings.ts:136,154-156`）。
   - 关掉走 core/ai-settings 唯一的写法 `writeAiSwitch({key:'ai.enabled', value:false})`，写不进去时显示错误（`usePlusSettings.ts:135,158-160`）。
   - 告知页用 `params[0] === 'ai'` 判断是从设置进来的，做完（同意、不同意、跳过）都用 `backOrReplace('settings','ai')` 回到 设置 › 语音与 AI，不多压一条历史（`ConsentRoute.tsx` 的 finish）。consent-wiring 测试覆盖了这条路径。
3. **首屏净增：见第三节。**

## 二、其他核对

- 接线：plus/index.ts 只多了一个 lazy 导出 `PlusSettings`（和 R-368 的方案 a 一致）。设置首页两行的值都包在 `QuietBoundary` 加 `Suspense` 里，没加载到之前空着；二级页 `SUBS` 加了 ai、claude，返回键的 testid 也有。
- 用量：读不到时写“读不出来”，不当成 0 次；读到“已用完”才记进本机额度（`ai-usage-api.ts:66-68`）。进度条带 `role="progressbar"`，最小值、最大值、当前值都有，当前值不超过上限。
- 麦克风那一行在 exe 里不显示（`usePlusSettings.ts:45-46`）。说明文字按设备分两套（R-367、R-369 ③，`PlusSettings.tsx:65`）。

## 三、首屏净增（112883、基线 111826、limitBytes 改成 1083）

- 我在独立目录（`dist/web-rev8852`，`--mode e2e`，量完已删）构建现在的工作区，check_size 报的是 **“B3 首屏净增：982 B / 额度 1024 B（基线 111826 B）”**，也就是稳定口径 **112808 B**，**比前端 A 报的 112883 少 75 B，没有超出 1024**。
- 差别来自工作区里另一项还没提交的 B2-UI-b V2 改动：vite.config.ts 的预加载表去重（`dropHostLoaded`）。check_size 当场核对了 58 处懒加载，全部通过。A 量那一次应该还没有这项去重。
- 另外，R-368 里写的是 112868 B（B3 净增 1042 B，比 S23 多 59 B），A 这次报的是 112883 B。两个数差 15 B，需求记录里的账和当前的实测对不上。
- **建议（S1）：limitBytes 先别改成 1083。** 两种情况分开处理：
  - 如果 FA-4 和预加载表去重一起合并：不用放宽，净增 982 B，还在 1024 以内。
  - 如果 FA-4 先单独合并：就按 FA-4 那棵提交树重新量一次，把 R-368 的数改成实测值，再按负责人 +80 B 的上限定 limitBytes。现在 112883 对 1083 只剩 26 B，下一次改动很容易又顶破。

## 必改

无。

## 建议（不挡合并）

- **S1** 首屏额度见第三节：limitBytes 和 R-368 的数，都等合并方式定了以后，按实际提交的树重量一次再写。
- **S2** `usePlusSettings.ts:93-96`：`busy` 是 state，要等重新渲染以后开关才灰掉。手快连点两下，可能在灰掉之前发出两次 create，生成两个码：界面只显示后一个，前一个明文没人看到，但它仍然有效，而且占掉当天 10 次里的 1 次。建议加一个 ref 防重入，`disconnect` 也一样。
- **S3** `PlusSettings.tsx:118`：关掉开关会当场吊销所有连接码，不用确认。手一滑碰到，Claude 那边就得重新粘一次新码。可以考虑关掉时先确认一下，或者给一个“撤销”提示条。这属于产品决定，R-369 没有写，需要由主持人定。
- **S4** `ai-usage-api.ts:68`：`d.remember(0, …)` 如果 reject，会落进外层的 catch，界面就显示“读不出来”，可这时用量其实已经读到了。建议单独包一层 try/catch，记不进去就算了。
- **S5** `usePlusSettings.ts:158-160`：`turnOff()` 没有接 reject。现在的 `writeAiSwitch` 不会抛错，但测试替身或者以后改了实现，就可能出现未处理的 Promise 拒绝。加 `.catch(() => setFailed(true))` 会更稳。
- **S6** `PlusSettings.tsx:38-43,92-95`：每次进设置首页，两行的值会各发一次请求，一次是 `my_ai_usage`，一次是读 `api_tokens`；进二级页又各读一次。数据量很小，但离线时首页那两行会是空的或者显示“读不出来”。如果想省，可以在模块里缓存几十秒。

## 复审（2026-11-10）

**结论：通过，9 分。没有必改项。S2、S4、S5 已解决；新增的部分没有引入新问题，有 3 条小建议。**

复跑 `tests/arch/eslint.test.ts`、`src/features/plus`、`src/features/settings`：52 个文件，731 条，全部通过。按主持人的安排，这次首屏不量。

### 上一轮的建议

| 编号 | 复审 |
|---|---|
| S2 连点生成两个码 | **已解决。** `create` 和 `disconnect` 共用一个 `running` ref，正在跑时直接返回，在 finally 里复位（`usePlusSettings.ts` 的 create、disconnect） |
| S4 记本机额度出错时显示“读不出来” | **已解决。** `remember` 单独包了 try/catch（`ai-usage-api.ts:58-63`），记不进去不影响显示 |
| S5 turnOff 没接 reject | **已解决。** then 的第二个参数也会把 failed 设成 true（`useAiOrganize`） |
| S1、S3、S6 | 不在这次范围内：S1 由主持人按提交树重新量；S3 是产品决定；S6 没改，仍然是建议 |

### 新增部分

- **断开、生成之后按服务器重读：对。**
  - 断开：不管 PATCH 成功还是失败，都重新 `listLinks`。重读后还连着，就提示失败；不连了，才提示“已断开”。这样一来，RLS 一行都没改却不报错、或者超时但其实已经断开，这两种情况都能显示对。
  - 生成：失败时（例如超时，服务器其实已经建好了）也重读一次。
- **页面切到后台时清掉明文码：对。** 监听 visibilitychange，切到 hidden 就清空 code，卸载时摘掉监听。
- **ESLint A31：对。**
  - 按 import 来源认 writeAiSwitch 和 writeAiSwitchSettled，改名导入、命名空间导入都认得出来。改名后的函数如果被当成值来传，在 onboarding 以外一律报错。
  - ai.enabled 只能在 onboarding 下写 true；ai.vault 在哪里都只能写字面量 false。参数如果不是对象字面量、看不出写的是什么，也报错。
  - 新增的 4 个 a31 样例（不该过的）和 3 个 ok 样例（该过的），在 eslint.test 里都按预期报错或放行。
- **韩文那一行：可以。** 连接码一行改用 `SettingsRow`，左边 `.codeLbl` 放名称，右边 `.codeVal` 放值，值在右栏里换行、不省略，读屏顺序还是先名后值。
- **探测页入口：正式构建会整块删掉，已实测。**
  - 我在草稿目录复制了一份工作区，填上假的公开值，跑 `--mode production` 构建，check_no_probe 通过。
  - SettingsPage 块里已经没有 `csp-lab-entry`，也没有跳转 `dev-csp` 的调用。正式产物里只剩词典里的一条 `"settings.about.probe":"录音探测（试验）"`，这和注释里说的一致。
  - main 块里的 `dev-csp` 是 router 路由名列表里原来就有的，不是这次带进来的。
  - 副本和它的构建结果量完都已经删掉。
- **PlusSettings 的测试拆成了两份：** 两份都通过。

### 建议（不挡合并）

- **R1** `usePlusSettings.ts` 的 create：生成请求还在路上时页面切到后台，回包会在后台照样 `setCode`，切回来以后明文码仍然显示，等于绕过了“切到后台就清掉”。建议在 `setCode(r.value)` 之前看一下 `document.visibilityState`：如果是 hidden，就不显示明文码，改为提示“已生成，请重新生成以查看”，或者直接重读。
- **R2** A31 规则还有两处认不出：`const f = ns.writeAiSwitch` 这种把命名空间成员当值传的写法，以及 `await import('…/ai-settings')` 动态导入。现在仓库里都没有这样的写法，可以先登记，以后需要时再补。
- **R3** 探测页的词条 `settings.about.probe` 会留在正式版的词典里。它是无害的，而且会随 voice-probe 同一个 PR 一起删掉；也可以把这一句挪进只有非正式版才加载的词条。

### 复审建议的处理（主持人 11-10 定）

- **R1 已改**：`usePlusSettings.ts` 的 create 在显示明文码之前看 `document.visibilityState`，是 hidden 就不显示，改为按服务器重读开关状态；PlusSettings-claude.test.tsx 补了 1 条用例。
- **R2 登记，不做**：A31 规则认不出 `const f = ns.writeAiSwitch`（命名空间成员当值传）和 `await import('…/ai-settings')`（动态导入）两种写法。现在仓库里都没有，以后真出现时再给规则补上。
- **R3 不做**：`settings.about.probe` 留在正式版词典里，无害，随 voice-probe 同一个 PR 删。

## 复核 R1（2026-11-10，提交 9abed23 之后的工作区改动）

**R1 已解决。没有必改项。**

- `usePlusSettings.ts:119-123`：生成成功、回包回来时，如果 `document.visibilityState === 'hidden'`，就不执行 `setCode`，只按服务器重读一次开关状态（`load()`）。这一步放在 `live` 检查和失败分支之后，所以只对“生成成功但页面在后台”这一种情况起作用。
- `PlusSettings-claude.test.tsx` 新加了一条用例：请求还在路上时切到后台，回包到达以后，页面上找不到明文码；`list` 被调了 2 次；开关显示已连接。这份文件跑下来 20 条，全部通过。测试里的假码用的是 `lemo_` 开头的占位值，不是真码。
- 附带说明（不算必改）：这种情况下，用户看到的是“已连接”，但看不到码。要拿到码，得先断开再重新生成。如果想说得更清楚，可以在这种情况下加一句提示“已生成，切回来后不再显示，需要的话断开后重新生成”。
