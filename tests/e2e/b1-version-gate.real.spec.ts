// TC-B1-63 完整链路（E2E-REAL 第 6 步，10-30）：低版本客户端经 /sb 调真的 account 函数——export、delete、restore 都不被 426 挡，而且真的办成了。
// 无后端组的 b1-version-gate.spec.ts 只证明转发层放行、路径和 x-proxy-secret 拼对（上游是假的）；这里上游是 lemo-e2e 的 edge runtime：
//   /sb 转发层（8789，版本门读 lemo-e2e 的 app_config.min_client_version = 4.0.0）→ kong 55321 → supabase/functions/account。
// 函数的环境变量由 tools/e2e/real-backend.mjs 写成假值（E2E_FUNCTIONS_ENV）：PROXY_SECRET 和转发层一致；
//   Resend 的密钥是假的，而且 HTTPS_PROXY 指向没人听的端口，通知信一律发不出去（函数照常走“没发出去”的分支），测试邮箱不出本机。
// 顺序：建账号 → 收码登录（loginViaOtp）→ 3.9.0 export（gzip 包，包头 user_id 是本人）→ 3.9.0 delete（{ok, purge_after}，服务器吊销全部会话）
//   → 重新收码登录（restore 要求 10 分钟内用验证码登录过）→ 3.9.0 restore（{ok}）→ status 回 active。
// 对照：名单外的 invite-admin 用 3.9.0 调，转发层本地回 426 upgrade_required（min 是 lemo-e2e 里真的 4.0.0）。
// 每条用例自己建账号，不互相依赖。
import { expect, test } from './csp-fixture.ts';
import { createAccount, fnInPage, loginViaOtp, realBackend } from './real-backend.ts';

const OLD = '3.9.0';
/**
 * 旧令牌被吊销后 account 回的错误码（10-30 实测）：account_request_deletion 删掉了这个人的全部会话，
 * requireActiveUser 里 GoTrue 的 getUser 先就认不出这个令牌 → 401 unauthorized（走不到 session_alive 那步的 session_revoked）。
 * 同一个令牌在 delete 之前调 export 是 200，所以这个 401 证明的是吊销，不是令牌本来就坏
 */
const STALE_ERROR = 'unauthorized';

/** 用 service role 查这个人的 export_mail_failed 日志（只取 act、src） */
async function mailFailedLogs(userId: string): Promise<unknown> {
  const b = realBackend();
  const r = await fetch(new URL(`/rest/v1/logs?select=act,src&user_id=eq.${userId}&act=eq.export_mail_failed`, b.api), {
    headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}` },
  });
  return r.status === 200 ? r.json() : `HTTP ${r.status}`;
}

test.describe('TC-B1-63 低版本客户端经 /sb 调 account（真函数）', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', '只是经页面发的 HTTP 请求，chromium 跑一遍就够');
  });

  test('3.9.0 依次 export、delete、restore：都不是 426，而且都办成了；恢复后 status 回 active', async ({ page }) => {
    const acc = await createAccount();
    await loginViaOtp(page, acc.email);

    const exp = await fnInPage(page, 'account', { action: 'export' }, { version: OLD });
    expect(exp.status, `export：${JSON.stringify(exp.json)}`).toBe(200);
    expect(exp.contentType).toMatch(/^application\/gzip/);
    expect(exp.exportHead).toEqual({ format: 'lemomemo-export', version: 1, user_id: acc.userId, vault: 'omitted' });
    // 通知信真的没发出去（审查建议 1 的直接证据）：account 在响应之后发信，失败就往 public.logs 记一条 act = export_mail_failed
    //   （supabase/functions/account/core.ts 的 exportData ⑤）。发信是后台做的，轮询等它落库
    await expect.poll(() => mailFailedLogs(acc.userId), { timeout: 15_000 }).toEqual([{ act: 'export_mail_failed', src: 'account' }]);

    const del = await fnInPage(page, 'account', { action: 'delete', confirm: '注销' }, { version: OLD });
    expect(del.status, `delete：${JSON.stringify(del.json)}`).toBe(200);
    expect(del.json).toEqual({ ok: true, purge_after: expect.any(String) });

    // delete 吊销了全部会话（审查建议 3）：旧令牌再调 status，函数回 401
    const stale = await fnInPage(page, 'account', { action: 'status' }, { version: OLD });
    expect(stale.status).toBe(401);
    expect(stale.json).toEqual({ error: STALE_ERROR });

    // 重新收码登录（amr 里有新鲜的 otp）；status 回 pending_deletion 证明服务器上真进了冷静期，再恢复
    await loginViaOtp(page, acc.email);
    const st = await fnInPage(page, 'account', { action: 'status' }, { version: OLD });
    expect(st.json).toEqual({ ok: true, status: 'pending_deletion', purge_after: expect.any(String) });

    const res = await fnInPage(page, 'account', { action: 'restore' }, { version: OLD });
    expect(res.status, `restore：${JSON.stringify(res.json)}`).toBe(200);
    expect(res.json).toEqual({ ok: true });

    const after = await fnInPage(page, 'account', { action: 'status' }, { version: OLD });
    expect(after.json).toEqual({ ok: true, status: 'active' });
  });

  test('对照：名单外的 invite-admin 用 3.9.0 调，转发层本地回 426 upgrade_required（最低版本取自 lemo-e2e 的 app_config）', async ({ page }) => {
    const acc = await createAccount();
    await loginViaOtp(page, acc.email);
    const r = await fnInPage(page, 'invite-admin', { action: 'list' }, { version: OLD });
    expect(r.status).toBe(426);
    expect(r.json).toEqual({ code: 'upgrade_required', min: '4.0.0' });
  });
});
