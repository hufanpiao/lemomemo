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
| D1-S1 | **（11-03 补充：已升为必改 D1-7，见 1.5 第 ③ 点）** p256dh、auth 的 SQL 校验收紧到和字节长度对应：`p256dh` 匹配 `^B[A-Za-z0-9_-]{86}=?$`（65 字节，首字节 0x04 在 base64url 里一定是 `B`），`auth` 匹配 `^[A-Za-z0-9_-]{22}(==)?$`。现在“86～88 个 `[A-Za-z0-9_=-]`”的写法放过了 `=` 出现在中间、首字节不是 0x04 的写法，会出现 SQL 收下、Deno 解码报错的不一致。devices 的 check 约束也同样收紧 |
| D1-S2 | **（11-03 补充：已由 1.5 第 ② 点取代，以那里为准）** `PUSH_SERVICE_OVERRIDE_URL` 判断“是不是本机”时要能**确认**是本机，不能只看有没有设；线上只要这个变量**不为空**，就在每次请求验完 `x-cron-secret` 之后回 500 `misconfigured`，日志记 `misconfigured:override`，一条都不发。设了替身以后，**仍然先按白名单查一遍库里的端点**，然后才改投到替身 |
| D1-S3 | 运维的发布脚本（`tools/release/publish.ps1` 一类）在预览、正式两边跑 `supabase secrets list`，看到 `PUSH_SERVICE_OVERRIDE_URL` 这个名字就失败退出。这样拦截发生在部署时，不必等到第一次 cron 回 500 才发现。**（11-03 补充：正式一侧已做；令牌权限和预览一侧的做法见 1.5 第 ③、④ 点；拦截的名字加上 `LEMO_LOCAL_PUSH_STUB`）** |
| D1-S4 | `claim_endpoint` 抛出 `endpoint_not_allowed`、`bad_push_keys` 时不带 `detail` 和 `hint`，也不把原串写进异常信息（照 B1 `bad_tz` 的写法）。前端也不把地址写进错误上报 |
| D1-S5 | 观察（不属于本项）：M9“删掉别的账号名下同一 endpoint 的行”意味着，知道某人端点的人能用自己的账号认领它，把对方的订阅挤掉（拒绝服务，拿不到内容，因为推送是用认领人自己的密钥加密的，对方的浏览器解不开）。端点本身就是一个不公开的地址，危害低，接受，记一笔 |
| D1-S6 | `_shared/gen/version-gate-list.ts` 加 push-dispatch 那一行（`caller: 'server'`、`why: 'cron-x-cron-secret'`），照 account-purge 的写法 |

### 1.5 11-03 补充裁定（测试开发写样例时提出的两件事）

**① 路径和查询串的字符集，以及点段：收窄字符集，两边都禁止点段。D1-1 第 ③ 步里路径那一段 `(/[^\\#\s]*)` 作废，改成下面的写法。**

原来的写法只排除了反斜杠、`#` 和空白，放过了 `" < > ^ \` { }`、查询串里的 `'`、点段 `.`、`..`、`%2e%2e` 这几类。WHATWG 会把前一类改成百分号编码，把点段消掉，于是 `new URL(s).href === s` 不成立，SQL 收下而 Deno 拒绝，两边结论不一致。点段被消掉以后路径会变，但主机不变，所以这不算绕过；即便如此，两边也必须一致。

字符集按四家推送服务的真实端点来定：
- FCM：`/fcm/send/<令牌>`、`/wp/<令牌>`，令牌里有 `:`、`-`、`_`；
- WNS：`/w/?token=<…>`，令牌里有 `%2b`、`%2f`、`%3d` 这类百分号编码；
- Mozilla：`/wpush/v1/…`、`/wpush/v2/…`，用的是 base64url，可能带 `=`；
- Apple：`web.push.apple.com/<令牌>`，测试开发提到的 `/3/device/…` 也收。

这四家合起来，只需要 unreserved 字符，加上 `/ : ? = & % +`。

- **原串的整体写法（替换 D1-1 第 ③ 步）**：
  `^https://(<主机>)(/(?:[A-Za-z0-9._~:/=&+-]|%[0-9A-Fa-f]{2})*)(\?(?:[A-Za-z0-9._~:/=&+-]|%[0-9A-Fa-f]{2})*)?$`
  - 路径必须以 `/` 开头；
  - 最多出现一个 `?`，它后面就是查询串，查询串里用同一个字符集，但不能再出现 `?`；
  - 不许 `#`；
  - `%` 后面必须正好跟两位十六进制数字。

  SQL 一侧用 `~`，区分大小写；JS 一侧不加任何标志。字符类里的 `-` 放在最后一位，两边写法一字不差。
- **另加两条检查，两边都做**：
  - 原串里不许出现 `%2e`、`%2E`，也就是编码过的点。真实端点用不到它，禁掉以后 `.%2e`、`%2e%2e` 这类变形就都不用一一列举了。
  - 路径部分（`?` 之前）不许有点段：用 `(^|/)\.{1,2}(/|$)` 去匹配路径，命中就拒绝。
- **不收的字符**：`" < > ^ \` { } | \ ' ! $ ( ) * , ; @ [ ]`，以及空白、控制字符、非 ASCII。原因有两类：一是会被 WHATWG 改写（比如查询串里的 `'`）；二是真实端点用不到，又容易引起混淆（比如 `@`）。
- **在这个字符集下 WHATWG 不改写原串**：大小写不同的百分号编码（`%2b` 和 `%2B`）会原样保留；`~`、`+`、`=`、`&`、`:` 都不会被编码；空查询串 `?` 也原样保留。D1-2 的 `href === s` 照旧要求，作为第二道保险。
- **D1-7（新增必改，原 D1-S1）**：p256dh、auth 收紧，SQL 函数、devices 的 check 约束、Deno 一侧三处写法一致。测试开发已经按第 38、39 条样例让后端这样做了，同意。**11-03 按代码审查 S9 定最终写法，D1-S1 里的两条正则作废**：
  - **p256dh**：`^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]=?$`
    - 第 1、2 个字符：首字节必须是 0x04。`B` 给出首字节的前 6 位 `000001`，第 2 个字符的高 2 位补上首字节的最后 2 位，这两位必须是 `00`，所以第 2 个字符只能是 A～P（值 0～15）。代码审查员的结论对：原写法会放过首字节是 0x05～0x07 的值（比如以 `BQ` 开头的）。
    - 最后一个字符：65 字节是 520 位，87 个字符是 522 位，多出来的 2 位必须是 0，所以末字符只能是值为 4 的倍数的 16 个字符。这一步是我在代码审查员建议的基础上加的。不加的话，两个不同的串会解码成同一把公钥，一个“非规范编码”的串，SQL 收下，严格的解码器却会拒。
    - 带补齐时整串是 88 个字符，末尾正好一个 `=`。
  - **auth 也要改**：`^[A-Za-z0-9_-]{21}[AQgw](==)?$`。16 字节是 128 位，22 个字符是 132 位，多出来的 4 位必须是 0，所以末字符只能是 A、Q、g、w。带补齐时末尾正好是 `==`。
  - **Deno 一侧**：解码之前先用**同一条正则**查原串，再严格解码。解码以后再核：p256dh 是 65 字节且首字节 0x04，auth 是 16 字节。
  - **正则管不到的部分**：公钥点不在 P-256 曲线上。这种值 SQL 会收下，发送时 `importKey` 失败，按 `bad_push_keys` 处理：这一行三列置空，记 `push_bad_endpoint`，code 写 `bad_keys`。这是两边判断的唯一差别，接受。fixture 把它单列一组“SQL 合格、发送时 bad_keys”，**不放进两边结果必须一致的那一组**。
  - **fixture 补充的不合格样例**：p256dh 第二个字符是 Q～Z、a～z、0～9、`-`、`_` 的各一条（至少有 `BQ…`、`Bg…`、`B_…`）；末字符不是 4 的倍数（比如以 `B` 结尾）；88 个字符却以两个 `=` 结尾；auth 末字符是 `B`、`R` 这类不合规的字符；auth 只补一个 `=`。合格组补：p256dh 以 `BA…`、`BP…` 开头的，末字符为 `0`、`w` 的，带补齐和不带补齐的各一条；auth 末字符为 `A`、`Q`、`g`、`w` 各一条。

**② 本机替身用不用 `host.docker.internal`：允许，但要满足下面全部条件，缺一条就不认替身。**

理由：不放开的话，TC-B2-81～83 的“替身每个请求拖 3 秒、造 300 条、两轮重叠”就只能在预览上用真推送服务做。真推送服务既不能人为拖慢，也不能按需回 3xx 和 410，这几条用例在预览上做不了。所以整链测试必须能在本机跑。风险方面，只要“是不是本机”判断得严，`host.docker.internal` 在线上永远不会被认，额外的风险可以接受。

- **D1-8（新增必改）判断本机必须同时满足两条，任何一条不满足都按线上处理**：
  1. `new URL(Deno.env.get('SUPABASE_URL'))` 的协议是 `http:`，并且主机名正好是 `kong`、`127.0.0.1`、`localhost` 三者之一。线上的 `SUPABASE_URL` 一定是 `https://<ref>.supabase.co`，而且是平台注入的：`supabase secrets set` 不允许设 `SUPABASE_` 开头的变量，所以这一条在线上伪造不了。
  2. 另有一个只在本机设的开关变量 `LEMO_LOCAL_PUSH_STUB=1`，只写在 `supabase/.env.local`（或它的 example 文件）里。发布脚本对预览、正式环境跑 `supabase secrets list`，只要看到这个名字或 `PUSH_SERVICE_OVERRIDE_URL` 就失败退出（即 D1-S3，本条起两个名字都查）。

  `SUPABASE_URL` 缺失、解析失败、开关不等于 `1`，都按线上处理。
- **替身地址的写法**：原串匹配 `^http://(127\.0\.0\.1|localhost|host\.docker\.internal):([0-9]{4,5})(/[A-Za-z0-9._~:/=&+-]*)?$`，端口在 1024～65535 之间，不许带用户名密码、查询串和 `#`。不合格时，即使在本机也回 500 `misconfigured`。
- **线上（上面两条有一条不满足）**：只要 `PUSH_SERVICE_OVERRIDE_URL` 不为空，不管它的值是什么，每次请求验完 `x-cron-secret` 之后都回 500 `misconfigured`，日志记 `misconfigured:override`，一条都不发。
- **设了替身以后**：
  - 仍然先按白名单查库里的真实端点，不合格的照常置空、记 `push_bad_endpoint`；
  - 合格的才改投到替身，**真实端点一次都不连**；
  - 照样用 `redirect: 'manual'` 和 5 秒超时；
  - VAPID JWT 的 `aud` 仍然按真实端点的 origin 签（这样替身能核对 `aud`），**不会**签一个 `aud = http://host.docker.internal…` 的 JWT。
- **代码位置收拢**：`host.docker.internal` 这个字符串只准出现在 push-dispatch（以及将来的 push-test）的替身判断模块和 `tests/` 里。建议 check_backend 加一条规则，在别处出现就报错，免得它被抄进别的出站白名单。
- **测试（进 TC-B2-80）**：
  - `SUPABASE_URL` 为 `https://x.supabase.co`、开关为 `1`、替身有值 → 500；
  - `SUPABASE_URL` 为 `http://kong:8000`、开关没设 → 500；
  - 两条都满足、替身地址为 `http://host.docker.internal:54399` → 改投替身；
  - 替身地址为 `http://host.docker.internal.evil.com:54399`、`http://10.0.0.1:54399`、`https://host.docker.internal:54399`、`http://host.docker.internal:80` → 都回 500；
  - 替身回 302、`Location` 指向另一个端口 → 算失败，另一个端口一次都没被访问。

不放开的退路是：整链只在预览上用真推送做，本机只测进程内注入。这条退路**不选**，原因见上面的理由。

**③ 正式发布令牌加“Edge Function Secrets 只读”：同意，附条件。**

- 理由：
  - 正式令牌现在已经有“API Key Secrets 只读”，能读到正式的 service_role 密钥。和它相比，Edge Function Secrets 只读多出的暴露面很小。
  - 这把令牌照旧每次发布时临时生成，1 天到期，发完就删（R-220），存在的时间很短。
  - 拿到这项权限，就能在改库之前确认线上没有替身变量，这一点值得。
- 条件（运维改 `publish.ps1` 和环境清单第四节，③ 正式审查时核对）：
  1. 只给**只读**，不给读写。环境清单第四节“正式 Supabase 令牌”一行补上这一项，并写明理由：“只为发布前核对线上不存在 `PUSH_SERVICE_OVERRIDE_URL`、`LEMO_LOCAL_PUSH_STUB`”。
  2. 脚本只取 `name` 字段。读到的响应体当场只留名字列表：不打印，不写日志和转录（不进 `Start-Transcript`，不用 `Write-Verbose`、`Write-Debug` 输出原始响应），不落盘；出错时也不把响应体带进异常信息。
  3. **第一次在预览上跑时，要实测这个接口返回的 `value` 是明文还是摘要**（CLI 的 `secrets list` 显示的是 DIGEST，我推测接口返回的是 SHA-256 摘要，但离线核实不了）。结果写进环境清单。如果是明文，第 2 条更不能有任何例外；同时改成“读到 `name` 后立即把整个响应对象置空”，并在 ③ 正式审查时重新评估。
  4. 拦截的名字有两个：`PUSH_SERVICE_OVERRIDE_URL` 和 `LEMO_LOCAL_PUSH_STUB`（D1-8），只要看到其中一个就失败退出，退出时只报出名字。令牌缺这项权限时（403），照现在的写法停在改库之前，不能降级成“跳过检查、继续发布”。
  5. 这一步放在改库、部署函数之前，和现在一样。

**④ 预览令牌也加“Edge Function Secrets 只读”、deploy-preview 补上这个检查：同意加，但不必为此单独重建令牌。**

- 理由：预览上最容易误设替身变量（测试的人就在这个环境里）。但预览令牌是长期放在 GitHub repository secrets 里的，第四节写着，任何能推送工作流的人都能把它带出去。加只读权限以后，带出去的人还能看到预览所有函数密钥的名字，以及摘要或值（见 ③ 第 3 条）。好在这把令牌本来就能读预览的 service_role 密钥，预览也没有真数据，所以增量可以接受。
- 项目级令牌建好以后不能改权限，要加就得由负责人重建，GitHub secret 也要重填。线上的函数一侧已经 fail-closed：在预览上设了替身变量，每次 cron 都会回 500 `misconfigured`，心跳停下，lemo-ops 告警。所以这个检查只是第二道保险，不卡 B2。
- 做法：
  - 下一次重建预览令牌时，把这一项一起加上。重建的时机是到期（2027-01-26），或者因为别的权限变更、提前要重建。
  - deploy-preview 的检查照 ③ 第 2、4 条写：只取名字，有权限就查；没权限时在 `GITHUB_STEP_SUMMARY` 写一行“未核对推送替身变量（令牌缺 Edge Function Secrets 只读）”，**不让部署失败**。等令牌重建以后，改成没权限就失败。
  - 环境清单第四节“预览令牌”一行记下这条待办。要是负责人这段时间正好要重建令牌，就当场一并加上。

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

0. （11-03 补充）路径和查询串的字符集、`%2e` 和点段的禁令按 1.5 第 ① 点；p256dh、auth 按 D1-7；替身和判断本机按 D1-8（1.5 第 ② 点）。
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

**路径和查询串（11-03 补充，按 1.5 第 ① 点）**——下面都要拒：
40. 路径里有 `"`、`<`、`>`、`^`、`` ` ``、`{`、`}`、`|`，比如 `https://fcm.googleapis.com/fcm/send/a"b`、`…/a{b}`
41. 查询串里有 `'`，比如 `https://wns2-par02p.notify.windows.com/w/?token=a'b`；还有 `!`、`$`、`(`、`)`、`*`、`,`、`;`、`@`、`[`、`]`
42. 点段：`https://fcm.googleapis.com/a/../b`、`/a/./b`、`/..`、`/.`、`/a/..`、`/a/%2e%2e/b`、`/a/.%2e/b`、`/a/%2E/b`；查询串里也不许有 `%2e`，比如 `?token=%2e`
43. 坏的百分号编码：`/a%`、`/a%2`、`/a%zz`
44. 两个 `?`：`https://wns2-par02p.notify.windows.com/w/?token=a?b`

下面都要**合格**（放进合格组）：`/a..b`、`/a.b/`、`/.well`（点不单独成段）；`?token=a%2Bb%3D`（大写编码）和 `?token=a%2bb%3d`（小写编码）；`?`（空查询串）；`/fcm/send/abc:APA91b-x_y`；路径里带 `~`、`+`、`=`、`&`。

**替身地址（11-03 补充，按 1.5 第 ② 点，TC-B2-80 的环境变量组）**：见 1.5 第 ② 点“测试”一条。

**合格组至少要有**：`https://web.push.apple.com/<token>`、`https://api.push.apple.com/<token>`（另一个一级子域）、`https://wns2-par02p.notify.windows.com/w/?token=<…>`（带查询串）、`https://fcm.googleapis.com/fcm/send/<token>`、`https://fcm.googleapis.com/wp/<token>`、`https://updates.push.services.mozilla.com/wpush/v2/<token>`、正好 2048 字符的边界、子域标签正好 63 字符、路径里带 `%`（比如 `%3A`，只许出现在路径里）、带 `:` 的路径。

TC-B2-80 另加两条：push-test 对不合格端点只回 `bad_endpoint`、不回状态码（D1-5）；替身回 301、302、307、308（`Location` 指向 `http://127.0.0.1:<别的端口>`）时都算失败，并且另一个端口一次都没被访问。

---

## 六之二、O-1 正式审查和 S3（11-03）

### O-1：`tools/keys/set-vapid-keys.ps1`、`tests/build/set-vapid-keys.test.ts`、`docs/00-团队/负责人-VAPID密钥-步骤.md`

**结论：通过，可以交负责人运行 `-Target preview`。没有必改项。** 正式那次（`-Target prod`，B7a 前）有两个前提，见 O1-P1、O1-P2。

逐项核对任务单 O-1 和本记录 C 节的要求：

| 要求 | 核对结果 |
|---|---|
| 不经 AI | 私钥在负责人本机的 PowerShell 子进程里生成，屏幕上只显示“已写入”和名字。令牌用 `Read-Host -AsSecureString` 读，不回显。终端里没有任何私钥或令牌可读。R-223 定了不查 Claude 是否在运行，这一点不影响结论 |
| 不进参数 | 只有 `-Target`、`-Subject`（公开值）和测试用的 `-ApiBase`。不用 `supabase secrets set`。写入走 HTTPS 请求正文 |
| 不落盘 | 没有 `Out-File`、`Set-Content`、临时文件，测试的静态检查查过。.NET `ECDsa.Create(curve)` 和 `ImportParameters` 用的都是 CNG 的临时密钥，不进密钥库。页面文件这一层控制不了，作为剩余风险接受 |
| 不进历史 | 只许用 `-File` 运行，点源和 `&` 都拒。子进程里用 `SaveNothing`。父窗口的历史只记下命令行，里面没有值 |
| 不上剪贴板 | 脚本只往剪贴板写空格（静态检查：`Set-Clipboard` 只有 `-Value ' '` 一处）。粘贴令牌后清剪贴板、清历史，开头检查剪贴板历史是否关着 |
| 不另存（R-282） | 不提示另存，测试断言文中没有“Google”和“密码管理器” |
| C-8 私钥格式 | 一行 JWK，d、x、y 各 32 字节，格式用整串正则校验 |
| C-9 成对 | 写入前自检，写入 `VAPID_PUBLIC_KEY` 供函数侧启动时比对；测试里用 Node 独立核对成对 |

运维自己提的六个点：

1. **`$jwk`、`$dB64` 是字符串，没法清零：接受。** 脚本只能用 `-File` 运行，私钥只活在一个很快就退出的子进程里，进程退出后内存就释放了，开着的父窗口从来没拿到过私钥。`D` 的字节数组已经清零，可以清的都清了。步骤文档里“最后关窗口”那句留着。
2. **Hide-Secrets 的名单（`jwk`、`dB64`、`sbTok`）：够用。** 写 secrets 的请求正文里，JWK 会被 JSON 转义，`"` 变成 `\"`，所以整串 `$jwk` 匹配不上。但 `d` 是 base64url，转义以后照原样出现，`dB64` 能把它盖住。测试也覆盖了“400 时回显请求正文”的情况。`dB64` 在 POST 返回以后才置空，所以 POST 出错时它还在，遮得住。建议把 `body` 也加进名单（O1-S1）。
3. **只有写 secrets 那一次用了 `-NoDetail`：同意。** 其他几次请求的正文里没有私钥，令牌在请求头里，`Hide-Secrets` 会把它换成 `***`。
4. **自检用的是 CNG 导入：可靠。** 不管 CNG 导入时核不核对 Q 和 D，签名只用 D，验签只用 x、y，两者不成对就一定验不过。改一个字节以后必须验不过，这一条也能挡住“验签恒为真”的错误。
5. **三项在同一个请求里写入：同意。** 平台不一定保证这个请求是原子的，但就算只写进去一部分，函数侧 C-9 启动自检也会对不上，回 500、一条都不发，是 fail-closed 的。写完还核对了原有的 secrets 一个没少。
6. **临时令牌两项权限（Edge Function Secrets 读写、Project Settings 只读）：同意，已经是最小。** 这把令牌也能**读**和删除这个项目所有的函数 secrets，所以 1 天到期、用完先删，再关窗口，这几条都要照做。建议在文档的“剩下的风险”里写明“也能读”（O1-S2）。

正式运行（`-Target prod`）之前的两个前提：
- **O1-P1**：预览跑完以后，确认两件事并写进环境清单。一是令牌页面上的权限名和文档写的一样。二是 `GET /secrets` 返回的 `value` 是明文还是摘要（即 1.5 第 ③ 点第 3 条）。核实的办法见 O1-S3。
- **O1-P2**：预览上已经有过一次真实推送，并且 C-9 自检在函数侧通过了，日志里没有 `vapid_keypair_mismatch`。

建议项（不卡交付）：
- **O1-S1**：Hide-Secrets 名单加上 `body`。
- **O1-S2**：步骤文档的“剩下的风险”改成“临时令牌能**读**、改、删这个项目的所有函数 secrets，跑完马上删”。
- **O1-S3**：写完以后，只拿两个**公开值** `VAPID_PUBLIC_KEY`、`VAPID_SUBJECT` 去和接口返回的 `value` 比：
  - 和原值相等，就是明文；
  - 等于 SHA-256 十六进制，就是摘要；
  - 都不是，就是不清楚。

  屏幕上只打印“接口返回：明文 / 摘要 / 不清楚”，不打印任何值；私钥那一项不参与比较。这样第一次跑预览时，O1-P1 的问题就有答案了。
- **O1-S4**：公钥的格式正则跟 D1-7 对齐，写成 `\AB[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]\z`。脚本第 342 行、deploy-preview 第 105 行、测试第 186 行三处同改。.NET 生成的点首字节一定是 0x04，所以现在不会出错，只是三处写法要一致。
- **O1-S5**：`-Subject` 的 `ValidatePattern` 在 PowerShell 里默认不分大小写，`HTTPS://`、`MAILTO:` 也能过。建议在脚本里再加一道 `-cmatch`，只收小写的 `https://` 和 `mailto:`。
- **O1-S6**：`LEMO_TEST_API=1` 时，会放宽“`&` 调用被拒”这一条。建议在 `LEMO_TEST_API=1` 而 `-ApiBase` 又是官方地址时直接停，这样测试模式就不可能对着真接口跑。
- **O1-S7**：加一句 `$VerbosePreference = 'SilentlyContinue'; $DebugPreference = 'SilentlyContinue'`，或者给每个 `Invoke-RestMethod` 带上 `-Verbose:$false`，跟 `publish.ps1` 的写法一样。这样负责人误带 `-Verbose` 时，也不会多打印出东西。

**顺带看的两处（照 1.5 第 ③、④ 点做的）：都符合要求。**
- `publish.ps1` 的 `Assert-NoPushStub`：
  - 位置在核对项目名、输入项目名确认之后，改库之前；
  - 接口地址固定是 `api.supabase.com`，不跟随跳转，带 `-Verbose:$false`；
  - 只取 `name`，响应对象读完就置空；名单为空也停；名字用 `-ccontains`，区分大小写；
  - 出错时清 `$Error`，只报状态码；403 时停下，不降级。
- deploy-preview 的“推送替身变量核对”：
  - 令牌经 stdin 交给 curl，只走 https，不跟随跳转；
  - 只有 200 才去查；401、403 只写摘要、不让部署失败，其他状态码失败，正是 1.5 第 ④ 点定的做法；
  - jq 的报错丢掉，读完就清空 body，命中时只报名字。
  - 另一步“VAPID 公钥核对”：看起来像 JWK 的值会被拦下，并且提示换钥匙，这个做法好。
  - 小建议 **O1-S8**：bash 的 `<<<` 遇到大的输入，可能经临时文件传过去。runner 是一次性的，风险很低，但可以改成 `printf '%s' "$body" | jq …`，这样响应体完全不碰磁盘。

**11-03 复核 O1-S1～S8 的落地情况**：八条都已落地，没有引出新问题。S1 遮挡名单加了 `body`；S2 步骤文档写明令牌“能读、改、删”；S3 只比两个公开值，屏幕只打印“明文 / 摘要 / 不清楚”三者之一，`$after` 用完就置空，`finally` 里也置空；S4 三处公钥正则都对齐到 `B[A-P]…`；S5 用 `-cmatch` 校验，和后端一致；S6 测试开关对着官方地址会直接停下，而且放在 `byFile` 检查之前；S7 固定了 Verbose、Debug 偏好；S8 改成 `printf` 管道，第 332 行剩下的 `<<<"$names"` 只处理名字，可以接受。O1-P1、O1-P2 已写进步骤文档第 98～103 行和环境清单（第 40 行、第 160～162 行）。另有一个小点，不算问题：写入后 `dB64` 已经置空，之后 `Hide-Secrets` 遮不到私钥原值，但这一段的报错本来就不带值，可以接受。

### S3：CI 在 Linux 上怎样连到推送替身

**选 A：替身在 127.0.0.1 之外，再绑一个 Docker 网桥网关地址。B、C 不选。D 只作为 A 实测不通时的退路，并且只用在 TC-B2-81～83 上。**

- **为什么选 A**：
  - 函数一侧什么都不用改。D1-8 的替身地址仍然只收 `127.0.0.1`、`localhost`、`host.docker.internal`。
  - 新增的暴露面只有一个：一个私有网桥地址上的测试端口，从外面路由不到，CI runner 又是一次性的。
  - 替身收到的只有 seed 里的假 VAPID 钥匙和测试数据，没有可泄露的东西。
- **为什么不选 B**：socat 转发同样要监听网桥地址，暴露面和 A 一样，却多了一个进程和一个外部依赖，转发不通时也更难查。
- **为什么不选 C**：替身的地址会变成容器别名，函数侧的替身白名单就得再加一个主机名，等于为了测试放宽线上代码。另外，测试要随时改替身的行为（拖慢多久、回什么状态码），替身放在容器里还得再开一条控制通道。
- **为什么不选 D**：TC-B2-80（P1）里的“3xx 不跟随”和替身判断，以及 TC-B2-81～83 的整链，都是 S-B2 签字要的证据，CI 不能长期不跑。
- **A 的条件**（运维实现，Docker 开着时实测一次，把结果写进 TC-B2-80 的记录）：
  1. 只在 `CI=true` 并且是 Linux 的时候才绑网桥地址。本机 Windows 和 macOS 的 Docker Desktop 照旧只听 `127.0.0.1`，那边 `host.docker.internal` 本来就能转到宿主机的回环地址。
  2. 要绑的地址必须**同时**满足三条，有一条不满足就不绑，相关用例直接失败，不悄悄跳过：
     - 是 `docker network inspect bridge` 读出来的网关地址；
     - 在 edge runtime 容器里 `getent hosts host.docker.internal` 解析出来，也正好是这个地址；
     - 属于私有网段（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`），并且不是 `0.0.0.0`、不是 `::`。
  3. 端口随机分配，≥ 1024，只在测试期间监听，测完就关。替身只接受来自回环地址和 Docker 各网络子网的连接，其他来源一律断开（小成本的第二道保险）。
  4. 替身代码里不许出现 `0.0.0.0` 和 `::`。测试开发在替身的单测里断言实际监听的地址，只能是 `127.0.0.1` 和上面那个网关地址。
  5. 退路：如果 A 实测不通，要回到安全审查再定，不能直接改用 0.0.0.0。在重新定之前，按 D 做：只把 TC-B2-81～83 标成“只在本机 Docker Desktop 上跑”；TC-B2-80 的替身判断和 3xx 部分改成进程内注入，在 CI 里照跑。

## 六之三、前端 A 第 8、9 行里涉及安全的部分（11-03，只读审）

范围：`src/sw/sw.ts`、`src/sw/push.ts`、`src/sw/pending.ts`、`src/platform/push.ts`、`src/platform/env.ts`（`isTauri`）、`src/core/pending-actions.ts`、`src/core/boot.ts`（启动时的 prune）、`tests/build/sw-no-user-data.test.ts`，另外顺带看了 `tests/build/sw-pending.test.ts`、`tests/build/sw-push.test.ts`。看的是 `git diff` 和新文件，测试没有跑。

**结论：有条件通过。** 下面两件做得对：
- K-sw-seal 的 ⑴⑵ 都写对了：开库不带版本号；库不存在就中止升级，不留下新库；读 owner 和写入在同一个 readwrite 事务里，owner 不一致就丢；收到 versionchange 立刻关，写完也关；pending 里只存 id、表名、按键和时间。这几点都有行为测试。
- 跳转地址的前缀写死了，不会变成开放跳转。

但还有两处漏洞：一是锁屏和通知中心在账号切换或退出以后，仍可能显示上一个账号的标题；二是从通知数据回到整页提醒时，参数没有再校验。另外 sw-no-user-data 放宽以后，有一处说明写错了路径。下面四件按顺序回答。

### 1. 用户数据会不会进 SW 缓存，锁屏能看到什么

- **SW 缓存：不会进。** 运行时缓存仍只有三个公共缓存；测试从“不准 `caches.open`”收紧成不准出现任何 `caches.` 调用；`/sb/*`、`/files/*` 照旧直连。SW 不读 localStorage、不带 Authorization，测试钉住了。
- **锁屏和通知中心：SW 原样显示负载里的 `title`、`body`。** 隐藏标题（“15:00 有 1 项日程”）全靠服务器按 `push_show_title` 和 `remind.show_title` 生成。SW 这一层没有兜底，所以哪怕只是服务器 bug，或者是一条 resolve、test 推送带了标题，都会显示在锁屏上。→ 建议 FE-S1。
- 通知只用固定的图标，不从负载里取图片和地址，也没有 HTML，系统按纯文本显示，不存在注入。
- 负载解不开时，只显示 App 名，这一点对。
- **明早清单第 62 条，从安全角度看**：
  - ① 把“日程”和“待办”分开写：锁屏多暴露的只是条目的类别，可以接受。
  - ② 通知上加“完成”按钮：可以接受，条件是它和“推迟”走同一条 pending 路径（owner 一致、24 小时、页面转成 outbox 前再校验），并且完成以后能撤销。iPhone 的网页推送本来就不显示按钮，只影响 Edge。

### 2. 账号隔离

- **pending 不会串号。** SW 一侧比对 owner，页面启动时 `prunePendingActions` 删掉别人的、超过 24 小时的、形状不对的；`ensureAccount` 换账号时整库清空，三层都在。
- **通知可能串号：必改 FE-1、FE-2。** 服务器一侧靠两件事断开旧账号的推送：退出时删本会话的 devices 行，新账号用 claim_endpoint 换绑。问题有两个：
  - 退出时如果 `DELETE devices` 没发出去（比如离线），旧账号的推送会继续到达这台设备，SW 照样把旧账号的标题显示在锁屏上。这时设备上可能已经没有人登录，或者已经是另一个账号。
  - 退出以后，通知中心里已经显示的旧通知还留着标题。

  另外，`unsubscribePush` 写好了，但仓库里还没有任何地方调用它。

### 3. 点开通知后跳转的地址能不能被负载带偏

- **不会变成开放跳转。** `reminderUrl` 的前缀固定是 `/app/#/remind/`，再经 `new URL(url, sw.location.origin)` 处理，结果永远是同源地址；负载里没有地址字段，SW 也从不打开负载给的地址。
- **但 hash 路由里的参数没有再校验：必改 FE-3。** `parsePushPayload` 对 uid、id 做了 UUID 校验，但点击时走的是 `dataOf`，它从通知的 data 读回来时只校验了类型。如果有一条通知不是经 `parsePushPayload` 生成的（比如页面自己调 `showNotification`，或者以后加的代码），`id` 可以带上 `/`、`?`、`&`、`#`，从而改写整页提醒路由的参数。

### 4. sw-no-user-data 放宽以后还守不守得住原来的意图

**基本守得住。** IndexedDB 只准在 `pending.ts` 里碰，开库方式、owner 比对、只写一个仓、写完关库都钉在源码上；引入的模块有白名单；事件只多了 push、notificationclick、notificationclose 三个。缺三处，见 FE-4：
- 说明里写的行为测试路径不对：写的是 `src/sw/__tests__/pending.test.ts`，实际在 `tests/build/sw-pending.test.ts`、`tests/build/sw-push.test.ts`。
- 没有钉住“写进 pending 的记录只有那 6 个字段”。
- 没有钉住“SW 只打开 `reminderUrl` 或 `/app/`”。

还有一点：原来“退出以后 SW 一侧不留用户数据”这个意图，现在多了系统通知中心这一处存放的地方。这一处由 FE-2 兜。

### 必改

| # | 必改 | 落在哪 |
|---|---|---|
| **FE-1** | **SW 显示通知之前先核对账号**：用 `pending.ts` 现有的 `openExisting` 只读打开库、读 owner，只有当负载里的 `uid` 和 owner 一致时，才显示负载里的 `title`、`body` 和推迟按键。另外三种情况（没有库、没有 owner、owner 不一致）都改成显示兜底通知：只写 App 名，不带按键，tag 照旧，这样同一条的 resolve 还能替换掉它。读库失败也按兜底处理。不建库、不写任何东西，读完就关。要补测试：owner 一致时显示标题；不一致、没有库时只显示 App 名；不留下新库 | `src/sw/push.ts`、`tests/build/sw-push.test.ts` |
| **FE-2** | **退出流程把浏览器这一侧也断开**：在 K9 退出的 `sealForExit` 之后、删库之前，依次做：① `getNotifications()` 关掉本 App 所有已显示的通知（不支持就跳过）；② `unsubscribePush()` 退订，尽力而为，失败不阻塞退出；它返回的 endpoint 只交给服务器删 devices 行，不写日志。被移除、注销、换账号这几条路径也照这样做。要有一条测试证明退出路径调用了这两步 | FA-1 / FA-4 的退出流程（`core/account.ts` 一侧） |
| **FE-3** | **`dataOf` 和负载用同一套校验**：`uid`、`id` 必须是 UUID，`due_at` 必须是正的安全整数，有一项不合格就返回 null，按“不是我们的通知”只打开 `/app/`。FA-4 的整页提醒路由在页面一侧也要自己再校验 `kind`、`id`、`due`，不认任何 `next`、`redirect`、`url` 这类参数。要钉一条测试：`reminderUrl` 的输出匹配 `^/app/#/remind/(event|todo|anniv)/<uuid>\?due=[1-9][0-9]*$` | `src/sw/push.ts`、FA-4 的路由 |
| **FE-4** | **sw-no-user-data 补三处**：① 改正说明里的测试路径；② 静态断言 `push.ts` 调 `writePendingAction` 时传的对象只有 `id`、`user_id`、`row_table`、`row_id`、`action`、`created_at` 这 6 个字段，不出现 `title`、`body`；③ 静态断言 `openWindow` 和 `navigate` 的参数只能来自 `reminderUrl(...)` 或 `'/app/'`，负载里永远不加地址字段 | `tests/build/sw-no-user-data.test.ts` |

### 建议

- **FE-S1**：resolve 和 test 两类通知，SW 不用负载里的标题，改用本地词典里的固定文案（SW 已经能用 `t()`，词典要补中文、韩文两条）。这样就算服务器出错，这两类通知也不会把条目内容带上锁屏。
- **FE-S2**：`keepPendingAction` 再加一条，`created_at` 晚于“现在 + 5 分钟”的也不留，免得时间写到将来的项永远不过期。
- **FE-S3**：FA-4 的 `toEnqueue` 转 outbox 之前，按 SW 的规则再校验一遍：`row_table` 是那三个表之一，`row_id` 是 UUID，分钟数在 1～1440，`due_at` 是整数。
- **FE-S4**：iPhone 真机（P2）顺带看一件事：中止“新建库”的升级以后，Safari 会不会留下一个空库。如果会留，FE-1 会把它当成“没有 owner”，显示兜底通知；页面启动时 owner 为空，会按正常流程认领账号，所以两种结果都能接受，记下来就行。
- **FE-S5**：`isTauri` 只看 window 上的全局变量，网页脚本可以伪造它，但伪造的后果只是让自己订不了推送，属于自害，可以接受。服务器一侧任何判断都不能依赖它（D1-5 已经写了按端点主机判断，不看客户端声明）。
- **FE-S6**：通知 data 里的 `uid` 会留在系统的通知存储里，它不显示出来，是一个不透明的 id，接受。

### 后端要和前端对齐的两件（推送负载 v1）

- 负载里永远不放地址和图片字段。resolve、test 两类不带条目标题（架构审第四节第 3 点）。`uid` 只给 SW 比对 owner 用。
- `body` 照第四节一起补齐。SW 的 300 字上限只是兜底；服务器在 notify-text 里截断以后，负载必须能放进 3072 字节那一档。

### 11-03 复核（前端 A 按 FE-1～FE-4、FE-S1～S3 改完以后，只读）

**结论：FE-1～FE-4 都通过；FE-S1、FE-S2、FE-S3 也都落地了。剩下的是 FA-4 路由一侧的再校验（前端 A 已经归到 FA-4），它保留为 FA-4 ③ 的打勾条件。**

- **FE-1 通过**：`handlePush` 先用 `readSwOwner` 只读核对（不带版本号开库；库不存在就中止升级，不建库；读完就关）。只有 owner 和负载的 `user_id` 一致，才显示标题、正文和按键。没有库、没有 owner、不一致、读库出错，一律只显示 App 名，不带 data，tag 照旧；resolve 也照样关旧通知，换成静默的兜底通知。`sw-push.test.ts` 覆盖了这几种情况，也覆盖了“不留下新库”。
- **FE-2 通过**：`disconnectBrowserPush` 先关掉所有已显示的通知（不支持就跳过），再退订；整体最多等 2 秒，出错、超时都不抛；endpoint 不记录、不交出去。删 devices 行照旧由退出流程按会话做，这样和原来的口径一致。四条路径都有测试，并且钉住了“断开在删库之前”：`wipeThisDevice`（设置页退出、被移除、登录页“退出并换账号”）、`ensureAccount` 换账号、`watchAccount`（会话没了、换了账号）、`wipeOnRemoved`。两份测试在 `src/core/__tests__/account-push.test.ts`、`src/platform/__tests__/sign-out-push.test.ts`，不在 tests/build 下。还有两点：
  - exe 里 `disconnectBrowserPush` 什么都不做，exe 的本机通知由 B6-exe 外壳审查的 X-5 负责；
  - 换账号以后旧订阅会被退订，新账号如果开着提醒，要重新订阅。这是功能上的事，请前端 A 确认启动流程会按新账号的设置重新订阅。
- **FE-3 通过**：`itemRefOf` 由负载和 `dataOf` 共用（`user_id`、`id` 必须是 UUID，`kind` 必须认识，`due_at` 必须是正的安全整数），不合格就只打开 `/app/`。地址和 tag 收口到 `shared/logic/remind-route.ts`，只留一份，这个文件不 import 别的文件。`native-bridge-url.test.ts` 钉了 FE-3 正则，也有反例：大写 UUID、外来主机、多带参数、`//` 开头。**FA-4 的整页提醒路由还没有在页面一侧再校验 `kind`、`id`、`due`，也还没有拒绝 `next`、`redirect`、`url` 这类参数**，这一条留到 FA-4 ③ 时打勾。exe 的 `openReminder` 也走这条路由，所以一并靠它兜住。
- **FE-4 通过**：说明里的路径改对了；`indexedDB` 在 SW 其他文件里按出现次数核对，并且有别名、解构绕写的反例；写进 pending 的对象按顶层键核对，只有 6 个字段；`openWindow`、`navigate` 的调用点都是固定的，`url` 只来自 `reminderUrl(d.kind, d.id, d.due_at)` 或 `APP_HOME = '/app/'`。
- **FE-S1、FE-S2、FE-S3 落地**：resolve、test 两类通知改用本地词典（`push.resolved`、`push.test`）；`keepPendingAction` 拒收时间晚于“现在 + 5 分钟”的项；转进 outbox 之前先校验形状（三张表、UUID、1～1440 分钟、正的安全整数）。

## 六之四、BE-1 实现审查（11-03，只读）

范围：迁移 20261103100000、110000、120000，`supabase/functions/_shared/push/*.ts`，`push-dispatch/`，`config.toml`，`check_backend.py` 的 F9 ③ 和 F10。只读代码和测试源码，没有跑测试。另有代码审查员在并行审同一批代码。

**结论：通过，没有必改项。D1-1～D1-8、D2-1～D2-4 和 1.5 节在这一批里都落实了。push-dispatch 现在还是骨架：真正的发送循环在 BE-2，下面“留给 BE-2 的条件”要在那时打勾。`gen_push_endpoints.py` 进 F10 放行名单，同意，但有条件（见第 5 点）。**

**1. 端点白名单两边一致（D1-1～D1-3、1.5 第 ①）：落实。**
- SQL `private.push_endpoint_ok` 和 TS `checkEndpoint` 的检查顺序相同：纯可见 ASCII → 长度 ≤ 2048 → 整串正则 → 禁 `%2[eE]` → 路径点段 → 主机白名单（两个固定主机，加上 Apple、WNS 的一级子域，并排除 `xn--`）。
- 整串正则由 `PATH_RULE` 一份常量生成。SQL 照抄，`push-path-rule-sync.test.ts` 逐字核对；`\?` 写成 `[?]`，意思不变。
- 两边都不用 `/i`、`~*`、`lower()`。
- `tests/fixtures/push-endpoints.json` 两边各跑一遍：pgTAP 有 146 条端点向量和 83 条密钥向量。跳过的 1 条是 PG 的 text 存不了的值，可以接受。“只在发送时拒”的公钥单列 3 条。
- TS 多做一步 WHATWG 核对（`href`、`hostname`、端口、用户名密码、协议），原样用原串发送，`origin` 只取 `u.origin`。
- p256dh、auth 在 devices 约束、`push_keys_ok`、TS 三处用同一条正则（D1-7）。SQL 先用 `case` 挡住正则不过的值，再解码，不会因解码抛错；TS 解码后核对 65 字节、首字节 0x04 和 16 字节。

**2. VAPID 自检：落实。**
- 三个变量没设或是空串，都回 `vapid_missing`；JWK 坏了回 `vapid_bad_key`；`d` 和 `x`、`y` 签名验签不过，或者和 `VAPID_PUBLIC_KEY` 逐字节不一致，都回 `vapid_keypair_mismatch`；自检过程中抛异常也按坏钥匙算。
- 以上情况在 `handle` 里一律回 500 `misconfigured`，日志只记 `misconfigured:<原因码>`。这一步放在 `x-cron-secret` 鉴权之后，没带对密钥的调用方看不出函数配没配好，也不会白白耗掉签名的 CPU。TC-B2-88 等用例在 `tests/edge/push-dispatch.test.ts` 里。
- 私钥 `extractable: false`。JWT 按 origin 缓存，`aud` 等于真实端点的 origin，有效期 12 小时，剩余不到 1 小时就重签（C-7、C-8、C-9、D1-6）。

**3. 替身判断：落实（D1-8）。**
- `isLocalStubEnv` 要同时满足两条：`SUPABASE_URL` 是 `http`，主机为 kong、127.0.0.1、localhost 之一；并且开关正好等于 `'1'`。
- 线上只要 `PUSH_SERVICE_OVERRIDE_URL` 不是空串（只有空格也算），就回 500 `misconfigured:override`。本机的地址也要过 1.5 的原串正则，端口在 1024～65535 之间。
- 设了替身以后，`deliver` 照旧先查端点和密钥；`aud` 仍按真实端点签；真实端点一次都不连。
- 测试覆盖了 1.5 列的全部情况，包括 `.evil.com`、IP、https、80 端口和 302。

**4. 发送（D1-4、第五节第 5 条）：落实。**
- `redirect: 'manual'`；`opaqueredirect`、状态 0、任何 3xx 都归为 `redirect`，不读 `Location`。
- `AbortSignal.timeout(5000)`，`credentials: 'omit'`，除 VAPID 以外不带别的凭据。
- 响应体读到 1 KB 就 `cancel()`，内容不记录。
- 结果只给枚举，日志只记原因码。
- 每条都新生成 ECDH 临时密钥和 salt。固定向量入口 `encryptWithFixedKeysForTest` 不在发送路径上。补齐用 1024 / 2048 / 3072 三档。

**5. 负载、F9、F10：**
- **负载：落实。** 只能经 `buildPayload` 组装。类型上就没有地址、图片字段；resolve、test 不带 `title`、`body`、`snooze`；`user_id` 必带；`title`、`body` 各 ≤ 300 字，整份 ≤ 3071 字节。
- **F9 ③（D2-1～D2-4）：落实。** `SERVER_SECRET_FUNCTIONS` 写死，有单测钉住；`config.toml` 里 `verify_jwt = false` 只有 account-purge、push-dispatch、usage-report 三个。push-dispatch 已进 version-gate 免查名单（D1-S6）。
- **claim_endpoint 的会话检查和授权：落实。**
  - 顺序：`not_password_session` → `account_usable` → `session_alive`，然后才校验；校验不过整次拒绝，一行不动。
  - `endpoint_not_allowed`、`bad_push_keys` 都用 22023，不带 detail、hint，也不带原串（D1-S4）。
  - `public.claim_endpoint` 只授 authenticated，并撤掉了 public、anon、service_role 的执行权；两个校验函数不授任何角色执行权。
- **`build/gen_push_endpoints.py` 进 F10 放行名单：同意。** 它只生成测试向量，`host.docker.internal` 在里面是“必须被拒”的样例；它只 import json、base64、os、random 和 cryptography，不联网，产物落在 `tests/fixtures/`。放行按精确路径，不放整个 `build/`，这一点对。条件：在 `check-backend` 的测试里加一条断言，这个脚本不 import `urllib`、`http`、`socket`、`requests`、`subprocess`。以后它开始联网或者被别处 import，就挪进 `tests/`，并从名单里删掉。

**留给 BE-2 的条件（③ 时打勾）**

- 发送循环只用 `deliver`：
  - `bad_endpoint`、`bad_keys`：三列置空，记 `push_bad_endpoint`，code 只写原因码；
  - `gone`：删订阅；
  - `vapid_rejected`：只加 `push_fail_count`，不删订阅；
  - `*.push.apple.com`（`apple` 为真）一律不发 resolve；
  - 日志和心跳都不带地址、标题、响应内容。
- push-test 也只调 `deliver`，只回枚举（D1-5）。
- 心跳新加的 `claimed`、`budget_hit` 记得进 usage-report 的转发字段（D2-S2）。

**建议（不卡）**

- **BE1-S1**：`vapid.ts` 的 `SUBJECT` 现在允许主机有大写，路径字符也比较宽。可以收紧到和 O-1 脚本、R-283 一致：`https://` 后面只许小写主机、不带端口，或者 `mailto:`。脚本已经拦了一道，所以不卡。
- **BE1-S2**：test 类负载现在也带了 `kind`、`id`、`due_at`（SW 不用）。建议按负载 v1 只发 `{v, type, user_id}`，多一个字段就多一处暴露。
- **BE1-S3**：F10 在任何层级遇到名为 `tests`、`__tests__` 的目录都跳过。如果 `supabase/functions/<名>/tests/` 下的文件被函数 import，它们会跟着部署出去。建议在 `supabase/functions/` 下不跳过这两类目录，或者只跳过仓库根目录的 `tests/`。
- **BE1-S4**：`drain` 是按块读的，单块可能超过 1 KB。块的大小有网络缓冲兜着，可以接受；注释里可以写成“读到超过 1 KB 的那一块为止”。

## 六之四补：BE-1 后续改动复看（11-03，只读）

只看后端按代码审查改动的五处，不整轮重审。说明：其中几个文件还没被 git 跟踪（`git status` 显示为 `??`），`git diff` 里看不到，所以直接读了当前文件的内容。没有跑测试。

**结论：五处都通过，没有必改项。另有两个小条件和一个留给 BE-2 的条件，见下文。**

1. **claim_endpoint 第 e 步（S6）：通过，不会让别的会话借此删掉主人还在用的那一行。**
   - 新规则：占着这个地址的同账号的行，要满足 `deleted_at is null` 并且会话还活着，才回 `endpoint_in_use`；否则删掉。
   - 关键在于，`deleted_at` 和会话状态都不是别的会话能改的：
     - devices 的 `upd` 策略要求 `session_id` 等于本次 JWT 的会话，所以只有那一行自己的会话能把它软删；
     - 会话失效只能来自那台设备退出，或者用户在设置页移除、吊销它，这本来就是第 99 条④留给主人的做法。
   - 因此，认领方只能删掉“已经被主人自己放弃”的行；会话还在、又没软删的行照旧回 `endpoint_in_use`，由用户确认。跨账号的删除仍是第 d 步（M9），这是已接受的风险（D1-S5），这次没有变。
   - 一个小边角，接受：一行刚被它自己的会话软删、还在撤销期内，这时如果被认领方删掉，撤销以后这台设备就没有推送订阅了。下次启动会重新认领，影响的只是功能。
   - pgTAP 新增 3 条，覆盖“已软删、会话还在”这一种（删掉，认领方写上地址）。

2. **VAPID subject 正则（BE1-S1）：通过。** `vapid.ts` 和 `set-vapid-keys.ps1` 第 95 行是同一条正则：JS 用 `^…$`，没有 `m` 标志；PS 用 `\A…\z` 加 `-cnotmatch`，区分大小写。https 后面只许小写主机，至少一个点，不带端口，路径字符集也收窄了；mailto 的域名只许小写。subject 只经 `JSON.stringify` 放进 JWT，不存在注入。

3. **负载（S3、S11）：通过。** `buildPayload` 先校验：`user_id`、`id` 必须是小写 UUID，和 SW 的 `UUID_RE` 是同一条；`kind` 必须认识；`due_at` 必须是正的安全整数。不合格抛 `PushPayloadError('bad_payload')`，只影响这一条。test 负载只有 `{v, type, user_id}`（即 BE1-S2）。`topic` 必须是 1～32 个 base64url 字符，不合格不发，记 `failed`。
   - **留给 BE-2 的条件**：`Topic` 请求头是**明文**交给推送服务的（Google、Apple、Mozilla、Microsoft 都看得到），不在加密范围内。BE-2 用 topic 合并同一条提醒时，**不能直接用条目 id 或 tag**，要用不透明的值，比如对 tag 加服务器端密钥做 HMAC 以后截短。这样推送服务就不能按 topic 把同一个条目的多次提醒关联起来。

4. **F10 放行 `build/gen_push_endpoints.py`：通过。** 放行名单正好两项，按精确路径。断言覆盖了 `import`、`from … import`，以及 `__import__`、`importlib`。小条件（不卡）：脚本 import 了 `os`，所以 `os.system`、`os.popen`、`os.exec*`、`os.spawn*` 也能起进程。断言里请顺手加上 `/\bos\.(system|popen|exec|spawn)/`。

5. **函数目录里的 `*.test.ts` 继续按文件名放过：同意协调员的做法。另加的那条检查要把三种引用方式都算上。**
   - 部署时，Supabase 只把入口文件的 import 链打进包。所以测试文件只要没被非测试文件引用，就不会上线，F10 放过它不会让 `host.docker.internal` 进入线上出站代码。
   - 新检查的范围：`supabase/functions/` 下的非测试源码（去掉注释以后），下面三种写法引用了 `*.test.*`、`*.spec.*`、`*_test.*` 或 `tests/`、`__tests__/` 下的文件，都报错：
     - 静态 `import … from`；
     - `export … from`；
     - 字符串字面量的 `import('…')`。
   - 不是字面量的动态 `import(…)` 在函数代码里本来也不该有，建议一并报错。
   - 补一个违规样例。

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
| 前端 SW 推送和 pending（第六之三节 FE-1～FE-4） | P1 | 四条必改的代码和测试 | 待审 |
| O-1 VAPID 脚本（不经 AI、不进参数、不落盘；JWK 格式） | — | O-1 初稿 | **11-03 已审：通过，预览可运行**（第六之二节）；正式运行前满足 O1-P1、O1-P2 |
| 风险接受：usage-report、push-dispatch 未鉴权的请求能进函数、算一次调用（和 account-purge 一样） | — | 写明即可 | 待审 |

## 签字

| 环 | 结论 | 签字 | 日期 |
|---|---|---|---|
| ③ 安全审查 | （留空，正式审查时填） | | |

---

## 修改记录

- 2026-11-03：第一版，开工前审 D1、D2（结论都是有条件通过；必改 D1-1～D1-6、D2-1～D2-5）；按主持人补充加了 Web Push 自实现密码学的审查要点（C-1～C-11）和补齐方案（改成 1 / 2 / 3 KB）；签字栏留空。只新建了这一个文件，没改别的文件，没有登记文件登记册（主持人登记）。
- 2026-11-03：补 1.5 节，定了四件事：① 路径和查询串改用收窄的字符集，两边都禁止 `%2e` 和点段（D1-1 第 ③ 步的路径写法作废）；② 替身允许用 `host.docker.internal`，判断本机要同时满足两条（D1-8）；③ 同意正式发布令牌加 Edge Function Secrets 只读，附五个条件；④ 预览令牌也同意加，但不单独重建，下次重建时一并加，在那之前检查只写摘要、不让部署失败。D1-S1 升为必改 D1-7；样例清单补第 40～44 条和合格组。
- 2026-11-03：按代码审查 S9，D1-7 定了最终写法：p256dh 加了第二个字符和末字符的限制，auth 加了末字符的限制。
- 2026-11-03：加第六之二节：O-1 正式审查通过，预览可以运行，没有必改项；正式运行前要满足 O1-P1、O1-P2，另有建议 O1-S1～S8；`Assert-NoPushStub` 和 deploy-preview 的两步核过，都符合要求；S3 选 A（绑网桥网关地址，附五个条件），B、C 不选，D 只作退路。
- 2026-11-03：加第六之三节：只读审了前端 A 第 8、9 行里涉及安全的部分，结论有条件通过；必改 FE-1～FE-4（推送显示前核对 owner、退出时关通知并退订、`dataOf` 再校验、sw-no-user-data 补三处），另有建议 FE-S1～S6。
- 2026-11-03：六之二节补一行，复核 O1-S1～S8 的落地情况：都已落地，没有引出新问题；O1-P1、O1-P2 已写进步骤文档和环境清单。
- 2026-11-03：六之三节补“11-03 复核”：FE-1～FE-4 通过，FE-S1～FE-S3 落地；FA-4 路由一侧的再校验留到 FA-4 ③ 打勾；exe 的本机通知归 B6-exe 外壳审查的 X-5。
- 2026-11-03：加第六之四节：只读审 BE-1 实现，结论通过、没有必改项；D1-1～D1-8、D2-1～D2-4、1.5 节都已落实；列了留给 BE-2 的条件和建议 BE1-S1～S4；同意 build/gen_push_endpoints.py 进 F10 放行名单（附条件）。
- 2026-11-03：加“六之四补”：复看 BE-1 后续五处改动（S6、BE1-S1、S3/S11、F10 放行条件、函数目录测试文件），都通过；小条件两条（os.system 一类也要断言、引用测试文件的检查要覆盖三种写法），留给 BE-2 一条（Topic 用不透明值）。
