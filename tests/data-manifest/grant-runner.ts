// 执行“表 × 角色 × 操作”用例（TC-B0-89；生成器见 grant-matrix.ts）。数据库由调用方传入：离线是 PGlite + 全部迁移（grant-matrix.test.ts），
// CI 可以接本地 Supabase（同一个 { exec, query } 接口）。
//
// 做法：每格先用 has_table_privilege / has_column_privilege 算出能用的列，和期望逐项比；再以那个角色真的执行来印证授权表——
// 能用的列逐列执行（必须成功），不能用的执行一句（必须是 SQLSTATE 42501）。执行时在事务里 `set local role <角色>`，语句都**不动数据**，别的错误直接报：
//   SELECT  select <列> from <表> limit 0
//   INSERT  insert into <表> (<列>) select null where false
//   UPDATE  update <表> set <列> = default where false
//   DELETE  delete from <表> where false（不按列）
// 权限在执行器启动时检查，和有没有行无关；零行也就不会碰到 RLS 的 with check（它也回 42501，会和“没授权”混在一起）。
// 视图（scan_）只看授权表，不执行（视图上的写会先报“不能写视图”）。
// 表级另判一次：期望 all 的格 has_table_privilege 必须为真，期望列名单或 none 的格必须为假（列全给了不等于表级给了）。

import { GRANT_ROLES, type GrantCase, type GrantMatrix, type GrantOp, type RpcCase } from './grant-matrix.ts';

export interface GrantDb {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface GrantOutcome {
  id: string;
  ok: boolean;
  problems: string[];
  /** 实际能用的列（DELETE 和表级的写成 ['*']） */
  actual: string[];
}

export interface GrantRunResult {
  outcomes: GrantOutcome[];
  rpc: { id: string; ok: boolean; problem?: string; missing?: boolean }[];
  /** 双向比对：数据库里有、生成器没覆盖的关系；生成器有、数据库里没有的关系 */
  extraRelations: string[];
  missingRelations: string[];
  /** public 里不在 PUBLIC_RPCS 的函数 */
  extraRpcs: string[];
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const rel = (r: string) => r.split('.').map(q).join('.');

function sqlState(e: unknown): string {
  const o = e as { code?: unknown; sqlState?: unknown } | null;
  return typeof o?.code === 'string' ? o.code : typeof o?.sqlState === 'string' ? o.sqlState : '';
}

function statement(c: GrantCase, col: string | null): string {
  const r = rel(c.relation);
  switch (c.op) {
    case 'SELECT':
      return `select ${q(col ?? '')} from ${r} limit 0`;
    case 'INSERT':
      return `insert into ${r} (${q(col ?? '')}) select null where false`;
    case 'UPDATE':
      return `update ${r} set ${q(col ?? '')} = default where false`;
    case 'DELETE':
      return `delete from ${r} where false`;
  }
}

/** 以 role 执行一句：true 行，false 被拒（42501）；别的错误抛出 */
async function tryAs(db: GrantDb, role: string, sql: string): Promise<boolean> {
  await db.exec(`begin; set local role ${q(role)};`);
  try {
    await db.exec(sql);
    return true;
  } catch (e) {
    if (sqlState(e) === '42501') return false;
    throw new Error(`${role} 执行“${sql}”出了别的错：${sqlState(e) || '?'} ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await db.exec('rollback');
  }
}

async function columnsOf(db: GrantDb, relation: string): Promise<string[]> {
  const [s, t] = relation.split('.');
  const r = await db.query<{ c: string }>(
    `select column_name as c from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position`,
    [s, t],
  );
  return r.rows.map((x) => x.c);
}

async function tableLevel(db: GrantDb, role: string, relation: string, op: GrantOp): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(`select has_table_privilege($1, $2, $3) as ok`, [role, relation, op]);
  return r.rows[0]?.ok === true;
}

async function columnLevel(db: GrantDb, role: string, relation: string, col: string, op: GrantOp): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(`select has_column_privilege($1, $2, $3, $4) as ok`, [role, relation, col, op]);
  return r.rows[0]?.ok === true;
}

/**
 * 一格：先用 has_*_privilege 算出能用的列，再真的执行——能用的列逐列执行（必须成功），不能用的执行一句（必须 42501）。
 * 不能用的只执行一句：PGlite 每抛一次错会漏一点栈，同一个实例上约 1500 次就报 stack depth（2026-10-28 实测），逐列执行会撑爆。
 */
async function runOne(db: GrantDb, c: GrantCase, cols: readonly string[]): Promise<GrantOutcome> {
  const problems: string[] = [];
  const table = await tableLevel(db, c.role, c.relation, c.op);
  const exec = c.kind === 'table';
  const confirm = async (col: string | null, catalog: boolean) => {
    const ran = await tryAs(db, c.role, statement(c, col));
    if (ran !== catalog) problems.push(`${col ?? c.op}：执行结果（${ran ? '成功' : '42501'}）和授权表（${catalog ? '有' : '没有'}）不一致`);
  };
  let actual: string[];
  if (c.op === 'DELETE') {
    if (exec) await confirm(null, table);
    actual = table ? ['*'] : [];
  } else {
    actual = [];
    let deniedOne: string | null = null;
    for (const col of cols) {
      if (await columnLevel(db, c.role, c.relation, col, c.op)) {
        actual.push(col);
        if (exec) await confirm(col, true);
      } else {
        deniedOne ??= col;
      }
    }
    if (exec && deniedOne) await confirm(deniedOne, false);
  }
  const wantAll = c.expect === 'all';
  if (wantAll !== table) problems.push(wantAll ? `应有表级 ${c.op}，实际没有` : `不该有表级 ${c.op}，实际有`);
  if (c.op !== 'DELETE') {
    const want = c.expect === 'all' ? [...cols] : c.expect === 'none' ? [] : [...c.expect];
    for (const w of want) if (!cols.includes(w)) problems.push(`期望的列 ${w} 在 ${c.relation} 里不存在`);
    const extra = actual.filter((x) => !want.includes(x));
    const missing = want.filter((x) => cols.includes(x) && !actual.includes(x));
    if (extra.length) problems.push(`多给了：${extra.join('、')}`);
    if (missing.length) problems.push(`少给了：${missing.join('、')}`);
    if (table && c.expect !== 'all') actual = ['*'];
  }
  // DELETE 不按列，actual 就是表级结果：表级有无上面已比过一次，这里不再另报“不该能 DELETE”（B1 接手清单 C9：原来同一处报两遍）
  return { id: c.id, ok: problems.length === 0, problems, actual };
}

/**
 * 还没建、按计划在后面批次新迁移里才建的 public RPC（架构设计-v4 0.31 第 23 条确认改标注、0.33 第 3 条；
 * B0 批次的迁移建了 record_consent、purge_deleted（0001）和 files_authorize（0004）；
 * B1 迁移 20261029192000_core_devices_sessions.sql 建了 report_tz、remove_device、my_sessions，20261029200000_core_apply_patch.sql 建了 apply_patch）。
 * 只有这里列出的没建算正常；九个里别的没建一律报错。哪一个建好了就从这里删掉。
 */
export const RPCS_BUILT_LATER: Readonly<Record<string, 'B1' | 'B2' | 'B3'>> = {
  claim_endpoint: 'B2', // B2 新迁移，配 private.claim_endpoint_impl（0.31 第 23 条）
  my_ai_usage: 'B3', // B3 新迁移，配 private.my_ai_usage_impl（0.31 第 23 条）
};

async function runRpc(db: GrantDb, c: RpcCase): Promise<GrantRunResult['rpc'][number]> {
  const fns = await db.query<{ ok: boolean }>(
    `select has_function_privilege($1, p.oid, 'EXECUTE') as ok from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $2`,
    [c.role, c.fn],
  );
  if (fns.rows.length === 0) {
    const later = Object.hasOwn(RPCS_BUILT_LATER, c.fn) ? RPCS_BUILT_LATER[c.fn] : undefined;
    // 名单里的（B1～B3 才建）没建不算“少”；名单外的没建就是少了
    return later ? { id: c.id, ok: true, missing: true } : { id: c.id, ok: false, missing: true, problem: `数据库里没有 public.${c.fn}（不在后面批次才建的名单里）` };
  }
  const bad = fns.rows.find((r) => r.ok !== c.expect);
  return bad ? { id: c.id, ok: false, problem: `${c.role} ${c.expect ? '应能' : '不该能'}执行 public.${c.fn}` } : { id: c.id, ok: true };
}

export async function runGrantMatrix(db: GrantDb, m: GrantMatrix): Promise<GrantRunResult> {
  for (const role of GRANT_ROLES) {
    const r = await db.query<{ n: number }>(`select count(*)::int as n from pg_roles where rolname = $1`, [role]);
    if (r.rows[0]?.n !== 1) throw new Error(`数据库里没有角色 ${role}`);
  }
  const inDb = (
    await db.query<{ r: string }>(
      `select n.nspname || '.' || c.relname as r from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm') order by 1`,
    )
  ).rows.map((x) => x.r);
  const names = m.relations.map((r) => r.name);
  const extraRelations = inDb.filter((r) => !names.includes(r));
  const missingRelations = names.filter((r) => !inDb.includes(r));

  const colCache = new Map<string, string[]>();
  const outcomes: GrantOutcome[] = [];
  for (const c of m.cases) {
    if (missingRelations.includes(c.relation)) continue;
    let cols = colCache.get(c.relation);
    if (!cols) {
      cols = await columnsOf(db, c.relation);
      colCache.set(c.relation, cols);
    }
    outcomes.push(await runOne(db, c, cols));
  }

  const rpc = [];
  for (const c of m.rpcCases) rpc.push(await runRpc(db, c));
  const listed = new Set(m.rpcCases.map((c) => c.fn));
  const extraRpcs = (await db.query<{ f: string }>(`select distinct proname as f from pg_proc where pronamespace = 'public'::regnamespace order by 1`)).rows
    .map((x) => x.f)
    .filter((f) => !listed.has(f));
  return { outcomes, rpc, extraRelations, missingRelations, extraRpcs };
}

/** 汇总成一张问题清单（空 = 全过） */
export function grantProblems(r: GrantRunResult): string[] {
  return [
    ...r.outcomes.filter((o) => !o.ok).map((o) => `${o.id}：${o.problems.join('；')}`),
    ...r.rpc.filter((x) => !x.ok).map((x) => `${x.id}：${x.problem ?? ''}`),
    ...r.extraRelations.map((x) => `数据库里有 ${x}，清单和白名单都没有（生成器没覆盖）`),
    ...r.missingRelations.map((x) => `清单或白名单里有 ${x}，数据库里没有`),
    ...r.extraRpcs.map((x) => `public.${x} 不在 3.3 D 的九个 RPC 里`),
  ];
}
