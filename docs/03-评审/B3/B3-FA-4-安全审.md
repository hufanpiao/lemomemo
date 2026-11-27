# B3 FA-4 安全审：AI 整理开关 + Claude 连接页

- 审查员：独立安全审查员（只读）
- 日期：2026-11-10
- 范围：工作区 git diff（S23 已提交在 42e6305，不算在内）。具体文件：src/features/plus/ui/PlusSettings.tsx、src/features/plus/hooks/usePlusSettings.ts、src/features/plus/data/claude-link-api.ts、src/features/onboarding/ui/ConsentRoute.tsx，以及顺带核对的 core/ai-settings.ts、useConsentWiring.ts、app/router.ts 的 backOrReplace、supabase/migrations/0001_core.sql 中 api_tokens 的策略。
- 对照依据：架构 15.5（docs/10-架构/架构设计-v4.md:4741）、第三轮 X5（同文件 :369）。

## 分数

| 块 | 分数 | 结论 |
|---|---|---|
| 一、AI 整理开关 | 9 / 10 | 通过 |
| 二、Claude 连接页 | 8.5 / 10 | 通过 |
| 合计 | 8.5 / 10 | 通过（及格线 8） |

## 必改

无。

## 建议

1. **断开后要拿服务器结果核实一次**（中低）。位置：src/features/plus/hooks/usePlusSettings.ts:115-122、src/features/plus/data/claude-link-api.ts:248、:310-311。
   - 现在的做法是：PATCH 只要没报错，界面就直接显示“已断开”。
   - 问题是 RLS 的 tok_upd 策略带着 `private.is_active()`（0001_core.sql:367-368）。账号不是 active 状态时，PATCH 一行都不会改，但也不报错，界面就会误报“已断开”。
   - 建议二选一：在 revokeAll 后面加 `.select('id')`，看返回的行数；或者断开成功后调一次 `load()`，以服务器读到的 connected 为准。
2. **超时以后显示的状态可能不对**（低）。位置：claude-link-api.ts:277、usePlusSettings.ts:99-101、:115-117。
   - 8 秒超时一律报“没网”，但这时请求可能已经在服务器上执行完了。
   - 断开的情况：码其实已经吊销，开关却还显示“开”。往安全的方向错，不会误报“已断开”。
   - 生成的情况：码已经建好、占掉一个名额，明文却拿不到了。
   - 建议出错后都调一次 `load()` 刷新状态；生成超时的提示文字可以补一句“如果连接码已满，先断开连接再生成”。
3. **明文码一直留在屏幕上**（低）。位置：PlusSettings.tsx:134-142。
   - 现在离开页面码会清掉，这点属实。但只要页面一直开着（比如切到后台），明文码就一直显示。
   - 建议在 visibilitychange 变成 hidden 时，或者显示超过几分钟后，执行 `setCode(null)`。
4. **writeAiSwitch 在类型上允许写 true**（低）。位置：src/core/ai-settings.ts:25。
   - ESLint 规则 lemo/settings-ai-write（build/eslint-rules/index.js）不管谁调用 `writeAiSwitch({ key: 'ai.enabled', value: true })`。
   - 现在只有告知页（useConsentWiring.ts:96）这样调用。服务器的 aiAllowed 也会比对同意版本，所以这不是安全漏洞，只是防回退的护栏还缺一块。
   - 建议在规则里加一条：写 true 的调用只允许出现在 onboarding 下面。

## 核实要点（属实的，没有扣分）

- **绕过告知页**：
  - 写 `ai.enabled` 的地方只有两处：usePlusSettings.ts:135 只写 false；useConsentWiring.ts:96 在本人勾选同意后（onDone(agreed) 为真，:105）写 true。
  - 调 `record_consent` 的只有 consent-api.ts:267。
  - 设置开关打开时只做跳转（usePlusSettings.ts:154-156），不写库，也不调 RPC。
  - 就算有人在本机篡改出 true，服务器的 aiAllowed 也会比对 `consent_policy_ver`（架构 :2846），照样不认。
- **开放跳转**：
  - ConsentRoute.tsx:18-19 只判断 `params[0] === 'ai'`，目标写死为 settings/ai。
  - backOrReplace（router.ts:241-264）的处理：如果历史记录里有应用内 navigateSub 留下的记号，就退一步；没有记号（比如外部直接打开 #/onboarding/ai）就用 replace 跳到 #/settings/ai。
  - 两种情况都不会根据参数里的地址去跳转，不存在开放跳转。
- **明文码**：
  - 只放在 hook 的 state 里（usePlusSettings.ts:75、:103），不存储，也不打印日志。
  - 显示为纯文字 `<span>`，可以全选复制（PlusSettings.tsx:138、TypeBar.module.css:130-133），没有做成链接，也不进 URL。
  - 生成请求走 POST 正文，带 `cache: 'no-store'`（claude-link-api.ts:253-259）。
  - 页面卸载后码就没了；断开时也会顺带清掉（usePlusSettings.ts:120）。
- **吊销全部有效码**：
  - 执行的是 `update revoked_at where revoked_at is null`（claude-link-api.ts:248），RLS 把范围限定在本人的行（0001_core.sql:367-368）。
  - 列级授权只放开了 `revoked_at`（:372）。
  - 触发器把时间改成服务器的 `now()`，已经吊销的码不能再改（:354-361）。
  - 过了 180 天、还没吊销的码也会一并吊销，没有坏处。
- **失败和离线不会误报“已断开”**：
  - 离线时请求根本不发出去（:271）；出错或超时时，notice 是错误码，开关保持原状（usePlusSettings.ts:115-117）。
  - 只有服务器没报错，才会显示“已断开”（例外情况见建议 1）。

## 复核（2026-11-10，前端 A 按 4 条建议改完后，只读）

分数：维持 8.5。4 条建议都已解决，必改项没有。

| 建议 | 结论 | 核实位置 |
|---|---|---|
| 1 断开后用服务器结果核实 | 已解决 | usePlusSettings.ts 的 disconnect：PATCH 之后不管成败，都用 `listLinks` 重读一遍。重读后仍有有效码，就报 `failed`（PATCH 报过错就报那个错误码），不显示“已断开”；重读失败就把界面置成 error、不显示“已断开”。只有重读确认一个有效码都没有了，才显示“已断开”。账号不是 active、RLS 一行都没改的情况已经兜住。 |
| 2 超时后刷新状态 | 已解决 | create 出错后调 `load()`；disconnect 同上，统一以重读结果为准。另外，断开和生成共用一个 `running` 锁（ref），连点不会发出两次请求；`finally` 里会解锁、清掉 busy。 |
| 3 切到后台时清掉明文码 | 已解决 | 页面切到后台（visibilitychange 为 hidden）就 `setCode(null)`，切回来也不再显示；卸载时会摘掉监听。 |
| 4 ESLint 限定写 true 的位置 | 已解决（有残余，见下） | 在 build/eslint-rules/settings-ai-write.js 加了第 ③ 条（:6-7、:35-55、:109-111）。onboarding 以外的地方，参数必须是对象字面量，而且要么写 ai.vault，要么写 ai.enabled 且 value 是字面量 false。三个样例覆盖了：写 true、value 是变量、整个参数是变量（报 3 处），以及 onboarding 下写 true、别处关掉（都不报）。 |

### ③ 条能不能绕过去

问到的两种写法都拦得住：
- **先存进变量**：`writeAiSwitch(sw)` 的参数不是对象字面量，会报（:44）。
- **展开对象**：`{ ...x }` 里有 SpreadElement，不是 Property，会报（:48）。
- 另外 `value: on`、`value: !0` 这类非字面量的值也会报。

仍能绕过的写法（静态规则天生管不到，都是低风险）：
1. **改名调用**：`import { writeAiSwitch as w }`、`const f = writeAiSwitch`、`(0, writeAiSwitch)(…)`、`ns['writeAiSwitch'](…)`、`writeAiSwitch.call(…)`。isSwitchCall（:35-37）只认这两个函数名本身，以及不带方括号的 `x.writeAiSwitch`。
2. **ai.vault 一律放行**：:53 只要看到 key 是 `ai.vault` 就放行，不检查 value。所以 `{ key: 'ai.vault', value: true } as unknown as AiSwitch` 能通过（:43 会先剥掉 as）。这条有类型和服务器 settings_guard 的 vault_required 两道兜底，不构成漏洞。
3. **借 onboarding 里的包装函数**：可以在 onboarding 里写一个透传 value 的函数，再从别处调用。onboarding/index.ts 只导出 routes 和 ConsentGate，再加上 eslint-plugin-boundaries 拦着跨功能引内部文件，这条路基本走不通。

这几种绕过之所以都不算漏洞：本机就算写进了 true，服务器 aiAllowed 也要比对 `consent_policy_ver >= min_consent_ver`（架构 :2846），没有有效同意就不送 AI。这条规则只是防回退的护栏。

建议（可选，不影响分数）：
- isSwitchCall 改成按 import 的来源解析，认 `ImportSpecifier.imported.name`，这样能挡住第 1 条的改名。
- :53 对 ai.vault 也要求 value 是字面量 false。
