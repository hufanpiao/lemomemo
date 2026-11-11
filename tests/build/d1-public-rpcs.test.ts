// D1 第 6 节之二：public 里的 RPC（build/d1/public-rpcs.ts）。只测判定逻辑；真库上的反例是 supabase/tests/d1-fixtures/45、46（离线 PGlite 也跑）。
import { describe, expect, it } from 'vitest';
import { publicRpcProblems, type PublicFnRow } from '../../build/d1/public-rpcs.ts';
import { PUBLIC_RPCS_DEFINER } from '../../build/d1/whitelist.ts';

const row = (f: string, definer: boolean, anon = false): PublicFnRow => ({ f, definer, anon, authenticated: true, service_role: false });

describe('publicRpcProblems：security definer 只准 PUBLIC_RPCS_DEFINER 里的', () => {
  it('名单钉住：只有 session_fate（往里加要过安全审查，同时改这条）', () => {
    expect(PUBLIC_RPCS_DEFINER).toEqual(['session_fate']);
  });
  it('名单外的是 invoker、名单里的是 definer：不报', () => {
    expect(publicRpcProblems([row('report_tz', false), row('session_fate', true, true)])).toEqual([]);
  });
  it('名单外的是 definer：报', () => {
    expect(publicRpcProblems([row('report_tz', true)])).toEqual(['public.report_tz 是 security definer（只准 session_fate）']);
  });
  it('名单里的是 invoker：报', () => {
    expect(publicRpcProblems([row('session_fate', false, true)])).toEqual(['public.session_fate 在 definer 名单里，却是 invoker']);
  });
});
