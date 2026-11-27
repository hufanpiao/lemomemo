// 入口共用码（shared/schema/entry-codes.ts，接手清单 ENTRY-codes）：前端三处（邀请注册、登录页 restore、设置页 account）的映射锁在一起。
// 每个码配上它实际会带的 HTTP 状态，走三处真的映射函数；改其中一处、或共享码表加了码而某处没跟上，这里会失败。
// 放 tests/build（只有 vitest 跑）：要引 src 的前端代码（顺着引用拉进 DOM 类型），Deno 的 deno task test 只跑 tests/shared、类型过不了；
// 只引 shared 的那部分（码表、类别、isEntryErrorCode、和 ACCOUNT_ERROR_CODES 比对）在 tests/shared/entry-codes.test.ts
import { describe, expect, it } from 'vitest';
import { ENTRY_CODE_KIND, ENTRY_ERROR_CODES, type EntryErrorCode } from '../../shared/schema/entry-codes.ts';
import { RESTORE_ENTRY, restoreError } from '../../src/features/auth/data/account-gate.ts';
import { createAuthApi, INVITE_ENTRY } from '../../src/features/auth/data/auth-api.ts';
import type { Db } from '../../src/platform/supabase/client.ts';
import { ACCOUNT_ENTRY, mapAccountCode } from '../../src/features/settings/data/account-api.ts';

const STATUS: Record<EntryErrorCode, number> = {
  bad_request: 400,
  method_not_allowed: 405,
  unauthorized: 401,
  session_revoked: 401,
  upgrade_required: 426,
  misconfigured: 500,
};

const httpErr = (code: string, status: number) => ({
  name: 'FunctionsHttpError',
  context: new Response(JSON.stringify({ error: code }), { status, headers: { 'content-type': 'application/json' } }),
});

async function invite(code: string, status: number): Promise<string> {
  const db = { functions: { invoke: async () => ({ data: null, error: httpErr(code, status) }) } };
  const api = createAuthApi(async () => db as unknown as Db);
  const r = await api.inviteVerify({ email: 'n@b.co', code: 'ABCDEFGHJKLM', emailOtp: '1', locale: 'zh-CN' });
  return r.ok ? 'ok' : r.error;
}

describe('入口共用码：前端三处的映射', () => {
  it('三处的映射表都覆盖全部入口码，没有多余的键', () => {
    for (const m of [INVITE_ENTRY, RESTORE_ENTRY, ACCOUNT_ENTRY]) expect(Object.keys(m).sort()).toEqual([...ENTRY_ERROR_CODES].sort());
  });

  it('三处按真的映射函数落地：请求不对、版本门、配置错误都显示“出错”（unknown）；会话没了各走自己的“会话失效”', async () => {
    const got: Record<string, [string, string, string]> = {};
    for (const code of ENTRY_ERROR_CODES) {
      const s = STATUS[code];
      got[code] = [await invite(code, s), await restoreError(httpErr(code, s)), mapAccountCode(code, s)];
    }
    expect(got).toEqual({
      //                  邀请注册     登录页 restore      设置页 account
      bad_request: ['unknown', 'unknown', 'unknown'],
      method_not_allowed: ['unknown', 'unknown', 'unknown'],
      // invite-signup 不要会话，这两个码实际不会出现，按状态落成 unknown
      unauthorized: ['unknown', 'reauth_required', 'revoked'],
      session_revoked: ['unknown', 'reauth_required', 'revoked'],
      upgrade_required: ['unknown', 'unknown', 'unknown'],
      misconfigured: ['unknown', 'unknown', 'unknown'],
    });
    // 按类别看：除了 session_lost，其余类别三处一律 unknown
    for (const code of ENTRY_ERROR_CODES) {
      if (ENTRY_CODE_KIND[code] !== 'session_lost') expect(new Set(got[code]), code).toEqual(new Set(['unknown']));
    }
  });

  it('misconfigured 即使是 500 也不当稍后再试（三处同口径）；没有码的 500 才是稍后再试', async () => {
    expect([await invite('misconfigured', 500), await restoreError(httpErr('misconfigured', 500)), mapAccountCode('misconfigured', 500)]).toEqual([
      'unknown',
      'unknown',
      'unknown',
    ]);
    expect([await invite('', 500), await restoreError(httpErr('', 500)), mapAccountCode(null, 500)]).toEqual(['try_later', 'try_later', 'try_later']);
  });
});
