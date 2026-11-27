# B2 代码审查 · p4-ci-nofx（CI webkit 上给 8 条动效时序用例关掉 backdrop-filter）

- 审查人：独立代码审查员（只读，默认不通过，10 分制，8 分及以上才算通过）
- 日期：2026-11-06
- 对象：补丁 `scratchpad/p4-ci-nofx.patch`（基于 9d40848，只改测试）
  - `tests/e2e/webkit-ci-nofx.ts`：名单、`NOFX_RULE`、`needsNoFx`
  - `tests/e2e/session-fixture.ts`：在 auto fixture 里用 `addInitScript` 加构造样式表
  - `tests/build/e2e-webkit-nofx.test.ts`：把关测试
- 补丁没打进工作区，把关测试没在本机跑；用例正文按 9d40848 的 spec 核对

## 结论：不通过，7.5 / 10

做法本身是对的。第七轮二分（D 组全关模糊后静止 62fps、打勾 59.5fps；E 组改 2px 没改善）已经说明，慢的是 CI Linux webkit 软件合成下的 backdrop-filter，不是产品问题。
只在测试环境里、按名单关掉，产品代码不动，chromium 和本机照常开模糊，这正是 p3-anim 审查里建议的第 2 条路。
名单里 8 条逐条看过，都不在断言玻璃观感，测试没有被实质削弱。
不通过的原因只有一个：把关测试“不许在别处另开口子”那一条只查了 5 个写死的文件，新建一个 spec 或 fixture 就能绕过去。

## 必改 M

### M1 “不许另开口子”只查 5 个写死的文件，新文件随便就能绕过
- 位置：`tests/build/e2e-webkit-nofx.test.ts` 最后一条用例（只扫 `csp-fixture.ts`、三个名单 spec、`b2-tabbar-transition.spec.ts`）
- 绕法：
  - 在任何别的 spec 或新 fixture 里 `import { NOFX_RULE } from './webkit-ci-nofx.ts'` 自己注入；
  - 或者干脆不引这个文件，自己写一段 `addInitScript` 加 `backdrop-filter: none`（`adoptedStyleSheets` 或 `<style>`）。
- 这两种把关测试都发现不了。现在 tests/e2e 下有 55 个 ts 文件，10 个已经在用 `addInitScript`，再加一处很容易混进去。
- 要求：
  - 改成遍历整个 `tests/e2e/**/*.ts`：除了 `webkit-ci-nofx.ts` 和 `session-fixture.ts`，任何文件出现 `webkit-ci-nofx`、`NOFX_RULE`、`needsNoFx` 都报错；
  - 再加一条：除了 `webkit-ci-nofx.ts`，任何文件里出现关模糊的写法（`backdrop-filter:\s*none`、`backdropFilter\s*=\s*['"]none`、`-webkit-backdrop-filter`）都报错；
  - `session-fixture.ts` 里只准出现一次 `needsNoFx(`。

## 建议 S

- S1 观感检查只扫用例自己那一段正文，正文里调用的 helper 看不到。
  - 例子：两条 N1 的正文只有一行 `ghostRun(...)`，真正的取样逻辑在文件前面的 `ghostRun` 里；以后有人把截图对比或读 backdrop-filter 写进 helper，`LOOK_MARKERS` 是查不出来的。
  - 建议 `bodyOf` 再往下展开一层：找出正文里调用的本文件顶层函数名，把这些函数的源码也拼进来一起查；或者要求名单 spec 的整个文件不含 `toHaveScreenshot`、`.screenshot(`、`backdrop`、`toMatchSnapshot`。
- S2 `LOOK_MARKERS` 有漏项：没有 `toMatchSnapshot`、读像素的 helper（如 `pixels(`、`dist(`）、`getComputedStyle(...).filter / boxShadow / backgroundColor` 这类读材质的写法。建议补上。
- S3 名单“写死副本”和名单放在同一个仓库里，同一个提交两边一起改就过了，只能算减速带。建议名单每一条带一个评审记录编号（比如 `'…': 'B2-代码审查-p4-ci-nofx'`），把关测试检查那份评审文件存在；或者在 CODEOWNERS 里把这两个文件交给审查人。

## 低 L

- L1 `needsNoFx` 只比 `testInfo.title`（最后一级名字）和文件名（basename）。同一文件不同 describe 里有同名用例，或者别的子目录有同名 spec，都会被一起关掉。建议用 `testInfo.titlePath.join(' › ')` 和相对 `tests/e2e/` 的路径做键。
- L2 关了模糊的用例会写进 annotation，挺好；建议 CI 汇总里再打一行“本次关模糊的用例数 = 8”，名单悄悄变长时一眼就能看到。
- L3 `NOFX_RULE` 用的是 `*, *::before, *::after`，覆盖了 `.band i`、`.lemo-top-*`、`.bar`、`.fab`，范围够了；`::view-transition-*` 本身没有模糊，不用管。

## 重点问题

### 1. 算不算削弱测试，名单里有没有其实在断言观感的
逐条看了 9d40848 的正文：
- `b2-motion-list` 的 5 条（M1、两条 N1、今天页 N1、M2）：断言的是位置、`getComputedStyle(...).opacity`（离开那一行的不透明度）、字框有没有重叠、组有没有回退。都是时序和布局，和模糊无关。
- `b2-tabbar` 的 D1：每 16ms 用 `checkVisibility()` 和宽度不为 0 判断底栏、“＋”看不看得见，再看液滴 `--i` 在 100ms 内有没有变。是 DOM 层面的“看得见”，不比像素。
  - 真正比像素、查过渡中底栏画没画出来的是 `b2-tabbar-transition.spec.ts`，不在名单里，CI webkit 照样开着模糊跑，这一块没被削弱。
- `b2-tilt` 的 2 条：读 `--g-sx`，以及 `.barTint::after` 径向渐变中心的位置。这是倾斜高光跟没跟传感器，不是玻璃材质；把关测试对 `--g-sx/--g-sy` 和 `hasAttribute('data-glass')` 的放行理由成立。
- 结论：没有观感断言被关掉。
- 代价：CI webkit 上不再验证“模糊开着时动效时序还对”。这本来就测不准（软件合成和真机差太远），chromium 那边照样开着模糊跑同样的 8 条，可以接受。建议在 `webkit-ci-nofx.ts` 文件头写明这个代价，以后真机有卡顿反馈时不要以为 CI 覆盖到了。

### 2. 把关测试能不能被绕过
- 改名单、只改一边：会被发现（名单和写死副本比对）。
- 名单里写了不存在的用例：会被发现。
- 把查观感的 spec 整个文件加进来：文件名正则会拦住一部分。
- 能绕过的几种：
  - 在别的文件另开口子（M1）；
  - 把观感断言藏进 helper（S1）；
  - 用没列在 `LOOK_MARKERS` 里的写法查观感（S2）；
  - 同一个提交两边一起改（S3，只能靠流程管）。

## 复审（2026-11-06 第二轮，补丁 338 行）：通过，8.5 / 10

补丁仍没打进工作区，把关测试没在本机跑；以下按补丁原文和 9d40848 的 `ci.yml`、`playwright.config.ts` 核对。

| 条目 | 结果 | 核对 |
|---|---|---|
| M1 | 已解决 | `allE2eTs()` 递归扫整个 `tests/e2e`，还断言扫到了 40 个以上的文件，防止扫了个空目录。除名单文件和 `session-fixture.ts` 外，谁引用 `webkit-ci-nofx`、`NOFX_RULE`、`needsNoFx` 都报错；除名单文件外，三种“设成 none”的注入写法都报错；`session-fixture.ts` 里只准调一次 `needsNoFx(` |
| S1 | 已解决 | `withHelpers` 会递归展开正文里调用到的本文件顶层函数；还专门加了一条测试，往 `startSampler` 里藏一句 `toHaveScreenshot`，证明查得出来。展开时可能多带进别的代码，只会多报、不会漏报，方向是安全的 |
| S2 | 已解决 | `LOOK_MARKERS` 补上了 `toMatchSnapshot`、读像素的几种写法、`.filter` 属性（数组的 `.filter(` 调用除外）、`box-shadow`、`background-color` |
| L2 | 已解决 | fixture 每条打一行 `[webkit-ci-nofx] 文件 › 用例`，CI 汇总时去重计数。CI 下的报告器是 `list`（`playwright.config.ts:45`），它会把 worker 的 stdout 打出来，所以 `e2e.log` 里有这几行；重试打出的同一行去重后只算一次 |
| S3 | 未改 | 写死副本只是减速带，靠送审流程管，可以接受 |
| `-webkit-backdrop-filter` 只拦“设成 none” | 同意 | `b2-tabbar-transition.spec.ts:95` 读这个值是在查观感，必须放行。现在三条正则只匹配“设成 none”，还有一条测试证明读值不会误伤，这比我原来的字面要求更准确 |

**ci.yml 会不会吞掉退出码：不会。**
- e2e 那一步没写 `shell:`，GitHub 的默认是 `bash -e {0}`，不带 pipefail；补丁在脚本第一行加了 `set -o pipefail`，所以 `npm run e2e 2>&1 | tee e2e.log` 的退出码以 npm 为准。npm 失败时整条管道非 0，`-e` 让这一步失败。`run-watchdog.mjs` 超时杀进程时返回的非 0 也照样传出来。
- 汇总那一步是 `if: always()`：e2e 失败也会跑。里面每条命令都带 `|| true` 或者是管道末尾的 `wc`，这一步自己永远不会失败，也不会把前一步的失败盖掉（GitHub 按步骤分别算结果）。
- `e2e.log` 在仓库根目录，`.gitignore` 第 17 行忽略了 `*.log`，`check_registry` 用的是 `git ls-files`，不会把它报成漏登。

**低 L**
- L4 e2e 那一步建议照 `ci.yml:286` 的写法显式加 `shell: bash`：GitHub 会自动带上 `-eo pipefail`，和文件里其他用 tee 的步骤一致；`set -o pipefail` 可以留着当双保险。
- L5 注入检查只扫 `.ts`。放一个 `.css` 文件，再用 `page.addStyleTag({ path })` 注入，查不出来。可以把 `allE2eTs` 扩到 tests/e2e 下的所有文本文件，或者再拦一下 `addStyleTag`。字符串拼接这类故意绕过的写法防不住，只能靠送审。
- L6 汇总只打出数字。可以加一行：数字大于名单总数（8）时 `echo "::warning::…"`，名单外的用例也被关了的时候，在 CI 页面上直接能看到。
