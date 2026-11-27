# B3 BE-1 评测骨架 + voice-probe 引用链守门 代码审

- 审查人：独立代码审查员（只读，默认不通过）
- 日期：2026-11-09
- 范围：
  - `tests/ai/run-core.ts`、`tests/ai/run.ts`、`tests/edge/ai-eval-run.test.ts`
  - `tsconfig.node.json` 的 exclude 改动
  - 仓库根 `deno.json` 的 `check` 任务。注意：改的是根目录的 `deno.json`，`supabase/functions/deno.json` 没有改动，也不需要改
  - `tests/edge/voice-probe-guard.test.ts` 新加的“ai-voice/core.ts 引用链”一条
- 实跑：`npx vitest run tests/edge/ai-eval-run.test.ts tests/edge/voice-probe-guard.test.ts`，2 个文件、18 条全部通过。未跑 `deno check`，因为本机这一步要先执行 copy:shared，会生成 gen 目录，超出只读范围。

## 结论：有条件通过，8 分（必改 1 条）

## 逐项核对

| 重点 | 结论 | 依据 |
|---|---|---|
| 复制步骤是否和部署用同一套 | 是 | `run.ts` 用 `node build/copy_shared.mjs` 跑复制，CI、deploy-preview 的 `npm run copy:shared` 和 `publish.ps1` 第 6 步执行的也是这个脚本。脚本第 71 行会先 `rmSync` 清空输出目录，不会残留旧的 gen。复制失败就抛错、不跑评测。`parse-with-ai.ts` 等复制完才动态 import，测到的就是刚生成的那一份。 |
| 80% 限速算法 | 正确 | 每分钟最多 `perMin = floor(rpm×0.8)` 次，两次开始之间至少隔 `ceil(60000/perMin)` 毫秒。这样任意 60 秒内最多开始 `perMin` 次：n 次开始至少相隔 (n−1)×间隔 < 60000 毫秒，可推出 n ≤ perMin。间隔从上一句开始时计时，上一句花掉的时间算在里面；用例用 rpm 10、每句耗时 1 秒，断言 sleep 依次是 1000、6500……，对得上。 |
| 每天上限 | 本轮内正确，有一处局限 | `dailyCap = floor(rpd×0.8)`。一句只调一次 `generate`（parse-core 只有一处 parse 调用，没有内部重试），所以按句计数等于按请求计数。超出的句子进 `skipped`，有用例覆盖。局限：只按本次运行计，同一天跑第二次会重新从 0 开始算，见 S2。 |
| 单句出错不中断整轮 | 是 | `parse` 抛错时只记这一句：`reason='error'`，`errName` 填异常类型名，不记 message，所以不会带出正文；然后继续跑下一句。有用例。失败结果（invalid / quota / error）照记 raw，也有用例。 |
| 真调用只读 GEMINI_EVAL_KEY，读不到就停 | 是 | 非回放分支只调 `Deno.env.get('GEMINI_EVAL_KEY')`，读不到就抛错，`exit 1`。用法里写的是 `--allow-env=GEMINI_EVAL_KEY`、`--allow-net` 只放行 Google 的域名，Deno 权限层面也只给了这一个变量。小问题见 S3。 |
| --replay 结果不进仓库 | 是 | 回放模式的输出目录是 `Deno.makeTempDir`（系统临时目录）。复制步骤写的 `_shared/gen/` 已在 `.gitignore`。真调用才写 `tests/ai/reports/`。 |
| 引用链守门会不会漏 | 主路径够用，有几个小缺口 | 能拦住：`from '…'` / `import '…'`（含 `export … from`、`import type`）；非相对引用（绝对路径、`file:`、`npm:`、`https:`）一律算违规；动态 `import(` 直接判违规；顺着相对路径递归往下跟，并断言确实跟到了 `_shared/body.ts`、文件数 ≥ 5，证明不是空跑。注释里写的引用只会误报，不会漏。缺口见 S5。 |
| tsconfig / deno.json 改动 | 正确 | `run.ts` 用到 `Deno.*`，从 Node 的 tsconfig 里排除；同时加进 `deno task check`，类型检查没有出现空档。`run-core.ts` 不碰 Deno，仍归 Node 那边检查，Vitest 能直接 import。 |

## 必改

- **M1 报告名要在调用之前算好、校验好。**
  - 现状：`reportName(args.date, PROMPT_VERSION.parse, model)` 在 `runSet` 之后才执行，而它对模型名有字符限制（`^[a-z0-9][a-z0-9.-]*$`）。
  - 后果：如果 `--model` 带了大写字母、下划线，或者别的不认识的字符，会先把整套句子真调一遍，额度照扣，最后在算报告名时抛错，结果一行都没落盘。
  - 改法：把 `const name = reportName(...)` 挪到 `copyShared()` 之前，或者在 `parseArgs` 里就校验模型名。回放模式用的是常量 `REPLAY_MODEL`，不受影响。
  - 建议补一条用例：模型名不合法时，`parse` 一次都没被调。

## 建议（不卡通过）

- **S1 真调用分支先查密钥，再做复制和读句库。** 现在是先复制、再读句库，最后才发现没有密钥。顺序换一下可以早点失败，也少写一次 gen 目录。
- **S2 每天上限是按本次运行算的，跨运行不累计。** 同一天手动跑两次，合计会超过 80%。
  - 至少在用法注释里写明“同一天同一模型只跑一次”。
  - 或者开跑前查 `tests/ai/reports/` 里当天同模型的结果，把已经调过的句数扣掉。
- **S3 复制步骤的子进程会继承全部环境变量，包括 `GEMINI_EVAL_KEY`。** 现在 `copy_shared.mjs` 不读这个变量，所以没有实际风险。更稳的做法是给 `Deno.Command` 传 `clearEnv: true`，只放 `PATH` 等必要变量。这一条属于安全面，提一下即可。
- **S4 遇到额度用完（quota）就停下这一轮。** 现在拿到 quota 后还会接着调剩下的句子，每一句都会再次 429、白白消耗请求，报告里也会全是 quota。建议遇到第一个 quota（或连续 N 个）就停，把剩下的句子列进 `skipped`。
- **S5 引用链守门的小缺口。** 下面几种写法会漏过：
  - `Deno['env']`、`globalThis.Deno.env`，或者把 `Deno` 赋给别的变量再用（正则只认字面上的 `Deno.env`）；
  - 测试标题写了“不碰网络连接”，但没有检查 `fetch(`、`WebSocket`、`Deno.serve`。ai-voice/core.ts 这条链目前不引 gemini，也就不碰 fetch，所以眼下不漏，只是和标题对不上。
  - 建议把正则补成 `\bDeno\b(?!\.(?:Command…)` 这类写法，或者直接禁止链上出现 `Deno` 和 `globalThis`；再加上 `\bfetch\s*\(`、`WebSocket`。
- **S6 `run.ts` 主流程没有测试。** 下面这几项现在只靠 `deno check`（类型检查）和人工看：读不到密钥就停、回放输出在临时目录、复制失败就停、M1 的顺序。可以补一条 `deno test`，把 `Deno.Command` 和环境变量换成替身；或者至少在 voice-probe 守门那样的源码断言里查一遍，比如“非回放分支只有 `GEMINI_EVAL_KEY` 一处 `Deno.env`”“回放输出走 `makeTempDir`”。
- **S7 `parseArgs` 同一个参数写两次时，后一个会悄悄覆盖前一个。** 建议改成报错。

## 评分

正确性 8（M1） / 测试真实度 8（`run-core` 走真 `GeminiProvider` + 回放，`run.ts` 主流程没测） / 与任务单一致 8.5 / 可维护性 8，综合 8 分，有条件通过：M1 改完即可，不需要再审全文。

## 复审（2026-11-10）

**结论：通过，8.5 分（10 分制）。没有必改项。**（复审结论由主持人转达；同批安全审结论也是通过，没有必改项。）

第一轮各条，逐条核对已解决：

| 条目 | 处理 |
|---|---|
| M1 报告名在调用前算好、校验好 | `parseArgs` 里就按报告名规则校验模型名；主流程挪进 `run-core.ts` 的 `runEval`，外部动作全部注入，顺序定为“参数 → 查密钥 → 报告名 → 复制 → 读句库 → import → 调用 → 落盘”；补用例：模型名不合法、参数写重时一个动作都不做、一次都不调 |
| S1 先查密钥再复制 | 没有密钥（未设或空串）只查一次密钥就停，不复制、不读句库；有用例 |
| S2 每天上限只按本次运行计 | `run.ts` 用法注释和 `runSet` 注释写明：同一天跑第二次，`--rpd` 要自己扣掉上一次的 `meta.called` |
| S3 复制子进程不继承环境变量 | `Deno.Command` 用 `clearEnv: true`，只给 `PATH`、`SYSTEMROOT`；源码断言核对 |
| S4 遇到 quota 就停 | 第一个 quota 就停下这一轮，剩下的句子记进 `skipped`，结果新增 `stopped`（`quota` / `daily_cap` / null）；有用例 |
| S5 引用链守门的缺口 | 链上整词禁 `Deno`、`globalThis`、`fetch`、`WebSocket` 等（见下面安全审建议 7）；副本里加违规写法逐个验证变红 |
| S6 `run.ts` 主流程没有测试 | 按主持人意见不单独做；`runEval` 的顺序测试和 `run.ts` 源码断言已覆盖“没密钥就停、回放写临时目录、复制失败就停、M1 顺序” |
| S7 参数写两次 | 直接报错；有用例 |

复审和同批安全审提的小建议，都已补上：

| 来源 | 建议 | 处理 |
|---|---|---|
| 代码审复审 1 | `MODEL_NAME_RE` 挪到 `parseArgs` 前面 | 已挪 |
| 代码审复审 2 | 登记册写复审结果，本文件加“复审”一节 | 已写（本节） |
| 代码审复审 3 | 回放用法的 `--allow-write` 收窄 | 改成 `supabase/functions/_shared/gen` 加系统临时目录；按收窄后的权限实跑回放通过 |
| 安全审 4 | `--replay` 名字套白名单 | `^[a-z0-9][a-z0-9-]*$`；补用例：`../../x`、`a/b`、带点、大写、横线开头都被拒 |
| 安全审 5 | 模型名长度上限 | 64 个字符，和 `gemini.ts` 的 `MODEL_RE` 一致；补 64 收、65 拒的用例 |
| 安全审 6 | 评测结果不进仓库 | `tests/ai/reports/` 加进 `.gitignore`（`git check-ignore` 核对生效）；结果以工作流产物存档 |
| 安全审 7 | 守门正则补全 | 整词禁：`Deno`、`globalThis`、`self`、`window`、`Reflect`、`import.meta`、`eval(`、`Function(`（带不带 new）、`.constructor`、字符串形式的 `setTimeout` / `setInterval`、动态 `import(`、`fetch`、`WebSocket`、`EventSource`、`XMLHttpRequest`、`sendBeacon`、`Worker`、`indexedDB`、`caches`、`BroadcastChannel`、`process.env`、`createClient`、`postgres`、`@supabase/`。只去掉整行 `//` 注释（`gemini.ts` 第 8 行的说明里有 fetch 一词），行尾注释和字符串照扫。副本里 13 种写法逐个验证变红，副本已删。AST 那条按主持人意见先不做 |

注意：AI 句库 5.3 写的是“每句的原始输出和校验后结果存 `tests/ai/reports/<同名>.json`”，安全审建议 6 以后这个目录不提交，句库那一句要请评测员改成“以工作流产物存档”。
