// 函数侧版本门 ③ 低版本客户端逐个函数之 invite-admin（从 fn-version-gate.test.ts 拆出，那份行数已满）：
// 版本门在 core.ts 里（鉴权、管理员之后），直接调它的 handle；读配置经 minClientVersion 的缓存（0.38 第 52 条）。
import { describe, expect, it, vi } from 'vitest';
import { createFnVersionGate, type LoadMin } from '../../supabase/functions/_shared/version-gate-core.ts';
import { FUNCTION_VERSION_EXEMPTIONS, isFunctionExempt } from '../../shared/version-gate-list.ts';
import { needsVersionCheck } from '../../functions/sb/version-gate.ts';
import { handle as inviteAdminHandle, type Deps as InviteAdminDeps } from '../../supabase/functions/invite-admin/core.ts';

const MIN = '4.1.0';
const OLD = '4.0.9';
const NEW = '4.1.0';

function req(fn: string, method: string, version: string | null, extra: Record<string, string> = {}, body: unknown = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json', ...extra });
  if (version !== null) headers.set('x-app-version', version);
  return new Request(`https://x.supabase.co/functions/v1/${fn}`, { method, headers, body: JSON.stringify(body) });
}

const gate = () => createFnVersionGate({ exemptions: FUNCTION_VERSION_EXEMPTIONS });

describe('invite-admin（要查；版本门在 core.ts 的鉴权、管理员之后）', () => {
  const ADMIN = 'aaaaaaaa-0000-4000-8000-0000000000ad';
  function deps(min: string | null, load?: () => Promise<string | null>): InviteAdminDeps & { inserted: number } {
    const d: InviteAdminDeps & { inserted: number } = {
      inserted: 0,
      authenticate: async () => ({ ok: true, user: { userId: ADMIN, sessionId: 's1', jwt: 'jwt' } }),
      store: {
        isAdmin: async () => true,
        takeRate: async () => true,
        insertInvite: async () => { d.inserted++; return 'ok'; },
        listInvites: async () => [],
        minClientVersion: load ?? (async () => min),
      },
      now: () => Date.parse('2026-10-29T12:00:00Z'),
    };
    return d;
  }
  const auth = { authorization: 'Bearer x' };

  it('旧版本、没带版本头：create、list 都回 426，不写库', async () => {
    for (const v of [OLD, null]) {
      for (const body of [{ action: 'create', note: '10-29' }, { action: 'list' }]) {
        const d = deps(MIN);
        const res = await inviteAdminHandle(req('invite-admin', 'POST', v, auth, body), d);
        expect(res.status, `${String(v)} ${body.action}`).toBe(426);
        expect(await res.json()).toEqual({ code: 'upgrade_required', min: MIN });
        expect(d.inserted).toBe(0);
      }
    }
  });

  it('经 minClientVersion 缓存读：读到 min 后旧版本 426、新版本照常发码，60 秒内不再读', async () => {
    const g = gate();
    const load = vi.fn<LoadMin>(async () => MIN);
    const d = deps(null, () => g.minClientVersion(load));
    expect((await inviteAdminHandle(req('invite-admin', 'POST', OLD, auth, { action: 'create' }), d)).status).toBe(426);
    expect((await inviteAdminHandle(req('invite-admin', 'POST', NEW, auth, { action: 'create' }), d)).status).toBe(200);
    expect(d.inserted).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('新版本：照常处理（create 200、list 200）；和转发层结论一致（不在免查名单）', async () => {
    expect((await inviteAdminHandle(req('invite-admin', 'POST', NEW, auth, { action: 'create' }), deps(MIN))).status).toBe(200);
    expect((await inviteAdminHandle(req('invite-admin', 'POST', NEW, auth, { action: 'list' }), deps(MIN))).status).toBe(200);
    expect(isFunctionExempt(FUNCTION_VERSION_EXEMPTIONS, 'invite-admin', 'POST')).toBe(false);
    expect(needsVersionCheck('POST', '/functions/v1/invite-admin')).toBe(true);
  });
});
