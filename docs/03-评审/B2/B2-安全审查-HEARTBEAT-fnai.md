# B2 安全审查 · HEARTBEAT-fnai-policy（private.heartbeat 给 fn_ai 的策略收窄 + 列级 select）

- 审查人：安全审查员（只读；除本文件和租约式出队审查记录的“复审”一节外，没有改仓库里的任何文件，没有做 git 操作；没有启动 Supabase 或 Docker，没有连任何库）
- 日期：2026-11-05
- 审查对象（工作区未提交）：
  - `supabase/migrations/20261104140000_core_heartbeat_fnai_policy.sql`
  - `supabase/tests/rls/35_heartbeat_fnai_policy.test.sql`（20 条）
  - `build/d1/policies.ts`（新文件）
  - `build/d1/whitelist.ts` 的 `FN_AI_HEARTBEATS`、`COLUMN_GRANTS.fn_ai['private.heartbeat:SELECT']`
  - `tests/build/d1-policies.test.ts`
  - 反例 `supabase/tests/d1-fixtures/39_heartbeat_fnai_open.psql`、`40_heartbeat_extra_policy.psql`、`41_heartbeat_name_added.psql`
- 来由：PURGE-heartbeat-ops 安全审查建议 S2（`B1-安全审查-PURGE-heartbeat-ops.md`）；负责人 11-04 定 HEARTBEAT 选项 A（同时加列级读权限）
- 对照：`0001_core.sql` 第 29 行（`create role fn_ai nologin noinherit`）、第 179 行（heartbeat 表只有 name、at、detail 三列）、第 589、609、610 行；`usage-report/core.ts` 的 `DETAIL_FIELDS_BY_NAME`
- 跑过：
  - `npm run test:db:offline`：全部通过（35 号 20 条、03 号 44 条；反例 39、40、41 都按预期报出）
  - `vitest tests/build/d1-policies.test.ts` 等相关文件全过
  - 变异 8 个（F1～F8），在会话草稿目录的独立副本里做，跑完核对迁移已还原，见第四节

## 结论：通过，没有必改

## 一、列级授权有没有越出这三列

- 授的是 `grant select (name, at, detail) on private.heartbeat to fn_ai`。这张表本来就只有这三列，所以没有越出；而且列级授权不会自动扩到以后新加的列。
- 表级授权仍然只有 insert、update，没有 delete、truncate。35 号第 ④ 段断言 delete 回 `permission denied`。
- D1 两层都钉住了：
  - 表级白名单 `fn_ai['private.heartbeat'] = ['INSERT', 'UPDATE']`：变异 F3（改成表级 select）、F4（多授 delete）都被 03 号抓到。
  - 列级白名单 `COLUMN_GRANTS`：F7（把列级 select 也授给 authenticated）被抓到。
- **读的范围**：select 同样受策略管，fn_ai 只看得到自己的三行（35 号第 ④ 段）。正常写心跳的 upsert 必须读列，所以这项授权是功能上需要的，迁移头里写了在 lemo-b2push 上的实测。
- **读到的内容**：别人的心跳里只有时刻和计数，读不到；自己三行的 detail 本来就是自己写的。

## 二、策略能不能被其他 name 绕过

- **策略本身**：`fn_ai_own` 是 `for all to fn_ai`，using 和 with check 都是 `name in ('ai-embed', 'ai-media', 'file-check')`。字符串全等比较，大小写、前后空格、前缀相似（35 号测了 `ai-classify-x`）都过不去。
- **四条可能的路径都堵住了**：
  - 插入别人的名字：被 with check 拒（第 ③ 段）。
  - 用 upsert（`on conflict (name) do update`）去碰别人那一行：那一行不满足 using，报 42501（第 ④b 段）。
  - 不带 where 的整表 update：只动自己三行，push-dispatch、account-purge、ai-classify 的 at、detail 一点不变（第 ⑤ 段，这正是旧口子）。
  - 把自己那一行改名成别人的名字：被 with check 拒，整句回滚（第 ⑥ 段）。
- **角色**：fn_ai 是 `nologin noinherit`，不是表的属主，也没有 BYPASSRLS；fn_vault 对这张表没有任何表级权限（第 ⑦ 段）。
- **旧策略已删**：变异 F6（不删 fn_all）被抓到。
- **加一条宽策略来 OR**：F5（另加一条只读的 using (true)）被抓到；反例 40 证明给 public 的宽策略也会被 D1 报出。
- **改名单**：F1（名单里加 ai-classify）、F2（with check 改成 true）、F8（with check 改成 `like 'ai-%'`）都被 35 号抓到。
- **能伪造的上限**：fn_ai 最多伪造自己这三个名字。usage-report 的 `DETAIL_FIELDS_BY_NAME` 里没有这三个名字，它们的 detail 一律不转发给 lemo-ops，所以 fn_ai 往 detail 里写什么都进不了告警。顺带的好处是，租约式出队的 `queue_poison` 累计（读上一次的 push-dispatch 心跳）不再能被 fn_ai 改写。

## 三、D1 能不能拦住以后改宽

- `policies.ts` 对 `private.heartbeat` 是**逐字比对**：
  - 表上只准有 `fn_ai_own` 一条，多一条就报（不管给谁、看着多窄）；
  - 必须是 `ALL to fn_ai PERMISSIVE`；
  - using 和 with check 都必须等于由 `FN_AI_HEARTBEATS` 拼出来的 `(name = ANY (ARRAY[...]))`。
- 反例 39（退回 fn_all）、40（多一条宽策略）、41（名单加 ai-classify）都报出。
- 其他表上给 fn 角色的字面量 `using (true)`、`with check (true)` 也会报。
- **仍然拦不住的一种情况**：有人把**迁移、`FN_AI_HEARTBEATS`、附录 A 三处一起**改宽，D1 会认为一致而放行。现在挡这种情况的只有 `d1-policies.test.ts` 第 63 行：断言名单里不含 6 个写死的 service_role 心跳名。这份清单是手写的，以后新加的服务心跳名（比如新的定时函数）不在里面，就挡不住。见建议 G1。

## 四、变异（独立副本，8 个，全部被抓到）

| # | 变异 | 结果 |
|---|---|---|
| F1 | 策略名单加 ai-classify | 被抓到（35 号） |
| F2 | with check 改成 true | 被抓到（35 号） |
| F3 | 列级 select 改成表级 select | 被抓到（03 号） |
| F4 | 多授 delete | 被抓到（03 号） |
| F5 | 另加一条只读的 using (true) | 被抓到（35 号） |
| F6 | 不删旧的 fn_all | 被抓到（35 号） |
| F7 | 列级 select 也授给 authenticated | 被抓到（03 号） |
| F8 | with check 改成 `like 'ai-%'` | 被抓到（35 号） |

## 五、打分（10 分制）

| 维度 | 分 | 说明 |
|---|---|---|
| 授权最小化 | 9 | 列级 select 只有这三列，读的范围受策略限制；扣 1 分是因为 upsert 必须读 detail，读的列比“只读 name”宽（表只有三列，影响很小） |
| 策略不可绕过 | 10 | 插入、upsert、整表 update、改名四条路径都有测试 |
| D1 防以后改宽 | 8 | 逐字比对，反例齐全；名单的“禁止名”是手写清单（G1） |
| 测试 | 10 | 8/8 被抓到 |

## 六、建议（不阻塞）

- **G1**：`d1-policies.test.ts` 里“不含 service_role 心跳名”的清单改成从代码里取，例如 lemo-ops 的 `HEARTBEAT_LIMITS` 键、usage-report 的 `DETAIL_FIELDS_BY_NAME` 键，或者另立一份“service_role 心跳名”清单，并断言它和 `FN_AI_HEARTBEATS` 没有交集。这样以后加新服务时，它的心跳名会被自动挡在 fn_ai 名单之外。
- **G2**：`isTrue` 只认字面量 true。其他表上给 fn 角色的策略，如果写成恒真式（`1 = 1`、`name is not null`），会被放过。heartbeat 已经逐字比对，不受影响；其他表可以考虑按附录 A 逐表逐字比对。
- **G3**：迁移头里的回滚语句会重新打开这个口子，文中已写明“只在临时救急时用”。建议手册里同样注明：用了以后要尽快补新迁移收回。

---

## 复审（11-05）：G1～G3

- **做法**：只读，默认不通过。跑了离线数据库测试（35 号 20 条全过，反例 42 报出）和 `tests/build/d1-policies.test.ts`。

### 结论：通过，没有必改

| 建议 | 改法 | 判定 |
|---|---|---|
| G1 禁止名从代码里取 | `d1-policies.test.ts` 第 74 行：服务心跳名从 lemo-ops 的 `HEARTBEAT_LIMITS` 键、usage-report 的 `DETAIL_FIELDS_BY_NAME` 键、各函数里的 `export const HEARTBEAT = '…'` 三处汇总（至少 6 个），断言和 `FN_AI_HEARTBEATS` 没有交集 | 已解决。附带一个隐患：以后 lemo-ops 如果要监控 ai-embed 这类 fn_ai 自己的心跳（加进 `HEARTBEAT_LIMITS`），这条断言会误报，逼人把它从 fn_ai 名单里删掉。建议到时把“lemo-ops 监控的名字”和“service_role 函数自己写的名字”分开，只拿后者比，或者在测试旁边写明这一点（G4） |
| G2 恒真式 | `policies.ts`：fn 角色的策略（heartbeat 逐字比对；`counters.fn_global` 例外，但必须含 `global`）的 using 和 with check 都必须含 `app.uid`，所以 `1 = 1`、`key is not null` 都会报，反例 42 报出 | 已解决。仍然拦不住“含 app.uid 却又 or 上恒真式”的写法，也拦不住“只是在别处提到 app.uid”的写法，已登记为 HB-policy-verbatim（低），同意 |
| G3 手册 | 上线与回滚手册第 151 行写明：迁移头里的回滚语句会重新打开口子，只能临时用，用了要尽快补迁移收回 | 已解决 |

打分不变：授权最小化 9、策略不可绕过 10、D1 防以后改宽 9（G1、G2 补上，比上一轮加 1）、测试 10。
