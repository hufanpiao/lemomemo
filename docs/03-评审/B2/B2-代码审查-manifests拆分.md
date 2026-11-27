# B2 代码审查：manifests 拆分（给 FA-7 底栏腾首屏体积）

- 审查员：独立代码审查员（兼看安全；只读，默认不通过，10 分制，8 分及以上通过）
- 日期：2026-11-05
- 对象：前端 A 工作区未提交的改动——`src/core/manifest-tables.ts`（新）、`src/core/manifest-sync.gen.ts`（新，生成）、`src/core/manifest.ts`、`src/core/manifest-source.ts`、`src/core/cache-schema.ts`、`src/core/outbox-logic.ts`（`loadRowSchemas` 带上完整清单，`RowSchemas.manifests`）、`build/gen_manifests_snapshot.mjs`、`src/core/__tests__/manifest-snapshot.test.ts`、`tests/build/first-paint-graph.test.ts`、`src/app/__tests__/first-paint-pages.test.tsx` 的超时，以及 L-d、L-e
- 口径：首屏按页面时钟算（`docs/03-评审/B2/B2-FA-6-执行说明.md` 第一节），硬线 150 KB；守护 `tests/e2e/b2-first-screen-budget.spec.ts`
- 所有构建、e2e、变异都在 scratchpad 的独立副本里做（node_modules 用联接；端口 8851、inspector 9291、假后端 9192/9193），做完已拆联接、删副本，确认端口没人在听；主仓没改任何源码

## 一、结论先说

**通过，8.5 分。** 没有高、中问题；5 条低问题都是注释过时、检查覆盖面这类收尾，不挡合入，建议顺手改。

## 二、逐项核实

### 1. 正确性

| 关注点 | 结论 | 依据 |
|---|---|---|
| 精简清单和完整快照会不会漂移 | 不会悄悄漂移 | 两份由同一个脚本、同一份 `allManifests` 生成（`renderManifests`、`renderSyncTables`）；`--check` 两份都比（`build/gen_manifests_snapshot.mjs:72`）；`manifest-snapshot.test.ts` 逐字比对 `manifest-sync.gen.ts`，还逐表核对四项等于 `allTables(完整快照)`，并核对 `syncStores()` 等于 `syncStores(manifests)` |
| CI 哪里跑 check:manifests | unit.yml 一步 `npm run check:manifests`；`build_web.mjs` 在 `vite build` 之前跑 `--check`（deploy-preview 不跑测试也拦得住）；全量 vitest 里的快照测试是第三道 | 读码；变异 V2 三道都挂 |
| 建库的 store 集合、索引、版本号 | 和改前完全一致 | `cache-schema.lock` 和 `DB_VERSION` 都没改；`cache-schema.test.ts` 的锁文件用例在副本里通过；`syncStores` 不传清单时只是数据来源换了，过滤条件同 `syncTables`（`sync === true`），keyPath、indexes、rebuildable 照旧。已装用户升级不会触发重建、不丢数据 |
| rows / 清单还没下载完时第一次写入 | 等待，不放行 | `outbox.ts:73-81`：先 `await loadRowSchemas()`，回来再查闸，再 `validateWrite(input, rows, ctx.opts.manifests)`；`validateWrite` 的 rows 是必填参数，清单取 `list ?? rows.manifests`，没有“先写后补校验”的路径 |
| 离线 / 下载失败 | 失败即关：不写本机、不入队 | `Promise.all([rows.ts, manifest-source.ts])` 任一失败 → `loadOnceRetrying` 让下次重试，本次抛 `OutboxCodeUnavailableError`，`write.*` 归成 `local_unavailable`（`outbox-code-unavailable.test.ts` 覆盖 rows 失败那一支）。清单那一块和 rows 走同一条路径；`loadAfterPaint` 里确实预取了 `loadRowSchemas()`（`src/app/after-paint.ts:28`），SW 预缓存后离线也能加载 |
| 变异 V3：`loadRowSchemas` 给空清单 | 失败即关（全部 `table_not_synced`），14 条用例挂 | 不会变成放行 |

### 2. 首屏数字（自己量）

副本里 `npx playwright test tests/e2e/b2-first-screen-budget.spec.ts --repeat-each 3`（2 个 worker）：

| 浏览器 | 3 次结果 | 今天页出现 |
|---|---|---|
| chromium | 148.0 / 148.0 / 148.0 KB | 729～765 ms |
| webkit | 148.0 / 148.0 / 148.0 KB | 2018～2058 ms |

12 条全部通过，zod 那条也过。和前端 A 报的 148.0 KB 一致，余量约 2.0 KB。

### 3. 测试能不能拦住回退（变异，都在副本里做、做完还原）

| 编号 | 变异 | 结果 |
|---|---|---|
| V1 | `syncStores` 不传清单时过滤改成 `sync !== false`（墓碑表也建仓） | 拦住：cache-schema 3 条（9 张表、不建仓名单、锁文件）+ 快照 1 条挂 |
| V2 | 手改 `manifest-sync.gen.ts`：settings 的 sync 改 false | 拦住：`--check` 退出码 1；快照测试、cache-schema 2 条挂 |
| V3 | `loadRowSchemas` 返回 `manifests: []` | 拦住：outbox-logic 1 条 + outbox 13 条挂（且是失败即关） |
| V4 | `--check` 只查第一份（`outs.slice(0, 1)`） | **没拦住**：38 条全过。实际影响小（vitest 的逐字比对仍会挂），只有“不跑测试只跑构建”的 deploy-preview 那条路漏查精简清单，见 L1 |
| V5（e2e） | `cache-schema.ts` 改回从 `manifest.ts` 引 `syncTables` | 拦住：首屏 150.4 KB，chromium、webkit 的预算用例都挂；`first-paint-graph` 的静态闭包用例也覆盖同一回退 |

### 4. 其他

- `tsc -p tsconfig.app.json`、`tsc -p tsconfig.node.json` 0 错；改动文件 eslint 0 条。
- 相关 9 个测试文件 70 条全过（含 `first-paint-pages` 20 秒超时、`first-paint-graph` 缓存 + 20 秒超时，L-e 已落实）。
- L-d：`NOT_FIRST_PAINT` 里 account-status 的说明属实——`consent-exit.ts:25` 等处静态引用了它。
- `文件登记册.md:1282-1283` 已登记两个新文件。
- `manifest.ts` 对外接口不变，只是转调 `manifest-tables.ts`；`read/lenient.ts`、`core/sync` 照旧用默认完整清单（在首屏之后的块里），没有改变行为。

## 三、问题表

| 编号 | 严重程度 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| L1 | 低 | `build/gen_manifests_snapshot.mjs:72`；`src/core/__tests__/manifest-snapshot.test.ts` | `--check` 覆盖两份是对的，但没有测试钉住：把它改成只查第一份（变异 V4）测试全过。deploy-preview 只跑构建不跑测试，那条路会漏查精简清单 | 快照测试里加一条：对一份过期的 `manifest-sync.gen.ts`（临时目录或把 OUT_SYNC 做成可传参）跑 `--check` 应退出 1；或至少断言脚本 `--check` 分支遍历的是 `outs` 全部 |
| L2 | 低 | `src/core/cache-schema.ts:61` | 不传清单时自己写了一遍 `t.sync === true`，和 `manifest-tables.ts` 的 `syncTables` 是两处规则；也绕开了 `allTables` 的“同名表只能有一个主人”检查（快照测试会跑 `allTables(完整快照)`，所以目前有兜底） | 在 `manifest-tables.ts` 加一个只认 `{ sync }` 的 `isSyncTable(t)`，两边共用；注释里写明重复检查由快照测试兜底 |
| L3 | 低 | `src/core/manifest-source.ts:3-4`；`build/gen_manifests_snapshot.mjs:1-3`；`src/core/__tests__/manifest-snapshot.test.ts:1`；`.github/workflows/unit.yml:137` | 注释和步骤名还写着“首屏用的数据清单快照 manifests.gen.ts”“本机库的表清单首屏就要用”，现在首屏只用 `manifest-sync.gen.ts`，完整快照不进首屏，读者会误会 | 改成“完整快照（入队校验、同步用，按需加载）”；unit.yml 步骤名写两份文件 |
| L4 | 低 | `src/core/manifest-tables.ts:2` | 注释说完整快照“约 2.8 KB gzip”，实测首屏差 2.4 KB（V5：150.4 − 148.0），执行说明里写的“约 2.5 KB” | 统一成实测数，或去掉具体数字 |
| L5 | 低 | `src/core/__tests__/outbox-code-unavailable.test.ts` | 只模拟了 rows.ts 下载失败；`manifest-source.ts` 那一块下载失败走的是同一条 `Promise.all`，读码看是对的，但没有用例 | 加一条：mock `../manifest-source.ts` 抛错，断言同样返回 `local_unavailable`、不入队，下次成功后照常校验 |

## 四、评分

| 维度 | 分数 | 说明 |
|---|---|---|
| 正确性 | 9 | 建库结构、版本号不变；写入失败即关；清单两份不会悄悄漂移 |
| 安全 | 9 | 没有“加载不了就放行”的路径；变异 V3 也是失败即关 |
| 测试拦截力 | 8 | 关键回退（V1、V2、V3、V5）都拦得住；`--check` 覆盖面没钉住（L1），清单块下载失败没用例（L5） |
| 首屏数字 | 9 | 自测 chromium、webkit 各 3 次 148.0 KB，和报告一致 |
| 风格、一致性 | 8 | 和周边一致、登记齐全；有几处注释过时（L3、L4）、一处规则重复（L2） |
| **总分** | **8.5** | **通过** |

## 五、结论

**通过（8.5 分）。** 没有必改项。建议顺手改 L1～L5（都是低）：L1、L5 补两条测试，L2 把同步表的判断收成一处，L3、L4 修过时注释。余量约 2.0 KB，FA-7 底栏外壳要在这个数里，做完照旧跑 `b2-first-screen-budget.spec.ts`（两个浏览器各 3 次）。

## 六、复审（2026-11-05，前端 A 按 L1～L5 修改后）

做法同上：scratchpad 独立副本（node_modules 联接），做完拆联接、删副本；没起服务。`check:manifests` 一致；相关 39 个测试文件里，除 `src/motion/__tests__/vt.test.ts` 2 条外全过。这 2 条在主仓工作区同样失败，原因是 `src/styles/base.css` 新出现的 `tabbar`、`tabbar-add` 两个 view-transition 名字没在 `VT_FIXED` 登记，看样子是 FA-7 底栏正在做的改动，和本次无关，另报给主持人。

| 编号 | 修法 | 复核 | 结论 |
|---|---|---|---|
| L1 | 生成脚本抽出 `outputs()`、`staleFiles(outs, read)`，主程序的 `--check` 和生成都遍历 `outputs()` 的全部；快照测试用替身 read 验证“哪份过期、哪份读不到都报”，再按源码钉住主程序那三行 | 变异 V4′：`staleFiles(outs.slice(0, 1))`，红；变异 V4″：`outputs()` 漏掉精简清单，红 | 已解决。钉主程序靠的是文字比对，`stale` 被别处改写时看不出来，但已覆盖常见回退，可以接受 |
| L2 | `manifest-tables.ts:36` 新增 `isSyncTable`，`syncTables` 和 `cache-schema.ts:61` 共用；加“精简清单无重名表”用例 | 读码 | 已解决 |
| L3 | `manifest-source.ts`、生成脚本文件头、快照测试文件头、unit.yml 步骤名都改成“完整快照按需加载、精简清单首屏用” | 读码 | 已解决 |
| L4 | `manifest-tables.ts:2` 改成“首屏实测少 2.4 KB 左右” | 读码 | 已解决 |
| L5 | 新文件 `src/core/__tests__/outbox-manifest-unavailable.test.ts`：mock `manifest-source.ts` 下载失败；启动照常，`write.*` 回 `local_unavailable` 不入队；`enqueue` 抛 `OutboxCodeUnavailableError`、本机没这行；下次加载成功后照常入队，非法行照样拒收 | 变异 V5：清单下载失败时吞掉错误、改用空清单，2 条都红 | 已解决 |

**复审结论：L1～L5 全部解决，没有新问题。评分由 8.5 调为 9.0，通过。**
