# B3 版本门免查：前端会审

- 会审人：前端 B（只读，不改后端文件）
- 日期：2026-11-07
- 依据：`docs/09-路线图/B3-任务单.md` S17、BE-5、文件分工表（“`version-gate.ts` 只加 `PATCH /rest/v1/api_tokens`”）；架构 0.27 第 1 点
- 范围（工作区 diff，基线 HEAD）：
  - `functions/sb/version-gate.ts`：`EXEMPT_RULES` 加一条 `PATCH /rest/v1/api_tokens`（exact）
  - `shared/version-gate-list.ts`：`FUNCTION_VERSION_EXEMPTIONS` 加 `claude-intake`（`methods: ['POST']`，`caller: 'client'`）
  - 测试：新增 `tests/functions/version-gate-b3.test.ts`；`version-gate.test.ts`、`fn-version-gate.test.ts` 同步名单
- 跑过：版本门 5 个测试文件 190 条全过；`src` 里涉及 426、`version_too_new`、`upgrade_required` 的客户端单测 49 个文件、551 条全过

## 结论

**通过，没有必改项。**
- 客户端已有的行为（426 横幅、最低版本、离线队列暂停）不受影响。
- 免查范围和任务单一致，没有放宽。
- 有 3 条提醒，留给 B3 前端和 QA。

## 一、客户端已有行为不受影响

1. **判断和回法没改**：`needsVersionCheck`、`createVersionGate().check()`、`upgradeRequiredResponse` 和转发层 `functions/sb/[[path]].ts` 都没有改动。两份名单各只多一条，别的路径照旧判“查”，低版本照旧收到同样的 426 和 `min`。
2. **426 横幅、最低版本**：客户端是看响应码和 `min` 出横幅、记最低版本（`src/core/upgrade.ts`、`src/app/UpdateBanner.tsx` 等）。这批 `src` 一个文件都没改。免查只会让这两条请求不再收到 426，不会多出 426，也不会改 426 的内容。
3. **离线队列暂停**：
   - 队列（outbox）只发同步表的写操作；`api_tokens` 在同步清单里是 `"sync": false`（`src/core/manifest-sync.gen.ts`），不会进队列。
   - `claude-intake` 由 `tools/claude-intake/add.ps1` 调，App 不调。
   - 所以这两条免查和队列碰上 426 就暂停、等升级的逻辑没有交集；队列里的其他写操作照旧被 426 挡住、照旧暂停。

## 二、免查范围没有比任务单宽

| 任务单（S17、BE-5） | 实际 | 结论 |
| --- | --- | --- |
| `version-gate.ts` 只加 `PATCH /rest/v1/api_tokens` 一条路径规则 | 只加这一条：`method: 'PATCH'`、`match: 'exact'` | 一致 |
| claude-intake 写进 `version-gate-list.ts`，`caller: 'client'`，只免 POST | `methods: ['POST']`、`caller: 'client'` | 一致 |
| ai-parse、ai-voice、token-admin 标“查” | `version-gate-b3.test.ts` 断言这三个函数的 POST 照查 | 一致 |

逐项核对了边界：
- **路径**：
  - 转发层用的是原始路径（`upstreamPath` 不解码），先去掉查询串；字符白名单不含 `%`，带编码的路径一律不收，`.`、`..` 段、`//`、反斜杠也直接回 404（`PATH_CHARS_RE`、`SUSPICIOUS_PATH_RE`）。
  - 版本门看到的路径就是上游收到的路径，不会出现“版本门当成 `api_tokens`、上游当成别的表”的情况。
  - `exact` 匹配下，`/rest/v1/api_tokens/`、`api_tokens_x`、`API_TOKENS` 都照查，测试已覆盖。
- **方法**：`api_tokens` 的 POST、PUT、DELETE 照查（测试已覆盖）；GET 本来就不查（读）。
- **放行以后由库把关**（只读查看 `supabase/migrations/*0001_core.sql` 第 348～372 行）：
  - `authenticated` 只有 `update (revoked_at)` 的列级授权；
  - `tok_upd` 策略限本人；
  - `guard_token_revoke()` 触发器：已吊销的再改就报错，`revoked_at` 一律写成 `now()`，不信客户端传的时间；
  - 没有 insert、delete 授权。
  - 所以这条 PATCH 免查最多让旧版“吊销自己的连接码”，改别的列会被库拒。这和注释里“只改 revoked_at”的说法一致。
- **claude-intake**：只免 POST，GET、PUT 照查，`claude-intake-x` 照查（测试已覆盖）。

## 三、提醒（不阻塞）

1. **函数子路径没钉测试**：`functionName()` 取 `/functions/v1/<名字>` 的第一段，所以 `POST /functions/v1/claude-intake/任意子路径` 也免查。这和已有的 `account` 是同一套机制，子路径到的仍是同一个函数，没有放宽到别的函数。建议在 `version-gate-b3.test.ts` 里加一条，把“子路径同样免查、仍只免 POST”钉住，免得以后改匹配时没人注意。
2. **给 B3 前端（设置里的“断开连接”）**：
   - 要直接调 `PATCH /rest/v1/api_tokens?id=eq.<id>`，别走同步队列（`api_tokens` 本来就不同步）。
   - 带上 `revoked_at=is.null` 条件，或者只按单个 id 改。触发器遇到已吊销的行会报错，不带条件一次改多行时，只要有一行已吊销，整批就会失败。
   - 失败时提示“断开失败，请重试”，不要当成 426 去出升级横幅。
3. **冒烟**：任务单要求“同一个 PR 有低版本测试进冒烟”。`version-gate-b3.test.ts` 的 TC-B3-23 已有低版本用例（4.0.0 < 9.0.0）。请 QA 把它列进 B3 冒烟回归集，B2 那两条也列在 QA 报告里。
