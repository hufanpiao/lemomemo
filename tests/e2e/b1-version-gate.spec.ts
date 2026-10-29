// TC-B1-63 转发层那一半：旧版本（X-App-Version 低于 app_config.min_client_version）调 /sb 上的函数。
// account 在免查名单里（shared/version-gate-list.ts，0.38 第 47 条：旧版也必须能导出、注销、恢复），转发层不挡、照转给上游；
// 名单外的函数（invite-admin）照查，本地回 426 upgrade_required，不转发。
// 跑在 wrangler pages dev + 本机假后端上（playwright.config.ts）：假 Supabase 的 app_config 回最低版本 4.0.0（tests/e2e/fake-backends.ts），
// 假上游对 /functions/v1/* 回 {forwarded: 收到的路径, secretOk: x-proxy-secret 是否等于 FAKE_PROXY_SECRET}：
// 既证明请求到了上游，也证明转发层去掉 /sb 后路径拼对了、带上了 x-proxy-secret（转发层自己回的错都是 {"code":…}）。
// 函数侧的第二道检查（account 里自己判版本）在 tests/functions/ 的单测里，这里不管。
// 完整链路（上游是 lemo-e2e 里真的 account 函数，export、delete、restore 真的办成）在 b1-version-gate.real.spec.ts（npm run e2e:real，E2E-REAL 第 6 步）。
// 只是 HTTP 请求，不分浏览器：webkit 项目跳过，免得同一件事跑两遍。
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';

const OLD = '3.9.0';

async function callFn(request: APIRequestContext, fn: string, version: string): Promise<APIResponse> {
  return request.post(`/sb/functions/v1/${fn}`, {
    headers: { 'X-App-Version': version, 'Content-Type': 'application/json' },
    data: { action: 'export' },
  });
}

test.describe('版本门：转发层（TC-B1-63）', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', '只是 HTTP 请求，chromium 项目跑一遍就够');
  });

  test('X-App-Version 3.9.0 调 POST /sb/functions/v1/account：免查，转发到假上游（路径 /functions/v1/account、带对了 x-proxy-secret），不是 426', async ({ request }) => {
    const r = await callFn(request, 'account', OLD);
    expect(r.status(), '不该被版本门挡下').not.toBe(426);
    expect(r.status()).toBe(200);
    expect(await r.json()).toEqual({ forwarded: '/functions/v1/account', secretOk: true });
  });

  test('对照：同样的请求调 POST /sb/functions/v1/invite-admin：名单外，本地回 426 upgrade_required，最低版本 4.0.0', async ({ request }) => {
    const r = await callFn(request, 'invite-admin', OLD);
    expect(r.status()).toBe(426);
    expect(await r.json()).toEqual({ code: 'upgrade_required', min: '4.0.0' });
  });

  test('对照：invite-admin 带 4.0.0 就放行、转发到假上游（路径 /functions/v1/invite-admin、带对了 x-proxy-secret；说明 426 是按版本挡的）', async ({ request }) => {
    const r = await callFn(request, 'invite-admin', '4.0.0');
    expect(r.status()).toBe(200);
    expect(await r.json()).toEqual({ forwarded: '/functions/v1/invite-admin', secretOk: true });
  });
});
