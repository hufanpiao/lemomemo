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
