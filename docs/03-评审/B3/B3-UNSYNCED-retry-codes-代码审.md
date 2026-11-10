# B3 进门条件 UNSYNCED-retry-codes 代码审（11-10）

- 审查对象：接手清单 `docs/09-路线图/B1-接手清单-来自B0评审.md` 的 UNSYNCED-retry-codes 一行（前端 A 11-06 做完）。代码在主仓 HEAD（ad173542）里：`src/core/outbox-logic.ts` 的 `canRetryUnsynced`、`NO_RETRY_CODES`、`TRANSIENT_CODES`、`classifyFailure`，相关提交是 3fc33795 和 3ff04100。
- 对照：数据字典 10.4b（`docs/05-数据字典/数据字典-v4.md` 第 905 行起）。
- 方式：只读；在独立工作树里跑测试、做变异；审完工作树已删。

## 结论：通过，审过，可关单

没有必修。

1. **排除码和 10.4b 表二的结论一一对上。**
   - 不给重试：gone、validation、invalid_row、23505、23514、23502、22 开头的五位码、insert_conflict、vault_file_readonly、file_immutable、install_id_immutable、PGRST1xx、http_413。见 `src/core/outbox-logic.ts:52-65`。
   - 给重试：quota、note_not_writable、23503、42501、PGRST202/204/205、42883、42P01，以及没有码的 `http_<状态>`。
   - 码要整串相同才算，不会误伤。
2. **不该自动重试的，都不会自动重试。**
   - 426 和 upgrade_required 归 upgrade，暂停队列，不进 failed，见 `outbox-logic.ts:96`。
   - 401、PGRST301、PGRST303、jwt_expired 归 auth，由 K8 刷新令牌，见 `outbox-logic.ts:102`。
   - 其他 4xx 一律归 permanent，进 failed，只有用户点“重试”才重发。
3. **该重试的，都在自动重试。**
   - 断网、408、429、5xx、55P03、25006、try_later 归 transient，见 `outbox-logic.ts:98`、`:103-107`。
   - 退避 2、4、8 秒……最长 5 分钟，见 `outbox-logic.ts:112-114`；try_later 另按 5 秒、30 秒、2 分钟、5 分钟退避。
4. **不会无限重试。**
   - 点“重试”只把 failed 改回 pending，并把 tries 清零，见 `src/core/outbox.ts:248`。再败就回到 failed，没有自动循环。
   - transient 不限次数，但有 5 分钟上限；它只挡住同一条记录和依赖它的记录，别的记录照常发，见 `outbox-logic.ts:141` 起的 `sendOrder`。
5. **这一项不会丢数据。** 重试不删项。gone 在两处都被排除：`canRetryUnsynced` 和 `outbox.ts:241` 的 `retryFailed`。
6. **单测覆盖：够用。**
   - `src/core/__tests__/outbox-retry-recs.test.ts` 逐条列出排除码和保留码，也覆盖了“长得像但不在表里”的码；真 outbox 上也按码分类核过。
   - `src/features/reminders/__tests__/retry-unsynced.test.ts` 钉住了负责人 L2 的决定。
   - 实跑 `src/core`、`src/features/reminders`：92 个文件，855 条全过。
   - 我单独做了 9 个变异：去掉 23502、install_id_immutable、http_413，收窄 PGRST1xx，收窄 22xxx，429 改永久，25006 不归临时，去掉“只认 failed”，这 8 个都被拦住。唯一存活的是“408 改永久”，见下面建议 1。

## 建议（不挡关单）

1. 408 归 transient 没有测试（变异存活）。在 `classifyFailure` 的单测里补一条 `{ status: 408 }` → `'transient'` 即可。
2. 10.4b 表二写的范围是“PGRST100～PGRST128”，代码排除的是整个 PGRST1xx（100～199），和表二的结论一致。以后 PostgREST 新增 PGRST1xx 码时，记得回头核一下。

## 范围外（不属于本项，供主持人登记）

- 新建那一项永久失败以后（比如 23514，已经排除），同一条记录后面的修改会被 `sendOrder` 照常发出去（failed 项不挡同记录的后续项，见 `outbox-logic.ts:144`）。apply_patch 找不到这一行，回 not_found，归 drop，修改就被删掉（`outbox-send.ts` 的 drop 分支）。
- 这些修改原本就不在本机视图里（`rebaseView` 不叠加 failed 项，见 `outbox-logic.ts:124-131`），所以用户之后的编辑会悄悄丢掉。
- 这是 K6 起就有的行为，和重试排除码无关，“重试”按钮也没让它变得更糟。建议另开一行，由 K8 同步负责人评估。
