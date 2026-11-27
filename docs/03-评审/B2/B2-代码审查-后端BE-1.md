# B2 代码审查：后端 BE-1（推送链路第一段）及 BE-3、BE-4、BE-5 骨架、BE-7

日期：2026-11-03　审查：代码审查员（只读）　被审：后端　版本：工作区 11-03 下午（未提交）

被审文件：
- 迁移 `20261103100000_core_devices_push_constraints.sql`、`20261103110000_core_claim_endpoint.sql`、`20261103120000_core_push_dispatch_cron.sql`；pgTAP `28_claim_endpoint.test.sql`、`29_push_endpoint_vectors.test.sql`（生成）
- `supabase/functions/_shared/push/`（b64、endpoint、ece、vapid、send、stub、payload）、`supabase/functions/push-dispatch/`（core、index）
- `shared/logic/remind.ts`、`functions/sb/version-gate.ts`、`shared/version-gate-list.ts`、`build/check_backend.py`（F9 ⑤、F10、F11）、`supabase/config.toml`、`usage-report/core.ts`、`build/gen_push_vectors.mjs`、`tools/lunar/`
- 对应测试：`tests/shared/remind.test.ts`、`tests/shared/push/*`、`tests/edge/push-*.test.ts`、`tests/functions/push-dispatch-usable.test.ts`、`tests/functions/version-gate-b2.test.ts`、`tests/build/push-vectors-sync`、`push-path-rule-sync`、`check-backend-f9-server`、`lunar-tools`

不在范围：三个旧迁移 20261029193000、200000、201000 的工作区改动。

## 结论：有条件签，8 / 10

M1～M3 改完即签。做得好的地方：
- Web Push 自实现按 C-1～C-10 逐条落地，RFC 8291 附录 A 固定向量逐字节一致，另有独立解密的往返测试。正式入口 `encryptPush` 只收三个参数。
- 端点校验 SQL 和 TS 的正则逐字一致，由 `push-path-rule-sync` 钉住。同一份 fixture 在两边都跑了：pgTAP 231 条，Deno 和 Node 一侧也全过。
- `claim_endpoint` 的顺序、授权、错误码都照 3.3 D 和 D1-S4 写，pgTAP 56 条覆盖了 TC-B2-79、80 和 TC-B1-22、81。
- 替身判断（D1-8）、发送的 `redirect: 'manual'`、5 秒超时、读 1 KB 后 cancel、401/403 只记 `vapid_rejected`，都有测试。
- F9 ③ 名单写死，单测钉住了完整内容，三个违规样例齐全。`verify_jwt = false` 正好只出现在三个函数里。

## 必改

| # | 问题 | 位置 | 改法 |
|---|---|---|---|
| M1 | **`npm run typecheck` 失败，有 12 个错误**。新测试用静态 `import` 引入 `_shared/auth.ts`，这个文件顶上有 `npm:@supabase/supabase-js@2.118.0`，`tsconfig.functions.json` 把 `tests/functions/**` 编进来以后找不到这个模块，`unknown` 一路传下去，报错都落在 `supabase/functions/_shared/auth.ts`。我把这个文件临时挪开再跑，`tsconfig.functions` 就过了，挪回后文件原样，没有改动 | `tests/functions/push-dispatch-usable.test.ts:4` | 照同目录 `account-export-p0-auth.test.ts:18-20` 的写法：路径写进常量，用 `await import(AUTH_PATH)` 动态加载，类型自己声明成最小接口；或者把用例挪到 `tests/edge/`，用 node 替身。改完后 `npm run typecheck` 必须 0 错误 |
| M2 | **`remindAtOf` 的“已过就回落到截止时刻”会被重算重复触发，吞掉“稍后”**。`remind_at` 依赖 `now`。待办 17:00 截止、提前 1 小时，16:00 推了一次，16:01 用户按“稍后 10 分钟”，写入 `snooze_at = 16:11`。`snooze_at` 在 `todos_remind` 触发列里，所以会入队，第 0 步在 16:02 重算：16:00 已过、截止还没到，`remind_at` 被改成 17:00。`due_at = greatest(17:00, 16:11) = 17:00`，16:11 那次“稍后”不会响。实验脚本 `scratchpad/cr-be1/snooze.mts` 已复现，输出 `due_at = 08:00Z`（首尔 17:00）。同样的问题：打勾后又取消、改了截止日期以外的触发列，都可能在截止时刻再提醒一次。客户端保存时也用这一份函数，所以两边都有这个问题。0.29 续第 124 条② 的本意是“新建或改截止时，算出的时刻已经过了，就改在截止时刻提醒”，不是“每次重算都往后挪” | `shared/logic/remind.ts:67-69`；连带 `supabase/migrations/0002_calendar_todos.sql:82` 的触发列 | 先请架构师和前端 A 定口径（会改“接口先定”第 4 条的签名）。推荐给 `todoRemindAt` 加一个可选参数 `prevRemindAt`：算出的 `remind` 已过、并且等于 `prevRemindAt`（输入没变，这次提醒已经到过点）时原样返回 `remind`，不回落；只有 `prevRemindAt` 不同（新建、改了截止或提前量）时才回落到截止时刻。补三条用例：16:00 推过后在 16:02 带 `prevRemindAt = 16:00` 重算，结果仍是 16:00，`snooze` 16:11 能生效；16:30 新建，结果是 17:00；取消打勾后不会多出一次 17:00 的提醒。三个时区都跑 |
| M3 | **`test` 负载不符合 v1 定稿**。0.53 第 4 条写明 `test` 只有 `v`、`type`、`user_id`，但 `buildPayload` 对 `test` 也必带 `kind`、`id`、`due_at`（类型上是必填），测试还把这个偏差钉成了期望。push-test（BE-6）只能编一个假的 kind、id、due_at 传进来，前后端对拍样例也就和正文不一致 | `supabase/functions/_shared/push/payload.ts:168-179`、`:202`；`tests/shared/push/push-payload.test.ts:15-20` | `PayloadInput` 改成按 `type` 区分的联合类型：`test` 只收 `user_id`，输出只有 `{v, type, user_id}`；`remind`、`resolve` 不变。测试改成断言 `test` 正好三个键，对拍样例补一条 `test` |

## 建议

- **S1（第 4 点意见）超长时先截标题，不太合理，建议改成先截正文**：
  - 标题是锁屏上唯一能认出是哪件事的信息，正文一般只是“17:00 截止”或备注，价值更低。
  - 在两个字段各 300 码点的上限下，中文最多约 1800 字节，emoji 约 2650 字节，都放得进 3071；真正会超的，只有大量控制字符（JSON 转义后每个 6 字节）或引号、反斜杠这类异常输入，所以截哪一个很少会真的触发。
  - 建议顺序：先在 notify-text 里把 C0 控制字符替换成空格（通知里本来就显示不出来，替换后基本不会再超）；超了先截正文，再截标题；截标题时至少留 20 个码点，不要截到 `null`。按现在 `keep <= 1 → null` 的写法，锁屏只剩正文。
  - 这一条要改架构 5.3“放不下由 notify-text 再截标题”的写法，转架构师定。位置：`payload.ts:214-227`。
- **S2** `snooze.label` ≤ 40 字、`minutes` 1～1440 只有 SW 在查。服务器在 `buildPayload` 里也按同样的规则截断、校验，免得一个超长 label 导致整条 `payload_too_large`（`payload.ts:205`）。
- **S3** `buildPayload` 不校验 `user_id`、`id` 是不是 UUID，`due_at` 是不是正的安全整数。SW 遇到不合格的会按兜底处理，只显示 App 名，BE-2 出了 bug 也不容易发现。建议在这里断言一下，不合格就抛错、记 `push_failed`。
- **S4** `drain` 按分块读：读到第一个超过 1 KB 的分块才停，实际可能多读一个分块（Deno 一块最多 64 KB）。内存有上限，内容也丢掉了，可以接受；把注释改成“最多多读一个分块”（`send.ts:40-56`）。
- **S5** `ece.ts:96` 的注释说 `tests/shared/push/push-ece.test.ts` 有一条源码检查，但这个文件不存在。请补一条源码扫描测试：除 `tests/` 以外，任何地方都不准引用 `encryptWithFixedKeysForTest`。这是 C-5“代码审查核对”的落地。
- **S6** `claim_endpoint` 第 e 步没有排除已软删的行。如果同账号一条 `deleted_at` 不为空、会话还在的行占着同一个地址，函数会回 `endpoint_in_use`，但设置页的设备列表按 `deleted_at is null` 过滤，用户看不到它，也就没法移除。建议软删的占用行一律直接删掉（`20261103110000:121-129`），并补一条 pgTAP。
- **S7** `device_not_found` 不在“接口先定”第 1 条和 3.3 D 里。请写进去；前端现在把它归成 `claim_failed`，下次启动再认领。还要确认启动流程会先建好本会话的 devices 行再认领，否则会一直失败。
- **S8** 架构 3.3 C 和附录 A 只写了 `push_endpoint_ok`“不授权、不进白名单”，新加的 `private.push_keys_ok` 没写。请架构师补一句，口径相同。
- **S9** F10 的放行名单里有 `build/gen_push_endpoints.py`，注释写着“待安全审查确认”。请拿到安全审查签字；拿不到就把脚本挪进 `tests/`，再删掉这一项（`check_backend.py` 的 `DOCKER_HOST_OK`）。
- **S10** BE-2 接发送时，`VapidSigner` 按实例常驻，跨轮复用缓存，这才符合“同一 origin 签一次”；`vapidOnce` 的缓存键换了，就要新建 signer。`vapidOnce` 的键里私钥只取了长度：换钥匙时公钥也会变，所以实际不会漏判，但建议改成整串比较（值只在内存里，`index.ts:134-137`）。
- **S11** `postPush` 的 `topic` 头没有校验。RFC 8030 要求最多 32 个 base64url 字符，BE-2 用到时要先校验，或者由调用方保证（`send.ts:69`）。
- **S12（第 6 点代审意见）** version-gate 新加的两条规则都是 exact、只免对应的方法，查询串在转发层已经去掉；尾斜杠、大小写、`_impl` 后缀、别的方法都有反例，低版本放行也有测试。我认为可以通过。剩两件：前端 B 仍要在 PR 上补会审签名；QA 要确认 TC-B2-27 的两条低版本用例已经进了冒烟回归集（现在只有 `tests/functions/version-gate-b2.test.ts` 这一层单测）。
- **S13** `npm run lint` 有 4 个错误，都在 `src/kit/components/Form.tsx`（未跟踪的前端新文件，A26 展开属性）。不属于本批后端，转前端；后端的文件没有 lint 错误。

## 八个重点逐项结论

1. **Web Push 自实现（ece、vapid）：通过。**
   - JWT 按 origin 缓存，`aud` 等于 origin（`u.origin`，不带路径和端口）。
   - `exp` = 签发时刻 + 12 小时，剩不到 1 小时就重签。
   - 头部是 `{"typ":"JWT","alg":"ES256"}`，签名是 64 字节 `r‖s`。
   - 补齐三档 1024、2048、3072，最大一档整份 3174 字节。
   - `classify` 把 opaqueredirect、状态 0、3xx 都判成 `redirect`。
   - 响应体读 1 KB 后 cancel，见 S4。
   - HKDF 各段的 salt 和 info 都对；`rs = 4096`、`idlen = 65`，分隔字节是 `0x02`。
2. **端点白名单，SQL 和 TS 一致：通过。**
   - 正则逐字同源。
   - 我另跑了 40 万条随机路径的模糊测试（含 `%2e`、点段、`?`、`//`，以及各种主机），没有一条“过了正则却被 WHATWG 改写”（`url_mismatch` 为 0），所以 SQL 收、Deno 拒的不一致不会出现。
   - 主机边界我也逐个试过：`a--b`、纯数字标签、`0x7f`、63 字符标签、`xn--`、两级子域，两边结论一致。
   - 没有发现能绕过的写法。
3. **claim_endpoint：通过（S6、S7）。**
   - 三项会话检查都在校验之前。
   - 拒收时一行不动，errcode 22023，不带 detail。
   - `public.claim_endpoint` 是 invoker，只授 authenticated；`_impl` 是 definer，`search_path = ''`，只授 authenticated；两个校验函数不授任何角色，靠 0001 的默认权限保证，pgTAP 已核。
   - anon 调 `_impl` 回 42501。
4. **负载 v1：`user_id` 必带。**
   - resolve 不带标题、正文、snooze。
   - test 有偏差，见 M3。
   - 300 码点和 SW 的 `clipText` 同一算法；3071 字节的上限也有测试。
   - 截断顺序的意见见 S1。
5. **替身判断（D1-8）：通过。**
   - 线上只要替身变量非空（只有空白也算），在验完 `x-cron-secret` 之后回 500 `misconfigured:override`；空串按没设处理，和“不为空”的口径一致。
   - 本机必须两条都满足，替身地址按原串匹配，端口 1024～65535。
   - 改投替身时，仍先过白名单，`aud` 按真实端点签。
6. **version-gate 两条（代审）：通过**，见 S12。
7. **remindAtOf 的 due_time 分支**：三个进程时区（UTC、首尔、洛杉矶）各跑一遍，各 48 条都过；Deno 也过。算法本身对，“1 天”按墙上时间退一天、夏令时也测到了。但和重算放在一起会出 M2 的问题。
8. **F9 ③ 名单和违规样例：通过。**
   - `SERVER_SECRET_FUNCTIONS` 写死，单测钉住了完整内容。
   - 比对按调用判定（读头、调 `safeEqual`、不许 `===`），判空除外。
   - 名单里有、但 config 没关的也报。
   - 三个违规样例都附了报错断言，另有“只出现头名字符串”的样例。
   - D2-S1（`OPS_SECRET` 只准 usage-report 读）、D2-4（真仓库正好三个）都落地了。
   - 放行只认两个集合（cron、名单），没有第三条路。

## 其余核对

- cron 迁移：25000 ms、`x-region`、URL 写法 F9 认得出、密钥从 Vault 读。通过。
- usage-report 的 `DETAIL_FIELDS` 加了 `claimed`，布尔字段另列 `budget_hit`，只收 boolean（D2-S2）。通过。
- `shared/version-gate-list.ts` 加了 push-dispatch（`server`、`cron-x-cron-secret`，D1-S6），`check:gate` 通过。
- devices 三条约束和 D1-7 定稿的正则一致；种子脚本 `export-load-seed.mjs` 也改成了合规值。
- `tools/lunar/` 是骨架：没有数据时退出码 2，不生成半截文件。数据来源（联网下载、KASI 的 serviceKey）等负责人定，本次不评数据。

## 跑过的测试

- `npm run typecheck`：**失败**。`tsconfig.functions.json` 报 12 个错，原因见 M1；其余四个 tsconfig 都过
- `npm run lint`：4 个错误，都在前端的 `src/kit/components/Form.tsx`（S13）；后端文件没有错误
- `python -I build/check_backend.py`：0 个错误
- `npm run test:db:offline`：全过，其中 `28_claim_endpoint.test.sql` 56 条、`29_push_endpoint_vectors.test.sql` 231 条
- `deno task test`：268 过、0 失败、1 忽略
- 相关 vitest（remind、shared/push、edge/push-*、push-dispatch-usable、version-gate、version-gate-b2、fn-version-gate、usage-report、push-vectors-sync、push-path-rule-sync、check-backend-f9-server、check-backend、check-backend-migrations、lunar-tools、fn-*-coverage、data-manifest）：25 个文件，378 过、11 跳过
- `node build/run_tz_tests.mjs --project node tests/shared/remind.test.ts tests/shared/push`：三个时区各 48 条，全过
- `npm run check:gate`：通过；`node build/gen_push_vectors.mjs --check`：生成的 SQL 和 fixture 一致
- 实验脚本（都在 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\cr-be1\`）：`snooze.mts`（复现 M2）、`fuzz.mts`（40 万条，两边结论一致）、`hosts.mts`（主机边界）
- 没跑：`npm run test:db`（要 Docker，按要求不启动）；没有连任何真实服务

## 采纳情况（主持人，11-03）

- M1：交后端必改。改成 `await import(常量路径)`，或者把测试挪到 `tests/edge/`，由后端选一种。
- M2：采纳审查员的改法。接口约定由主持人定：`remindAtOf` 加可选参数 `prevRemindAt`，只在新建、改了截止时间或提前量时才回落到截止时刻；其余重算保留原来的 `remind_at`，“稍后”的 `snooze_at` 照常生效。架构文档的“接口先定”第 4 条，等后端交回后由主持人改；前端 A 由主持人另行通知。后端要补测试：用审查员的 snooze.mts 场景，再加打勾后取消、改了其他触发列这两种情况。
- M3：和安全审查 BE1-S2 合并。test 负载只带 `{v, type, user_id}`，输入按 type 分成联合类型，测试断言正好三个键。
- S1：截断顺序（先截标题还是先截正文）由负责人定，见明早清单第 71 条，定了再改。不受这一决定影响、现在就做的两项：先把 C0 控制字符换成空格；标题至少留 20 个码点，不截成 null。
- S9：安全审查已有条件同意（S-B2 签字“六之四”），条件交后端在做。
- S13：`Form.tsx` 的 lint 错误转前端 A（FA-2 编辑页）。
- 第 6 项还缺的两件：① 前端 B 会审签名，已派前端 B，结论追加在本文末；② 冒烟回归集：主持人核实，这两条低版本用例就是测试用例-v4 的 TC-B2-27，已标 ★（进自动冒烟，P0），不用再加。
- S2～S8、S10～S12：交后端，本批能改的一起改；不改的逐条写明理由。

## 前端 B 会审（version-gate 两条）

会审人：前端 B（`version-gate.ts` 的主人、exe 的作者），11-03。对象：`functions/sb/version-gate.ts` 的 `EXEMPT_RULES` 新加的 `DELETE /rest/v1/devices`、`POST /rest/v1/rpc/claim_endpoint` 两条（BE-3），以及 `tests/functions/version-gate-b2.test.ts`。

**结论：同意合并，签名。** 两条规则不影响 exe 的 426 处理，也不影响 `requestAppUpdate`。

核对了这几件：

1. **规则本身**：两条都是 `exact`，只免各自的那一个方法。`needsVersionCheck` 先比路径、再比方法，转发层传进来的路径已经去掉了查询串。所以 supabase-js 的 `from('devices').delete().eq('id', …)`（`DELETE /rest/v1/devices?id=eq.…`）能命中；尾斜杠、大小写不同、加了后缀、换成别的方法、换成别的表，一律照查。测试里这些反例都有，低版本放行也有用例。
2. **exe 走转发层的完整路径**：用一个临时用例跑了 `handleSb`（跑完已删，不进仓库）。条件是 exe 来源 `http://tauri.localhost`、`X-App-Version: 4.0.0`、最低版本 9.0.0：
   - `DELETE /sb/rest/v1/devices?id=eq.…` 和 `POST /sb/rest/v1/rpc/claim_endpoint` 都转发到了上游，返回 200，带 exe 的 `Access-Control-Allow-Origin`；
   - 同一台旧 exe 发 `PATCH /sb/rest/v1/devices` 照样回 426，也带 exe 的 CORS 头，页面读得到 `upgrade_required`；
   - 预检（OPTIONS）由转发层直接回，不经过版本门；`Access-Control-Allow-Methods` 里有 `DELETE`，`Prefer: return=minimal` 在允许的请求头里。
3. **对 exe 的 426 处理**：exe 收到 426 后，`appFetch` 通知 `onUpgradeRequired`，同步层停下来，弹出升级横幅。免查的两条不会回 426，所以旧版 exe 退出登录时删本机那一行不会被挡，也不会因此弹出升级横幅。这正是这两条规则要的效果。别的写操作照旧回 426，横幅照常出现。
4. **对 `requestAppUpdate`**：它走 Rust 的 `app_update`，访问的是更新清单地址（`env.rs` 的 `update_url`），完全不经过 `/sb`，和版本门无关。
5. **`claim_endpoint`**：exe 不注册 Service Worker、不订阅 Web Push（架构 0.49 第 8 条），不会调这条。它只对网页版和主屏幕版有用，对 exe 没有影响。

提醒一件事（不挡合并）：`DELETE /rest/v1/devices` 不管带什么过滤条件都免查。版本门本来就不是权限措施，能删哪几行由 RLS 管，只能删自己的行。按现在的约定，客户端只按 `id=eq.<本机>` 删，没问题；以后要是有人写出不带过滤的 DELETE，版本门不会拦。前端 A 写退出流程时请注意只删本机这一行。

跑过的测试：`tests/functions/version-gate-b2.test.ts`、`tests/functions/version-gate.test.ts`，加上上面那个临时用例，共 105 条全过。

## 复核（11-03）

复核人：代码审查员（同一人，只读）。对象：后端按 M1～M3、S1～S11 交回的工作区改动（未 git add）。先逐条核对上一轮的意见，再按同一尺度打分。

### 结论：签，9 / 10

M1～M3 都已解决。M2 的写法和我上一轮的建议不同，我核过，认为后端的写法更对（见下）。还剩两件，都不挡签字：
- 一件新问题：`tsconfig.functions` 又失败了，但来源是前端 B 的新测试，不是后端；
- 一条新建议 R1。

### 逐条核对

| # | 上一轮意见 | 现在 | 怎么核的 |
|---|---|---|---|
| M1 | typecheck 失败，12 个错误在 `_shared/auth.ts` | **解决** | `push-dispatch-usable.test.ts` 改成 `await import(AUTH_PATH)`；`_shared/auth.ts` 不再报错。五个 tsconfig 单独跑：app、sw、shared、node 都是 0；**functions 还有 33 个错**，全部来自前端 B 新加的 `tests/functions/cors-supabase-js-headers.test.ts`（它把 `src/platform/env.ts`、`auth-storage.ts` 带进了 Workers 的 tsconfig，见下面 N1），和后端无关 |
| M2 | 重算会吞掉“稍后” | **解决（接受偏离）** | 见下面“M2 偏离评估”；脚本 `cr-be1/snooze2.mts` 跑了七个场景 |
| M3 | test 负载多带了字段 | **解决** | 输入分成三种类型；`test` 输出只有 `{v, type, user_id}`，运行时多给的键丢掉；新测试断言正好三个键 |
| S1 | 截断顺序 | **部分做**（按主持人的安排） | C0 控制字符换成空格（`noC0`）、标题至少留 20 个码点，都已落地。截断顺序等明早清单第 71 条，没改，符合安排 |
| S2 | snooze 没在服务器校验 | **解决** | label 换掉 C0 后截到 40 个码点；minutes 不是 1～1440 的整数就整个不带 snooze，和 SW 一致 |
| S3 | 基础字段没校验 | **解决** | `PushPayloadError('bad_payload')`：校验小写 UUID、kind、正的安全整数 |
| S4 | drain 注释 | **解决** | 注释写明“最多多读一块” |
| S5 | 测试入口没有源码检查 | **解决** | `tests/build/push-fixed-key-guard.test.ts`：`tests/` 以外只有 `ece.ts` 的定义行出现这个名字，另有“扫到了源码”的防空断言 |
| S6 | 软删的占用行 | **解决** | 第 e 步改成“没软删、而且会话还在”才回 `endpoint_in_use`，否则直接删；pgTAP 从 56 条增到 59 条，全过 |
| S7 | `device_not_found` 没写进接口 | **解决** | 任务单“接口先定”第 1 条、架构 3.3 D（0.54）都写了，并要求启动流程先建好本会话的 devices 行 |
| S8 | 文档没写 `push_keys_ok` | **解决** | 架构 3.3 C 补了 0.54 一条：不授权、不进白名单，附录 A 同 |
| S9 | F10 放行生成脚本 | **解决** | 安全审查“六之四”有条件同意；条件“不联网、不被别处 import”由 `check-backend-f9-server.test.ts` 断言，注释写明以后要联网或被别处 import 就挪进 `tests/` |
| S10 | `vapidOnce` 只按私钥长度判断 | **解决** | 改成三个变量整串比较（只在内存里） |
| S11 | topic 没校验 | **解决** | `^[A-Za-z0-9_-]{1,32}$`，不合格不发、算 `failed`（`send.ts:64-78`） |
| S12 | version-gate 会审、冒烟集 | **解决** | 前端 B 已会审并签名；主持人核实 TC-B2-27 已标 ★，在自动冒烟里 |
| S13 | Form.tsx 的 lint 错误 | **解决** | `npm run lint` 现在 0 个错误、11 个警告，警告都不在后端文件里 |

另外两项自述也核了：
- **BE1-S1**：`vapid.ts` 的 `SUBJECT` 和 `set-vapid-keys.ps1:95` 的 `$SubjectRe` 是同一条正则（JS 的 `^…$` 写成 `\A…\z`，用区分大小写的 `-cnotmatch`）；只收小写 https 和 mailto，不带端口、不许空白。
- **F10 的 BE1-S3**：`supabase/functions/` 下的 `tests/`、`__tests__/` 也扫了，`f10-fn-tests-dir`、`f10-fn-tests-dir-ok` 两个样例都有。

### M2 偏离评估：接受

后端的规则：**传没传 `prevRemindAt`** 决定回落不回落，而不是我建议的“它等于算出的值才不回落”。传了时，原来已经回落到截止时刻的保持截止时刻，否则返回算出的（已过的）时刻。

后端的理由成立。我在 `snooze2.mts` 里跑了这几个场景：

| 场景 | 结果 |
|---|---|
| 09:00 新建 | 16:00 |
| 16:00 推过，16:02 按“稍后”后重算（传 16:00） | 16:00，`due_at = 16:11`，稍后照常响 |
| 16:30 新建（不传） | 17:00 |
| 16:30 新建后，16:40 按“稍后”重算（传 17:00） | 17:00 |
| 16:05 打勾后又取消（传 null） | 16:00。`pushed_for` 已经是 16:00，不会多推；按我原来的写法，null 不等于 16:00，会回落到 17:00、多出一次提醒 |

所以“看传没传”比“比值”更准。任务单“接口先定”第 4 条、架构 0.54 第 2 条的文字和 `remind.ts:62-96` 的实现一致；remind 的三个时区用例从 48 条增到 65 条，都过。

**R1（新建议，不挡签字）**：这个参数是可选的，**漏传就退回旧行为**（`snooze2.mts` 的场景 F：16:02 重算得 17:00，稍后又被吞掉）。最容易漏的是 BE-2 第 0 步，以及 FA-2 里不改时刻的保存路径。建议二选一：
- 把参数改成必填（比如 `prev: number | null | 'fresh'`，新建、改了时刻时显式传 `'fresh'`），由类型系统逼着每个调用点表态；
- 至少在 BE-2 的 push-dispatch 测试里加一条：第 0 步重算时传了原来的 `remind_at`；FA-2 的代码审查也查一遍各个保存路径。

另有一处残余情况，接受，记一笔：今后的旧版客户端改了截止日期，但它不懂 `due_time`、没按“不传”的方式重算，这一行就拿不到“截止时刻回落”。

### 新发现

- **N1（转前端 B，不属于后端）**：`npx tsc -p tsconfig.functions.json` 有 33 个错误，都来自 `tests/functions/cors-supabase-js-headers.test.ts`（B6-exe F5 ①）。它 import 了 `src/platform/env.ts`、`src/platform/supabase/auth-storage.ts`，这些文件要 Vite 的 `import.meta.env`、`__APP_VERSION__` 和 DOM 类型，Workers 的 tsconfig 里没有。所以 `npm run typecheck` 整体仍然失败。改法照 M1：动态加载，或者把这个测试挪到 app 或 node 的 tsconfig 能覆盖的目录。

### 复核时跑的测试

- 五个 tsconfig 单独跑：app、sw、shared、node 都是 0；functions 有 33 个错，都来自 N1，后端文件 0 个
- `npm run lint`：0 个错误，11 个警告（都不在后端文件里）
- `python -I build/check_backend.py`：0 个错误
- `npm run test:db:offline`：全过，其中 `28_claim_endpoint` 59 条、`29_push_endpoint_vectors` 231 条
- `deno task test`：285 过、0 失败、1 忽略
- 相关 vitest（上一轮那一套，加上 `push-fixed-key-guard`、`set-vapid-keys`）：27 个文件，409 过、11 跳过
- `node build/run_tz_tests.mjs --project node tests/shared/remind.test.ts tests/shared/push`：三个时区各 65 条，全过
- `npm run check:gate` 通过；`node build/gen_push_vectors.mjs --check` 一致
- 实验脚本 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\cr-be1\snooze2.mts`（M2 七个场景）
- 没跑：`npm run test:db`（要 Docker）；没有连任何真实服务

### 复核后的采纳情况（主持人，11-03）

- N1：交前端 B，并进 F5 那一批的必改项（`cors-supabase-js-headers.test.ts` 改成动态加载，或挪到别的目录；5 个 tsconfig 都要 0 错误）。
- R1：选第二种做法。参数仍是可选的，不再改签名，免得前端 A 已经标了 TODO 的地方又要跟着改。补两道防线：
  - BE-2 第 0 步的测试钉住“传了这一行原来的 remind_at”，并补一条漏传就失败的用例；这一条已经并进 BE-2 的条件清单。
  - 审查前端 A 的 FA-2 时，把各条保存路径逐一查一遍：不改时刻的保存必须传 prevRemindAt。主持人派 FA-2 后续审查时写进说明。
- 提交：BE-1 和运维 O-1 合成一批。`build/check_backend.py` 只暂存后端那几段，前端 B 的 F11 那段留到它的批次。
