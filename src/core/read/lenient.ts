// 网络数据宽容读取（架构 0.27 第 1 点、2.6、3.5 vaultRows；数据字典 10.2）：纯函数，不碰本机库
// 服务器、Realtime、别的设备（可能是更新的版本）写来的行，在写进本机缓存之前过这里：
// • 按行校验，不整批拒收：一行解析不了（id 不是 uuid、必须有的列缺了、认识的列基本类型不对）只丢这一行，
//   交给调用方记进“待补拉”和日志
// • 不认识的枚举值换成 UNKNOWN，这一行只读（ro）；repeat 这类 RO_IF_PRESENT 列有值也只读
// • 不认识的列：普通行原样留在 server 副本里（以后 patch 只发改过的列，不会把新列写空）
// • 有 vaultRows 的表：隐私记行只留 cipherCols 和 neutralCols，别的列（含不认识的）一律丢；
//   flag 列读不出、读到不认识的值或缺了这一列 → 判断不了，按隐私记行处理、flag 列写 UNKNOWN、只读（失败就关上）
// • 列名来自网络（不可信）：一律 own 查找（Map / Object.hasOwn），结果行用 Object.fromEntries 建；
//   Object.prototype 上有的名字（__proto__、constructor、toString……）当不认识的列丢掉
// 纯 TS：不准 import React 和任何功能（A1）
import { readColsOf, requiredColsOf, roIfPresentOf, UNKNOWN, type EnumValue, type ReadCol } from '../../../shared/schema/rows-read.ts';
import type { ServerRow } from '../cache.ts';
import { allTables, type Manifest, type ManifestTable } from '../manifest.ts';
import type { ServerRowInput } from '../outbox-types.ts';

export { UNKNOWN };

export type VaultRules = NonNullable<ManifestTable['vaultRows']>;

/** 隐私记判断：vault 是隐私记行；plain 是普通行；unsure 判断不了（按隐私记行处理） */
export type VaultVerdict = 'vault' | 'plain' | 'unsure';

/** 解析好的 vaultRows.flag */
export interface VaultFlag {
  /** flag 用到的列 */
  readonly col: string;
  /** 按这一列的原始值判断（列不在行里时传 undefined） */
  test(v: unknown): VaultVerdict;
}

const COL = '[a-z_][a-z0-9_]*';
const BOOL_FLAG = new RegExp(`^(${COL})$`);
const EQ_FLAG = new RegExp(`^(${COL}) = '([^']*)'$`);
/** logs.item_id、待补拉的 id 都是 uuid 列（数据字典 4.6）：不是这个形状的 id 一律当没有 id */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 日志的长度上限（logs 表的列不放长串） */
export const LOG_MAX_FIELDS = 20;
export const LOG_MAX_FIELDS_LEN = 640;
export const LOG_MAX_COLL = 32;

/**
 * 解析 vaultRows.flag 的两种写法（3.5）：
 * - 'is_private'：布尔列，true 是隐私记行，false 是普通行，其他（null、缺列、不是布尔）判断不了；
 * - "bucket = 'vault-images'"：等于它是隐私记行；是这一列登记过的其他枚举值才算普通行，其他（含 'unknown'）判断不了。
 * 别的写法直接抛错（清单写错了，单元测试里就能发现）
 */
export function parseVaultFlag(flag: string, cols: ReadonlyMap<string, ReadCol>): VaultFlag {
  const b = BOOL_FLAG.exec(flag);
  if (b) {
    const col = b[1] as string;
    return { col, test: (v) => (v === true ? 'vault' : v === false ? 'plain' : 'unsure') };
  }
  const e = EQ_FLAG.exec(flag);
  if (e) {
    const col = e[1] as string;
    const target = e[2] as string;
    const rc = cols.get(col);
    const plainValues: readonly EnumValue[] = rc?.kind === 'enum' ? rc.values.filter((x) => x !== target) : [];
    return {
      col,
      test: (v) => (v === target ? 'vault' : typeof v === 'string' && plainValues.includes(v) ? 'plain' : 'unsure'),
    };
  }
  throw new Error(`vault_flag_unsupported:${flag}`);
}

/** 解析不了、整行丢掉的原因 */
export type DropCode = 'not_object' | 'no_id' | 'missing' | 'bad_type';

/** 一行的读取结果 */
export type RowOutcome =
  | {
      ok: true;
      /** 交给 outbox.applyServer 的一行 */
      input: ServerRowInput;
      /** 按隐私记行处理了（含判断不了的） */
      vault: boolean;
      /** 值换成了 UNKNOWN 的列 */
      unknownValues: string[];
      /** 不认识的列：普通行留着（Object.prototype 上有的名字除外），隐私记行已丢 */
      unknownCols: string[];
    }
  | {
      ok: false;
      id: string | null;
      code: DropCode;
      cols: string[];
      /**
       * R-229：判断为隐私记行或判断不了、但整行要丢时，用它覆盖本机的 server 副本——只读空壳，只有 id 和 flag 列
       * （判断不了写 UNKNOWN），本机原来的明文立即清掉；这一行照样进待补拉。普通行没有它（本机原有那份不动）
       */
      shell?: ServerRowInput;
    };

/** 写进 logs 的一条（只有表名、列名、错误码和行 id，不记内容；logs 表的列名） */
export interface ReadLog {
  act: 'row_unknown';
  /** 表名（≤ LOG_MAX_COLL） */
  coll: string;
  /** uuid 或 null */
  item_id: string | null;
  /** 出问题的列名（≤ LOG_MAX_FIELDS 个，逗号连起来 ≤ LOG_MAX_FIELDS_LEN） */
  fields: string[];
  code: DropCode | 'table_unknown' | 'cache_not_plain';
}

/** 读一张表时要用的规则（按表缓存） */
export interface TableReader {
  readonly table: string;
  readonly cols: ReadonlyMap<string, ReadCol>;
  /** 每一行必须带上的列（不含 id） */
  readonly required: readonly string[];
  readonly vault: { readonly rules: VaultRules; readonly flag: VaultFlag; readonly keep: ReadonlySet<string> } | null;
  readonly roIfPresent: readonly string[];
}

/** 读不了的表：不是同步表（table_unknown）、本机缓存不是明文缓存（cache_not_plain，失败就关上） */
export type TableSkip = 'table_unknown' | 'cache_not_plain';

/** 按清单和 rows-read.ts 建一张表的读取规则 */
export function tableReader(table: string, manifests?: readonly Manifest[]): TableReader | TableSkip {
  const t = allTables(manifests).find((x) => x.schema === 'public' && x.name === table && x.sync === true);
  if (!t) return 'table_unknown';
  // 'cipher-only'、'none' 的表这里还没有规则：不进本机缓存（宁可不收，也不把明文写进去）
  if (t.localCache !== 'plain') return 'cache_not_plain';
  const cols = readColsOf(table);
  const v = t.vaultRows;
  return {
    table,
    cols,
    required: requiredColsOf(table),
    vault: v
      ? { rules: v, flag: parseVaultFlag(v.flag, cols), keep: new Set(['id', ...v.cipherCols, ...v.neutralCols]) }
      : null,
    roIfPresent: roIfPresentOf(table),
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const ownGet = (o: Readonly<Record<string, unknown>>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

/** 一列的值合不合登记：ok、换成 UNKNOWN（枚举，基本类型不对也算，见 rows-read.ts 头注释）、bad（非枚举列基本类型不对） */
function checkCol(rc: ReadCol, v: unknown): 'ok' | 'unknown' | 'bad' {
  if (rc.kind === 'enum') {
    if (v === null) return rc.nullable ? 'ok' : 'unknown';
    return rc.values.includes(v as EnumValue) ? 'ok' : 'unknown';
  }
  return rc.schema.safeParse(v).success ? 'ok' : 'bad';
}

/** 整行丢掉；隐私记行和判断不了的行带上只读空壳（R-229） */
function dropRow(
  v: TableReader['vault'],
  verdict: VaultVerdict,
  raw: Readonly<Record<string, unknown>>,
  id: string,
  code: DropCode,
  cols: string[],
): RowOutcome {
  if (!v || verdict === 'plain') return { ok: false, id, code, cols };
  const flag = verdict === 'vault' ? ownGet(raw, v.flag.col) : UNKNOWN;
  const rev = ownGet(raw, 'rev');
  // 原始行的 rev 是有效正整数才给，否则 null（K6 用本机旧 rev 补）：晚到的同 rev 旧普通行不能把空壳盖掉
  const minRev = typeof rev === 'number' && Number.isSafeInteger(rev) && rev > 0 ? rev : null;
  const row = Object.fromEntries([['id', id], [v.flag.col, flag]]) as ServerRow;
  return { ok: false, id, code, cols, shell: { row, ro: true, shell: true, minRev } };
}

/** 读一行（纯函数） */
export function readRow(reader: TableReader, raw: unknown): RowOutcome {
  if (!isRecord(raw)) return { ok: false, id: null, code: 'not_object', cols: [] };
  const id = ownGet(raw, 'id');
  if (typeof id !== 'string' || !UUID_RE.test(id)) return { ok: false, id: null, code: 'no_id', cols: ['id'] };

  // 先按隐私记白名单删列，再校验：隐私记行不认识的明文列连看都不看
  let verdict: VaultVerdict = 'plain';
  let entries = Object.entries(raw).filter(([, v]) => v !== undefined);
  const unknownCols: string[] = [];
  const v = reader.vault;
  if (v) {
    verdict = v.flag.test(ownGet(raw, v.flag.col));
    if (verdict !== 'plain') {
      const nulls = v.rules.plainColsMustBeNull;
      entries = entries.filter(([c]) => {
        if (v.keep.has(c)) return true;
        // D1 要求这张表的每一列都归进三类之一，三类都不在的就是更新的版本加的列
        if (!nulls.includes(c)) unknownCols.push(c);
        return false;
      });
    }
  }

  // 必须有的列缺了：残缺行会整份替换本机较新的副本，丢掉。隐私记行只看白名单里的；flag 列缺了走“判断不了”，不算缺
  const present = new Set(entries.map(([c]) => c));
  const missing = reader.required.filter(
    (c) => !present.has(c) && (verdict === 'plain' || v?.keep.has(c) === true) && c !== v?.flag.col,
  );
  if (missing.length) return dropRow(v, verdict, raw, id, 'missing', missing);

  const out = new Map<string, unknown>();
  const unknownValues: string[] = [];
  const bad: string[] = [];
  for (const [c, val] of entries) {
    if (c === 'id') {
      out.set(c, val);
      continue;
    }
    if (c in Object.prototype) {
      // __proto__、constructor、toString、hasOwnProperty、valueOf……：下游有 o[k] = v、o[k] 的写法会改原型或取到原型，
      // 当不认识的列丢掉（数据库的列不会叫这些名字）
      unknownCols.push(c);
      continue;
    }
    const rc = reader.cols.get(c);
    if (!rc) {
      if (verdict === 'plain') unknownCols.push(c);
      out.set(c, val);   // 普通行：不认识的列原样留着（隐私记行到这里的只有白名单里的列）
      continue;
    }
    const r = checkCol(rc, val);
    if (r === 'ok') out.set(c, val);
    else if (r === 'unknown' || (v && c === v.flag.col)) {
      // flag 列读不出来也不丢整行：已经按隐私记行处理了，值换成 UNKNOWN
      out.set(c, UNKNOWN);
      unknownValues.push(c);
    } else bad.push(c);
  }
  if (bad.length) return dropRow(v, verdict, raw, id, 'bad_type', bad);
  // 判断不了又缺了 flag 列：也写上 UNKNOWN，之后 isVaultRow 照样判成隐私记行
  if (v && verdict === 'unsure' && !out.has(v.flag.col)) {
    out.set(v.flag.col, UNKNOWN);
    unknownValues.push(v.flag.col);
  }

  const repeat = reader.roIfPresent.some((c) => out.get(c) !== undefined && out.get(c) !== null);
  const ro = unknownValues.length > 0 || verdict === 'unsure' || repeat;
  const input: ServerRowInput = { row: Object.fromEntries(out) as ServerRow };
  if (ro) input.ro = true;
  return { ok: true, input, vault: verdict !== 'plain', unknownValues, unknownCols };
}

/** 日志里的列名：最多 LOG_MAX_FIELDS 个，逗号连起来不超过 LOG_MAX_FIELDS_LEN */
export function logFields(cols: readonly string[]): string[] {
  const out: string[] = [];
  let len = 0;
  for (const c of cols.slice(0, LOG_MAX_FIELDS)) {
    const add = c.length + (out.length ? 1 : 0);
    if (len + add > LOG_MAX_FIELDS_LEN) break;
    out.push(c);
    len += add;
  }
  return out;
}

const logOf = (table: string, id: string | null, cols: readonly string[], code: ReadLog['code']): ReadLog => ({
  act: 'row_unknown', coll: table.slice(0, LOG_MAX_COLL), item_id: id, fields: logFields(cols), code,
});

/** 一批行的读取结果 */
export interface ReadBatch {
  table: string;
  /** 交给 outbox.applyServer（顺序和输入一致，丢掉的行不在里面） */
  rows: ServerRowInput[];
  /**
   * 丢掉的行（id 为 null 的记不进待补拉）。隐私记行和判断不了的行丢掉时，rows 里另有它的只读空壳（R-229），
   * 所以“这次读成功、可以从待补拉去掉的 id” = rows 的 id 减去 dropped 的 id
   */
  dropped: { id: string | null; code: DropCode; cols: string[] }[];
  /** 只读的行 */
  readonlyIds: string[];
  /** 要写的日志（每丢一行一条；整张表读不了时一条） */
  logs: ReadLog[];
}

const readers = new Map<string, TableReader | TableSkip>();

/**
 * 读一批行（纯函数）：按行校验，不整批拒收。
 * 表读不了（更新的版本加的新表、不是明文缓存的表）：整批跳过、记一条日志，不抛错。
 * 传 manifests 时不走缓存（测试用）
 */
export function readRows(table: string, raw: readonly unknown[], manifests?: readonly Manifest[]): ReadBatch {
  let reader = manifests ? tableReader(table, manifests) : readers.get(table);
  if (reader === undefined) {
    reader = tableReader(table);
    readers.set(table, reader);
  }
  const batch: ReadBatch = { table, rows: [], dropped: [], readonlyIds: [], logs: [] };
  if (typeof reader === 'string') {
    if (raw.length) batch.logs.push(logOf(table, null, [], reader));
    return batch;
  }
  for (const r of raw) {
    const o = readRow(reader, r);
    if (o.ok) {
      batch.rows.push(o.input);
      if (o.input.ro) batch.readonlyIds.push(o.input.row.id);
    } else {
      batch.dropped.push({ id: o.id, code: o.code, cols: o.cols });
      batch.logs.push(logOf(table, o.id, o.cols, o.code));
      if (o.shell) {
        batch.rows.push(o.shell);
        batch.readonlyIds.push(o.shell.row.id);
      }
    }
  }
  return batch;
}

/**
 * K8 的 ParseServerRows（core/sync/types.ts）同形：rows 交给 applyServer，bad 是要记进待补拉的 id（都是 uuid）。
 * 注意：bad 里的隐私记行在 rows 里还有一份只读空壳（R-229），从待补拉去掉时要排除 bad 里的 id
 */
export interface ParsedRows {
  rows: ServerRowInput[];
  bad: string[];
}

/**
 * 给 K8 的 createSync({ parseRows }) 用：纯函数，不碰本机库；每丢一行（或整张表读不了）调一次 log（只有表名、列名、错误码、id）。
 * 待补拉列表由调用方写（K8 的 pull；也可以用 read/ingest.ts 的 updateRefetch，它顺带去掉这次读成功的 id）
 */
export function createParseRows(opts: { log?: (e: ReadLog) => void; manifests?: readonly Manifest[] } = {}): (
  table: string,
  raw: readonly unknown[],
) => ParsedRows {
  return (table, raw) => {
    const b = readRows(table, raw, opts.manifests);
    if (opts.log) for (const e of b.logs) opts.log(e);
    return { rows: b.rows, bad: b.dropped.flatMap((d) => (d.id === null ? [] : [d.id])) };
  };
}

const vaultFlags = new Map<string, VaultFlag | null | 'unknown_table'>();

/**
 * 本机缓存里的一行是不是隐私记行（界面、导出、“＋”结果统一用它，不要各自看 is_private / bucket）。
 * 没有 vaultRows 的表返回 false；清单里没有的表、flag 判断不了（含宽容读取写的 UNKNOWN）一律返回 true（失败就关上）
 */
export function isVaultRow(table: string, row: Readonly<Record<string, unknown>>, manifests?: readonly Manifest[]): boolean {
  let f = manifests ? undefined : vaultFlags.get(table);
  if (f === undefined) {
    const t = allTables(manifests).find((x) => x.schema === 'public' && x.name === table);
    f = !t ? 'unknown_table' : t.vaultRows ? parseVaultFlag(t.vaultRows.flag, readColsOf(table)) : null;
    if (!manifests) vaultFlags.set(table, f);
  }
  if (f === 'unknown_table') return true;
  if (f === null) return false;
  return f.test(ownGet(row, f.col)) !== 'plain';
}

/**
 * 记录类型、种类这类单个枚举值的宽容读取（“＋”的查找结果、AI 输出里的 kind 等）：
 * 认识的原样返回，不认识的返回 UNKNOWN，不抛错；调用方对 UNKNOWN 只显示、不提供操作
 */
export function readEnum<T extends EnumValue>(known: readonly T[], v: unknown): T | typeof UNKNOWN {
  return known.includes(v as T) ? (v as T) : UNKNOWN;
}
