// 数据清单用例生成器的公共部分：用例类型、报错类、拼 SQL 标识符和字面量（从 generate.ts 拆出，W1 每个文件不超过 300 行）

export type CaseKind =
  | 'account-delete'
  | 'system-cols'
  | 'soft-delete-purge'
  | 'orphan-sweep'
  | 'max-lifetime'
  | 'vault-rows-cipher-only';

/** 对象存储探针的一个选择器：按前缀列，再按第几级目录、正则筛（objstore-cases.ts） */
export interface ObjSelector {
  /** 列对象用的前缀，'<user>' 由 runner 换成 A 或 B 的 user_id；'' 是整桶 */
  prefix: string;
  /** 不按前缀找人时：key 的第几级目录是 user_id（backups 那种 <date>/<user_id>/…） */
  level: number | null;
  /** 清单的 pathPattern（整条 key 要匹配）；没写为 null */
  pattern: string | null;
}

/** store = 'r2' 的桶的探针（runner 经 shared/objstore.ts 打替身或 R2，桶名是逻辑名，runner 自己加 R2_BUCKET_PREFIX） */
export interface ObjProbe {
  bucket: string;
  /** count：按选择器分别数 A、B 的对象；snapshot：整桶 key 列表前后不变；head：keys 里的对象在不在 */
  mode: 'count' | 'snapshot' | 'head';
  selectors?: ObjSelector[];
  keys?: string[];
}

export interface GeneratedCase {
  id: string;
  kind: CaseKind;
  /** 'sql'：runner 打本地数据库；'objstore'：runner 打对象存储（S3 替身或 R2，0.32）；'e2e'：要在浏览器里跑（本机 IndexedDB） */
  runner: 'sql' | 'objstore' | 'e2e';
  target: string;
  manifests: string[];
  /** 造数据之后、执行之前先跑一次，执行之后再跑一次 */
  probe?: { a: string; b?: string };
  /** runner = 'objstore' 时代替 probe */
  objProbe?: ObjProbe;
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
