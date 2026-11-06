# B2 安全审查 S-B2 · 服务器一侧证据清单（陪审用，不签字）

- 日期：2026-11-06　作者：后端（B2）　用途：③ 正式审查时，审查员按 [S-B2 签字记录](../../03-评审/B2/B2-安全审查-S-B2签字.md) 第七节逐项打勾，本表给每一项指到代码和测试的位置。**本表不打勾、不签字、不下结论。**
- 范围：签字记录第一节 D1-1～D1-8、第二节 D2-1～D2-4、第三节 C-1～C-10、第四节补齐、第五节约束 0～13、第七节表格（跳过“前端 SW 推送和 pending”“O-1 VAPID 脚本”两行，前者归前端 A，后者 11-03 已审）。
- 行号：11-06 按当前工作区（main 7e197ea 之后，未含别人未提交的改动对这些文件的影响——这些文件今天没有未提交改动）逐个读过。
- 路径简写：`_shared/…`、`push-dispatch/…`、`push-test/…`、`usage-report/…` 指 `supabase/functions/…`；`migrations/…`、`config.toml` 指 `supabase/…`；`claim_endpoint.sql` 指 `migrations/20261103110000_core_claim_endpoint.sql`。
- 签字记录里写的 usage-report 鉴权行号 310-319 已过时，现在是 `usage-report/core.ts:331-336`。

## 一、D1 推送端点白名单

| 条目 | 要点 | 实现 | 测试 | 备注 |
|---|---|---|---|---|
| D1-1 | 原串只收规范形式，不做规范化 | `_shared/push/endpoint.ts:19-42,57-78`；`claim_endpoint.sql:34-49` | `tests/shared/push/push-endpoint.test.ts:28,39,50`；`supabase/tests/rls/29_push_endpoint_vectors.test.sql`；`rls/28_claim_endpoint.test.sql:23,70`；`tests/build/push-endpoints-fixture.test.ts:87,96,110` | |
| D1-2 | WHATWG 复核，fetch 原样用原串 | `endpoint.ts:79-89`（`url_mismatch`）；`_shared/push/send.ts:101,112,119` | `tests/edge/push-send.test.ts:54`；11-06 补 `tests/edge/push-sb2-gaps.test.ts:37,51,58,65` | 11-06 补齐：随机 5000 条合格串证明 `href` 与原串逐字相等（这一步是兜底、正常走不到）；换掉全局 URL 让 href / hostname 不一致、解析抛错，三种都回 `url_mismatch` |
| D1-3 | 只有一份 TS、一份 SQL，区分大小写 | `endpoint.ts:1-3`；`send.ts:13,101-104`；`push-dispatch/core.ts:23,133`；`push-test/index.ts:10,71` | `tests/build/push-path-rule-sync.test.ts:13,16,20,25`；`push-endpoints-fixture.test.ts:137` | |
| D1-4 | 3xx / 0 / opaqueredirect 算失败，读 1 KB 后 cancel，不带 Cookie | `send.ts:17-18,29-30,43-59,83,89-90` | `push-send.test.ts:68,123,132,139,146,154,174` | |
| D1-5 | push-test 只回枚举 | `push-test/core.ts:28-29,69-77,108-117` | `tests/edge/push-test.test.ts:79,107` | |
| D1-6 | JWT 按 origin 缓存，`aud` = origin | `_shared/push/vapid.ts:75-95`；`send.ts:115`；`endpoint.ts:89` | `tests/shared/push/push-crypto.test.ts:208,233` | |
| D1-7 | p256dh、auth 三处同一规则 | `migrations/20261103100000_core_devices_push_constraints.sql:17-20`；`claim_endpoint.sql:52-61`；`endpoint.ts:96-97,112-117` | `push-path-rule-sync.test.ts:25`；`push-endpoint.test.ts:65,68,75,83`；`push-endpoints-fixture.test.ts:121,131` | |
| D1-8 | 本机两条都满足才认替身 | `_shared/push/stub.ts:16-42`；`push-dispatch/core.ts:114`；`push-dispatch/index.ts:54`；`push-test/core.ts:84-87`；F10 `build/check_backend.py:1127-1179` | `tests/edge/push-dispatch.test.ts:83,158-180`；`push-send.test.ts:71`；`push-test.test.ts:157,170`；`tests/build/check-backend-f9-server.test.ts:64,73,76` | |

## 二、D2 F9 ③ 名单、usage-report 关网关校验

| 条目 | 要点 | 实现 | 测试 | 备注 |
|---|---|---|---|---|
| D2-1 | 名单写死、单测钉住 | `build/check_backend.py:1007-1012` | `check-backend-f9-server.test.ts:12` | |
| D2-2 | 按调用判定 `safeEqual` | `check_backend.py:1017-1037,1098-1114` | `check-backend-f9-server.test.ts:37`；`tests/functions/usage-report.test.ts:36,45` | |
| D2-3 | 三个违规样例 | `tests/arch-fixtures/check_backend/f9-server-secret/`、`f9-server-secret-cfg/`；`check_backend.py:1115-1124` | `check-backend-f9-server.test.ts:21` | |
| D2-4 | `verify_jwt = false` 只有三个函数 | `config.toml:192-203`（account-purge、push-dispatch、usage-report） | `check-backend-f9-server.test.ts:55` | preview 构建另给 `_preview/db-probe` 关了 verify_jwt，只在预览产物里，不在 config.toml |

## 三、Web Push 自实现 C-1～C-10

| 条目 | 要点 | 实现 | 测试 | 备注 |
|---|---|---|---|---|
| C-1 | 每条新的 ECDH 临时密钥 | `_shared/push/ece.ts:86-91` | `push-crypto.test.ts:109` | |
| C-2 | salt 16 字节，只用 getRandomValues | `ece.ts:90` | `push-crypto.test.ts:109`；11-06 补 `push-sb2-gaps.test.ts:79,87` | 11-06 补齐：扫 `supabase/functions` 下全部 .ts（`_shared/gen` 生成目录除外，它由 eslint 的 shared 规则管），只跳过整行以 `//` 开头的注释（行尾注释、块注释照扫）；认 `Math.random`、`Math?.random`、`Math['random']`、`const { random } = Math`（含 `globalThis.Math`）四种写法，第 79 行先测规则本身认得出、不误报 `getRandomValues` |
| C-3 | 对方公钥 65 字节、0x04、在曲线上 | `endpoint.ts:112-117`；`ece.ts:52-59,64-71`；`send.ts:105-110` | `push-crypto.test.ts:118`；`push-send.test.ts:87` | |
| C-4 | RFC 8291 密钥推导 | `ece.ts:33-35,47-50,72-74` | `push-crypto.test.ts:81,97`；11-06 补 `push-sb2-gaps.test.ts:122` | 11-06 补齐：附录 A 输入上截下 ece.ts 每一步 Web Crypto 的输入输出（ECDH 共享密钥、key_info、IKM、CEK、NONCE、AES-GCM 的 iv），和 node:crypto（createECDH、hkdfSync）另算的一份逐字节比 |
| C-5 | 附录 A 固定向量；正式入口不收外部密钥 | `ece.ts:86,98-106` | `push-crypto.test.ts:81,91`；`tests/build/push-fixed-key-guard.test.ts:35` | |
| C-6 | aes128gcm 记录格式、请求头 | `ece.ts:19-22,38-45,75-79`；`send.ts:68-74` | `push-crypto.test.ts:97`；`push-send.test.ts:54` | |
| C-7 | VAPID JWT 头、aud、exp、sub、r‖s | `vapid.ts:17-21,36,72,85-93` | `push-crypto.test.ts:193,208,221,233` | |
| C-8 | 私钥只在内存、不可导出 | `vapid.ts:49-50,76`；日志只记原因码 `push-dispatch/core.ts:122`、`push-test/core.ts:91` | `push-crypto.test.ts:182`；11-06 补 `push-sb2-gaps.test.ts:188,196,215,231` | 11-06 补齐：私钥 `extractable = false`、exportKey 拒绝；loadVapid 六种失败只回原因码；push-dispatch 配置错和正常发一轮时，回包、deps.log、logs、心跳、console、发出的请求头都没有 d 和 JWK 原串 |
| C-9 | 启动自检密钥对 | `vapid.ts:56-67`；`push-dispatch/index.ts:34-37`；`push-dispatch/core.ts:116-122` | `push-crypto.test.ts:158,165,176`；`push-dispatch.test.ts:96,104,115` | |
| C-10 | 单条出错只影响这一条、只记码 | `send.ts:99-119`；`push-dispatch/round-send.ts:59-67,141-148` | `tests/edge/push-dispatch-guard.test.ts:129`；`tests/edge/push-dispatch-d3-full.test.ts` ③；真库 `supabase/tests/store-it/push-dispatch-d3.it.ts` ③ | ③ 两条是 11-06 新加，见 [B2 后端开发自测](B2-后端开发自测.md) |

## 四、正文补齐三档

| 条目 | 要点 | 实现 | 测试 | 备注 |
|---|---|---|---|---|
| 补齐 | 1024 / 2048 / 3072，RFC 8188 | `ece.ts:19,38-45`；`_shared/push/payload.ts:21-23,75,179-195` | `push-crypto.test.ts:128,145`；`push-send.test.ts:107`；`push-test.test.ts:63` | resolve 负载没有单独断言档位（字段少，落 1024 档） |

## 五、给后端的约束 0～13

| 条目 | 要点 | 实现 | 测试 | 备注 |
|---|---|---|---|---|
| 0 | 字符集、`%2e`、点段；D1-7、D1-8 | `endpoint.ts:32-42,76`；`claim_endpoint.sql:41,46-47` | `push-path-rule-sync.test.ts:13,16`；`push-endpoints-fixture.test.ts:87,96` | |
| 1 | 原串校验＋WHATWG 复核 | 同 D1-1、D1-2 | 同上 | |
| 2 | 先会话 → 校验 → 才删写 | `claim_endpoint.sql:71-77`（会话）→ `80-85`（校验）→ `94`（删别的行）→ `110-114`（写本行） | `rls/28_claim_endpoint.test.sql:137-147,151-166` | |
| 3 | 区分大小写，先 ASCII 后长度 | `endpoint.ts:72-73`；`claim_endpoint.sql:43-44` | `push-path-rule-sync.test.ts:20` | |
| 4 | 两份校验跑同一组 fixture | `endpoint.ts`；`claim_endpoint.sql:34-61`；`tests/fixtures/push-endpoints.json` | `push-endpoint.test.ts:28,68`；`rls/29_push_endpoint_vectors.test.sql:1-5` | |
| 5 | manual、超时 5 秒、1 KB、不带 Cookie | `send.ts:30,43-59,83` | 同 D1-4 | |
| 6 | 不合格：不发、三列置空、只记原因码 | `push-dispatch/round-send.ts:59-61`；`push-dispatch/store.ts:133` | `tests/edge/push-dispatch-round.test.ts:170`；`push-send.test.ts:77` | |
| 7 | JWT 按 origin、≤ 12 小时、只在内存 | `vapid.ts:17-18,76,85-95` | `push-crypto.test.ts:208,233` | |
| 8 | 替身线上在验完密钥后回 500 | `push-dispatch/core.ts:105-107,114`；`stub.ts:34-42`；`send.ts:101,112` | `push-dispatch.test.ts:71,83,168` | |
| 9 | push-test 只回枚举 | 同 D1-5 | 同 D1-5 | |
| 10 | C-1～C-10 | 见第三节 | 见第三节 | |
| 11 | 补齐三档 | 见第四节 | 见第四节 | |
| 12 | F9 ③ | 见第二节 | 见第二节 | |
| 13 | errcode 22023，不带 detail、hint、原串 | `claim_endpoint.sql:80-85` | `rls/28_claim_endpoint.test.sql:153-165`；11-06 补 `supabase/tests/rls/41_claim_endpoint_error_shape.test.sql:32-48` | 11-06 补齐：GET STACKED DIAGNOSTICS 取 code、message、detail、hint、上下文，三种不合格（地址、p256dh、auth）都是 22023、信息只有错误名、detail 和 hint 为空、五项都不含原串；lemo-e2e 和离线 PGlite 都过 |

## 六、第七节正式审查表逐行

| 第七节的行 | 实现 | 测试 / 运行证据 | 备注 |
|---|---|---|---|
| 免查名单（TC-B2-27，P0） | `functions/sb/version-gate.ts:56-66`（Cloudflare 一侧） | `tests/functions/version-gate-b2.test.ts:14,55`；`tests/functions/version-gate.test.ts:94` | 11-06 落盘：`version-gate-b2.test.ts`、`version-gate.test.ts` 104 条全过，见 [证据-11-06/TC-B2-27-冒烟.txt](证据-11-06/TC-B2-27-冒烟.txt)。用例期望里“todos 的行都还在”是真库权限一侧，单测只验到被 426 挡；QA 正式冒烟仍按用例表执行 |
| cron 密钥（TC-B2-68，P0） | `push-dispatch/core.ts:105-107`；`migrations/20261103120000_core_push_dispatch_cron.sql:12-17`（从 Vault 读，不写死）；`check_backend.py:1004,1079-1081` | `push-dispatch.test.ts:61,71,77`；`tests/build/check-backend-migrations.test.ts:84`；反例 `supabase/tests/d1-fixtures/27_cron_hardcoded_secret.psql` | lemo-e2e 上 cron 调用回 401（e2e 的密钥和库里对不上），说明错密钥被拒——旁证，不作判据 |
| claim_endpoint 授权（TC-B2-79、84，P0） | `claim_endpoint.sql:71-77,117,119-123`；`migrations/0001_core.sql:343-346`（三列不授给客户端） | `rls/28_claim_endpoint.test.sql:137-147,225-243`（11-06 lemo-e2e 全部 rls 1566 条通过） | 测试名没有带 TC 编号，按内容对 |
| usage-report 关网关校验、F9 ③（TC-B2-86，P0） | `usage-report/core.ts:331-336`；`_shared/proxy-headers.ts:25-32`；`config.toml:202-203` | `usage-report.test.ts:36,45,51,71,78`；`check-backend-f9-server.test.ts:12,21,37,55` | “开工前意见第二节 8 条证据”是流程证据，不在代码里 |
| 端点白名单两处、不跟随重定向、替身线上拒绝（TC-B2-80，P1） | 见第一节 | 见第一节 | |
| push-test（TC-B2-85，P1） | `push-test/core.ts:79-118` | `push-test.test.ts:62-190` | preview 冒烟见 [推送链路做通记录](B2-推送链路做通记录.md) 第一节（未执行） |
| 推送不写日志原文（TC-B2-24，P1） | `push-dispatch/round.ts:32`；`push-dispatch/core.ts:19`；`push-dispatch/index.ts:46`；`push-test/core.ts:13-14` | `push-dispatch-round.test.ts:46`；11-06 新加：内存库和真库 ③ 都断言 logs 和函数日志不含标题、端点；构建失败时函数日志只记原因码 `build_failed`（`round-send.ts` 补了 `c.log(reason)`），两份测试都断言日志非空且含它 | |
| Web Push 自实现、正文补齐（P1） | 见第三、四节 | 见第三、四节 | |
| TZ-invalid-b2（D7） | `push-dispatch/round-util.ts:82-95`；`round-step0.ts:120`；`round-dispatch.ts:59-60` | `push-dispatch-step0.test.ts:117`；`push-dispatch-r316.test.ts:41,66`；`push-dispatch-allday.test.ts:109,120` | 签字记录写“BE-2 代码审查时定” |
| 风险接受：未鉴权请求也算一次调用 | 先鉴权再判配置：`push-dispatch/core.ts:104-115`；`usage-report/core.ts:331-336` | `push-dispatch.test.ts:71`；`usage-report.test.ts:45` | 写明即可 |

## 七、缺口（11-06 补测后）

| # | 缺口 | 11-06 处理 | 证据 |
|---|---|---|---|
| 1 | D1-2 没有触发 `url_mismatch` 的测试 | 补了：随机 5000 条证明正常走不到；换掉全局 URL 三种情况都回 `url_mismatch` | `tests/edge/push-sb2-gaps.test.ts:37-70`；[vitest-sb2-gaps.txt](证据-11-06/vitest-sb2-gaps.txt) |
| 2 | C-2 `supabase/functions` 下没有拦 `Math.random` | 补了源码扫描测试（没改 eslint 配置） | `push-sb2-gaps.test.ts:79,87` |
| 3 | C-4 没有逐步中间值断言 | 补了，对照 node:crypto 另算的一份；没有逐字写 RFC 正文里的中间值（仓库里没收这些值，手抄易错），整份密文仍对附录 A | `push-sb2-gaps.test.ts:122` |
| 4 | C-8 没有“私钥不进日志”的断言 | 补了四条 | `push-sb2-gaps.test.ts:188-256` |
| 5 | 约束 13 没有“不带 detail、hint、原串”的断言 | 补了 pgTAP 7 条（新文件，没改 28） | `supabase/tests/rls/41_claim_endpoint_error_shape.test.sql`；[rls41.txt](证据-11-06/rls41.txt)；全部 rls 40 个文件 1573 条 [rls-all2.txt](证据-11-06/rls-all2.txt) |
| 6 | TC-B2-27 冒烟结果未落盘 | 落盘了单测一层（104 条全过） | [TC-B2-27-冒烟.txt](证据-11-06/TC-B2-27-冒烟.txt)；“经 /sb 真调、todos 行还在”要真后端 e2e，QA 正式冒烟时做 |
| 7 | TC-B2-86 开工前意见第二节 8 条证据 | **补不了**：那是审查流程里的证据（开工前安全意见被吸收的记录），不是代码行为，写不成测试；签字记录第二节 2.2 已有逐条吸收情况，审查员直接对那一节 | — |

## 修改记录

| 日期 | 改动 | 人 |
|---|---|---|
| 2026-11-06 | 建立（逐项定位，不打勾不签字） | 后端（B2） |
| 2026-11-06 | 按主持人要求补第七节 1～6 号缺口的测试，7 号写明补不了的原因；表里对应行改指新测试 | 后端（B2） |
