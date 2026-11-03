# B2 安全审查 · S-B2 签字记录

- 审查人：安全审查员
- 版本：**第一版（开工前审 D1、D2）**，2026-11-03。B2 第一天派工表第 17 行。
- 本版只写开工前对 D1、D2 方案的审查，另按主持人 11-03 补充，加了 Web Push 自实现密码学的审查要点（第三节）和推送正文补齐方案（第四节）。**这一版不签字**，第六节签字栏留空，等 ③ 正式审查时逐项打勾、再签。
- 依据：[B2 任务单](../../09-路线图/B2-任务单.md) 第三节、第四节 BE-1 和 BE-7、安全审查员一节；[B2 任务单架构审](B2-任务单-架构审.md) D1、D2；[架构设计-v4](../../10-架构/架构设计-v4.md) 0.49 第 1、2、7 条，5.3“推送端点校验”，3.3 C 的 0.49 说明，15.4 S-B2，附录 A devices；[开工前意见](B2-安全审查-开工前意见.md)；`build/check_backend.py` 的 F9；`supabase/functions/usage-report/`（`index.ts`、`core.ts`）；`supabase/config.toml`；`supabase/migrations/0001_core.sql` 的 devices；`supabase/functions/_shared/gen/version-gate-list.ts`；测试用例-v4 TC-B2-80～86。
- 只看了方案、现有代码和用例。claim_endpoint、push-dispatch、F9 的新代码都还没写（仓库里搜不到 `push_endpoint_ok`、`SERVER_SECRET_FUNCTIONS`、`endpoint_not_allowed`），所以本版结论都是对方案的结论。

---

## 结论

| 项 | 结论 | 一句话理由 |
|---|---|---|
| **D1** 推送端点白名单、P1 定级 | **有条件通过** | 白名单只有四个主机，两处都查，不跟随重定向，方向是对的；P1 也同意。但“主机名转小写、去末尾点后比对”这一步，加上 SQL 和 Deno 各自解析，会让两边判断不一致（`:443`、`@`、`%2e`、反斜杠、全角点、`xn--`），还会让同一个端点因大小写不同存成两行，绕过 M9 的跨账号去重。必改 D1-1～D1-6 做到才算通过 |
| P1 定级 | **同意 P1** | 请求体是用攻击者自己的公钥加密的，响应不回给用户，攻击者能做到的只是让服务器盲发 POST，不会跨账号泄露。前提有两个：push-test 也走同一个校验、只回枚举结果（D1-5）；VAPID JWT 按 origin 分开（D1-6）。两条有一条没做到，就要改定 P0 |
| **D2** F9 ③ 名单、usage-report 关网关校验 | **有条件通过** | 口径对：anon key 本来就是公开的，网关那道 JWT 校验对 usage-report 起不到鉴权作用，关掉只多出“未鉴权的请求也算一次调用”，和 account-purge 已经接受的一样。usage-report 现在的鉴权代码符合要求。条件是：名单写死并有单测钉住，比对方式按调用来判定、不能只看字符串里有没有头名，违规样例按开工前意见要三个（D2-1～D2-4） |

---

## 一、D1 推送端点白名单

### 1.1 已经对的部分（不用改）

- 白名单只有四个固定主机，没有可配置的正则或前缀，`android.googleapis.com` 不收；一级子域的定义（`a.b.push.apple.com`、`push.apple.com`、`evilpush.apple.com.example.com` 都不匹配）写得清楚。
- 两处都查：写入时 `claim_endpoint_impl` 在会话检查之后、删任何行之前查，不合格整次拒绝；发送前 push-dispatch 再查一次。这样既挡住绕过 RPC 的写入，也不让旧数据一直留在表里。
- `devices` 的三列只经 `claim_endpoint` 写：0001 只把 `insert (id, label, platform, app_version, last_seen_at, install_id)` 和 `update (label, app_version, last_seen_at, deleted_at, undone)` 授给 authenticated，用户经 PostgREST 写不到 `push_endpoint`、`p256dh`、`auth`。已核。
- 不做 DNS 解析、不缓存校验结果；发送时 `redirect: 'manual'`，每个请求 5 秒超时；日志不写地址；`PUSH_SERVICE_OVERRIDE_URL` 只在本机认。
- 推送到 `*.push.apple.com` 的不发 resolve，按端点主机判断，不看客户端自己写的 `devices.platform`。
- `push_endpoint` 本来就有 unique 约束，限到 ≤ 2048 字符后也不会超出 btree 单条约 2.7 KB 的上限。

### 1.2 能绕过的地方和两边解析不一致的地方

Deno 一侧如果先 `new URL(s)` 再看 `hostname`、`port`、`username`，会碰到 WHATWG URL 规范化：它会去掉默认端口，解码主机里的 `%`，把反斜杠当斜杠，对全角点做 IDNA 映射，去掉制表符和换行等。SQL 一侧多半是对原串跑正则。两边各走各的，结论就会不一样。下表的“危害”一栏分三种：**绕过**（校验通过，实际请求发到了白名单外）、**不一致**（两边结论不同，CI 拦得住但说明实现没对齐）、**去重失效**。

| 写法 | WHATWG 解析结果 | 原串正则的风险 | 危害 |
|---|---|---|---|
| `https://evil.com#.web.push.apple.com/` | 主机是 `evil.com` | 用 `split('/')[2]` 加 `endsWith('.push.apple.com')` 会放行 | **绕过**（写法太松时） |
| `https://evil.com?.web.push.apple.com/`，`https://evil.com\.web.push.apple.com/` | 主机是 `evil.com`（`?` 和 `\` 都结束主机部分） | SQL 用 `[^/]*\.push\.apple\.com` 会放行 | **绕过**（SQL 写松时） |
| `https://fcm.googleapis.com@evil.com/` | 主机是 `evil.com` | 按 `@` 前一段取主机就错了 | **绕过** |
| `https://@fcm.googleapis.com/x`，`https://:@fcm.googleapis.com/x` | `username` 为空，只看 `url.username` 会放行 | 原串里有 `@` | 不一致 |
| `https://fcm.googleapis.com:443/x`，`https://fcm.googleapis.com:/x` | `port` 为空 | 原串里有 `:` | 不一致 |
| `https://web%2epush%2eapple%2ecom/x` | 解码成 `web.push.apple.com` | 原串里有 `%` | 不一致 |
| `https://fcm．googleapis．com/x`（U+FF0E），`https://fcm.googleapis。com/x`（U+3002） | IDNA 映射成 `fcm.googleapis.com` | 原串不是纯 ASCII | 不一致 |
| `https://fcm.googleapiſ.com/x`（U+017F 长 s） | 映射成 `s` | 用 `/iu` 或 `~*` 不分大小写比较时可能当成 `s` | 不一致；用到 `/iu` 时有绕过苗头 |
| `https://WEB.push.apple.com/x`，`https://web.push.apple.com./x` | 主机转小写；末尾的点保留 | 转小写、去点后放行，**入库的是原串** | **去重失效**：同一个端点能以不同写法存成多行，`push_endpoint` 的 unique 约束和 M9“删掉别的账号名下同一 endpoint”都按原串比，旧账号的推送会继续发到这台设备 |
| `https://xn--zz.push.apple.com/x`（不合法的 punycode） | 可能解析失败 | `[a-z0-9-]+` 会放行 | 不一致 |
| `https://web.push.apple.com\t.evil.com/`，带换行，前后有空格 | 制表符、换行被删掉，前后空白被去掉 | 原串有控制字符 | 不一致；拼接以后有绕过苗头 |
| `HTTPS://fcm.googleapis.com/x`，`https:fcm.googleapis.com/x`，`https:/fcm…`，`https:///fcm…` | 都能解析成正常地址 | 原串不是 `https://` 开头 | 不一致 |
| 单个标签超过 63 字符、以 `-` 开头或结尾、空标签 `web..push.apple.com` | 不检查标签长度，多半能解析 | `[a-z0-9-]+` 会放行 | 不是绕过（DNS 解析会失败），但要两边一致 |
| `https://127.0.0.1/`、`https://2130706433/`、`https://0x7f.1/`、`https://[::1]/`、`https://[::ffff:7f00:1]/`、`https://[fe80::1%25eth0]/` | IPv4 简写会被规范化 | — | 白名单已经挡住；IP 拒绝那条留着，当第二道 |

结论：**规范化本身就是不一致的来源**。最稳的做法是不规范化，只收已经是规范形式的原串。浏览器 `PushSubscription.endpoint` 给出的都是序列化以后的地址，主机小写、没有默认端口、没有末尾点、纯 ASCII，所以拒绝其他写法不会误伤真实订阅。

### 1.3 D1 必改项

| # | 必改 | 落在哪 |
|---|---|---|
| **D1-1** | **两边都先校验原串，原串必须已是规范形式，不做转小写、去末尾点这类规范化**。按顺序：① 纯 ASCII，并且只含 0x21～0x7E 的可见字符（不许空格、控制字符、反斜杠）；② 再查长度 ≤ 2048（纯 ASCII 以后，SQL 的 `char_length` 和 JS 的 `.length` 才算得一样）；③ 整串匹配 `^https://(<主机>)(/[^\\#\s]*)$`。主机部分只许 `[a-z0-9.-]`，所以 `@`、`:`、`%`、`?`、`#`、`[`、`]`、大写字母、末尾点都直接不匹配；路径必须以 `/` 开头、不能为空，不许带 `#`；④ 主机名必须**完全等于** `fcm.googleapis.com` 或 `updates.push.services.mozilla.com`，或匹配 `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.push\.apple\.com$`、`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.notify\.windows\.com$`，并且子域标签不能以 `xn--` 开头。**这样不再需要单独的 IP 检查**（IP 不可能匹配这四条），但为了多一道保险，Deno 一侧可以留着。<br>这条和架构 0.49 第 1 条、5.3 的“主机名转小写、去末尾点后比对”不一样。这里的意思是：**不合规范的写法一律拒绝，而不是先规范化再放行**。请架构师在 5.3 里改成这个写法（安全上只严不松，不影响真实订阅） | 5.3；`private.push_endpoint_ok`；TS 校验函数 |
| **D1-2** | **Deno 一侧多做一步，核对 WHATWG 解析的结果**：原串通过 D1-1 以后，再做 `const u = new URL(s)`，必须满足 `u.href === s`、`u.hostname` 等于第 ④ 步取出的主机、`u.port === ''`、`u.username === '' && u.password === ''`、`u.protocol === 'https:'`。有一项不满足就拒绝。这一步是为了保证“校验的主机”和“`fetch` 实际连的主机”是同一个。发送时**原样用通过校验的这个字符串**去 `fetch`，中间不再拼接、不再改写 | push-dispatch、push-test 共用的 TS 校验模块 |
| **D1-3** | **只写一份 TS 校验**：放在 `supabase/functions/_shared/` 下，作为唯一实现，push-dispatch 和 push-test 都调它；SQL 只有 `private.push_endpoint_ok` 一份。两边各自的常量（四个主机、两条正则、2048）都从 `tests/fixtures/push-endpoints.json` 跑同一组向量，CI 比对两边每一条结果一致（TC-B2-80 已经这样写）。比较一律区分大小写：**不准用 JS 的 `/i`、`/u`，也不准用 SQL 的 `~*`、`ilike`、`lower()`** | BE-1 ①②；BE-6 |
| **D1-4** | **把 3xx 判成失败的写法要写全**：Deno 里 `redirect: 'manual'` 的响应，可能是 `type === 'opaqueredirect'`、`status === 0`，也可能直接是 3xx。三种情况都算失败，并且不读、不记录 `Location` 头。推送服务的响应体最多读 1 KB，读完就 `cancel()`；日志只记状态码的类别，不记响应体。发送的请求头里不能带 `Cookie`，也不能带除 VAPID 之外的凭据 | push-dispatch、push-test |
| **D1-5** | **push-test 也做同样的校验，返回值只给枚举**：架构第 6 节已经写了 push-test 的端点按 5.3 校验，这一条再加一点——push-test 的“每台设备的发送结果”只能是 `ok`、`gone`、`failed`、`bad_endpoint` 这类枚举值，**不能回原始状态码、响应头、响应体和耗时**。否则用户能拿 push-test 当探测工具，看服务器连某个地址的结果，P1 就要升成 P0 | BE-6；TC-B2-85 加一条 |
| **D1-6** | **VAPID JWT 按 origin 分开缓存**：缓存键是从通过校验的地址取出的 `https://<主机>`（不带路径和端口），`aud` 必须等于本次请求的 origin，不能拿给一个 origin 签的 JWT 去发另一个 origin。只有这样，“盲发 POST”时泄露出去的 JWT 也只对攻击者自己的主机有效。配合 `redirect: 'manual'`，JWT 不会被重定向带到别的主机 | push-dispatch、push-test |

### 1.4 D1 建议项

| # | 建议 |
|---|---|
| D1-S1 | p256dh、auth 的 SQL 校验收紧到和字节长度对应：`p256dh` 匹配 `^B[A-Za-z0-9_-]{86}=?$`（65 字节，首字节 0x04 在 base64url 里一定是 `B`），`auth` 匹配 `^[A-Za-z0-9_-]{22}(==)?$`。现在“86～88 个 `[A-Za-z0-9_=-]`”的写法放过了 `=` 出现在中间、首字节不是 0x04 的写法，会出现 SQL 收下、Deno 解码报错的不一致。devices 的 check 约束也同样收紧 |
| D1-S2 | `PUSH_SERVICE_OVERRIDE_URL` 判断“是不是本机”时要能**确认**是本机，不能只看有没有设：只有 `SUPABASE_URL` 的主机属于 `kong`、`127.0.0.1`、`localhost` 才认它，否则一律当成线上。线上只要这个变量**不为空**，就在每次请求验完 `x-cron-secret` 之后回 500 `misconfigured`，日志记 `misconfigured:override`，一条都不发。它的值本身也按原串校验 `^http://(127\.0\.0\.1|localhost):[0-9]{1,5}(/[^\s\\#]*)?$`，不合格在本机也回 `misconfigured`。设了替身以后，**仍然先按白名单查一遍库里的端点**，然后才改投到替身，这样本机测试也能覆盖校验。**注意**：本地 edge runtime 跑在 docker 里，`127.0.0.1` 指的是容器自己，测试开发很可能会想加 `host.docker.internal`。要加的话先回到安全审查，不能悄悄放宽 |
| D1-S3 | 运维的发布脚本（`tools/release/publish.ps1` 一类）在预览、正式两边跑 `supabase secrets list`，看到 `PUSH_SERVICE_OVERRIDE_URL` 这个名字就失败退出。这样拦截发生在部署时，不必等到第一次 cron 回 500 才发现 |
| D1-S4 | `claim_endpoint` 抛出 `endpoint_not_allowed`、`bad_push_keys` 时不带 `detail` 和 `hint`，也不把原串写进异常信息（照 B1 `bad_tz` 的写法）。前端也不把地址写进错误上报 |
| D1-S5 | 观察（不属于本项）：M9“删掉别的账号名下同一 endpoint 的行”意味着，知道某人端点的人能用自己的账号认领它，把对方的订阅挤掉（拒绝服务，拿不到内容，因为推送是用认领人自己的密钥加密的，对方的浏览器解不开）。端点本身就是一个不公开的地址，危害低，接受，记一笔 |
| D1-S6 | `_shared/gen/version-gate-list.ts` 加 push-dispatch 那一行（`caller: 'server'`、`why: 'cron-x-cron-secret'`），照 account-purge 的写法 |

---

## 二、D2 F9 ③ 名单和 usage-report 关网关校验

### 2.1 口径审查

- **会不会被滥用**：名单只决定“哪些函数可以关 verify_jwt”。关了以后，鉴权全靠函数自己比对密钥头。滥用的路子有四条：① 往名单里加函数没人审；② 函数在名单上，但比对写错了，或者有一条不验头的旁路；③ 名单外的函数借 cron 的身份关掉校验；④ 用户调的函数被关掉校验。①② 靠 D2-1～D2-3 管住；③ 已经有 F9 ④ 反向兜底（验了 `x-cron-secret` 却没有 cron 调它就报错）；④ 靠 D2-3 的第三个违规样例和 TC-B2-86 ⑥。
- **名单外的函数是否照旧被拦**：按架构 0.49 第 7 条的写法，名单外、又不是 cron 调的函数关了 verify_jwt 照旧报错，和现在 F9 ③（`check_backend.py` 第 1051～1058 行）一样。`PREVIEW_FUNCS`（只有 `db-probe`）跳过 F9 ③、归 F6 管，这一点不变。实现时不能把名单检查写成“名单里的、或 cron 调的、**或者在别的什么集合里的**”，免得以后多出一条放行的路。
- **usage-report 现有代码**（`core.ts` 第 310～319 行）：只收 POST；鉴权在读请求体、判断是否配好、读库之前；没设密钥、没带头、空值、错值都回同一个 `401 {"error":"unauthorized"}`，不记日志；比对用 `safeEqual`，先算 SHA-256 再定长比，不泄露长度；密钥最短 32 字节的检查放在鉴权之后；返回体只有心跳、冷静期时间、计数，没有 user_id 和邮箱。**符合开工前意见第二节第 2 条**。非 POST 回 405 发生在鉴权之前，只暴露“这个函数存在”，可以接受。
- **剩下的风险，接受**：未鉴权的请求能进函数、算一次调用，每次花两次 SHA-256 的 CPU。和 account-purge 已经接受的一样。打开网关校验也只需要 anon key，而 anon key 本来就在网页包里，公开的，所以关掉网关校验，安全上实际没有少什么。
- **以后加 Bearer 类条目**（claude-intake 用 `Bearer 连接码`、backup-manifest 用 `Bearer BACKUP_PULL_TOKEN`）：名单的值要能表示“`authorization` 头、Bearer 方案、和哪个密钥做定长比较”。到时候按条目单独审，**不能**写成 `'authorization'` 就算过，免得一个函数拿 anon JWT 也能进。本批不涉及。

### 2.2 开工前意见被吸收的情况

| 开工前意见 | 现在的状态 |
|---|---|
| 第一节补测 1：TC-B2-84 补低版本那一半 | 已吸收：测试用例修改记录（11-03）写明由 TC-B2-27 覆盖，并加了交叉引用 |
| 第一节补测 2：TC-B2-86 正向核对 account、invite-admin 仍被网关挡住 | 已吸收：TC-B2-86 ⑥ |
| 第二节第 1 条：`verify_jwt = false` 只出现在 account-purge、usage-report、push-dispatch 三个函数 | **没写进任务单**（BE-7 没有这一句）→ 放进 D2-4 |
| 第二节第 3 条：违规样例至少三个，另加单测钉住名单 | **没吸收**：任务单 BE-7 写“违规样例两个”，架构 0.49 第 7 条写“各一”，都缺“用户调的函数（account）关了校验”这个样例和钉住名单的单测 → D2-3 |
| 第二节其余几条（鉴权代码、测试结果、lemo-ops、密钥管理、预览实测、风险接受） | 作为 ③ 签字前要交的证据，照旧有效，见第六节 |
| 级别：TC-B2-84、86 是 P0 | 测试用例已经定成 P0（共 289 条 P0）；**任务单还没跟上**：QA 一栏写“TC-B2-01～80”，P0 只写了 27、68、79；安全审查员一栏也只写 27、68、79 → D2-5 |

### 2.3 D2 必改项

| # | 必改 | 落在哪 |
|---|---|---|
| **D2-1** | `SERVER_SECRET_FUNCTIONS` 是 `check_backend.py` 里写死的常量，**正好**是 `{'usage-report': 'x-ops-secret'}`，不从环境变量或配置文件读。另加一条单测断言名单的完整内容，以后往名单加函数时，改单测这一步在 diff 里一眼就能看到，必须过代码审查和安全审查 | BE-7 |
| **D2-2** | “对名单写的那个头做常量时间比对”要按**调用**来判定，不能只看源码里有没有头名字符串：在这个函数**自己目录**里的非测试源码中（去掉注释以后），必须同时有 ① 读这个头的写法（`headers.get('x-ops-secret')`，头名带引号，不分大小写）；② 对它调 `safeEqual(`；并且 ③ 不能出现把这个头和别的值用 `===`、`==`、`!==` 比较的写法。静态检查做不到完全证明，还要靠函数的单测兜底：没带头、错值、空值都回 401，并且不读库（TC-B2-86 ②③）。名单里的函数**必须**关 verify_jwt；名单里有、`config.toml` 里却没关的，也报错，免得名单和配置对不上 | BE-7 |
| **D2-3** | 违规样例**三个**，各附 F9 的报错输出：① 名单外、又不是 cron 调的函数关了 verify_jwt；② 名单里的函数没有对这个头调 `safeEqual`（只出现了头名字符串，或者用 `===` 比较）；③ 用户调的函数（account）关了 verify_jwt | BE-7；任务单 BE-7 的“两个”改成“三个” |
| **D2-4** | `config.toml` 的 `verify_jwt = false` 本批结束时**只出现在** account-purge、usage-report、push-dispatch 三个函数。② 代码审查和 ③ 安全审查都要核这一点 | BE-7、代码审查清单 |
| **D2-5** | 任务单跟上测试用例：QA 一栏的“TC-B2-01～80”改成“01～87”，P0 列表加 TC-B2-84、86；安全审查员一栏的“另核 TC-B2-68、79”加上 84、86 | 任务单作者（不归我改） |

### 2.4 D2 建议项

| # | 建议 |
|---|---|
| D2-S1 | 照 F1 对 `SIGNUP_HASH_SECRET` 的写法，加一条“`OPS_SECRET` 只准 usage-report 读”（名单的值将来对应哪个密钥变量，也按同样办法限定只给这一个函数读），免得别的函数读同一把钥匙做别的事 |
| D2-S2 | 不是安全问题，顺带一提：usage-report 的 `DETAIL_FIELDS` 只转发 `rows`、`ms`、`sent`、`failed`、`purged`，push-dispatch 新加的 `claimed`、`budget_hit` 不会转发出去，O-3“`claimed` 与 `sent` 之差”的规则就看不到数。BE-2 或 O-3 记得一起加（只加数字和布尔字段，不加别的） |

---

## 三、Web Push 自实现（Web Crypto）的审查要点

主持人 11-03 补充：后端定了用 Web Crypto 自己实现 Web Push，不引第三方库。这就不需要 9.6 的新依赖审查，但多了一段自己写的密码学代码，③ 时按下表逐条审，**每条都要有代码位置和测试名**。任务单 BE-1 的“锁版本进 `deno.json`”不再适用，O-1 的私钥格式按下面 C-8 定。

| # | 审什么 | 通过标准 |
|---|---|---|
| C-1 | **每条消息都用新的 ECDH 临时密钥** | 每加密一次就调一次 `crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, …)`，不缓存、不在设备之间复用、不在同一轮里复用。测试：同一份明文对同一个订阅加密两次，`keyid`（as_public）和 `salt` 都不一样 |
| C-2 | **salt 每条 16 字节随机** | 只用 `crypto.getRandomValues`，全文件不准出现 `Math.random`（可以让 check_backend 加一条规则） |
| C-3 | **对方公钥的校验** | `p256dh` 严格按 base64url 解码，必须正好 65 字节、首字节 0x04；`importKey('raw', …, {name:'ECDH', namedCurve:'P-256'})` 失败（点不在曲线上）就当 `bad_push_keys` 处理，不能抛到整轮；`auth` 正好 16 字节 |
| C-4 | **RFC 8291 的密钥推导**（第 3.3、3.4 节） | `PRK_key = HKDF-Extract(auth, ecdh_secret)`；`key_info = "WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public`；`IKM = HKDF-Expand(PRK_key, key_info, 32)`；再按 RFC 8188 用 salt 推出 `CEK`（info 为 `"Content-Encoding: aes128gcm" ‖ 0x00`，16 字节）和 `NONCE`（`"Content-Encoding: nonce" ‖ 0x00`，12 字节）。用 Web Crypto 的 HKDF `deriveBits` 时，每一段的 salt、info、长度都要对上，测试按每一步的中间值断言 |
| C-5 | **RFC 8291 附录 A 的固定向量** | 单测用 RFC 8291 附录 A 的 as_private、ua_public、auth、salt、明文，**逐字节**得出附录里的密文（含 86 字节头部）。为了注入固定的临时密钥和 salt，加密函数要有一个只给测试用的入口；**正式入口不接受外部传入的临时密钥和 salt**（代码审查核对：push-dispatch、push-test 只调正式入口） |
| C-6 | **aes128gcm 的记录格式**（RFC 8188） | 头部是 `salt(16) ‖ rs(4，大端) ‖ idlen(1)=65 ‖ keyid=as_public(65)`；**只有一条记录**，`rs` ≥ 明文 + 补齐 + 17；最后一条记录的分隔字节是 `0x02`；AES-GCM 128 位密钥、12 字节 nonce、16 字节 tag；整份密文 ≤ 4096 字节（见第四节）；请求头 `Content-Encoding: aes128gcm`、`Content-Type: application/octet-stream`，还有 `TTL`（`Urgency` 按需加） |
| C-7 | **VAPID JWT**（RFC 8292） | 头部 `{"typ":"JWT","alg":"ES256"}`；`aud` = 端点的 origin（`https://<主机>`，按 D1-6）；`exp` ≤ 签发时刻 + 12 小时，剩余不到 1 小时就重签，时间取服务器时钟；`sub` = `VAPID_SUBJECT`（只许 `https:` 或 `mailto:` 开头）；签名用 Web Crypto ECDSA P-256 / SHA-256，得到的是 64 字节 `r‖s`，**直接用于 JWS，不要转成 DER**；请求头写 `Authorization: vapid t=<jwt>, k=<公钥 65 字节 base64url>`。测试：用公钥独立验签通过；改一个字节验签失败；`exp` 不超过 12 小时 |
| C-8 | **私钥只放内存** | `VAPID_PRIVATE_KEY` 只从环境变量读，导入时 `extractable: false`，只存在模块内的变量里；不写库、不写日志、不进心跳 detail、不进错误信息；JWT 缓存同样只在内存。**格式建议用 JWK（d、x、y 三项齐全）**，以便做 C-9 的自检；O-1 脚本照这个格式写入（交 O-1 定稿时核） |
| C-9 | **启动时自检 x、y、d 是不是一对** | Web Crypto 导入 JWK 私钥时，不保证会核对 d 和 x、y 是否配对。所以每个实例第一次用之前：用私钥签一段固定的串，再用 x、y 导入的公钥验签；同时把公钥和服务器侧的 `VAPID_PUBLIC_KEY`（建议新增这个变量，值和 GitHub 变量 `PREVIEW_VAPID_PUBLIC_KEY` 相同）逐字节比对。有一项不过就回 500 `misconfigured`，日志记 `vapid_keypair_mismatch`，**一条都不发**，免得用错的钥匙对所有人发出去、招来一片 403。测试：配对的过；换一个 d、换一个 x 都不过 |
| C-10 | **出错和日志** | 每个订阅的加密、签名出错只影响这一条，记 `push_failed` 和原因代码；不记明文、密钥、端点、JWT、密文 |
| C-11 | **独立实现交叉核对**（建议，不卡） | 本机推送替身用一份独立实现解密并核对明文（比如测试专用、只在 `tests/` 下用的 ECE 解密库，或者测试开发自己按 RFC 写一份），免得加密和解密犯同一个错、互相“验证通过”。只是测试依赖，不进函数 |

---

## 四、推送正文补齐方案（1 / 2 / 4 KB 三档）

**结论：补齐要做，档位要改成 1 / 2 / 3 KB。“4 KB”这一档放不下。**

- **为什么要补齐**：密文长度推送服务（苹果、谷歌、微软、Mozilla）和网络上的旁观者都看得到。不补齐的话，标题长短、是不是 `resolve`、是不是“来自 Claude ·”的消息，都能从长度上看出来。`push_show_title` 关掉以后，锁屏只写“15:00 有 1 项日程”，补齐让这类消息和带标题的消息在长度上分不出来。
- **为什么 4 KB 不行**：Web Push 整份请求体上限是 4096 字节（苹果的上限也是 4096），里面要算上 aes128gcm 头部 86 字节、tag 16 字节、分隔字节 1 字节，**明文加补齐最多 3993 字节**。补齐到 4096 的明文，加密以后一定超限，会被推送服务回 413。
- **建议做法**：
  1. 明文（JSON）加补齐以后，凑到 **1024 / 2048 / 3072** 字节三档之一，取能装下的最小一档。架构审第四节第 3 点定的“加密前 ≤ 3 KB”正好是最高一档；超过 3072 字节的，由 notify-text 截断标题，不再往上加档，**不允许出现 3993 这种非整档长度**。
  2. 用 RFC 8188 自带的补齐方式：明文后面接分隔字节 `0x02`，再补 `0x00`，凑到档位长度。**不要往 JSON 里加空格**，否则解密以后 SW 拿到的 JSON 会变，长度也可能算错。
  3. `resolve` 和 push-test 的负载也补到同样的最低档（1024），三类消息在长度上看不出区别。
  4. 测试：取标题为 0、1、最长三种的消息，密文长度都正好是三个固定值之一；最大的那一档整份 ≤ 4096；SW 解密以后 JSON 和补齐前一字不差。
- **能防到哪里**：补齐只遮住长度。发送时刻、频率、每台设备收了几条，推送服务照样看得到，这是 Web Push 本身的局限，接受。1 KB 起步，按每人每天几十条算，流量可以不计。

---

## 五、给后端实现的约束（必须照做）

1. 端点校验按 D1-1、D1-2：先查原串、只收规范形式，不做转小写、去末尾点；Deno 一侧再用 WHATWG 解析核一遍，并且原样用这个字符串去 `fetch`。
2. 校验顺序：`claim_endpoint_impl` 里依次是会话检查 → `push_endpoint_ok` 和密钥格式 → 才删别的行、写本行。拒绝时一行都不动。
3. 比较一律区分大小写，不用 `/i`、`/u`、`~*`、`ilike`、`lower()`；先查纯 ASCII，再查长度。
4. 校验只有两份：SQL 的 `private.push_endpoint_ok` 和 `_shared` 下的一个 TS 模块。push-dispatch、push-test 都调这个模块；两边跑同一组 `tests/fixtures/push-endpoints.json`，CI 核对每一条结果一致。
5. 发送：原样用通过校验的字符串；`redirect: 'manual'`，`opaqueredirect`、状态 0、3xx 都算失败；`AbortSignal.timeout(5000)`；响应体最多读 1 KB 后 `cancel()`；不带 Cookie；日志只记原因代码。
6. 发送前查到不合格的：不发，三列置空，记 `push_bad_endpoint`，code 只写原因（`host_not_allowed`、`bad_scheme`、`too_long`、`bad_keys` 这一类），不写地址。
7. VAPID JWT 按 origin 缓存，`aud` 必须等于请求的 origin；`exp` ≤ 12 小时；只放内存。
8. `PUSH_SERVICE_OVERRIDE_URL`：只有确认是本机（按 D1-S2）才认；线上只要不为空，就在验完 `x-cron-secret` 后回 500 `misconfigured`；设了替身也要先按白名单查端点。
9. push-test 只回枚举结果，不回状态码、响应头、响应体和耗时（D1-5）。
10. 加密和签名按第三节 C-1～C-10 写，RFC 8291 附录 A 的固定向量要逐字节一致；启动时自检密钥对（C-9）。
11. 推送负载按第四节补到 1024 / 2048 / 3072 三档，用 RFC 8188 的补齐方式。
12. F9 ③ 按 D2-1～D2-4 写：名单写死、单测钉住、按调用判定比对、三个违规样例；`verify_jwt = false` 只出现在三个函数。
13. 错误码 `endpoint_not_allowed`、`bad_push_keys` 一律用 `errcode = '22023'`，不带 detail 和 hint，也不带原串。

---

## 六、给测试开发：`tests/fixtures/push-endpoints.json` 必须包含的恶意样例

以下每条都必须判为**不合格**，pgTAP 和 Deno 两边结果一致。写进 JSON 时，控制字符和非 ASCII 字符用 `\t`、`\n`、`。` 这类转义，每条加一个 `why` 字段，说明它测的是什么。

**协议和格式**
1. `http://fcm.googleapis.com/fcm/send/x`（不是 https）
2. `HTTPS://fcm.googleapis.com/fcm/send/x`（协议大写）
3. `https:fcm.googleapis.com/fcm/send/x`、`https:/fcm.googleapis.com/fcm/send/x`、`https:///fcm.googleapis.com/fcm/send/x`
4. `wss://fcm.googleapis.com/x`、`javascript:alert(1)`、`data:,x`、`file:///etc/passwd`
5. `//fcm.googleapis.com/x`（没有协议）、空串、只有空格
6. ` https://fcm.googleapis.com/x`（开头空格）、`https://fcm.googleapis.com/x `（末尾空格）、末尾 `\n`
7. `https://fcm.googleapis.com`（没有路径）、`https://fcm.googleapis.com?x=1`（问号直接跟在主机后面）

**主机名混淆**
8. `https://evil.com#.web.push.apple.com/x`
9. `https://evil.com?.web.push.apple.com/x`
10. `https://evil.com\.web.push.apple.com/x`、`https://fcm.googleapis.com\@evil.com/x`
11. `https://fcm.googleapis.com@evil.com/x`、`https://user:pass@fcm.googleapis.com/x`、`https://@fcm.googleapis.com/x`、`https://:@fcm.googleapis.com/x`
12. `https://fcm.googleapis.com.evil.com/x`、`https://web.push.apple.com.evil.com/x`
13. `https://evilpush.apple.com/x`、`https://evil-fcm.googleapis.com/x`、`https://xfcm.googleapis.com/x`
14. `https://push.apple.com/x`、`https://notify.windows.com/x`（只有根域）
15. `https://a.web.push.apple.com/x`、`https://a.b.notify.windows.com/x`（多级子域）
16. `https://.push.apple.com/x`、`https://web..push.apple.com/x`（空标签）
17. `https://-web.push.apple.com/x`、`https://web-.push.apple.com/x`（标签以连字符开头或结尾）
18. 子域标签 64 个字符：`https://` + `a`×64 + `.push.apple.com/x`
19. `https://xn--zz.push.apple.com/x`、`https://xn--web-abc.notify.windows.com/x`（`xn--` 标签）
20. `https://android.googleapis.com/gcm/send/x`（旧的 GCM）、`https://googleapis.com/x`、`https://updates.push.services.mozilla.com.evil.com/x`

**大小写、末尾点、编码**
21. `https://WEB.push.apple.com/x`、`https://Fcm.googleapis.com/x`（主机有大写）
22. `https://web.push.apple.com./x`、`https://fcm.googleapis.com../x`（末尾点）
23. `https://web%2epush%2eapple%2ecom/x`、`https://fcm%2Egoogleapis.com/x`、`https://evil.com%2f.web.push.apple.com/x`、`https://evil.com%23.web.push.apple.com/x`
24. `https://fcm．googleapis．com/x`（U+FF0E 全角点）、`https://fcm.googleapis。com/x`（U+3002）、`https://web.push.apple｡com/x`（U+FF61）
25. `https://fcm.googleapiſ.com/x`（U+017F）、`https://wеb.push.apple.com/x`（西里尔字母 е）、`https://ｆｃｍ.googleapis.com/x`（全角字母）
26. `https://web.push.apple.com\t.evil.com/x`、`https://fcm.googleapis.com\n/x`、`https://fcm.goo\tgleapis.com/x`、主机里带 `\u0000`

**端口**
27. `https://fcm.googleapis.com:443/x`（默认端口也拒）
28. `https://fcm.googleapis.com:/x`（端口为空）
29. `https://fcm.googleapis.com:8443/x`、`https://fcm.googleapis.com:0443/x`、`https://web.push.apple.com:65536/x`

**IP**
30. `https://127.0.0.1/x`、`https://169.254.169.254/latest/meta-data`、`https://10.0.0.1/x`
31. `https://2130706433/x`、`https://0x7f000001/x`、`https://0177.0.0.1/x`、`https://127.1/x`
32. `https://[::1]/x`、`https://[::ffff:127.0.0.1]/x`、`https://[::ffff:7f00:1]/x`、`https://[fe80::1%25eth0]/x`
33. `https://localhost/x`、`https://kong:8000/x`、`https://host.docker.internal/x`

**长度**
34. 2049 字符的合法形式（`https://fcm.googleapis.com/fcm/send/` 后面补足）——拒
35. 正好 2048 字符的同一种形式——**合格**（边界，放进合格组）
36. 10 万字符的超长串——拒，且两边都不应超时

**路径**
37. `https://fcm.googleapis.com/x#frag`（带片段）、`https://fcm.googleapis.com/a\b`（路径里有反斜杠）、`https://fcm.googleapis.com/a b`（路径里有空格）

**密钥（`bad_push_keys`，和端点分组写）**
38. `p256dh`：85 字符、89 字符；首字节不是 0x04（第一个字符不是 `B`）；`=` 出现在中间；含 `+`、`/`（标准 base64）；含非 ASCII；空串
39. `auth`：21 字符、25 字符；`=` 出现在中间；含 `+`、`/`；空串

**合格组至少要有**：`https://web.push.apple.com/<token>`、`https://api.push.apple.com/<token>`（另一个一级子域）、`https://wns2-par02p.notify.windows.com/w/?token=<…>`（带查询串）、`https://fcm.googleapis.com/fcm/send/<token>`、`https://fcm.googleapis.com/wp/<token>`、`https://updates.push.services.mozilla.com/wpush/v2/<token>`、正好 2048 字符的边界、子域标签正好 63 字符、路径里带 `%`（比如 `%3A`，只许出现在路径里）、带 `:` 的路径。

TC-B2-80 另加两条：push-test 对不合格端点只回 `bad_endpoint`、不回状态码（D1-5）；替身回 301、302、307、308（`Location` 指向 `http://127.0.0.1:<别的端口>`）时都算失败，并且另一个端口一次都没被访问。

---

## 七、③ 正式审查要逐项打勾的内容（本版先列出，不打勾）

| 项 | 级别 | 证据要求 | 结果 |
|---|---|---|---|
| 免查名单：低版本也能 `DELETE /rest/v1/devices`、`POST /rest/v1/rpc/claim_endpoint`（TC-B2-27） | P0 | 冒烟集里低版本测试的结果 | 待审 |
| cron 密钥（TC-B2-68） | P0 | — | 待审 |
| claim_endpoint 授权（TC-B2-79、84） | P0 | — | 待审 |
| usage-report 关网关校验、F9 ③ 名单（TC-B2-86；D2-1～D2-4；开工前意见第二节 8 条证据） | P0 | — | 待审 |
| 推送端点白名单两处生效、不跟随重定向、替身变量线上拒绝启动（TC-B2-80；D1-1～D1-6） | P1 | — | 待审 |
| push-test（TC-B2-85；D1-5） | P1 | — | 待审 |
| 推送不写日志原文（TC-B2-24） | P1 | — | 待审 |
| Web Push 自实现（第三节 C-1～C-10） | P1 | — | 待审 |
| 正文补齐（第四节） | P1 | — | 待审 |
| TZ-invalid-b2（D7） | — | BE-2 代码审查时定 | 待审 |
| O-1 VAPID 脚本（不经 AI、不进参数、不落盘；JWK 格式） | — | O-1 初稿 | 待审 |
| 风险接受：usage-report、push-dispatch 未鉴权的请求能进函数、算一次调用（和 account-purge 一样） | — | 写明即可 | 待审 |

## 签字

| 环 | 结论 | 签字 | 日期 |
|---|---|---|---|
| ③ 安全审查 | （留空，正式审查时填） | | |

---

## 修改记录

- 2026-11-03：第一版，开工前审 D1、D2（结论都是有条件通过；必改 D1-1～D1-6、D2-1～D2-5）；按主持人补充加了 Web Push 自实现密码学的审查要点（C-1～C-11）和补齐方案（改成 1 / 2 / 3 KB）；签字栏留空。只新建了这一个文件，没改别的文件，没有登记文件登记册（主持人登记）。
