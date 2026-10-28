# 负责人操作：给两个低权限数据库角色设密码（预览）

- 日期：2026-10-29（主持人写）
- 脚本：`tools/keys/set-fn-role-passwords.ps1`（10-29 已用假值从头跑通，19 条测试全过）
- 做完以后主持人测 B0 实测清单 P6。
- 约 5 分钟。整个过程中密码、令牌都不会显示在屏幕上，也不会存到任何文件里；丢了就重新跑一次（R-220）。

## 步骤

1. **生成临时令牌**：打开 <https://supabase.com/dashboard/account/tokens>，新建令牌：
   - 类型选项目级（Scoped），**只选 lemomemo-preview**；
   - 到期选 1 天；
   - 权限只勾这四项，其余都不给：
     - Database：Read-write
     - Connection Pooling：Read
     - Edge Function Secrets：Read-write
     - Project Settings：Read
   - 生成后点复制。不要粘贴到别的地方。
2. **完全退出 Claude**：脚本一开头会检查有没有 Claude 在运行，有就停下。
   - Claude 桌面版：右下角托盘图标右键 › 退出；
   - 如果还开着别的终端在跑 claude，也一起关掉。
   - 剪贴板历史要关着（设置 › 系统 › 剪贴板 › 剪贴板历史），脚本也会检查这一项。
3. **运行脚本**：开始菜单打开“Windows PowerShell”，粘贴下面这一行，按回车：

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\set-fn-role-passwords.ps1" -Target preview
   ```

4. 看到提示后粘贴第 1 步复制的令牌（屏幕上什么都不显示，这是正常的），按回车。等它显示 `FN_VAULT_DB_URL`、`FN_AI_DB_URL` 两行「已写入」。
5. **收尾**：
   - 关掉这个 PowerShell 窗口；
   - 回到第 1 步的令牌页，删掉这把令牌；
   - 重新打开 Claude，说一句“密码脚本跑完了”。

## 出错时

- 屏幕上的黄字、红字可以直接截图发给主持人，脚本不会打印密码和令牌。
- 如果提示「角色密码已改、secrets 未写，请立刻重跑本脚本」：重新生成一把令牌，从第 3 步再跑一次就行。
- 如果第一步就停下，说有 Claude 在运行：任务管理器里结束名字带 claude 的进程，再跑。
