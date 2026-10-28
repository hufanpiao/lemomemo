// 数据清单的类型（架构 3.5；0.23 vaultRows、userLookup；0.27 recordKinds、systemCols、noConflict、rebuildable）
// 每个功能一份 shared/manifests/<功能>.ts；D1（build/d1/）在 db reset 后拿它和数据库逐项比对
// 纯 TS + zod，前端、Edge Functions（Deno）、Node 脚本共用：只用可擦除的语法，import 带 .ts 后缀
import { z } from 'zod';

const col = z.string().regex(/^[a-z_][a-z0-9_]*$/);
const cols = z.array(col);

/** 这个人的数据怎么找（注销、清理的生成用例按它找，0.23 N3 问题二） */
export const userLookupSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('column'), col }),
  z.object({ by: z.literal('keyPattern'), col, pattern: z.string() }),        // counters：'%:<user>:%'
  z.object({ by: z.literal('emailHash'), col }),                              // pending_signups
  z.object({ by: z.literal('registry'), table: z.string(), col }),            // vault-preview 的随机路径
  z.object({ by: z.literal('pathPattern'), level: z.number().int().min(1) }), // 桶：第几级目录是 user_id
  z.object({ by: z.literal('rowRef'), tableCol: col, idCol: col }),           // remind_queue：按引用的行找主人（表里没有 user_id）
]);
export type UserLookup = z.infer<typeof userLookupSchema>;

/** 同一张表里既有普通行又有隐私记行的（notes、note_images、note_files） */
export const vaultRowsSchema = z.object({
  flag: z.string(),                 // 'is_private' / 'is_vault' / "bucket = 'vault-images'"
  cipherCols: cols,                 // 隐私记行只带这些
  plainColsMustBeNull: cols,        // 隐私记行一律不出现
  neutralCols: cols,                // 不含内容的列（宽容读取时隐私记行只留 cipherCols 和它）
});

export const tableSchema = z.object({
  name: z.string(),
  schema: z.enum(['public', 'private']),
  /** 同步到设备；'tombstone' 只给 tombstones：按 deleted_at 增量拉、只订阅 INSERT，不建本机仓（数据字典 4.3b） */
  sync: z.union([z.boolean(), z.literal('tombstone')]),
  realtime: z.boolean(),
  localCache: z.enum(['plain', 'cipher-only', 'none']),
  /** 客户端可写列（insert 和 update 的并集）；outbox 按它校验 */
  clientWritable: cols,
  /** 只在 insert 时可写（数据字典的 C-i，例如 id、created_at）；update 授权 = clientWritable − insertOnly */
  insertOnly: cols.default([]),
  /** 只在 update 时可写（deleted_at、undone）；insert 授权 = clientWritable − updateOnly */
  updateOnly: cols.default([]),
  /** anon 能读的列（只有 app_config 的四列，0.27） */
  anonReadable: cols.default([]),
  /** 客户端有表级 DELETE（只有 devices，0.29 续第 121 条） */
  clientDelete: z.boolean().default(false),
  softDelete: z.boolean(),
  backup: z.enum(['json', 'none']),
  export: z.enum(['json', 'none']),
  onAccountDelete: z.enum(['cascade', 'explicit', 'keep-id-only']),
  vaultRows: vaultRowsSchema.optional(),
  userLookup: userLookupSchema.optional(),
  noUserData: z.literal(true).optional(),
  /** 写进 private.table_meta：改了不算用户改动（不含 touch() 固定的 rev、fv、synced_at、updated_at） */
  systemCols: cols.optional(),
  /** 写进 private.table_meta：两台设备同时改也不报冲突 */
  noConflict: cols.optional(),
  /** 本机库迁移出错时能不能清空重拉 */
  rebuildable: z.boolean().default(true),
}).refine((t) => (t.userLookup === undefined) !== (t.noUserData === undefined), { message: 'userLookup 和 noUserData 必须二选一' })
  .refine((t) => (t.systemCols === undefined) === (t.noConflict === undefined), { message: 'systemCols、noConflict 要么都写（挂 touch() 的表），要么都不写' })
  .refine((t) => !t.systemCols || t.systemCols.every((c) => !t.clientWritable.includes(c)), { message: 'systemCols 和 clientWritable 不能重叠' })
  .refine((t) => !t.noConflict || t.noConflict.every((c) => t.clientWritable.includes(c)), { message: 'noConflict 只放客户端可写列' })
  .refine((t) => !t.vaultRows || !t.systemCols || t.systemCols.every((c) => !t.vaultRows!.cipherCols.includes(c) && !t.vaultRows!.flag.includes(c)),
    { message: 'systemCols 不能含 vaultRows 的 flag 列和 cipherCols' });
export type ManifestTable = z.infer<typeof tableSchema>;
/** 清单作者写的表（带默认值的字段可以省） */
export type ManifestTableInput = z.input<typeof tableSchema>;

export const bucketSchema = z.object({
  name: z.string(),
  /** 桶的主人才写大小和类型限制（D1 和 storage.buckets 比对）；只登记一段路径的（纪念日头像）不写 */
  limits: z.object({ fileSizeLimit: z.number().int(), allowedMimeTypes: z.array(z.string()) }).optional(),
  pathPrefix: z.string(),
  /** 整条路径的正则，和存储策略一字不差（0.23 L8）；没有客户端策略的桶写服务器端的拼法 */
  pathPattern: z.string(),
  backup: z.enum(['weekly-s3', 'none']),
  export: z.enum(['zip', 'none']),
  countsToQuota: z.boolean(),
  orphanSweep: z.object({ after: z.string(), table: z.string(), col: z.string() }).nullable(),
  maxLifetime: z.string().optional(),
  userLookup: userLookupSchema.optional(),
  noUserData: z.literal(true).optional(),
}).refine((b) => (b.userLookup === undefined) !== (b.noUserData === undefined), { message: 'userLookup 和 noUserData 必须二选一' });
export type ManifestBucket = z.infer<typeof bucketSchema>;

/** 记录类型（0.27 第 2 点；按 0.27② 的字段写，systemCols、noConflict 挂在表上，见数据字典 P-01） */
export const recordKindSchema = z.object({
  kind: z.string().regex(/^[a-z]+$/),
  table: z.string(),
  flag: z.string(),                                           // app_config.features 的键
  ai: z.object({ parse: z.boolean(), intent: z.boolean() }),
  plusResult: z.boolean(),
  vector: z.object({ fk: col }).nullable(),                   // 进不进按意思查找、外键列名
});
export type RecordKind = z.infer<typeof recordKindSchema>;

export const manifestSchema = z.object({
  feature: z.string(),
  owner: z.enum(['core', 'feature']),
  tables: z.array(tableSchema),
  buckets: z.array(bucketSchema).default([]),
  recordKinds: z.array(recordKindSchema).default([]),
  /** 本功能用到的 settings 键前缀（settings 只有一张表、归 core，各功能在这里声明，3.5 第 5 点） */
  settingsKeys: z.array(z.string()).default([]),
  ai: z.object({
    sendsToAI: z.boolean(),
    functions: z.array(z.string()),
    /** 每张表哪些列要算向量（D1 和 enqueue_embed() 的触发列比对） */
    vectors: z.record(z.string(), cols),
  }).optional(),
  usageReport: z.object({ rows: z.boolean(), buckets: z.boolean() }).default({ rows: false, buckets: false }),
  /** 额外的向量写入来源（vault_ai，登记在 search.ts，D1 不报“多出来”） */
  extraEmbedSources: z.array(z.string()).default([]),
});
/** 清单作者写的形状（带默认值的字段可以省） */
export type ManifestInput = z.input<typeof manifestSchema>;
/** 校验以后的形状（默认值已补上） */
export type Manifest = z.output<typeof manifestSchema>;

/** 各清单文件用它包一层：写错字段在加载时就报错 */
export function defineManifest(m: ManifestInput): Manifest {
  return manifestSchema.parse(m);
}
