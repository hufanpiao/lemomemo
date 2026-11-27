// D1 第 6 节之二：public 里的 RPC（架构 3.3 D）。从 checks.ts 拆出来（R-382，checks.ts 超过 300 行），判定不变。
// 只准 PUBLIC_RPCS 里的 11 个；除 PUBLIC_RPCS_DEFINER 外一律 security invoker；不给 service_role；anon 只准 PUBLIC_RPCS_ANON（R-382 的 session_fate）；都要给 authenticated。
import { PUBLIC_RPCS, PUBLIC_RPCS_ANON, PUBLIC_RPCS_DEFINER } from './whitelist.ts';

/** checks.ts 第 6 节查出的函数行里，这里用到的几列 */
export type PublicFnRow = { f: string; definer: boolean; anon: boolean; authenticated: boolean; service_role: boolean };

/** public 里每个函数各查一遍，问题逐条返回（空 = 通过） */
export function publicRpcProblems(fns: readonly PublicFnRow[]): string[] {
  const out: string[] = [];
  for (const f of fns) {
    if (!PUBLIC_RPCS.includes(f.f)) out.push(`public.${f.f} 不在 3.3 D 的 11 个 RPC 里`);
    if (f.definer !== PUBLIC_RPCS_DEFINER.includes(f.f)) out.push(f.definer ? `public.${f.f} 是 security definer（只准 ${PUBLIC_RPCS_DEFINER.join('、')}）` : `public.${f.f} 在 definer 名单里，却是 invoker`);
    if (f.service_role) out.push(`public.${f.f} 给了 service_role 执行权`);
    if (f.anon !== PUBLIC_RPCS_ANON.includes(f.f)) out.push(f.anon ? `public.${f.f} 给了 anon 执行权（anon 只准 ${PUBLIC_RPCS_ANON.join('、')}）` : `public.${f.f} 在 anon 名单里，却没给 anon 执行权`);
    if (!f.authenticated) out.push(`public.${f.f} 没给 authenticated 执行权`);
  }
  return out;
}
