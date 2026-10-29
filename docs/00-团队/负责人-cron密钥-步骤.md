# 负责人操作：设 CRON_SECRET（pg_cron 调函数用的密钥）

- 日期：2026-10-29（QA 兼后端写；同日按 R-228 改成“值在数据库里生成”）
- 依据：架构 0.38 第 46 条、第 6 节“pg_cron 怎么带 CRON_SECRET 调函数”、8.4；R-228（负责人定方案 A）
- 脚本：`tools/keys/set-cron-secret.ps1`（10-29 已用本机假服务从头跑通；脚本发出的两段 SQL 也在本机数据库上真跑过）
- 预览、正式**各做一次**，两次的值不一样。先做预览。
- 每次约 3 分钟。你只需要做三件事：生成令牌、运行脚本、粘贴令牌。密钥和令牌都不会显示在屏幕上，也不会存到任何文件、不经过剪贴板；丢了就重新跑一次（R-220），两边会一起换。
- 这把密钥要在两个地方各存一份，值必须相同，脚本一次全做完：
  - 数据库那边：Vault 里的 `cron_secret`（值在数据库里生成）和 `functions_url`；
  - 函数那边：Edge Function Secrets 里的 `CRON_SECRET`（脚本从数据库读回来写进去）。

## 步骤

1. **生成临时令牌**：打开 <https://supabase.com/dashboard/account/tokens>，新建令牌：
   - 类型选项目级（Scoped），**只选这一个项目**：预览选 lemomemo-preview，正式选 lemomemo-prod；
   - 到期选 1 天；
   - 权限只勾这三项，其余都不给：
     - Database：Read-write（在数据库里生成值、写进 Vault、读回来）
     - Edge Function Secrets：Read-write（写 CRON_SECRET，并核对写进去了）
     - Project Settings：Read（核对项目名，防止贴错环境）
   - 生成后点复制。不要粘贴到别的地方。
   - 这三项权限的名字和脚本用的接口是照 Supabase 官方文档写的，**没有在真实的令牌页面和真实项目上核对过**。第一次跑预览时如果页面上的写法不一样，或者脚本报 HTTP 401、403，截图发给主持人。
2. **确认剪贴板历史是关着的**：设置 › 系统 › 剪贴板 › 剪贴板历史。脚本会检查这一项（粘贴令牌要经过剪贴板）。不用退出 Claude（10-29 负责人定，R-223）。
   剪贴板管理软件、远程桌面、手机连接（Phone Link 的跨设备剪贴板）也会读剪贴板，脚本查不出来，运行前请先关掉。
3. **运行脚本**：开始菜单打开“Windows PowerShell”，粘贴下面这一行，按回车（正式那次把最后的 `preview` 改成 `prod`）：

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\set-cron-secret.ps1" -Target preview
   ```

4. 看到提示后粘贴第 1 步复制的令牌（屏幕上什么都不显示，这是正常的），按回车。等它显示「已写入 CRON_SECRET；原有的 … 个 secrets 都在」和「全部写好」。
5. **收尾（马上做，先删令牌再关窗口）**：
   - **先回到第 1 步的令牌页，删掉这把令牌**。这把令牌带 Database 读写，约等于整个数据库的最高权限，跑完就删，不要等 1 天到期；
   - 再关掉这个 PowerShell 窗口；
   - 回到 Claude 说一句“预览（或正式）的 CRON_SECRET 设好了”。

## 出错时

- 屏幕上的黄字、红字可以直接截图发给主持人，脚本不会打印密钥和令牌。
- 如果提示「数据库 Vault 的 cron_secret 已换、函数侧的 CRON_SECRET 还没换好，请立刻重跑本脚本」：说明数据库那边已经换成新值，函数那边还是旧的（或者没有），cron 调函数会被拒掉。没有安全问题，只是定时任务停摆。重新生成一把令牌，从第 3 步再跑一次就行，两边会一起换成新值。
- 提示 `schema "vault" does not exist` 之类的数据库报错：截图发给主持人。

## 剩下的风险

- 临时令牌带 Database 读写，约等于整个数据库的最高权限。它在你删掉之前一直有效，所以第 5 步要跑完马上删，删令牌放在关窗口之前。
- 仅就我们这一侧而言，密钥的值只在两个地方出现：从数据库读回来的那个 HTTPS 响应里一次，写进函数 secrets 的那个 HTTPS 请求里一次。Supabase 平台那一侧是否记录请求、响应的正文，我们控制不了。
- 值在脚本的内存里只短暂存在，用完马上清掉。PowerShell 没法把内存逐字节清零，所以最后要关掉窗口。
- 发给数据库的 SQL 里没有值（值是数据库自己生成的），所以数据库的查询日志、查询统计里只会留下这段不含值的文字。

## 本机（不用你做）

本机开发用的是固定假值：`supabase/seed.sql` 把 `cron_secret`、`functions_url` 写进本机的 Vault，`supabase/functions/.env.example` 里的 `CRON_SECRET` 和它相同。`supabase db reset` 会自动写好，和预览、正式无关。
