// push-dispatch 只给可用账号发（TC-B1-109 的 push-dispatch 部分；架构 0.29 续第 138 条④）。
// 放在 tests/functions：要 import _shared/auth.ts（npm: 类型），tsconfig.node 不认；push-dispatch 其余用例用了 node 替身，在 tests/edge/push-dispatch.test.ts
import { describe, expect, it } from 'vitest';
import { filterUsable } from '../../supabase/functions/push-dispatch/core.ts';

// _shared/auth.ts 顶上有 `import type … from 'npm:…'`（只有 Deno 认）：路径放在变量里动态加载，tsc（tsconfig.functions、tsconfig.node）不去解析它；
// Vitest 运行时类型导入会被去掉，能直接加载（写法同 tests/functions/account-export-p0-auth.test.ts）
type IsUsable = (admin: unknown, userId: string) => Promise<{ ok: boolean }>;
const AUTH_PATH = '../../supabase/functions/_shared/auth.ts';
const { isUsable } = (await import(/* @vite-ignore */ AUTH_PATH)) as { isUsable: IsUsable };

// TC-B1-109 的 push-dispatch 部分（tests/build/fn-account-disabled-coverage.test.ts 的 PLAN 引用这两条的标题）：
// 走真的 _shared/auth.ts isUsable（index.ts 也是这样接的），数据库换成按 private.account_usable 语义回答的假客户端
type Prof = { disabled_at: string | null; disabled_reason: string | null };
function usableVia(profiles: Record<string, Prof>) {
  const one = (data: unknown) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) });
  const admin = {
    schema: () => ({
      rpc: async (_fn: string, a: { p_user: string }) => ({ data: profiles[a.p_user]?.disabled_at === null, error: null }),
      from: () => one({ purge_after: '2026-11-10T00:00:00Z' }),
    }),
    from: () => ({ select: () => ({ eq: (_c: string, u: string) => ({ maybeSingle: async () => ({ data: profiles[u] ?? null, error: null }) }) }) }),
  };
  return async (u: string) => (await isUsable(admin, u)).ok;
}

describe('TC-B1-109：push-dispatch 只给可用账号发', () => {
  it('TC-B1-109 push-dispatch：管理员停用（disabled_at 有值）的账号跳过，不发推送', async () => {
    const usable = usableVia({ ok: { disabled_at: null, disabled_reason: null }, s: { disabled_at: '2026-11-01T00:00:00Z', disabled_reason: 'admin' } });
    expect(await filterUsable(['ok', 's'], usable)).toEqual(['ok']);
  });
  it('TC-B1-109 push-dispatch：注销冷静期（disabled_reason = deletion）的账号跳过，不发推送', async () => {
    const usable = usableVia({ ok: { disabled_at: null, disabled_reason: null }, p: { disabled_at: '2026-11-02T00:00:00Z', disabled_reason: 'deletion' } });
    expect(await filterUsable(['p', 'ok'], usable)).toEqual(['ok']);
  });
});
