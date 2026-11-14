// 后端安全审查第 2 条：invite-signup、invite-admin、account、token-admin 读请求体要边读边计字节（_shared/body.ts 的 readJsonCapped），
// 超过上限立刻中断，不能整段读进内存再比长度。请求体用不带 Content-Length 的流（只看声明长度的拦不住），一直给数据：
// 读到的字节数必须停在上限附近，回 400 bad_request（错误码和原来一样）。
import { describe, expect, it } from 'vitest';
import { handle as accountHandle, type Deps as AccountDeps } from '../../supabase/functions/account/core.ts';
import { handle as inviteAdminHandle } from '../../supabase/functions/invite-admin/core.ts';
import { handle as signupHandle } from '../../supabase/functions/invite-signup/core.ts';
import { handle as tokenAdminHandle, type Deps as TokenDeps } from '../../supabase/functions/token-admin/core.ts';
import { deps as inviteAdminDeps, FakeStore as InviteAdminStore } from './invite-admin-fakes.ts';
import { viaProxy, world } from './invite-signup-harness.ts';

const CHUNK = 16 * 1024;
const TOTAL = 4 * 1024 * 1024;

/** 不带 Content-Length 的流式请求体：开头是一段合法 JSON 的前缀，后面一直是空格，最多给 TOTAL 字节；pulled 记已经被读走的字节数 */
function streamReq(url: string, headers: Record<string, string> = {}) {
  const box = { pulled: 0 };
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (box.pulled >= TOTAL) { c.close(); return; }
      const chunk = box.pulled === 0 ? enc.encode('{"action":"create","x":"'.padEnd(CHUNK, ' ')) : enc.encode(' '.repeat(CHUNK));
      box.pulled += chunk.byteLength;
      c.enqueue(chunk);
    },
  });
  const req = new Request(url, { method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json', ...headers }, body, duplex: 'half' } as RequestInit);
  return { req, box };
}

async function expectCapped(res: Response, box: { pulled: number }) {
  expect([res.status, await res.json()]).toEqual([400, { error: 'bad_request' }]);
  expect(box.pulled).toBeLessThanOrEqual(64 * 1024);   // 上限 2～4 KB，读到第一块超了就停；整段读完是 4 MB
}

describe('请求体边读边计字节（安全审查第 2 条）', () => {
  it('account：超长请求体读到上限就中断，回 400 bad_request', async () => {
    const { req, box } = streamReq('https://x/functions/v1/account');
    await expectCapped(await accountHandle(req, {} as AccountDeps), box);
  });

  it('token-admin：鉴权之后读请求体，超长就中断，回 400 bad_request', async () => {
    const { req, box } = streamReq('https://x/functions/v1/token-admin');
    const deps: TokenDeps = {
      authenticate: async () => ({ ok: true, user: { userId: 'aaaaaaaa-0000-4000-8000-000000000001', sessionId: 's', jwt: 'j' } }),
      store: {} as TokenDeps['store'],
      now: () => 0,
      log: () => {},
    };
    await expectCapped(await tokenAdminHandle(req, deps), box);
  });

  it('invite-admin：管理员、版本门之后读请求体，超长就中断，回 400 bad_request', async () => {
    const { req, box } = streamReq('https://x/functions/v1/invite-admin');
    await expectCapped(await inviteAdminHandle(req, inviteAdminDeps(new InviteAdminStore())), box);
  });

  it('invite-signup：超长请求体读到上限就中断，回 400 bad_request', async () => {
    const w = await world();
    const { req, box } = streamReq('https://x/functions/v1/invite-signup', viaProxy('203.0.113.7'));
    await expectCapped(await signupHandle(req, w.deps), box);
  });
});
