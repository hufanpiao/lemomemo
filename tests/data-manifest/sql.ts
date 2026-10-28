// 数据清单用例生成器的公共部分：用例类型、报错类、拼 SQL 标识符和字面量（从 generate.ts 拆出，W1 每个文件不超过 300 行）

export type CaseKind =
  | 'account-delete'
  | 'system-cols'
  | 'soft-delete-purge'
  | 'orphan-sweep'
  | 'max-lifetime'
  | 'vault-rows-cipher-only';

export interface GeneratedCase {
  id: string;
  kind: CaseKind;
  /** 'sql'：runner 打本地数据库；'e2e'：要在浏览器里跑（本机 IndexedDB） */
  runner: 'sql' | 'e2e';
  target: string;
  manifests: string[];
  /** 造数据之后、执行之前先跑一次，执行之后再跑一次 */
  probe?: { a: string; b?: string };
  /** 执行的动作（account-delete 是“A 申请注销 → 满 7 天 → account-purge”，由 runner 统一做） */
  act?: string;
  expect: string;
  /** vault-rows：本机缓存里允许出现和禁止出现的列 */
  cols?: { allowed: string[]; forbidden: string[] };
}

export class ManifestError extends Error {}

const IDENT = /^[a-z_][a-z0-9_]*$/;

export function ident(s: string, what: string): string {
  if (!IDENT.test(s)) throw new ManifestError(`${what} 不是合法标识符：${s}`);
  return s;
}

export function qualified(schema: string, table: string): string {
  return `${ident(schema, 'schema')}.${ident(table, '表名')}`;
}

/** SQL 字符串字面量（只用于清单里写死的模式串、前缀，不用于用户数据） */
export function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function splitQualified(name: string): [string, string] {
  const [a, b, ...rest] = name.split('.');
  if (a && b && rest.length === 0) return [a, b];
  if (a && b === undefined) return ['public', a];
  throw new ManifestError(`登记表名不对：${name}`);
}
