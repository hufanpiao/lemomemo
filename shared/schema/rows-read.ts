// 读网络数据用的宽容版列登记（架构 0.27 第 1 点、2.6；数据字典 10.2“宽容读取”）：写入仍用 rows.ts 的严格版
// • 只认列的“基本类型”（字符串、数字、布尔、可空、对象）和枚举；长度、格式这类写入约束读的时候不查
//   （新版可能放宽了约束，读到了照样显示；改这一列时 outbox 仍按严格版校验）
// • 枚举列读到不认识的值：换成 UNKNOWN，这一行只读（引擎在 src/core/read/lenient.ts）。
//   **有意如此**：枚举列读到基本类型都不对的值（例如数字列给了字符串、给了对象）也一样换成 UNKNOWN、只读，不丢整行——
//   新版把枚举从数字改成字符串这类变化，旧版照样能显示这一行；非枚举列基本类型不对才算“解析不了”
// • 必须有的列（REQUIRED_COMMON 和 rows.ts 严格版的列）缺了算“解析不了”：缺 rev 的残缺行会整份替换本机较新的副本
// • 本文件没登记的列一律算“不认识的列”：普通行原样留着，隐私记行按 vaultRows 白名单处理
// • 改了本文件认识的列或枚举，也要把 rows.ts 的 SCHEMA_V 加 1（本机库整表重拉，之前降级为只读的行恢复正常）
// A20：字符串里不放汉字；纯 TS + zod，只 import shared
import { z } from 'zod';
import { rowsWrite } from './rows.ts';

/** 不认识的枚举值换成它（0.27 第 1 点） */
export const UNKNOWN = 'unknown' as const;

export type EnumValue = string | number | boolean;

/** 一列怎么读 */
export type ReadCol =
  /** 枚举：值不在 values 里（也不是允许的 null）就换成 UNKNOWN、整行只读 */
  | { readonly kind: 'enum'; readonly values: readonly EnumValue[]; readonly nullable: boolean }
  /** 其他：只查基本类型；不过就是“解析不了”，整行丢掉、记进待补拉 */
  | { readonly kind: 'plain'; readonly schema: z.ZodType };

/** zod 4 的 def 里本文件用到的几项（只读，不改 schema） */
interface Def {
  type: string;
  innerType?: z.ZodType;
  entries?: Record<string, EnumValue>;
  values?: readonly EnumValue[];
  options?: readonly z.ZodType[];
}
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

const plain = (schema: z.ZodType): ReadCol => ({ kind: 'plain', schema });
const enumOf = (values: readonly EnumValue[], nullable = false): ReadCol => ({ kind: 'enum', values, nullable });

/**
 * 把严格版的一列放宽成读用的一列：uuid、正则、长度、int、范围都去掉，只留基本类型和可空；
 * enum、literal、literal 的 union 认成枚举。遇到不认识的 zod 类型直接抛错（加列时在单元测试里就能发现）
 */
export function readColOf(s: z.ZodType, nullable = false): ReadCol {
  const d = defOf(s);
  switch (d.type) {
    case 'nullable':
      if (!d.innerType) throw new Error('rows_read_bad_nullable');
      return readColOf(d.innerType, true);
    case 'enum':
      return enumOf(Object.values(d.entries ?? {}), nullable);
    case 'literal':
      return enumOf(d.values ?? [], nullable);
    case 'union': {
      const parts = (d.options ?? []).map((o) => readColOf(o));
      const values: EnumValue[] = [];
      let anyNull = nullable;
      for (const p of parts) {
        if (p.kind !== 'enum') throw new Error('rows_read_union_not_enum');
        values.push(...p.values);
        anyNull ||= p.nullable;
      }
      return enumOf(values, anyNull);
    }
    case 'string':
      return plain(nullable ? z.string().nullable() : z.string());
    case 'number':
      return plain(nullable ? z.number().nullable() : z.number());
    case 'boolean':
      return plain(nullable ? z.boolean().nullable() : z.boolean());
    default:
      throw new Error(`rows_read_unsupported:${d.type}`);
  }
}

/** 公共列（数据字典 3.2：九张同步表都有）；id 另由引擎查（必须是非空字符串） */
/** 公共列里每一行必须带上的（deleted_at 可以是 null，但这一列要在） */
export const REQUIRED_COMMON = ['rev', 'user_id', 'deleted_at', 'synced_at', 'undone'] as const;

const COMMON_READ: Readonly<Record<string, ReadCol>> = {
  user_id: plain(z.string()),
  rev: plain(z.number()),
  fv: plain(z.record(z.string(), z.unknown())),
  synced_at: plain(z.string()),
  deleted_at: plain(z.number().nullable()),
  undone: plain(z.boolean()),
};

/**
 * 各表只由服务器写、rows.ts 严格版里没有的列（系统列、派生列、vaultRows 的 flag 列）。
 * 只登记“值不对会影响本机逻辑”的列；没登记的照“不认识的列”处理，普通行原样留着。
 * B4、B5 给 notes、note_images、note_files 写严格版时，可写列从 rows.ts 自动带进来，这里只补服务器列
 */
const SERVER_READ: Readonly<Record<string, Readonly<Record<string, ReadCol>>>> = {
  events: {
    remind_at: plain(z.number().nullable()),
    pushed_for: plain(z.number().nullable()),
    defer_until: plain(z.number().nullable()),
    ai_status: enumOf(['none', 'pending', 'done', 'rule', 'skipped']),
  },
  todos: {
    remind_at: plain(z.number().nullable()),
    pushed_for: plain(z.number().nullable()),
    defer_until: plain(z.number().nullable()),
    ai_status: plain(z.string()),   // 数据字典 4.9：无取值约束（P-16）
  },
  notes: {
    is_private: plain(z.boolean()),   // vaultRows.flag
  },
  note_images: {
    bucket: enumOf(['images', 'vault-images']),   // vaultRows.flag：bucket = 'vault-images'
    ai_status: enumOf(['pending', 'done', 'skip', 'failed']),
  },
  note_files: {
    is_vault: plain(z.boolean()),   // vaultRows.flag
    ai_status: enumOf(['pending', 'done', 'skip', 'failed']),
  },
};

/**
 * 有值（不是 null、undefined）就让整行只读的列：本版本不认识、但知道“有它就不能照常改”的新列。
 * 4.1.0 的重复事项（0.27 第 1 点）：4.0.x 读到 repeat 不为空的日程和待办，只显示第一次并标成只读
 */
export const RO_IF_PRESENT: Readonly<Record<string, readonly string[]>> = {
  events: ['repeat'],
  todos: ['repeat'],
};

/** 一张表每一行必须带上的列（不含 id）：REQUIRED_COMMON + rows.ts 严格版的全部列（严格版没有可省的列，可空的也要在） */
export function requiredColsOf(table: string): readonly string[] {
  const writes: Readonly<Record<string, { shape: Record<string, z.ZodType> } | undefined>> = rowsWrite;
  const strict = Object.hasOwn(writes, table) ? writes[table] : undefined;
  const out = new Set<string>(REQUIRED_COMMON);
  if (strict) for (const col of Object.keys(strict.shape)) if (col !== 'id') out.add(col);
  return [...out];
}

/** 某张表的 RO_IF_PRESENT（表名可能来自网络，按自有属性查，F7） */
export function roIfPresentOf(table: string): readonly string[] {
  return (Object.hasOwn(RO_IF_PRESENT, table) ? RO_IF_PRESENT[table] : undefined) ?? [];
}

const cache = new Map<string, ReadonlyMap<string, ReadCol>>();

/**
 * 一张表认识的列：公共列 + rows.ts 严格版的列（放宽）+ 服务器列。同名时后者覆盖前者。
 * 返回 Map：调用方拿服务器行的列名（不可信，可能是 constructor、__proto__）来查，普通对象会取到原型链（F7）
 */
export function readColsOf(table: string): ReadonlyMap<string, ReadCol> {
  const hit = cache.get(table);
  if (hit) return hit;
  const out = new Map<string, ReadCol>(Object.entries(COMMON_READ));
  const writes: Readonly<Record<string, { shape: Record<string, z.ZodType> } | undefined>> = rowsWrite;
  const strict = Object.hasOwn(writes, table) ? writes[table] : undefined;
  if (strict) for (const [col, s] of Object.entries(strict.shape)) out.set(col, readColOf(s));
  const server = Object.hasOwn(SERVER_READ, table) ? SERVER_READ[table] : undefined;
  if (server) for (const [col, rc] of Object.entries(server)) out.set(col, rc);
  out.delete('id');   // id 由引擎单独查
  cache.set(table, out);
  return out;
}
