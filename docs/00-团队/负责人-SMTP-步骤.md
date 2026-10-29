# 负责人操作：给登录验证码配发信服务（自定义 SMTP）

- 日期：2026-10-29（主持人整理；调研员查官方页面核实）
- 起因：明早待确认 第 10 条——10-29 09:00 实测，登录邮件里只有登录链接、没有 6 位验证码。App 是邮箱验证码登录（架构 5.6），Supabase 要先配自定义 SMTP 才能改模板。
- 依据（**仓库里已经定下的，本文照这些写，不另选**）：
  - R-49、ADR-011 第 7 条、架构 5.6 和 15.6 总表：发信用 **Resend**，发件人 **`noreply@lemomemo.com`**，域名配好 SPF、DKIM、DMARC；
  - 架构 8.4、环境清单-v4 第 143 行：Auth SMTP 用**单独一把只发信、只限 lemomemo.com** 的密钥，和函数用的 `RESEND_API_KEY`、监控用的分开；
  - 环境清单-v4 第 100 行：“B1 前在 Resend 里加域名，按它给的记录在 Cloudflare DNS 里添加，★ 负责人（运维出步骤）”；
  - 账号注册清单-v4 第 4 节：Resend 账号 10-27 已注册、已开两步验证，当时说“先不要添加域名”——现在就是添加的时候；
  - R-220：密钥不另外保存，丢了就重新生成。
- 两个项目都要配：**预览** `yoeqwhygehbaftkppati`（lemomemo-preview），**正式** `uvlnwawwsdfihziaielj`（lemomemo-prod）。先做预览，测通了再做正式。

---

## 一、结论

**照原定方案用 Resend，不换。** 下面的对比只是确认原决定站得住，没有发现更合适的。

模板放不放登录链接：**已定用版本 A（主持人 10-29，依据架构 15.6）**，只放 6 位验证码、不放登录链接。版本 B（加登录链接作后备）保留在第五节备查，**不用**。理由见第五节。

---

## 二、候选对比

| | **Resend（原定）** | Amazon SES | Postmark | Brevo | Cloudflare Email Service |
|---|---|---|---|---|---|
| 免费额度 | **每月 3,000 封，每天 100 封**，免费版可加 3 个域名 | 新账号送最多 200 美元 AWS 抵用金（6 个月内有效），没有固定的免费封数 | 每月 100 封（开发者版） | 每天 300 封，含 SMTP | 每月 3,000 封，**但要先开 Workers 付费版** |
| 超出后的价格 | Pro 20 美元/月 5 万封 | 约 0.10 美元/千封（按量） | Basic 15 美元/月 1 万封 | 付费版起价各来源说法不一，以官网为准 | Workers 付费版（5 美元/月起）+ 超出部分 0.35 美元/千封 |
| 要不要绑卡 | 免费版一般不用（定价页没写，只写“接受信用卡”；你 10-27 注册账号时有没有被要求绑卡，以你看到的为准） | 要（开 AWS 账号就要绑卡） | 不用（官网写 “No Credit Card Required”） | 不用 | 要（Workers 付费版） |
| 自有域名和 DNS | 要。加 `send` 子域名的 MX、TXT（SPF）和 `resend._domainkey` 的 TXT（DKIM）；DMARC 官方建议加 | 要。DKIM（3 条 CNAME）、自定义 MAIL FROM、DMARC | 要。DKIM、Return-Path（CNAME） | 要。DKIM、DMARC，Brevo 的验证码 | 要。域名一般放在 Cloudflare |
| 有没有门槛 | 没有。加好域名就能给任何人发 | **有**：新账号在“沙盒”里，只能发给验证过的地址、每天 200 封；要提交“转正申请”，官方说 96 小时内初次回复，可能被拒 | 新账号要人工审核后才能发给外部地址（定价页没写，按以往经验，要实测） | 没有，但免费版邮件可能带 Brevo 标识 | **还是 Beta**；要 Workers 付费版 |
| Supabase 官方文档有没有提 | **有**（SMTP 页列在第一个；Resend 自己也有 Supabase 专页） | 有（AWS SES） | 有 | 有 | 没有 |
| 到 Gmail | 好（SPF、DKIM、DMARC 都齐就没问题） | 好 | 业内口碑最好 | 一般偏好，共享 IP | 未知（Beta） |
| 到 Naver | 没有官方数据，**要实测** | 同左 | 同左 | 同左 | 同左 |
| 到 QQ、163 | 没有官方数据；海外共享 IP 发到 QQ、163 偶有进垃圾箱或延迟的反馈，**要实测** | 同左（Resend 底层就是 SES，SPF 里是 `include:amazonses.com`） | 同左 | 同左 | 同左 |
| 开通难度 | **最低**：账号已有，只差加域名、加 3 条 DNS、建 1 把密钥 | 高（AWS 控制台、IAM 生成 SMTP 用户、转正申请） | 中（审核） | 中 | 中（要付费，Beta） |

关于送达口碑：这几家都没有公布发到 Naver、QQ、163 的数据，网上也查不到 Naver 官方的发件人规定。能确定的只有通用规则（Google 发件人指南）：SPF、DKIM、DMARC 三样齐全、内容像正常的事务邮件、不夹广告。所以**哪一家都要实测**，见第四节“事后验证”。

### 为什么还是 Resend

1. **已经定了，牵连很多**：R-49、ADR-011、架构 5.6、8.4（三把密钥）、15.6 总表、`config.toml` 的注释、lemo-ops 每天 20 封的告警上限（架构 6 节，是按 Resend 每天 100 封算的）都按 Resend 写。换别家要改一串文档和代码。
2. **账号已有，不用绑卡，没有审核**：今天就能配好，不挡 B1。
3. **额度够用**：朋友圈规模，每天 100 封足够；架构 12 节风险 4d 已经写了被刷时的处理。
4. **能选东京（ap-northeast-1）发信**：离首尔的 Supabase、离韩国和中国的收件人都最近。
5. **函数那边本来就用 Resend 的 API**（邀请注册、注销通知），一个服务管到底。

有一点要知道：Resend 不管从哪里发，**账号的日志和元数据都存在美国**（Resend 官方说明）。验证码邮件的内容只有验证码和收件地址，隐私说明（15.7）里“我们用到的服务”应该已经列了 Resend；后端核对一下有没有写地区。

---

## 三、谁做什么

| 步骤 | 谁做 | 为什么 |
|---|---|---|
| 在 Resend 里添加域名 `lemomemo.com`、选地区 | ★ 负责人 | 要登录你的 Resend 账号 |
| 在 Cloudflare DNS 里加 3～4 条记录 | ★ 负责人（主持人已把要填什么写在下面） | 要登录你的 Cloudflare 账号；这些记录不是密钥，截图发给主持人没问题 |
| 生成 SMTP 用的 API 密钥 | ★ 负责人 | 密钥只能你本人看、本人粘贴，AI 不经手 |
| 在 Supabase 控制台填 SMTP 设置、粘贴密钥 | ★ 负责人 | 同上 |
| 把模板粘进 Supabase 控制台 | 负责人粘贴（模板本身不是密钥，主持人写好） | 控制台要你的账号登录 |
| 准备 DNS 记录说明、写模板 HTML | 主持人（本文已做完） | |
| 公开查询 DNS 是否生效、核对邮件头、在真机上测 | 主持人和 QA | 只看公开信息和你转来的截图，不碰密钥 |

**规则**：密钥由你本人生成、本人粘贴；不要发到聊天里，不要存文件（R-220，丢了就重新生成一把）；截图前确认画面上没有密钥。

---

## 四、步骤

### 第 0 步：准备（1 分钟）

- 关掉剪贴板历史：设置 › 系统 › 剪贴板 › 剪贴板历史（粘贴密钥要经过剪贴板）。剪贴板同步软件、手机连接的跨设备剪贴板也先关掉。
- 用电脑做。iPhone 上 Resend 和 Supabase 的控制台都能打开，但表格多、复制粘贴容易出错。

### 第 1 步：Resend 添加域名（约 3 分钟，★ 你本人）

1. 打开 <https://resend.com/domains>，点 **Add Domain**。
2. 域名填 **`lemomemo.com`**（不加 `www`、不加 `send`）。
3. 地区（Region）选 **Tokyo (ap-northeast-1)**。选错了只能删掉域名重加、DNS 重配，所以这一步看清楚。
4. 点添加。页面会列出要加的 DNS 记录，**先不要关这个页面**。

> 说明：Resend 官方建议用子域名（例如 `mail.lemomemo.com`）发信，好把信誉分开。我们的架构定的是 `noreply@lemomemo.com`，而且 Resend 默认已经把退信地址放在 `send.lemomemo.com` 子域名上，本项目只发事务邮件、不发营销邮件，用主域名没有实际问题，**照原定不改**。

### 第 2 步：Cloudflare 加 DNS 记录（约 5 分钟，★ 你本人）

10-29 主持人公开查询过：`lemomemo.com` 现在**没有任何 MX、TXT 记录**，`_dmarc`、`send`、`resend._domainkey` 也都是空的，不会和已有记录冲突。

两种加法，选一种：

- **A. 自动（推荐）**：Resend 域名页上有 **Sign in to Cloudflare** 按钮（Domain Connect），点了以后在 Cloudflare 页面里确认，Resend 会把记录自动加好。这一步是给 Resend 授权改你的 DNS，**只授权这一次、只对 lemomemo.com**；你看清楚授权页写的是什么再点同意。
- **B. 手动**：打开 Cloudflare › lemomemo.com › DNS › Records › Add record，照 Resend 页面上的值逐条加。名字一栏**只填前缀**（例如 `send`），不要填成 `send.lemomemo.com`。

要加的记录（**值一律以 Resend 页面上显示的为准**，下面是样子）：

| 类型 | 名称 | 内容 | 优先级 | 代理状态 | 作用 |
|---|---|---|---|---|---|
| MX | `send` | 形如 `feedback-smtp.ap-northeast-1.amazonses.com` | 10 | （MX 没有代理开关） | 退信回到 Resend |
| TXT | `send` | 形如 `v=spf1 include:amazonses.com ~all` | | 仅 DNS | SPF |
| TXT | `resend._domainkey` | 以 `p=` 开头的一长串 | | **仅 DNS（灰色云朵）** | DKIM |
| TXT | `_dmarc` | `v=DMARC1; p=none;` | | 仅 DNS | DMARC（Resend 不自动加，**A、B 两种都要手动加这一条**） |

DMARC 先用 `p=none`（只观察、不拦截）。上线后两周如果预览、正式的信都正常收到，再改成 `v=DMARC1; p=quarantine;`，让冒充 lemomemo.com 的信进垃圾箱。到时候主持人会提醒。

可选（建议加）：主域名本身不发信，可以加一条 TXT，名称 `@`，内容 `v=spf1 -all`，告诉别人“没有服务器能用 lemomemo.com 的信封地址发信”。以后如果开 Cloudflare 的邮件转发（Email Routing），这一条要按 Cloudflare 的提示改。

加完回到 Resend 域名页，点 **Verify DNS Records**。官方说最长 72 小时，Cloudflare 一般几分钟。状态变成 **Verified** 就行。DNS 记录是公开信息，截图发给主持人没问题。

### 第 3 步：生成 SMTP 密钥（★ 你本人；预览、正式各一把）

1. 打开 <https://resend.com/api-keys>，点 **Create API Key**。
2. 名字：预览填 `supabase-auth-smtp-preview`，正式填 `supabase-auth-smtp-prod`。
3. 权限（Permission）选 **Sending access**（只能发信），域名（Domain）选 **lemomemo.com**。不要选 Full access。
4. 点创建。密钥**只显示这一次**，点复制，马上做第 4 步，不要粘到别处。

### 第 4 步：在 Supabase 填 SMTP（★ 你本人；约 3 分钟）

1. 打开预览项目：<https://supabase.com/dashboard/project/yoeqwhygehbaftkppati/auth/smtp>（正式那次把中间换成 `uvlnwawwsdfihziaielj`）。如果这个地址打不开，就从左边 **Authentication** › **Emails**（或 Notifications › Email）› **SMTP Settings** 进去。
2. 打开 **Enable Custom SMTP**，照下表填：

   | 栏目 | 填什么 |
   |---|---|
   | Sender email（发件地址） | `noreply@lemomemo.com` |
   | Sender name（发件人名称） | `柠檬记` |
   | Host | `smtp.resend.com` |
   | Port | `465` |
   | Username | `resend` |
   | Password | 粘贴第 3 步复制的密钥 |
   | Minimum interval between emails（如果有这一栏） | 保持默认 `60` 秒 |

3. 点 **Save**。
4. 保存后，Supabase 会把“每小时发信上限”设成 30 封。**保持 30，不要调高**（架构 15.6 总表、12 节风险 4d）。在 Authentication › Rate Limits 页能看到。
5. 回到 Claude 说一句“预览（或正式）的 SMTP 填好了”。不要把密钥发过来。

### 第 5 步：粘贴模板（负责人粘贴；约 2 分钟）

1. 同一项目里打开 **Authentication** › **Emails** › **Templates**（或 Email Templates），选 **Magic link or OTP**（有的版本叫 Magic Link）。
2. **Subject**（标题）填：`柠檬记 · 레모 验证码 / 인증 코드`（和本机 `config.toml` 一致）。
3. **Body**：把第五节的**版本 A** 整段粘进去（和本机 `supabase/templates/otp.html` 的正文一致），点 Save。不要用版本 B。
4. 同一页如果有 **Confirm signup**、**Invite user** 模板，不用改：注册走我们自己的 invite-signup 函数（经 Resend API 发码），不经这两个模板。

### 第 6 步：事后验证（主持人和 QA 做，你只需要收信、截图）

1. **DNS**：主持人公开查询 `send`、`resend._domainkey`、`_dmarc` 三条记录是否生效。
2. **收信测试**：你在 App 预览版（`https://preview.lemomemo.com/app/`）分别用这些邮箱登录一次（有哪个用哪个，至少 Gmail 和 Naver）：Gmail、Naver、QQ、163。每个看三件事并截图：
   - 进的是收件箱还是垃圾箱；
   - 从点“发送”到收到大概几秒；
   - 6 位码是否显示清楚，中文、韩文两种（韩文要先在设置里把语言改成韩文，再退出重登）。
3. **邮件头**：Gmail 里打开邮件 › 右上角 ⋮ › **显示原始邮件**，截图最上面那几行。主持人看 SPF、DKIM、DMARC 是不是都是 `PASS`。
4. QQ、163 进垃圾箱或收不到：先把 `noreply@lemomemo.com` 加进通讯录再试一次；还不行，主持人再看要不要给中国大陆的用户换发信路线（这是另一件事，不挡上线，写进风险表）。
5. 预览测通后，正式项目从第 3 步做一遍（域名第 1、2 步只做一次，两个项目共用）。

---

## 五、模板草稿（Magic link or OTP）

### 已定：用版本 A，只放验证码（主持人 10-29，依据架构 15.6）

**已定用版本 A（主持人 10-29，依据架构 15.6）**：架构 15.6 总表定的是“验证码邮件模板写 `{{ .Token }}`”，不放登录链接。版本 B 保留在下面备查，**不用**。下表是当时比较两版的理由。

| | A. 只放验证码（**采用**，本机 `supabase/templates/otp.html` 已同步成定稿） | B. 验证码 + 登录链接作后备（**不用**） |
|---|---|---|
| iPhone 主屏幕版 | 正常：在 App 里输入 6 位码 | **链接会在 Safari 里打开**，不是在主屏幕的 App 里，登录状态留在 Safari；而架构规定 iPhone 的 Safari 里只显示“添加到主屏幕”教程（第 9 节）。用户点了链接只会看到教程，以为登录坏了 |
| 邮件安全扫描 | 不受影响 | Supabase 官方说明：有的邮箱会**预先打开邮件里的链接**做安全扫描，这会把这次的验证用掉，用户再输入 6 位码也会报“已过期或无效”。链接和验证码是同一次验证，所以**放了链接，验证码也可能被连带作废** |
| 电脑网页、exe | 输入码 | 链接能用，但 exe 里也是开系统浏览器，同样不在 exe 里 |
| 改动 | 不用改 | 要改 `otp.html` 和架构 15.6 总表那一行，请后端同步 |

定稿的版本 A 已同步到本机 `supabase/templates/otp.html`（10-29），本地 `config.toml` 的 `[auth.email.template.magic_link]` 引用的就是它；控制台里粘贴的正文要和它一致。

### Supabase 模板变量怎么写

模板用 Go 模板语法，双花括号，变量名前面有个点，**大小写要一致**：

| 写法 | 是什么 |
|---|---|
| `{{ .Token }}` | 6 位验证码（长度由 Email OTP 长度设置决定，我们是 6 位） |
| `{{ .ConfirmationURL }}` | 登录链接（点了验证后跳到 Site URL 或 RedirectTo） |
| `{{ .TokenHash }}` | 验证码的哈希，用来自己拼链接；我们不用 |
| `{{ .SiteURL }}` | 项目的 Site URL（预览 `https://preview.lemomemo.com/app/`，正式 `https://lemomemo.com/app/`） |
| `{{ .Email }}` | 收件人邮箱 |
| `{{ .Data.locale }}` | `user_metadata` 里的 `locale`，我们存 `zh-CN` 或 `ko-KR`（架构 2.4 第 6 点） |
| `{{ if eq .Data.locale "ko-KR" }}…{{ else }}…{{ end }}` | 按语言分两段；没有 locale 的老账号走 `else`（中文） |

注意：
- 引号必须是英文直引号 `"`，不能是中文引号。
- Resend 的“点击追踪”（Click tracking）要保持关闭，否则它会改写邮件里的链接（Supabase 官方建议关掉）。Resend 新建域名默认是关的，第 1 步加完域名后在域名页 Configuration 里看一眼。
- 标题（Subject）一栏不分语言，用中韩双语的固定标题。

### 版本 A：只放验证码（**已定采用**，已过韩文审校 R-106）

```html
{{ if eq .Data.locale "ko-KR" }}
<div lang="ko" style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#1f2328">
  <p style="margin:0 0 12px;font-size:15px">레모 로그인 인증 코드예요.</p>
  <p style="margin:0 0 16px;font-size:32px;letter-spacing:8px;font-family:'SF Mono',Menlo,Consolas,monospace"><strong>{{ .Token }}</strong></p>
  <p style="margin:0 0 8px;font-size:14px">앱에서 이 6자리 인증 코드를 입력해 주세요. 10분 동안 유효해요.</p>
  <p style="margin:0;font-size:13px;color:#656d76">직접 요청하지 않았다면 이 메일은 무시해 주세요. 인증 코드는 누구에게도 알려 주지 마세요.</p>
</div>
{{ else }}
<div lang="zh-CN" style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#1f2328">
  <p style="margin:0 0 12px;font-size:15px">你的柠檬记登录验证码：</p>
  <p style="margin:0 0 16px;font-size:32px;letter-spacing:8px;font-family:'SF Mono',Menlo,Consolas,monospace"><strong>{{ .Token }}</strong></p>
  <p style="margin:0 0 8px;font-size:14px">请在 App 里输入这 6 位验证码，10 分钟内有效。</p>
  <p style="margin:0;font-size:13px;color:#656d76">如果不是你本人操作，请忽略这封邮件。不要把验证码告诉任何人。</p>
</div>
{{ end }}
```

#### 韩文审校（R-106）改了什么、为什么（10-29）

对照的现有词条：`shared/i18n/ko.ts`（`app.name` = `레모`；“앱을 업데이트해 주세요”“다시 시도해 주세요”等）和 `src/features/auth/i18n/ko.ts`（`auth.exit.pendingDeletion` 里的“이메일 인증 코드”、“다시 로그인해 주세요”）。

| 位置 | 原稿 | 定稿 | 为什么 |
|---|---|---|---|
| 韩文第 3 行 | 앱 화면에 이 6자리 코드를 입력해 주세요. | 앱에서 이 6자리 인증 코드를 입력해 주세요. | “화면에 입력”是直译，韩语说“앱에서 입력”更自然；“코드”统一成 App 词条里用的“인증 코드”，和第 1 行、标题“인증 코드”一致 |
| 韩文第 4 行 | 코드는 다른 사람에게 알려 주지 마세요. | 인증 코드는 누구에게도 알려 주지 마세요. | 语气更明确，对齐中文“不要把验证码告诉任何人”；同上统一成“인증 코드” |
| 韩文其余 | 레모 로그인 인증 코드예요. ／ 10분 동안 유효해요. ／ 직접 요청하지 않았다면 이 메일은 무시해 주세요. | 不改 | 自然；App 名“레모”和 `app.name` 一致 |
| 敬语层级 | 全篇 해요체 + “～해 주세요” | 不改 | 和 App 现有韩文词条（있어요、해 주세요）同一层级，没有混用 합니다체 |
| 中文第 3 行 | 请在 App 里输入这 6 位数字 | 请在 App 里输入这 6 位验证码 | App 登录页一律叫“6 位验证码”（`auth.code.title`、`auth.code.label`），统一说法 |
| 验证码那一行（中韩） | `<p … font-weight:700 …>{{ .Token }}</p>` | `<p …><strong>{{ .Token }}</strong></p>` | 和原 `otp.html` 一样用 `<strong>` 加粗：本地自动测试 `supabase/tests/auth/login-probe.mjs` 按 `<strong>6 位数字</strong>` 取码；显示效果不变 |

注意：“10 分钟内有效”和“10분 동안 유효해요”两句是自动测试用来区分中韩模板的，改文案时不要动这两句。

### 版本 B：验证码 + 登录链接作后备（**不用**，仅备查）

```html
{{ if eq .Data.locale "ko-KR" }}
<div lang="ko" style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#1f2328">
  <p style="margin:0 0 12px;font-size:15px">레모 로그인 인증 코드예요.</p>
  <p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:8px;font-family:'SF Mono',Menlo,Consolas,monospace">{{ .Token }}</p>
  <p style="margin:0 0 8px;font-size:14px">앱 화면에 이 6자리 코드를 입력해 주세요. 10분 동안 유효해요.</p>
  <p style="margin:16px 0 8px;font-size:13px;color:#656d76">코드 입력이 어려우면 아래 링크로 로그인할 수 있어요. 아이폰 홈 화면 앱을 쓰고 있다면 링크 대신 코드를 입력해 주세요.</p>
  <p style="margin:0 0 16px;font-size:13px"><a href="{{ .ConfirmationURL }}" style="color:#0969da">브라우저에서 로그인</a></p>
  <p style="margin:0;font-size:13px;color:#656d76">직접 요청하지 않았다면 이 메일은 무시해 주세요. 코드와 링크는 다른 사람에게 알려 주지 마세요.</p>
</div>
{{ else }}
<div lang="zh-CN" style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#1f2328">
  <p style="margin:0 0 12px;font-size:15px">你的柠檬记登录验证码：</p>
  <p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:8px;font-family:'SF Mono',Menlo,Consolas,monospace">{{ .Token }}</p>
  <p style="margin:0 0 8px;font-size:14px">请在 App 里输入这 6 位数字，10 分钟内有效。</p>
  <p style="margin:16px 0 8px;font-size:13px;color:#656d76">输入验证码有困难时，也可以点下面的链接登录。如果你用的是 iPhone 主屏幕上的柠檬记，请输入验证码，不要点链接。</p>
  <p style="margin:0 0 16px;font-size:13px"><a href="{{ .ConfirmationURL }}" style="color:#0969da">在浏览器里登录</a></p>
  <p style="margin:0;font-size:13px;color:#656d76">如果不是你本人操作，请忽略这封邮件。不要把验证码或链接告诉任何人。</p>
</div>
{{ end }}
```

版本 A 的韩文已过审校（见上）；版本 B 不用，没有审校。样式全部写在行内，因为 Gmail、Naver、QQ 都会去掉 `<style>`；没有图片、没有外部字体，避免进垃圾箱。

---

## 六、出错时

- Resend 域名一直不是 Verified：截图 Resend 域名页和 Cloudflare DNS 页发给主持人（都不含密钥）。常见原因是名称填成了 `send.lemomemo.com`（应只填 `send`），或 DKIM 那条开了橙色云朵代理。
- Supabase 保存 SMTP 后发信失败（登录页提示发送失败，或 Authentication › Logs 里有 SMTP 报错）：截图报错。多半是密钥贴错、端口不是 465、或 Resend 域名还没 Verified。密钥贴错就回第 3 步**删掉那把、重新生成一把**再填。
- 模板保存时报 template 语法错误：多半是引号变成了中文引号，或少了 `{{ end }}`。整段重新从本文复制。
- 收到的信里验证码位置是空的：模板里写成了 `{{ .token }}`（小写），改成 `{{ .Token }}`。
- 韩文账号收到的是中文：说明这个账号的 `user_metadata.locale` 没写成 `ko-KR`（老账号、或改语言的代码还没上），不是模板的问题，告诉主持人。

## 七、剩下的风险

- 发到 Naver、QQ、163 的送达情况没有任何一家公布过，只能靠第 6 步实测。
- Resend 免费版每天 100 封，和函数、监控邮件共用；被刷时的处理见架构 12 节风险 4d。
- Resend 的日志和元数据存在美国。
- 密钥只在 Resend 创建页和 Supabase 的 SMTP 密码栏出现；丢了就删掉旧的、重新生成（R-220）。

## 来源

- Supabase：自定义 SMTP（服务商列表、默认每小时 2 封、配好后每小时 30 封）<https://supabase.com/docs/guides/auth/auth-smtp>
- Supabase：邮件模板（变量表、Go 模板条件、链接预取会用掉验证、建议关掉点击追踪）<https://supabase.com/docs/guides/auth/auth-email-templates>
- Supabase：默认发信服务的调整（模板编辑与自定义 SMTP 的关系，官方前后说法有变化，以 10-29 实测为准）<https://github.com/orgs/supabase/discussions/29370>
- Resend：定价（免费每月 3,000、每天 100、3 个域名；Pro 20 美元 5 万封）<https://resend.com/pricing>
- Resend：用 Supabase 的 SMTP（`smtp.resend.com`、465、用户名 `resend`、密码是 API 密钥）<https://resend.com/docs/send-with-supabase-smtp>
- Resend：域名（建议用子域名）<https://resend.com/docs/dashboard/domains/introduction>
- Resend：Cloudflare 的 DNS 记录（`send` 的 MX 和 TXT、`resend._domainkey`、Domain Connect）<https://resend.com/docs/dashboard/domains/cloudflare>
- Resend：发信地区（含东京；账号数据存在美国；换地区要删了重加）<https://resend.com/docs/dashboard/domains/regions>
- Resend：API 密钥（可限定域名；创建后看不到）<https://resend.com/docs/dashboard/api-keys/introduction>
- Amazon SES：定价 <https://aws.amazon.com/ses/pricing/>；沙盒与转正申请 <https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html>
- Postmark：定价 <https://postmarkapp.com/pricing>
- Brevo：免费 SMTP（每天 300 封）<https://www.brevo.com/free-smtp-server/>
- Cloudflare Email Service（Beta，任意收件人要 Workers 付费版）<https://developers.cloudflare.com/email-service/>；定价 <https://developers.cloudflare.com/email-service/platform/pricing/>
- Google 发件人指南（SPF、DKIM、DMARC）<https://support.google.com/a/answer/81126?hl=ko>
