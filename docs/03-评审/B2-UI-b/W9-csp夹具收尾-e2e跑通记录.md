# B2-UI-b W9：csp-fixture 收尾，全量 e2e 跑通记录

- 人员和日期：前端 B，2026-11-09。
- 对应条目：B2-UI-a 前端 B 代码审最后一节“csp-fixture 跨文档累计（2026-11-07）”，审查结论是有条件通过，8 / 10。

## 四条遗留的处理

| 遗留 | 处理 |
|---|---|
| M1 全量 e2e 跑通记录 | 本文第二节。逐条结果另存在 `W9-全量e2e-逐条结果-2026-11-09.txt` |
| 建议 1：新测试第一条断言偏弱 | e96d8e2 已改：测试自己另挂一层“只数本文档”的计数，断言“第二页一开头接过来的数 = 第一页建的个数”“累计数 = 第一页 + 第二页单独数出的个数”“违规事件条数 = 同一个和”。见 `csp-webkit-select.spec.ts:90` |
| 建议 2：后退缓存恢复没有测试 | e96d8e2 已补两条：<br>① 真跑 A → B → 后退，按“从后退缓存恢复”和“重新载入”两种情况分别核对累计数（`:113`）；<br>② Playwright 里后退实际是重新载入，所以另用派发 `pageshow persisted` 的办法模拟恢复那条分支（`:135`） |
| 建议 3：文件头写明限制 | e96d8e2 已写：`csp-fixture.ts` 文件头“已知限制”的 ① 同源 iframe、② 跨源导航 |
| 建议 4：关掉遗留登记 | 已在 `docs/00-团队/明早待确认-2026-10-29.md` 写明“csp-fixture 跨文档缺陷已修……上面那条夹具遗留关闭”（11-07） |

本次没有改产品代码，也没有改这两个测试文件，按任务单 W9 不需要过八关。

## 全量 e2e（无后端组，chromium + webkit）

### 跑法

- 代码：主干 807a10f 加当时的工作区，也就是 B2-UI-b 未提交的改动，包括开关并进 Form.module.css。
- 构建：`npm run build -- --mode e2e`，输出到 dist/web-b33。构建最后一步 B3 体积检查报错退出，但产物是完整的；主持人 11-09 认可用这份产物跑。
- 服务：wrangler 开在 8833 端口。
- 运行：playwright.config.ts 的全部用例，4 个 worker。
- 没有起假后端（9190～9199 不用）；/sb、/files 指向没人监听的 8838、8839。

### 结果

共 352 条：

| 结果 | 条数 |
|---|---|
| 通过 | 304 |
| 跳过 | 36（用例里写了条件，原来就跳过） |
| 失败 | 12 |

12 条失败逐条查明，都和 csp 夹具无关：

| 用例 | 原因 | 处理 |
|---|---|---|
| `files.spec.ts` 三条 × 两个浏览器（6 条） | 要用本机假后端（`fake-backends.ts` 的 S3 替身、假 files_authorize）。这次按规定没起假后端，返回 503 try_later | 环境原因，不是代码问题。要跑得在有假后端的环境（CI，或主持人指定的端口）补 |
| `b1-version-gate.spec.ts` 三条（chromium，3 条） | 同样要假 Supabase 上游，返回 502 | 同上 |
| `b1-settings.spec.ts` 的 :112、:185、:226（chromium，3 条） | 同一个 worker 连着三条，页面根本没画出来：页面快照是空的，5 秒内找不到 `main`。同一轮里 webkit 的这三条都通过 | 单独重跑 `b1-settings`，两个浏览器各 3 遍，51 条通过、3 条跳过、0 条失败。判断是机器忙时偶发的冷启动慢，不是夹具或设置页的问题 |

**要假后端的 9 条由 CI 补跑**（代码审 W3W4 建议 3，主持人 11-09 定）：`files.spec.ts` 6 条、`b1-version-gate.spec.ts` 3 条，由 CI 的 e2e 任务补跑：ci.yml 的“Playwright（e2e 模式构建 + wrangler pages dev dist/web……）”那一步，也就是 `npm run e2e`，会按 playwright.config.ts 起假后端（`tests/e2e/fake-backends.ts`，9199、9198）。本机按规定不起假后端，所以这 9 条以 CI 结果为准，本单提交后第一次 CI 跑完再把结果补在这里。

**CI 结果（11-10 补，推断）**：本单在 10e2073，推送后第一次全绿是 5d442d4（含 10e2073）：ci run 42727513030、unit run 42727512591、deploy-preview run 42727512471 都成功，都是第 1 次运行（run_attempt 1）。ci 的“端到端（Playwright，带 CSP）”任务（job 129536834951）里，`npm run e2e` 那一步是 success。这一步用 `shell: bash` 加 `tee`，失败会让这一步变红；假后端是 playwright.config.ts 的 webServer，起不来整步就失败；`files.spec.ts` 没有跳过条件，`b1-version-gate.spec.ts` 只在非 chromium 下跳过（计入的 3 条正是 chromium）；`forbidOnly` 开着。按步骤结果和配置推断：这 9 条在 CI 里都跑了、最终都通过（没看到逐条日志，见下一句）。**还没核实到的一点**：CI 下 `retries: 1`，这 9 条有没有哪条是“第一次失败、重试才过”（flaky），只有日志看得出。GitHub 的任务日志接口要仓库管理员权限，本机没有 gh 和令牌，匿名下载返回 403（Must have admin rights to Repository），这次运行也没有上传产物，所以没能逐条核对日志。要逐条确认，请有权限的人打开 job 129536834951 的“Playwright（e2e 模式构建……）”那一步，搜 `files.spec.ts`、`b1-version-gate.spec.ts`，看有没有 `flaky` 或 `retry #1`。

### 审查员点名要的几条

- `csp-webkit-select.spec.ts`：两个浏览器各 6 条全过。webkit 的“最小复现”标了 test.fail，这次照预期失败，说明 WebKit 的误报还在。
- `hit-target.spec.ts`：两个浏览器的手机 440×956、电脑 1280×800 都过，点击区不足的 0 个。编辑页那一条合回去后，在两个浏览器都过了。
- 所有会刷新页面或整页跳转的用例，在两个浏览器都没有新出现的 CSP 违规失败。12 条失败里没有一条是 CSP 判失败。
