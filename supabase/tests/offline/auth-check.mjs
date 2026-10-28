// requireActiveUser、isUsable 的离线检查：用假的 supabase-js 客户端走一遍各分支（真 Auth、真库待 Docker）
// 由 run.mjs 的 fn 阶段调用，返回失败说明的数组
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
  try {
    const u = await isUsable(off('deletion', { purge_after: 'P' }), A);
    if (u.ok || u.code !== 'account_pending_deletion' || u.purgeAfter !== 'P') fails.push('isUsable 冷静期：没带 purge_after');
  } catch (e) { fails.push(`isUsable 冷静期：${e.message}`); }
  return { n: 16, fails };
}
