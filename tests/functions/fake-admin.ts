// 记调用的假 supabase-js 客户端（服务器函数 store.ts 的查询写法测试共用：push-dispatch-store、anniv-roll-store）：
// from / rpc / schema().from 起头的链式调用全部记下，await 时回 result
export type Call = [string, ...unknown[]];

/** 链式调用全部记下；await 时回 result */
export function fakeAdmin(result: { data: unknown; error: unknown } = { data: [], error: null }) {
  const chains: Call[][] = [];
  const chain = (first: Call) => {
    const calls: Call[] = [first];
    chains.push(calls);
    const p: Record<string, unknown> = new Proxy({}, {
      get(_t, k) {
        if (k === 'then') return (ok: (v: unknown) => void) => ok(result);
        return (...a: unknown[]) => {
          calls.push([String(k), ...a]);
          return p;
        };
      },
    });
    return p;
  };
  const admin = {
    from: (t: string) => chain(['from', t]),
    rpc: (f: string, a: unknown) => chain(['rpc', f, a]),
    schema: (s: string) => ({ from: (t: string) => chain(['from', `${s}.${t}`]), rpc: (f: string, a: unknown) => chain(['rpc', `${s}.${f}`, a]) }),
  };
  return { admin, chains };
}
