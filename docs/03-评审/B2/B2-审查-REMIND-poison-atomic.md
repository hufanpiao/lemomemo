# B2 审查：REMIND-poison-atomic（push-dispatch 心跳 queue_poison 原子累加）

- 审查日期：2026-11-05
- 审查员：独立代码与安全审查员（只读，未连任何数据库，未启停任何 supabase / docker 服务，未改仓库文件）
- 对象：迁移 `supabase/migrations/20261105140000_core_push_heartbeat_atomic.sql`，`supabase/functions/push-dispatch/core.ts`、`store.ts`，`tests/edge/push-dispatch-mem.ts`、`push-dispatch-lease-retry.test.ts`、`push-dispatch.test.ts`，`tests/functions/push-dispatch-store.test.ts`，`supabase/tests/rls/40_push_heartbeat_atomic.test.sql`、`03_roles_grants.test.sql`，`supabase/tests/store-it/account-store.it.ts`，`build/d1/whitelist.ts`、`fn-lock-timeout.ts`、`tests/build/d1-fn-lock-timeout.test.ts`，以及架构设计、数据字典、上线与回滚手册、文件登记册的相关行。

## 分数：7.0 / 10 —— 不通过

核心 SQL 写法正确，测试扎实（SQL 变异 10/10 被拦住）。不通过的原因不在算法，而在两处会直接出事的配套：**生成类型没更新，CI 的 db.types 比对必然失败**；**回滚手册写的“回滚到 11-05 之前”会把 push-dispatch 退到调不动现有出队函数的版本**。改完这两条、补上发布顺序说明，可到 8.5 以上。

## 已核实正确的部分

1. **并发不丢**：`insert … on conflict (name) do update` 在 READ COMMITTED 下，后到的语句在冲突行上等先到的提交，再按已提交的新版本重新计算 `set` 里的 `h.detail`，累加不会丢。store-it 用例 30 次同时写，核对返回值恰好是 3～32 的排列、库里是 32，能抓住“先读后写”的非原子写法（只在 CI 的 db 任务 / lemo-e2e 上跑）。
2. **returning 取的是新值**：`returning (h.detail ->> 'queue_poison')::int` 里的 `h` 是目标表别名，在 INSERT … RETURNING 中指插入或更新后的行（PG 18 之前没有 OLD 语义），返回的是累计后的新值。rls/40 第 21、26 等条按返回值断言，能区分新旧值。
3. **首尔日换算**：`private.heartbeat.at` 是 `timestamptz`（0001_core.sql 第 179 行），`timestamptz at time zone 'Asia/Seoul'` 得到首尔墙钟 `timestamp`，再 `::date` 与会话时区无关，正确。变异“改成按 UTC 日比较”“去掉同日判断”都被 rls/40 拦住。
4. **旧值兜底**：要求 `jsonb_typeof = 'number'` 且文本形如 `^[0-9]{1,9}$`，排除了负数、小数（`1.5`、`1.0`）、字符串、10 位以上；CASE 保证只在 THEN 分支才做 `::int` 转换，不会因坏数据报错。
5. **int 溢出**：旧值 ≤ 999999999，这一轮截到 ≤ 100000，和 ≤ 1000099999 < 2147483647，不溢出。p_poison 为 null、负数、超大都有用例。
6. **p_detail 注入**：`d || jsonb_build_object('queue_poison', …)` 右边覆盖左边，p_detail 自带的 queue_poison 不起作用；心跳名写死 `'push-dispatch'`，调用方改不了别的服务的心跳；非对象（数组、标量、null）当空对象。均有用例，变异“合并顺序反”“数组不当空对象”“心跳名改掉”都被拦住。
7. **授权与配置**：`security definer`、`search_path = ''`、`lock_timeout = '5s'`，函数体内全部 `pg_catalog.` / `private.` 限定；0001 第 7 行默认撤销 PUBLIC 的 EXECUTE，只授 service_role；rls/03 第 93 行白名单、rls/40 第 61～63 行、D1 whitelist、fn-lock-timeout 都已登记，变异“去掉 lock_timeout”被拦住。
8. **调用方失败路径**：`store.ts` 第 67～68 行 rpc 出错、返回值不是非负整数都抛 `new Error('db')`（不带原始报错）；`core.ts` 第 141～146 行捕获后只记 `heartbeat_failed`、回 `503 {"error":"try_later"}`，不泄露细节。`push-dispatch.test.ts` 第 139 行、`push-dispatch-store.test.ts` 第 51～60 行覆盖。响应体用的是函数返回的累计值（lease-retry 第 229 行用 `41 + poison` 的替身钉住，没有假通过）。
9. **替身与 SQL 一致**：`push-dispatch-mem.ts` 第 163～177 行的截断、同日判断、旧值判断和 SQL 对齐；lease-retry 第 244～259 行逐项对照。
10. **已跑的只读检查**：`npx vitest run tests/edge/push-dispatch tests/functions/push-dispatch-store.test.ts tests/build/d1-fn-lock-timeout.test.ts` 19 文件 173 条全过；`node supabase/tests/offline/run.mjs --only=rls` 全过（rls/40 24 条、rls/03 44 条）；`python -I build/check_backend.py` 0 个错误。
11. **变异验证**（脚本在 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\review-mut\mut.mjs`，在内存 PGlite 里 `create or replace` 变异后的函数再跑 rls/40，不碰仓库和任何库）：UTC 日比较、去掉同日判断、去掉正则、去掉类型判断、合并顺序反、不截上限、不截下限、心跳名改掉、去掉 lock_timeout、数组不当空对象，**10 个全部拦住**；原样 0 条失败。

## 问题（按严重程度）

### 必改（阻塞）

**B1. `shared/db.types.ts` 没有收录 `push_heartbeat_write`，CI 的类型比对必然失败**
- 位置：`shared/db.types.ts` private 函数段（约第 452～455 行，`push_endpoint_ok` 与 `push_keys_ok` 之间应有这一项）；CI `.github/workflows/ci.yml` 第 223～232 行。
- 为什么：CI 在 db reset 后 `supabase gen types typescript --local` 再和仓库 diff，对不上就 `exit 1`。新迁移建了函数而仓库类型没有，这次提交一推 CI 就红。同批的 `remind_queue_finish` 等都已在类型里，唯独这个漏了；文件登记册第 3252 行的“同步”清单也没提这一项。
- 怎么改：按现有条目格式补 `"push_heartbeat_write": { Args: { "p_detail": Json, "p_poison": number }; Returns: number }`（以 CI 产物 `db-types-generated` 为准覆盖最稳），并在登记册更正行补一句。

**B2. 回滚口径“回滚到 11-05 之前”会把 push-dispatch 退到调用已删签名的版本**
- 位置：`docs/08-发布/上线与回滚手册-v4.md` 第 149 行；迁移文件第 15 行写法相同（“core.ts 改回读心跳加 upsert”，没给版本）。
- 为什么：11-05 之前最后一版 push-dispatch 是 737f2f9（11-04 18:13），它调 `remind_queue_pop(p_limit)` 单参数版本；迁移 20261104130000 已把它删掉、改成 `(int, int, boolean)`，且租约、finish、queue_ok / queue_poison 都是 2b65b43（11-05 10:12）才进来的。照手册回滚，第 0 步每轮出队失败、编辑过的提醒一直不重算，lemo-ops 的 queue_ok、queue_poison 也全没了。真正“读心跳加 upsert、不依赖新函数”的版本是 3516b93（及本改动提交之前的那次提交）。
- 怎么改：手册和迁移头改成“先把 push-dispatch 回滚到本改动之前的那次提交（3516b93 或之后、本改动提交前的版本；不要回到 11-05 10:12 的 2b65b43 之前），再 drop function”；顺序本身（先代码、后 drop）是对的，保留“顺序反了会 503”那句。

### 中

**M1. 发布手册没写这个迁移和函数的先后要求，且与同批“先部署函数”的做法冲突**
- 位置：`docs/08-发布/上线与回滚手册-v4.md` 第 137～141 行（全天日程迁移要求正式环境先 `-Only functions` 部署函数、再 `db push`）、第 148～149 行。
- 为什么：新版 push-dispatch 写心跳只走 `push_heartbeat_write`。如果正式环境首次发布 B2 时按第 140 行先只部署函数，在 `db push` 之前的窗口里每一轮推送照发，但写心跳失败、回 503、心跳不更新，lemo-ops 可能误报“推送服务停了”；值班看到 503 也不知道是预期的。普通发布（先 db push、后 functions deploy）没问题。
- 怎么改：在第 148 行附近加一句“这个迁移要在新 push-dispatch 之前上；如果按全天日程那条先 `-Only functions`，中间窗口心跳写不进、函数回 503 属预期，`db push` 后自愈，lemo-ops 的心跳超时提示在这段时间内可忽略”，或者把这个迁移单独先推。

### 低

**L1. 跨首尔 0 点时 `at` 可能倒退，丢掉新一天已记的个数**
- 位置：迁移第 27、30 行。
- 为什么：`excluded.at` 是语句开始时刻（`now()`）。两轮重叠在 0 点前后时，开始得早的语句（23:59:59.9）若在开始得晚的语句（00:00:00.1）之后拿到行锁，会判成“不同日”从自己这一轮重算，并把 `at` 写回昨天；下一轮再判“不同日”，新一天已记的那一项被清掉。窗口是毫秒级，影响是当天提示可能漏一次，和本条需求要消除的问题同类但概率低得多。
- 怎么改（可选）：`at = greatest(h.at, excluded.at)`，同日判断也按 `greatest(h.at, excluded.at)` 比；或者接受并在迁移头注明。

**L2. 替身对小数 poison 的处理和真实调用不一致**
- 位置：`tests/edge/push-dispatch-mem.ts` 第 166 行 `Math.trunc(poison)`。
- 为什么：真实调用经 PostgREST 把 `1.5` 转 `int` 会报错（→ store 抛 db → 503），替身却截成 1 继续累加。调用方只会传整数，当前不可达，但替身注释写“照 SQL”，容易让人以为小数也能被吞掉。
- 怎么改：替身对非整数直接抛错，或注释写明“非整数在真实调用里会 503，这里不模拟”。

**L3. store-it 并发用例有两种偶发失败**
- 位置：`supabase/tests/store-it/account-store.it.ts` 第 290～312 行。
- 为什么：①恰好跨首尔 0 点运行时会被判换日、累计重算；②目标库上如果 pg_cron 的 push-dispatch 真在跑（lemo-e2e 起了函数服务时），会插进来写同一行，返回值和最终 32 都对不上。
- 怎么改：开头避开首尔 23:59～00:01（或检测到就跳过并说明）；或在用例期间确认没有真实 push-dispatch 写心跳（例如先看 `cron.job` 里这条是否会打到可用的函数地址），失败信息里提示这两种原因。

**L4. security definer 不是必需的**
- 位置：迁移第 18 行。
- 为什么：service_role 本来就对 `private.heartbeat` 有 select、insert、update（0001 第 589 行）且在 Supabase 上绕过 RLS，用 `security invoker` 也能跑，权限面更小；“心跳名写死、调用方不能改别的服务心跳”的说法只对这个函数成立，service_role 直接 upsert 表仍然可以。现在 search_path 为空、全限定、只授 service_role，风险很低。
- 怎么改（可选）：改成 security invoker，或在迁移头把“写死心跳名”的意义说准确（防误用，不是权限边界）。

**L5. 旧值到 1000000000 后会被静默清零**
- 位置：迁移第 32 行。累计到 10 位后下一轮正则不过、从这一轮重算。现实中不可达（每天最多约 1440 轮 × 100000），只建议在迁移头一句话注明“10 位以上视为坏值重算”是有意为之。

## 文档一致性

- 架构设计第 2368、5720 行 grant 行与迁移第 39 行一致；第 2934 行心跳段描述与代码一致。
- 数据字典第 735、1166 行、文件登记册第 3250～3252 行与代码一致（登记册缺 db.types.ts，见 B1）。
- 上线与回滚手册第 148 行一致；第 149 行回滚版本不对（B2），缺发布顺序说明（M1）。

## 结论

不通过（7.0）。必改：B1 补 `shared/db.types.ts` 的 `push_heartbeat_write`；B2 改回滚手册和迁移头的回滚版本（回到本改动之前的提交，不是 11-05 之前）。建议同时处理 M1（发布顺序说明）。改完后只需复查这三处，SQL 与测试部分无需重审。

## 复查（2026-11-05，同一审查员、同一尺度）

### 上次意见逐条核对

| 编号 | 结论 | 核实依据 |
|---|---|---|
| B1 db.types.ts | 已解决 | `shared/db.types.ts` 第 455～457 行补了 `push_heartbeat_write`（Args `p_detail: Json`、`p_poison: number`，Returns `number`），位置在 `push_endpoint_ok`、`push_keys_ok` 之间，格式与相邻条目一致；登记册的 REMIND-poison-atomic 更正行已提 db.types。对方称在 lemo-e2e 上 gen types 后 diff 为空，本审查员按约束没连库，没有复跑这一步，最终以 CI 的比对为准 |
| B2 回滚口径 | 已解决 | 迁移第 20～21 行、手册第 150 行改成回到 d87b1d5 里的版本，并写明不要回到 2b65b43 之前。`git show` 核实：d87b1d5 的 store.ts 第 67、71 行是心跳 upsert 加 select，第 78 行调 `remind_queue_pop(p_limit, p_lease_s, p_retry)`；2b65b43 的 core.ts 第 77 行已有 `poisonToday`，确实已经是读心跳加 upsert 的写法；737f2f9 调单参数 `remind_queue_pop`，“不要回到 2b65b43 之前”这句是对的 |
| M1 发布顺序 | 已解决 | 手册第 149 行、迁移第 19 行写了“迁移先于新函数；先只部署函数时窗口内回 503、心跳不更新属预期，db push 后自愈” |
| L1 跨 0 点 at 倒退 | 已解决 | 迁移第 33、36 行改成 `greatest(h.at, excluded.at)`；rls/40 第 32～35 行加 2 条；替身第 `const at = … Math.max(prev.at, now)` 同步。变异“去掉 at 的 greatest”“去掉同日判断里的 greatest”“at 改成 least”都被拦住。语义复核：开始得早、后拿到锁的那句按新一天累加，at 不倒退 |
| L2 替身小数 | 已解决 | 替身遇到非整数直接抛 `db`，与真实 PostgREST 转换报错一致 |
| L3 store-it 偶发 | 已解决 | 第 294～296 行避开首尔 23:59～00:01（`sleep` 从 harness 导入），断言信息提示可能有真实 push-dispatch 在写 |
| L4 security definer | 接受 | 保留 definer、与同批 remind_queue_* 一致；迁移第 16～17 行把“心跳名写死”改成防误用、不是权限边界，说法准确 |
| L5 10 位清零 | 已解决 | 迁移第 7 行注明是有意为之 |

### 本次复跑（只读，未连库）

- `npx vitest run tests/edge/push-dispatch tests/functions/push-dispatch-store.test.ts tests/build/d1-fn-lock-timeout.test.ts`：173 条全过。
- `node supabase/tests/offline/run.mjs`（全量离线）：全部通过，其中 rls/40 26 条、rls/03 44 条。
- `python -I build/check_backend.py`：0 个错误。
- 变异（`C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\review-mut\mut.mjs`，内存 PGlite 里替换函数再跑 rls/40）：上次 10 个加上 3 个 greatest 相关，共 13 个，全部拦住；原样 0 条失败。

### 新发现（低，不阻塞）

**L6. greatest 让未来时刻的 at 一直保留，心跳存活信号可能被掩盖**
- 位置：迁移第 33、36 行。
- 为什么：现在 at 只进不退。如果这一行的 at 被写成未来时刻（有人用 service_role 手工修数据、从别的环境恢复了行、或者数据库时钟往回调），之后每一轮都保留那个未来的 at。lemo-ops 按 at 判断服务停没停：这段时间里 push-dispatch 就算真停了也看着是活的；同日判断也一直按那个未来日期算。正常运行时碰不到，要先有人写坏这一行。
- 怎么改（可选）：只容忍很小的倒退，比如 `at = case when h.at > excluded.at and h.at < excluded.at + interval '5 minutes' then h.at else excluded.at end`，同日判断用同一个表达式；rls/40 补一条“旧行 at 在 1 天后：at 回到 now()”。或者在迁移头注明这个取舍。

### 复查结论

**8.8 / 10，通过。** 上次两条必改（B1、B2）和 M1 都已解决，L1～L5 已处理或接受。新发现的 L6 是低级问题、不阻塞，建议顺手改或注明取舍。
