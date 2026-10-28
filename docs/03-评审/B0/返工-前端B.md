# B0 第一轮评审 · 前端 B 返工记录

- 返工人：前端程序员 B（官网、语言分流、/sb 与 /files 的 Pages Functions、shared/objstore、exe 外壳）
- 依据：本目录 [B0-代码审查.md](B0-代码审查.md)、[B0-安全审查.md](B0-安全审查.md)、[B0-QA测试报告.md](B0-QA测试报告.md)、[B0-动效确认-UI4.md](B0-动效确认-UI4.md)；架构设计 v4（0.32）14.2 第 1、11 点，3.3 G“R2 起”，8.4、8.6；[B0 R2 任务单](../../09-路线图/B0-R2任务单.md) FB-1、FB-3
- 基线：main `14ae558`；分支 `worktree-agent-a53c0db82c7ea2619`
- 日期：2026-10-28
- 做法：每条先写会失败的测试，跑一遍确认是红的（46 条新断言失败），再改代码到全绿。**本记录只说明改了什么，是否通过由复查人判定。**

## 一、逐条：评审编号 → 改了什么 → 怎么验证

行号是本次提交后的行号。

### shared/objstore（代码审查中 3、低 1、低 2；安全审查低 2、低 3）

| 评审编号 | 改了什么（文件:行） | 怎么验证 |
|---|---|---|
| 代码审查 **中 3**：对象存储请求没有超时 | `shared/objstore-net.ts:107` 起新增 `timedFetch`：每个请求一个 `AbortController`，到时 `abort()` 并抛新错误码 `timeout`（`:41`）；超时后才回来的响应把体取消掉。`shared/objstore.ts:50～53` 配置加 `timeoutMs`（list、head、deleteMany，默认 10 秒，**含读完响应体**）和 `transferTimeoutMs`（put、get，默认 30 秒，**只算到拿到响应头**，get 的流式响应体交给调用方不计时）；`:170～171` 校验（0、负数、非整数报 `bad_input`）；`:212` 所有请求都经 `timedFetch`。`/files` 原来就把任何 `ObjStoreError` 归成 `503 try_later`，`timeout` 也走这条 | `tests/shared/objstore-net.test.ts`“请求超时”6 条：永不返回的假 fetch 下五种操作都报 `timeout` 且 signal 已中止；put/get 用长超时、head 用短超时；get 拿到响应头后慢慢读体不被中止；list 的 XML 一直不来也超时；迟到的响应体被 cancel；超时参数不合规报错。Node 和 Deno 各跑一遍 |
| 代码审查 **低 1**：非 200 的响应体没读也没取消 | `shared/objstore-net.ts:93～101` `discard()`；`timedFetch` 里处理函数抛错时（`fail()` 等不读体的分支）统一 cancel（`:138～142`）；`shared/objstore.ts:303`（put 成功的体）、`:313`（get 404）、`:325`、`:329`（head） | `objstore-net.test.ts`“不用的响应体一律取消”：404（get、head）、412、403、5xx（get、put、list、deleteMany）、put 的 200 共 9 种都 cancel 一次；get 200 的体不取消（交给调用方） |
| 代码审查 **低 2**、安全审查 **低 3**：`deletePrefix` 不要求 `<uuid>/` | `shared/objstore-net.ts:59` `USER_PREFIX_RE`（小写 uuid 加 `/`，整串匹配）；`shared/objstore.ts:340` 不符就 `bad_input`，一个请求都不发。内存替身 `tests/fakes/objstore-memory.ts:47、173` 同步同一条规则（`tests/build/objstore-fake.test.ts` 要求两边行为一致） | `objstore-net.test.ts`：少 `/`、`//`、多一级目录、两段 uuid、大写、短一位、长一位、`a/`、非 uuid、`/`、前面多字符、`../` 共 12 种都拒且 0 次请求；`objstore-fake.test.ts` 对内存替身和真客户端各跑一遍同一组反例；原有注销 runner、探针用例（都用 `<uuid>/`）照常通过 |
| 安全审查 **低 2**：非回环地址允许 `http://` | `shared/objstore-net.ts:61～69` `checkEndpoint`：只认 `https://主机[:端口]`；`http` 只许 `127.0.0.1`、`localhost`、`[::1]`；不许用户名、路径、大写协议。`shared/objstore.ts:169` 建 store 时检查 | `objstore-net.test.ts`“非本机地址不许 http”：6 个合法写法通过，9 个反例（含 `127.0.0.1.evil.test`、`localhost.evil.test`、`user@127.0.0.1`、`127.0.0.2`）都抛 `bad_input`。所有单测里的假地址从 `http://fake-s3.test` 改成 `https://`；E2E 的替身是 `http://127.0.0.1:9199`，照常通过 |

`shared/objstore.ts` 加了这些以后超过 W1 的 300 行，把“和运行环境之间的接口、错误类型、地址和超时检查、带超时的 fetch”拆到新文件 `shared/objstore-net.ts`，`objstore.ts` 原样再导出 `ObjStoreError` 和各类型，调用方不用改。`build/copy_shared.mjs` 按目录复制，新文件自动进 `_shared/gen/`（`deno task check` 通过）。

### functions/files（代码审查低 4、低 5、低 12；安全审查低 4）

| 评审编号 | 改了什么（文件:行） | 怎么验证 |
|---|---|---|
| 代码审查 **低 5**、安全审查 **低 4 ①**：`storeFor()` 抛错那条 500 没有安全头和 CORS | `functions/files/[[path]].ts:206～222` `onRequest` 的两条 500（缺配置、建 store 抛错）都改用 `err()`，和别的响应一样带 /files 安全头和 CORS | `tests/functions/files-get.test.ts`“Pages 入口：R2 配置不合规”：`R2_ENDPOINT` 为非本机 http、不是网址、空字符串三种，都回 500 `files_misconfigured`，带 nosniff、sandbox CSP、`private, no-store`、exe 来源的 CORS、JSON 的 Content-Type |
| 安全审查 **低 4 ②**：/files 预检和 /sb 共用方法表，带了 PATCH、DELETE | `functions/_lib/cors.ts:11` 新增 `FILES_ALLOW_METHODS = 'GET, PUT, POST, OPTIONS'`，`:61` `preflightHeaders` 加 `methods` 参数（默认仍是 /sb 那套）；`functions/files/[[path]].ts:160` /files 预检用它 | `files-get.test.ts`“OPTIONS”：`/files/v1/sign` 和 `/files/v1/o/…` 的预检都精确等于 `GET, PUT, POST, OPTIONS`，带 nosniff；`sb-proxy.test.ts` 里 /sb 预检的断言不变（仍是原来那套） |
| 代码审查 **低 4**：“桶不对”在 PUT 里有两种回法 | `functions/files/[[path]].ts:51～52`（本地判断）、`:76～80`（RPC 回的单项 reason）：统一成 **403 forbidden + reason `bad_bucket`**，和 TC-B0-36、E2E、sign 的单项 reason 一致；RPC 回 `bad_path` 仍是 400 `bad_path`；日志码分开记（`put_bad_bucket` / `put_rpc_bad_bucket`） | `tests/functions/files.test.ts`“RPC 回 bad_bucket → 403 forbidden / bad_bucket”：RPC 回 bad_bucket 和 bad_path 各一次，状态码和错误体按上面；原有 TC-B0-36 用例不变 |
| 代码审查 **低 12**：重复的小工具 | 新文件 `functions/_lib/raw-url.ts`：从原始 URL 取路径和查询串（不解码、不规整），`functions/files/[[path]].ts:28`、`functions/sb/[[path]].ts:102` 共用；`functions/_lib/files-upload.ts:29` 的 `concat` 导出，`functions/_lib/files-sign-route.ts:40` 改用它 | 原有 parseRoute、upstreamPath、sign 读请求体的用例全部照常通过 |

### QA D-02（/sb 拒绝名单的百分号编码绕过；代码审查低 7、安全审查低 1）

| 改了什么（文件:行） | 怎么验证 |
|---|---|
| `functions/sb/[[path]].ts:61～112`：`decodedLayers()` 把原始路径逐层 `decodeURIComponent`（最多 4 层；解不开或 4 层后还有 `%` 就拒）；原始那层和**每一层解码结果**都要过：可疑写法（点段、编码的 `/ . \`、空字节、双斜杠，大小写不敏感）、控制字符、白名单前缀、拒绝名单（按小写比）。转发给上游的仍是原始路径（不替上游解码）。正常编码（如 `%2D`、`%20`）照常放行 | 新文件 `tests/functions/sb-encoded-path.test.ts` 31 条：`files%5Fauthorize`、`files%5fauthorize`、`%66iles_authorize`、`%46ILES_AUTHORIZE`、`%61dmin`、`%41DMIN`、`adm%69n`；多重编码 `%255F`、`%25255F`、`%2561`、`%252561`；`%252F`、`%252f`、`%25252F`、`%252e%252e`、`%252E%252E`、`%255c`、`%2500`；解码后落到 `/rest/v1/` 根；`%`、`%2`、`%zz`、坏 UTF-8 `%C0%AF`；编码层数过多——全部 `null`；3 条经 `handleSb` 回 404 且没请求上游；正常编码放行。`tests/functions/sb-storage.test.ts`（TC-B0-119）加 5 条：编码过的 files_authorize 和 vault-preview 下多重编码的 `..`、`/` 都 404 不转发。**线上 Cloudflare 边缘的实际行为待预览**：`tests/e2e/sb-forward.preview.test.ts` 已加对应用例（见 D-11） |

### QA D-10（测试名和内容不符、占位测试显示为“通过”）

| 改了什么（文件:行） | 怎么验证 |
|---|---|
| `tests/e2e/files.spec.ts:47～61`：补一个**真的不带 `X-App-Version` 头**的 PUT（断言 426 + `upgrade_required`），原来发 3.9.0 的那个改名为“版本过低 426”保留 | `CI=true npx playwright test`：chromium、webkit 两个项目都过 |
| `tests/shared/objstore.test.ts:247` 起：没设 `OBJSTORE_ENDPOINT` 时用 `it.skip`，报告里显示为“跳过”，不再用一条 `expect(LIVE).toBe(undefined)` 冒充通过；打真替身那条的测试前缀改成随机 uuid（配合 deletePrefix 新规则）。`tests/shared/deno-vitest-shim.ts:4～7、24～27` 给 Deno 替身补 `it.skip`（Deno 报告里是 `ignored`） | Vitest 里这一条显示 skipped；`deno task test` 显示 `1 ignored` |

### 过时注释（代码审查低 10）

| 改了什么（文件:行） | 说明 |
|---|---|
| `shared/objstore.ts:4` | 替身 MinIO → LocalStack（注明为什么不用 MinIO 见 `docker-compose.objstore.yml`） |
| `tests/shared/objstore.test.ts:247` 段标题、`tests/shared/fake-s3.ts:1` | 同上 |
| `functions/index.ts:1～2` | “_routes.json 只让 `/` 和 `/sb/*` 进 Functions” → `site/_routes.json` 让 `/`、`/files/*`、`/sb/*` 进，后两者各有自己的处理文件 |

### 其他顺手改的（归我的）

| 评审编号 | 改了什么 | 怎么验证 |
|---|---|---|
| QA **D-03**（只改归我的测试文件；B0 是否先建 file-check 由主持人和架构师定） | `tests/functions/files-get.test.ts` 文末 TC-B0-116、`tests/data-manifest/objstore-cases.test.ts` 文末 TC-B0-117：空的 `it(…, () => {})` 改成 `it.todo`，写明要等哪个函数（file-check：B4b-1；account-purge：B1）和 Docker | Vitest 显示 4 todo（原 2 + 这 2） |
| QA **D-11** 第 1 点 | `tests/e2e/sb-forward.preview.test.ts:86～98`：删掉 0.32 已划掉的“Storage 签名链接是相对路径”，换成预览环境上核对“经 /sb 上传 images 回 404”和“三种编码过的 files_authorize 回 404”（顺带完成安全审查低 1 / QA 待实测总表第 24 项要的线上核对用例） | 待预览（`describe.skipIf(!ready)`，本机跳过） |
| QA **D-11** 第 3 点、任务单 FB-3 | 新文件 `.dev.vars.example`：只有变量名、本机地址和注释，**没有任何值**；`.gitignore:32～33` 加 `!.dev.vars.example`（原来 `.dev.vars.*` 会把它也忽略） | `git check-ignore` 不再忽略它；`check_registry` 已登记 |
| 新加的写法暴露的旧测试问题 | `tests/build/objstore-fake.test.ts:108～110`：“没建的桶”那条同时发两个请求再逐个 await，后一个先失败时被 Vitest 报“未处理的拒绝”；改成一个一个发。断言不变 | 全量 Vitest 0 个 unhandled error |

## 二、未改及原因

| 评审编号 | 原因 / 归谁 |
|---|---|
| 代码审查中 1、安全审查中 1、QA D-01（TC-B0-35、73、75、89、92、93、97 的 CI / D1 检查） | `build/`、`.github/workflows/`、`build/d1/` 和 SQL：归后端、运维（安全审查建议“后端或运维”） |
| 代码审查中 2 ①③④、QA D-04（CI db 任务跑打真替身的 Vitest、`ci.yml` 第 87 行注释） | CI 工作流归运维。我这边已做的配合：`objstore.test.ts` 真替身组在设了 `OBJSTORE_ENDPOINT` 时会跑（不是写死跳过）；TC-B0-116、117 空壳改为 todo。`purge-runner.test.ts` 第 81 行的 `describe.skip` 归后端 |
| 代码审查低 3（附件缩略图查找用不上主键索引）、低 8（note_images 不查隐私记）、QA D-08 | SQL / D1 样例：归后端（低 8 还要架构师定） |
| 代码审查低 6（客户端超时只管到响应头）、低 9（file-check 已改 ok 后重传回 403） | `src/platform/files.ts`：App 主体，归前端 A（低 9 还和 B4b-1 的调用顺序、后端 file-check 有关） |
| 代码审查低 11、QA D-06、D-07（架构规则样例按规则号核对、补样例） | `tests/arch/`、`eslint.config.js` 的规则样例：归前端 A |
| 安全审查中 2（`tools/release/publish.ps1`） | 登记册里归运维；审查已定“归 B6-exe、B7a 冻结前复审，本轮不阻塞 B0” |
| 安全审查低 5（令牌脚本按进程名判断 Claude） | `tools/keys/*.ps1` 归运维 |
| 安全审查低 6（deploy-preview 的 `workflow_dispatch`）、QA D-05（actionlint 进 CI）、D-09（pre-commit 钩子要手动启用） | 工作流和开发环境：归运维 / 主持人 |
| 安全审查低 7、低 8 | 架构文档风险 21、环境清单：归架构师、运维 |
| 安全审查低 9（旧 agent worktree） | 归主持人 |
| 安全审查低 10（Deno 一侧没有 deno.lock） | 审查建议 B1 起评估；归后端 / 运维 |
| QA D-02 的线上部分（Cloudflare 边缘会不会先规整 `%61` 这类编码） | 待预览环境：用例已写进 `sb-forward.preview.test.ts`，有 `PREVIEW_*` 变量后跑 |
| QA D-03 的决定（B0 先建 file-check 最小版，还是把 116、117 真链路正式挪到 B1 / B4b-1） | 归主持人和架构师；我只把空壳改成了 todo |
| QA D-11 第 2 点（测试用例 TC-B0-89 “八个”→“九个”）、第 4 点（manifest 的 icons 为空） | 测试用例文档归 QA；`src/public/manifest.webmanifest` 归前端 A |
| QA TC-B0-59（没有测试断言 `/app/` 的 CSP 有 base-uri、form-action） | `/app/*` 的头在 `src/_headers`、测试在 `tests/e2e/csp.spec.ts`，登记册里都归前端 A；`site/_headers`（归我）这一轮没有评审意见 |
| UI-4 动效确认 M-1、M-2、L-1～L-4 | 全在 `src/motion/`、`src/kit/`、`src/app/router.ts`、`eslint.config.js`：归前端 A，UI-4 定为 B1 / B2 处理、不卡 B0 |
| shared/i18n、site/ | 四份评审里没有归这两处的条目 |

## 三、本机检查结果（返工后，在本分支上跑）

| 命令 | 结果 |
|---|---|
| `npm run lint`（ESLint + Stylelint） | 0 错误 0 警告 |
| `npm run typecheck`（5 份 tsconfig） | 0 错误 |
| `npx vitest run` | 45 个文件通过、1 个跳过；**636 通过**、12 跳过、4 todo（返工前 592 通过、13 跳过、2 todo） |
| `deno task test` | 93 通过、0 失败、1 ignored（返工前 85 通过） |
| `deno task check` | 通过 |
| `CI=true npx playwright test`（chromium + webkit） | 42 通过、2 跳过（预览环境两条，要 `LEMO_E2E_PREVIEW_URL`） |
| `python -I build/check_arch.py` | 0 错误、2 警告（W2：缺 2027 年 cn、kr 节假日，预期提醒，和返工前一样） |
| `python -I build/check_registry.py` | 没登记 0、登记了不存在 0 |
| `python build/req_index.py --check` | 需求 218 条，问题 0 |

新加的超时用例连跑 5 次都过；用到的时间差都留了 2 倍以上余量（例如超时 20 毫秒对 150 毫秒才回的响应）。

## 四、请复查人重点看

1. `shared/objstore-net.ts` 的 `timedFetch`：超时、迟到响应、处理函数抛错三条路上响应体都被取消，没有未处理的拒绝。
2. `functions/sb/[[path]].ts` 的 `upstreamPath`：每一层解码结果都过可疑写法、白名单、拒绝名单；转发的仍是原始路径。
3. `deletePrefix` 的 `<uuid>/` 规则是“整串只能是一个人的前缀”，比审查建议的“以 `<uuid>/` 开头”更严。以后 storage-sweep 如果要按 `<uid>/<note_id>/` 删，需要放宽并重新评审。

---

## 第二次（架构 0.33）

- 依据：架构设计 v4 的“0.33 B0 第一轮评审返工”一节（第 1、3、9、10、13 条和返工清单“前端 B”），[返工-架构师](返工-架构师.md) 第三节“前端 B”
- 基线：main `8332dcb`；分支 `worktree-agent-aa0d16d9e80beceb8`
- 日期：2026-10-28
- 做法：先改测试，跑一遍确认是红的，再改代码。**本节只说明做了什么，是否通过由复查人判定。**

### 一、逐条

| # | 架构 0.33 | 做了什么 | 怎么验证 |
|---|---|---|---|
| 1 | 第 10 条（代低 7、安低 1、QA D-02）：`/sb` 路径里有 `%` 一律拒 | **以架构为准，推翻我上一轮的“最多 4 层逐层解码再比”**。`functions/sb/[[path]].ts`：路径字符表去掉 `%`，在比白名单、拒绝名单之前判断，出现就本地 404 `not_found`；`decodedLayers`、`MAX_DECODE_ROUNDS`、控制字符检查、`%2e %2f %5c %00` 那几条正则全部删掉，只留一套逻辑（字符表 → 点段、反斜杠、双斜杠 → 白名单、拒绝名单）。只看路径，查询串和 `#` 之后不受影响 | 先改 `tests/functions/sb-encoded-path.test.ts`，跑出 4 条红（原来放行的 `%2D`、`%20` 等），改完全绿。**四条反例**单列：`/sb/rest/v1/rpc/files%5Fauthorize`、`/sb/rest/v1/rpc/%66iles_authorize`、`/sb/auth/v1/%61dmin/users`、`/sb/auth/v1/adm%69n`；原来那些编码绕过的写法（多重编码、大小写、编码的 `/ . \`、空字节、解不开的 `%zz`、坏 UTF-8）全部仍被拒；原来当“正常编码”放行的 `ai%2Dparse`、`todos%20x`、vault-preview 的 `%2Epptx` 现在也拒；查询串带 `%`（PostgREST 过滤值、`redirect_to`、`token=a%2Bb`）照常转发、查询串原样带给上游；`handleSb` 对四条反例 GET、POST 都回 `{code: 'not_found'}` 且上游 0 次请求。`tests/e2e/sb-forward.preview.test.ts` 的线上用例换成这四条，并断言响应体是转发层的 `not_found`（不是上游的 404）——**待预览**（QA 待实测第 24 项） |
| 1a | 第 10 条的前提：正常路径里不会有 `%` | 改之前先核对过，**没发现会误伤**：白名单五个前缀下，REST 是表名和 `rpc/<函数名>`（都是 `[a-z_]`）；Auth 是固定路径加 uuid（`factors/<id>` 等）；Functions 是函数名（`[a-z-]`）；Realtime 是 `/realtime/v1/websocket`，参数都在查询串；vault-preview 是随机路径、不含 user_id 和文件名（D-12、5.13 第 11 点）。仓库里没有往 `/sb` 路径里 `encodeURIComponent` 的代码（`src/app/router.ts` 那处是 hash 路由） | 已有的正常路径用例（`sb-proxy.test.ts` 的白名单表、`sb-storage.test.ts` 的 vault-preview GET）全部照常通过 |
| 2 | 返工清单：三个 `describe.skip` 改 `describe.skipIf(!env(...))`；第 13 条“设了 `OBJSTORE_ENDPOINT` 却还有跳过的就让任务失败” | 条件统一写成 `describe.skipIf(!OBJSTORE_LIVE)`（新文件 `tests/shared/objstore-live.ts`：读 `OBJSTORE_*` 五个变量、建真客户端，四处共用）。组里写的是**设了变量就真能跑的测试**，不是空壳：① `purge-runner.test.ts`：`runPurgeCases` 打真替身（删对象经真客户端的 `deletePrefix`），外加“purge 没删就报 A 还剩”的反例；② `objstore-cases.test.ts`：生成的 count 探针在真替身上数得对，删掉 A 后 A 为 0、B 不变（随机 uuid，不和 ① 的 SEED_USERS 互踩）；③ `files-get.test.ts`：`/files` 经真替身 PUT → 同路径再 PUT 回 409 `exists`（真条件写）→ sign → GET 内容和类型一致、别人的路径 403、对象确实在替身里。`objstore.test.ts` 原来的 `liveIt` 也改成同一写法；Deno 的 vitest 替身补了 `describe.skipIf` | 本机用仓库锁定的镜像（本地已有，未下载）`node build/objstore.mjs up` 起 LocalStack 实测：**设了变量时 Vitest 这 5 条全部真跑通过、0 条跳过**（全量 710 过、10 跳过，剩下 10 条是预览环境和兼容 harness 的，与替身无关）；`deno task test` 94 过、0 ignored。没设变量时这 5 条显示“跳过”。测完已 `down`。ci.yml 里“设了变量却跳过就失败”那一步归运维 |
| 3 | 第 1 条：116、117 的空 `it` 改 `it.todo` 并写明落地批 | 上一轮已改成 `it.todo`；本次把文字改成“架构 0.33 第 1 条挪到 B4b-1 / B1”。`purge-runner.test.ts` 原来那个 `describe.skip` 里的空 `it` 拆成两块：B0 能跑的部分进上面的 skipIf 组，真 account-purge 那一遍改成 `it.todo`（B1） | Vitest 显示 5 todo（files-get 1、objstore-cases 1、purge-runner 1、sb-forward.preview 2） |
| 4 | 第 9 条、TC-B0-89：“表 × 角色 × 操作”正反用例生成器 | 新文件 `tests/data-manifest/grant-matrix.ts`（生成器）、`grant-runner.ts`（执行）、`pglite-migrated.ts`（离线建库）、`grant-matrix.test.ts`。**期望的来源**：清单（`clientWritable`、`insertOnly`、`updateOnly`、`anonReadable`、`clientDelete`）+ `build/d1/whitelist.ts`（`TABLE_GRANTS`、`COLUMN_GRANTS`、`PUBLIC_RPCS`），口径和 D1 第 4、5 节一致，不另起一套。每张清单表和白名单里的四个 `scan_` 视图 × {anon、authenticated、service_role、fn_vault、fn_ai} × {SELECT、INSERT、UPDATE、DELETE} 各一条，期望是“表级全给 / 一列都不给 / 只给这几列”；九个 public RPC 各 anon、authenticated、service_role 三条执行权。**双向**：白名单写了清单没有的表（`scan_` 视图除外）、同一格表级列级都写、空列名单、列级写 DELETE、RPC 重复、清单同一张表登记两次，生成时就报错；数据库里多出清单外的表、视图、public 函数，runner 报错；九个 RPC 里还没建的不算少（0.33 第 3 条）。**runner**：先用 `has_table_privilege` / `has_column_privilege` 算出能用的列和期望逐项比（多一列、少一列、表级有无都报），再以那个角色在事务里真执行不动数据的语句印证（能用的列逐列执行必须成功、不能用的执行一句必须 42501）。`cli.ts`（`npm run gen:manifest`）另写 `grant-cases.json` / `grant-cases.txt` 给后端审断言 | PGlite 跑 7 个迁移后：**780 格、27 条 RPC 全过**，数据库里没有生成器没覆盖的表和视图；B0 已建的 RPC 是 files_authorize、purge_deleted、record_consent。TC-B0-89 点名的反例逐条断言在生成结果里（fn_ai 读 vault 只有 user_id、pin_epoch；fn_vault 读 devices 只有四列；两个角色碰 anniversaries 全被拒；fn_vault insert note_vectors、fn_ai delete vault_ai、fn_vault delete notes / note_images / note_files 被拒；authenticated 只有 devices 能 delete；anon 调九个 RPC 被拒）。**改坏数据库五处**（多给 fn_ai 一列 pin_hash、收回 fn_vault 对 vault_credentials 的 insert、给 authenticated 删 events、给 anon 执行 record_consent、多建一张 private 表）正好报出 5 条、别的格不受影响；**改坏白名单一处**（期望 fn_ai 整表读 vault）报“应有表级”“少给了”。说明：生成器和它的单测是一起写的；runner 的单测先于修好 runner 跑红过一次（见第四节第 2 点） |
| 5 | 代低 10、代低 12、D-10、D-11（上一轮已做，本次核对） | 核对 main：MinIO 字样只剩 `shared/objstore.ts` 第 4 行“为什么不用 MinIO”的说明；`functions/index.ts` 注释写的是 `/`、`/files/*`、`/sb/*`；`rawPathAndQuery` 在 `functions/_lib/raw-url.ts` 一处，`/sb`、`/files` 共用；`concat` 只在 `files-upload.ts` 一处；`files.spec.ts` 有真不带 `X-App-Version` 的请求（426）；占位测试已是跳过（本次统一成 `describe.skipIf`）；`sb-forward.preview.test.ts` 里“Storage 签名链接是相对路径”已删；`.dev.vars.example` 只有变量名没有值，`git check-ignore` 不忽略它 | 无需改动 |

### 二、未改及原因

| 条目 | 原因 |
|---|---|
| ci.yml：db 任务带 `OBJSTORE_*` 跑 Vitest 和 `deno task test`，设了变量却有跳过就失败、跳过的项写进 summary（第 13 条） | 工作流归运维。我这边的配合：四个打替身的组都按同一个变量 `describe.skipIf`，本机已证明设了变量时 0 跳过；`deno.json` 的 `test` 任务本来就带 `--allow-env` 这五个变量和 `--allow-net=127.0.0.1:4566` |
| TC-B0-89 里的两条行级断言：“B 直接调 `private.report_tz_impl` 只能改到自己的行”“authenticated 删、改 devices 只能动 `session_id` 等于 JWT 的那一行（空的也不行）” | 这两条是 RLS / 函数体的**行级**行为，不是“表 × 角色 × 操作”的授权格，生成器按授权只能证明“能不能碰这张表这一列”。`report_tz_impl` 随 B1 的迁移建（0.31 第 23 条），B0 里不存在；devices 的会话行规则在后端的 `supabase/tests/rls/`。请 QA 判断要不要另立用例 |
| 生成器打本地 Supabase（真库）那一遍 | runner 只要 `{exec, query}` 两个方法，接 postgres.js 就能打 `supabase start` 起来的库；按要求本次没碰后端在用的 Docker Supabase，只在 PGlite 上跑。CI 接不接、接在哪一步由运维定 |
| 和前端 A 的 `tests/data-manifest/` 是不是同一个东西 | 核对过：**不是**。`tests/data-manifest/` 里原来没有“表 × 角色 × 操作”的东西（已有的是注销、清理用例生成器，登记册上归我，前端 A 只做过拆文件），所以照做了。**有重叠的是后端 D1 第 4、5 节**（按 information_schema 整表汇总比对）：D1 比“授权表和白名单是否一致”，生成器是逐格出正反用例、以角色真执行；期望的口径照 D1 写，没有另定规则。两者都留着是否多余，请后端审断言时一并看 |
| `tests/data-manifest/pglite-migrated.ts` 和 `supabase/tests/offline/run.mjs` 的 `freshDb` 做法相同（约 15 行） | run.mjs 归后端、是 .mjs 脚本，TS 直接 import 要动它的写法；本次没改后端的文件。要不要合成一处请后端定 |

### 三、本机检查结果（本分支最后一个 commit）

| 命令 | 结果 |
|---|---|
| `npm run lint` | 0 错误 0 警告 |
| `npm run typecheck`（5 份 tsconfig） | 0 错误 |
| `npx vitest run` | 55 个文件通过、1 个跳过；705 通过、15 跳过、5 todo（设 `OBJSTORE_ENDPOINT` 打本机 LocalStack：710 通过、10 跳过） |
| `deno task test` | 93 通过、0 失败、1 ignored（设变量打 LocalStack：94 通过、0 ignored） |
| `deno task check` | 通过 |
| `CI=true npx playwright test` | 42 通过、2 跳过（预览环境两条） |
| `python -I build/check_arch.py` | 0 错误、2 警告（W2：缺 2027 年 cn、kr 节假日，和上一轮一样） |
| `python -I build/check_registry.py` | 没登记 0、登记了不存在 0 |
| `python build/req_index.py --check` | 需求 218 条，问题 0 |

### 四、请复查人重点看

1. `functions/sb/[[path]].ts` 的 `upstreamPath`：现在只有一套判断，`%` 在字符表这一步就拒；以后如果有合法路径需要编码字符，要先改架构 14.2 第 1 点。
2. `tests/data-manifest/grant-runner.ts`：不能用的列每格只真执行一句。原因：PGlite 每抛一次错会漏一点栈，同一个实例上约 1500 次就报 `stack depth limit exceeded`（本机实测，第一版逐列执行时就是这样红的）；能用的列仍逐列执行。打真库没有这个限制，要逐列也可以改。
3. `grant-matrix.ts` 的 service_role 在 public 上按“四种全给”期望（Supabase 默认，0.29 续第 86 条不收窄）；以后要收窄，得同时改这里和 3.3 C。
