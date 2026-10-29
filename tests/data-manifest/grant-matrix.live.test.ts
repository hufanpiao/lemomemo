// TC-B0-89 真库版（B1 接手清单 C9：“B1 起在真库上再跑一遍”）：grant-matrix.test.ts 在 PGlite 上跑的同一套 runner，改打本机 supabase start 的库。
// 连接只取 IT_DB_URL（和 purge-runner、store-it 同名；CI 的 db 任务由 supabase status -o json 填），不是本机回环地址就拒绝；没设时整组跳过。
// 真库上 postgres 不是 fn_vault、fn_ai 的成员（PGlite 上是超级用户），runner 的 tryAs 要 set local role 过去：
//   适配层在同一个事务里先 grant 给自己（with set true, inherit false，跟着 rollback 一起撤掉），和 supabase/tests/rls/_helpers.psql 同一个做法
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReservedSql, Sql } from 'postgres';
import * as realWhitelist from '../../build/d1/whitelist.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { generateGrantMatrix, type GrantWhitelist } from './grant-matrix.ts';
import { grantProblems, RPCS_BUILT_LATER, runGrantMatrix, type GrantDb } from './grant-runner.ts';
import { isLoopback } from './live-s3.ts';

const DB_URL = process.env.IT_DB_URL;
const m = generateGrantMatrix(allManifests, realWhitelist as GrantWhitelist);
const SET_ROLE = /^begin; set local role ("(?:fn_vault|fn_ai)");$/;

describe.skipIf(!DB_URL)('授权矩阵打本机真库（TC-B0-89 / C9；没设 IT_DB_URL 时跳过）', () => {
  let sql: Sql | undefined;
  let conn: ReservedSql | undefined;
  let db: GrantDb;
  beforeAll(async () => {
    if (!isLoopback(DB_URL ?? '')) throw new Error('授权矩阵真库版：IT_DB_URL 不是本机地址，不跑');
    const { default: postgres } = await import('postgres');
    sql = postgres(DB_URL ?? '', { max: 1, onnotice: () => {} });
    conn = await sql.reserve();
    const c = conn;
    db = {
      // 不带参数走简单查询协议，一次可以执行多句（runner 的 begin; set local role …;）
      exec: async (s) => { await c.unsafe(s.replace(SET_ROLE, 'begin; grant $1 to current_user with set true, inherit false; set local role $1;')); },
      query: async <T>(s: string, p?: unknown[]) => ({ rows: [...(await c.unsafe(s, (p ?? []) as never[]))] as T[] }),
    } as GrantDb;
  }, 60_000);
  afterAll(async () => {
    conn?.release();
    await sql?.end({ timeout: 5 });
  });

  it('全部格和九个 RPC 都和期望一致；暂缺的 RPC 正好是“后面批次才建”名单里的', async () => {
    const r = await runGrantMatrix(db, m);
    expect(grantProblems(r)).toEqual([]);
    expect(r.outcomes).toHaveLength(m.cases.length);
    expect([...new Set(r.rpc.filter((x) => x.missing).map((x) => x.id.split('-')[3]))].sort()).toEqual(Object.keys(RPCS_BUILT_LATER).sort());
    // 正例真的执行成功了（适配层的 grant 生效，不是什么都 42501）
    expect(r.outcomes.find((o) => o.id === 'TC-GRANT-private.vault-fn_ai-SELECT')?.actual).toEqual(['user_id', 'pin_epoch']);
    expect(r.outcomes.find((o) => o.id === 'TC-GRANT-public.devices-authenticated-DELETE')?.actual).toEqual(['*']);
  }, 300_000);

  it('反证：给 authenticated 删 events，真库上只报一遍（C9：原来还多报一句“不该能 DELETE，实际能”）', async () => {
    const one = { ...m, cases: m.cases.filter((c) => c.relation === 'public.events'), rpcCases: [] };
    await conn?.unsafe('grant delete on public.events to authenticated');
    try {
      const ps = grantProblems(await runGrantMatrix(db, one)).filter((p) => p.startsWith('TC-GRANT-'));
      expect(ps).toEqual(['TC-GRANT-public.events-authenticated-DELETE：不该有表级 DELETE，实际有']);
    } finally {
      await conn?.unsafe('revoke delete on public.events from authenticated');
    }
    expect(grantProblems(await runGrantMatrix(db, one)).filter((p) => p.startsWith('TC-GRANT-'))).toEqual([]);
  }, 300_000);
});
