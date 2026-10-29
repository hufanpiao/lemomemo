// requireActiveUser、isUsable 的离线检查：用假的 supabase-js 客户端走一遍各分支（真 Auth、真库待 Docker）
// 由 run.mjs 的 fn 阶段调用（Node），tests/shared/auth.test.mjs 用 Deno 再跑一遍；返回失败说明的数组
// Buffer 从 node:buffer 取：Deno 下也能跑
import { Buffer } from 'node:buffer';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const S = 'aaaaaaaa-5555-4000-8000-000000000001';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtOf = (c) => `x.${b64u(c)}.sig`;

// 假客户端：rpc、from(...).select().eq().maybeSingle()、auth.getUser 都按 cfg 返回
function fake(cfg) {
  const q = (table) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => cfg.tables?.[table] ?? { data: null, error: null } }) }) });
  const rpc = async (fn) => (cfg.rpcHang?.includes(fn) ? new Promise(() => {}) : cfg.rpc?.[fn] ?? { data: null, error: { message: 'x' } });
  return {
    auth: { getUser: async () => cfg.user ?? { data: { user: { id: A } }, error: null } },
    schema: () => ({ rpc, from: q }),
    from: q,
  };
}
const req = (jwt) => new Request('http://x', { headers: jwt ? { authorization: `Bearer ${jwt}` } : {} });
const good = { rpc: { account_usable: { data: true, error: null }, session_alive: { data: true, error: null } } };

export async function checkAuth() {
  const { requireActiveUser, isUsable } = await import('../../functions/_shared/auth.ts');
  const fails = [];
  const expect = async (what, p, want) => {
    try { const r = await p; if (want !== 'ok') fails.push(`${what}：应为 ${want}，实际放行`); else if (r.userId !== A || r.sessionId !== S) fails.push(`${what}：返回值不对`); }
    catch (e) { if (e.code !== want) fails.push(`${what}：应为 ${want}，实际 ${e.code ?? e.message}`); }
  };
  const tok = jwtOf({ sub: A, session_id: S });
  await expect('正常', requireActiveUser(req(tok), fake(good)), 'ok');
  await expect('没带 JWT', requireActiveUser(req(null), fake(good)), 'unauthorized');
  await expect('JWT 无效', requireActiveUser(req(tok), fake({ ...good, user: { data: { user: null }, error: { status: 401 } } })), 'unauthorized');
  await expect('Auth 服务出错', requireActiveUser(req(tok), fake({ ...good, user: { data: { user: null }, error: { status: 502 } } })), 'try_later');
  // supabase-js 2.118：fetch 失败报 AuthRetryableFetchError、status 0（B0 集成升版后复查补的两条）
  await expect('Auth 连不上（status 0）', requireActiveUser(req(tok), fake({ ...good, user: { data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 0 } } })), 'try_later');
  await expect('Auth 限流（429）', requireActiveUser(req(tok), fake({ ...good, user: { data: { user: null }, error: { status: 429 } } })), 'try_later');
  await expect('JWT 没有 session_id', requireActiveUser(req(jwtOf({ sub: A })), fake(good)), 'unauthorized');
  const off = (reason, pd) => fake({ rpc: { ...good.rpc, account_usable: { data: false, error: null } },
    tables: { profiles: { data: reason ? { disabled_reason: reason } : null, error: null }, pending_deletions: { data: pd, error: null } } });
  await expect('管理员停用', requireActiveUser(req(tok), off('admin')), 'account_disabled');
  await expect('没有 profile', requireActiveUser(req(tok), off(null)), 'account_disabled');
  await expect('注销冷静期', requireActiveUser(req(tok), off('deletion', { purge_after: '2026-11-27T00:00:00Z' })), 'account_pending_deletion');
  await expect('冷静期 restore 放行', requireActiveUser(req(tok), off('deletion', { purge_after: 'x' }), { allowPendingDeletion: true }), 'ok');
  await expect('会话被吊销', requireActiveUser(req(tok), fake({ rpc: { ...good.rpc, session_alive: { data: false, error: null } } })), 'session_revoked');
  await expect('session_alive 出错', requireActiveUser(req(tok), fake({ rpc: { account_usable: good.rpc.account_usable } })), 'try_later');
  await expect('session_alive 超时', requireActiveUser(req(tok), fake({ ...good, rpcHang: ['session_alive'] })), 'try_later');
  await expect('account_usable 出错', requireActiveUser(req(tok), fake({ rpc: { session_alive: good.rpc.session_alive } })), 'try_later');
  // TC-B1-111（架构 0.36 第 1 条 ②、0.38）：amr 里有 password、或有 amr 却不是数组，回 401 unauthorized；没有 amr、otp、magiclink、recovery 照常
  const at = (amr) => jwtOf({ sub: A, session_id: S, amr });
  const ts = 1761700000;
  await expect('密码会话', requireActiveUser(req(at([{ method: 'password', timestamp: ts }])), fake(good)), 'unauthorized');
  await expect('刷新后的密码会话（iat 新、amr 沿用）', requireActiveUser(req(jwtOf({ sub: A, session_id: S, iat: ts + 3600, amr: [{ method: 'password', timestamp: ts }] })), fake(good)), 'unauthorized');
  await expect('密码和验证码都有', requireActiveUser(req(at([{ method: 'otp', timestamp: ts }, { method: 'password', timestamp: ts }])), fake(good)), 'unauthorized');
  // 先于查库：数据库出错时也回 unauthorized，不是 try_later
  await expect('密码会话、数据库出错', requireActiveUser(req(at([{ method: 'password', timestamp: ts }])), fake({})), 'unauthorized');
  await expect('验证码会话', requireActiveUser(req(at([{ method: 'otp', timestamp: ts }])), fake(good)), 'ok');
  await expect('magiclink 会话', requireActiveUser(req(at([{ method: 'magiclink', timestamp: ts }])), fake(good)), 'ok');
  await expect('recovery 会话', requireActiveUser(req(at([{ method: 'recovery', timestamp: ts }])), fake(good)), 'ok');
  await expect('amr 不是数组（字符串标量）', requireActiveUser(req(at('otp')), fake(good)), 'unauthorized');
  await expect('amr 是对象（不是数组）', requireActiveUser(req(at({ method: 'otp' })), fake(good)), 'unauthorized');
  await expect('amr 是字符串数组 ["password"]', requireActiveUser(req(at(['password'])), fake(good)), 'unauthorized');
  await expect('字符串和对象混合', requireActiveUser(req(at(['otp', { method: 'password', timestamp: ts }])), fake(good)), 'unauthorized');
  await expect('对象 otp 和字符串 password 混合', requireActiveUser(req(at([{ method: 'otp', timestamp: ts }, 'password'])), fake(good)), 'unauthorized');
  await expect('amr 是字符串数组 ["otp"]', requireActiveUser(req(at(['otp'])), fake(good)), 'ok');
  await expect('amr 是 null（有键、不是数组）', requireActiveUser(req(at(null)), fake(good)), 'unauthorized');
  // account 的 status 靠 pendingDeletion 分出正常和冷静期：正常账号没有这个键，冷静期放行时带 purge_after
  try {
    const r = await requireActiveUser(req(tok), fake(good));
    if (Object.hasOwn(r, 'pendingDeletion')) fails.push('正常账号：不应带 pendingDeletion');
    const p = await requireActiveUser(req(tok), off('deletion', { purge_after: 'P' }), { allowPendingDeletion: true });
    if (p.pendingDeletion?.purgeAfter !== 'P') fails.push('冷静期放行：pendingDeletion.purgeAfter 应为 P');
    const q = await requireActiveUser(req(tok), off('deletion', null), { allowPendingDeletion: true });
    if (q.pendingDeletion?.purgeAfter !== null) fails.push('冷静期放行、没有 pending_deletions 行：purgeAfter 应为 null');
  } catch (e) { fails.push(`pendingDeletion：${e.code ?? e.message}`); }
  try {
    const u = await isUsable(off('deletion', { purge_after: 'P' }), A);
    if (u.ok || u.code !== 'account_pending_deletion' || u.purgeAfter !== 'P') fails.push('isUsable 冷静期：没带 purge_after');
  } catch (e) { fails.push(`isUsable 冷静期：${e.message}`); }
  return { n: 33, fails };
}
