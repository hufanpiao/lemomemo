// B1 K6：换账号清本机（架构 4.1、0.38 第 17 条）的端到端，先用 test.fixme 占位
// 架构原文的 E2E：A 登录有数据 → 打开 /app/auth/ 以 B 登录 → 回 /app/ 看不到 A 的任何一行、A 的 outbox 没发到服务器。
// 为什么还不能跑：
//   ① 要真登录两个账号：e2e 的 /sb 现在接假后端（playwright.config 的 SUPABASE_UPSTREAM），不发验证码、没有 RLS；
//      要 /sb 接本地 Supabase ＋ Mailpit（和 b1-login-ua.spec.ts 的 TC-B1-16、17 同一个前提）；
//   ② “A 有数据、有没发的 outbox”要 K8（同步）把队列发出去，K8 还没接；
// 单元测试已覆盖四个判断时机和清库内容：src/core/__tests__/account.test.ts、boot.test.ts，src/platform/__tests__/session.test.ts。
// 能跑以后的步骤（照写成断言）：
//   1. A 登录，回 /app/，新记 2 条（断网，让它们留在 outbox）；
//   2. 打开 /app/auth/，“换账号”，以 B 登录，回 /app/（联网）；
//   3. 页面里看不到 A 的任何一行；IndexedDB planner-v4 里没有 A 的行、outbox 为空、meta.user_id = B；Cache Storage 已清；
//   4. 服务器上（以 A 查）没有那 2 条：A 的 outbox 没发出去；
//   5. 另开一个标签页停在 /app/（A 的会话），在第一个标签页换成 B：第二个标签页收到 storage 事件后清库并重新载入。
import { test } from './csp-fixture.ts';

test.describe('换账号清本机（架构 4.1、0.38 第 17 条）', () => {
  test.fixme('A 登录有数据 → /app/auth/ 换成 B → 回 /app/ 看不到 A 的任何一行、A 的 outbox 没发到服务器【需真后端（/sb 接本地 Supabase ＋ Mailpit）和 K8 同步】', async () => {
    // 见文件头的步骤
  });

  test.fixme('别的标签页换了账号：本页收到 storage 事件后清库并重新载入【需真后端和 K8 同步】', async () => {
    // 见文件头第 5 步
  });
});
