// “表 × 角色 × 操作”正反用例生成器（TC-B0-89；架构 0.33 第 9 条、1.3b：前端 B 写，后端审生成出来的断言）。
// 按“清单里的每张表 + 白名单里的四个 scan_ 视图 × {anon、authenticated、service_role、fn_vault、fn_ai} × {SELECT、INSERT、UPDATE、DELETE}”
// 每格生成一条用例，写明期望：整张表都给（all）、一列都不给（none）、只给这几列（列名单）。runner（grant-runner.ts）在数据库里以那个角色
// 逐列真的执行一句不动数据的语句，看哪些成功、哪些被拒（42501），和期望逐项比：多一列、少一列都失败。
// 另外 public 的九个 RPC（3.3 D）各生成 anon、authenticated、service_role 三条执行权用例。
//
// 期望从哪来（和 D1 第 4、5 节同一口径，不另起一套）：
//   anon          public：只有清单 anonReadable 的列能 SELECT；其余一律没有。private：一律没有
//   authenticated public：表级 SELECT；INSERT = clientWritable − updateOnly；UPDATE = clientWritable − insertOnly；DELETE 只有 clientDelete 的表。private：一律没有
//   service_role  public：四种全给（Supabase 默认，0.29 续第 86 条不收窄）。private：build/d1/whitelist.ts 的 TABLE_GRANTS.service_role
//   fn_vault、fn_ai  TABLE_GRANTS（表级）+ COLUMN_GRANTS（列级）；名单外一律没有
// 双向：白名单里写了清单没有的表（四个 scan_ 视图除外）、同一格表级和列级都写了，生成时就报错；数据库里多出清单外的表或视图，runner 报错。

import { ManifestError, qualified } from './sql.ts';
import type { Manifest, ManifestTable } from './types.ts';

export const GRANT_ROLES = ['anon', 'authenticated', 'service_role', 'fn_vault', 'fn_ai'] as const;
export type GrantRole = (typeof GRANT_ROLES)[number];
export const GRANT_OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
export type GrantOp = (typeof GRANT_OPS)[number];

/** build/d1/whitelist.ts 里生成器读的三项（按结构传，测试里可以传改过的副本） */
export interface GrantWhitelist {
  TABLE_GRANTS: Record<'service_role' | 'fn_vault' | 'fn_ai', Record<string, readonly string[]>>;
  COLUMN_GRANTS: Record<'fn_vault' | 'fn_ai', Record<string, readonly string[]>>;
  PUBLIC_RPCS: readonly string[];
}

/** 'all'：表级授权（每一列都行）；'none'：一列都不行；列名单：只有这几列行（列级授权，表级没有） */
export type GrantExpect = 'all' | 'none' | readonly string[];

export interface GrantCase {
  /** TC-GRANT-<schema.表>-<角色>-<操作> */
  id: string;
  relation: string;
  kind: 'table' | 'view';
  role: GrantRole;
  op: GrantOp;
  expect: GrantExpect;
  /** 期望的出处（给后端审断言用） */
  why: string;
}

export interface RpcCase {
  id: string;
  fn: string;
  role: 'anon' | 'authenticated' | 'service_role';
  expect: boolean;
}

export interface GrantMatrix {
  cases: GrantCase[];
  rpcCases: RpcCase[];
  /** 生成的关系：清单里的表、白名单里的视图（runner 拿它和数据库双向比） */
  relations: { name: string; kind: 'table' | 'view' }[];
}

/** 白名单里不在清单、却允许出现的关系：private 的扫描视图（3.3 C、TC-B0-78） */
const VIEW_RE = /^private\.scan_[a-z0-9_]+$/;
const FN_ROLES = ['fn_vault', 'fn_ai'] as const;

function minus(a: readonly string[] = [], b: readonly string[] = []): string[] {
  return a.filter((x) => !b.includes(x));
}

function expectFor(rel: string, t: ManifestTable | null, role: GrantRole, op: GrantOp, wl: GrantWhitelist): [GrantExpect, string] {
  const isPublic = rel.startsWith('public.');
  if (role === 'anon') {
    if (!t || !isPublic) return ['none', 'private 对 anon 一律没有（3.3 C ②）'];
    if (op !== 'SELECT' || !t.anonReadable?.length) return ['none', 'anon 只能读清单 anonReadable 的列，别的都没有（3.3 B2）'];
    return [[...t.anonReadable], '清单 anonReadable（3.3 B2，0.27）'];
  }
  if (role === 'authenticated') {
    if (!t || !isPublic) return ['none', 'private 对 authenticated 一律没有（3.3 C ②）'];
    if (op === 'SELECT') return ['all', 'public 表给 authenticated 表级 SELECT，行由 RLS 管（3.3 A）'];
    if (op === 'DELETE') return t.clientDelete ? ['all', '清单 clientDelete（只有 devices，0.29 续第 121 条）'] : ['none', '客户端没有表级 DELETE（0.29 续第 121 条，R-180）'];
    const cols = op === 'INSERT' ? minus(t.clientWritable, t.updateOnly) : minus(t.clientWritable, t.insertOnly);
    const src = op === 'INSERT' ? 'clientWritable − updateOnly' : 'clientWritable − insertOnly';
    return cols.length ? [cols, `清单 ${src}（3.3 A 列级授权）`] : ['none', `清单 ${src} 为空`];
  }
  if (role === 'service_role' && isPublic) return ['all', 'Supabase 默认给 service_role public 全部表级权限（0.29 续第 86 条不收窄）'];
  const tableOps = wl.TABLE_GRANTS[role][rel] ?? [];
  if (tableOps.includes(op)) return ['all', `whitelist.ts TABLE_GRANTS.${role}`];
  if (role !== 'service_role') {
    const cols = wl.COLUMN_GRANTS[role][`${rel}:${op}`];
    if (cols?.length) return [[...cols], `whitelist.ts COLUMN_GRANTS.${role}`];
  }
  return ['none', `不在 ${role} 的白名单里（3.3 C、6.2）`];
}

/** 白名单自己的一致性：写到的关系必须在清单里（或是 scan_ 视图）；同一格不能表级、列级都写 */
function checkWhitelist(wl: GrantWhitelist, tables: ReadonlySet<string>): string[] {
  const views = new Set<string>();
  const see = (rel: string, where: string) => {
    if (tables.has(rel)) return;
    if (VIEW_RE.test(rel)) views.add(rel);
    else throw new ManifestError(`${where} 写了 ${rel}，清单里没有这张表（白名单和清单要双向一致）`);
  };
  for (const role of ['service_role', ...FN_ROLES] as const) {
    for (const [rel, ops] of Object.entries(wl.TABLE_GRANTS[role])) {
      see(rel, `TABLE_GRANTS.${role}`);
      for (const op of ops) if (!(GRANT_OPS as readonly string[]).includes(op)) throw new ManifestError(`TABLE_GRANTS.${role}.${rel} 的操作 ${op} 不认识`);
    }
  }
  for (const role of FN_ROLES) {
    for (const [k, cols] of Object.entries(wl.COLUMN_GRANTS[role])) {
      const [rel = '', op = ''] = k.split(':');
      see(rel, `COLUMN_GRANTS.${role}`);
      if (!['SELECT', 'INSERT', 'UPDATE'].includes(op)) throw new ManifestError(`COLUMN_GRANTS.${role} 的 ${k}：列级只能是 SELECT、INSERT、UPDATE`);
      if (wl.TABLE_GRANTS[role][rel]?.includes(op)) throw new ManifestError(`${role} 的 ${k} 表级、列级都写了，说不清期望是哪个`);
      if (cols.length === 0) throw new ManifestError(`COLUMN_GRANTS.${role} 的 ${k} 是空名单`);
    }
  }
  return [...views].sort();
}

export function generateGrantMatrix(manifests: readonly Manifest[], wl: GrantWhitelist): GrantMatrix {
  const byRel = new Map<string, ManifestTable>();
  for (const m of manifests) {
    for (const t of m.tables) {
      const rel = qualified(t.schema, t.name);
      if (byRel.has(rel)) throw new ManifestError(`${rel} 在清单里登记了两次`);
      byRel.set(rel, t);
    }
  }
  const views = checkWhitelist(wl, new Set(byRel.keys()));
  const relations = [...[...byRel.keys()].sort().map((name) => ({ name, kind: 'table' as const })), ...views.map((name) => ({ name, kind: 'view' as const }))];

  const cases: GrantCase[] = [];
  for (const r of relations) {
    const t = byRel.get(r.name) ?? null;
    for (const role of GRANT_ROLES) {
      for (const op of GRANT_OPS) {
        const [expect, why] = expectFor(r.name, t, role, op, wl);
        if (op === 'DELETE' && Array.isArray(expect)) throw new ManifestError(`${r.name} 的 DELETE 不能按列给`);
        cases.push({ id: `TC-GRANT-${r.name}-${role}-${op}`, relation: r.name, kind: r.kind, role, op, expect, why });
      }
    }
  }

  if (new Set(wl.PUBLIC_RPCS).size !== wl.PUBLIC_RPCS.length) throw new ManifestError('PUBLIC_RPCS 有重复');
  const rpcCases: RpcCase[] = wl.PUBLIC_RPCS.flatMap((fn) =>
    (['anon', 'authenticated', 'service_role'] as const).map((role) => ({ id: `TC-GRANT-rpc-${fn}-${role}`, fn, role, expect: role === 'authenticated' })),
  );
  return { cases, rpcCases, relations };
}

/** 给人审的一行：TC-GRANT-…：期望 */
export function describeGrantCase(c: GrantCase): string {
  const e = c.expect === 'all' ? '整张表都行' : c.expect === 'none' ? '一列都不行（42501）' : `只有 ${c.expect.join('、')}`;
  return `${c.id}：${e}（${c.why}）`;
}
