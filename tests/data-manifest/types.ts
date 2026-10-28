// 生成器读的清单形状（架构 3.5 第 1 点）。只写生成器用到的字段，按结构匹配：
// 后端的 shared/schema/manifest.ts（zod 推出来的类型）的清单对象能直接传进来（tests/data-manifest/generate.test.ts 用真清单跑一遍）。
// B0 集成：字段名按后端的类型改过 —— pathPattern 的 segment → level、orphanSweep.olderThan → after（可为 null）、加 rowRef。

/** “这个人的数据怎么找”（3.5 userLookup） */
export type UserLookup =
  | { by: 'column'; col: string }
  | { by: 'keyPattern'; col: string; pattern: string }
  | { by: 'emailHash'; col: string }
  | { by: 'registry'; table: string; col: string; pathCol?: string }
  | { by: 'pathPattern'; level: number }
  /** 表里没有 user_id，按 (tableCol, idCol) 引用的那一行找主人（remind_queue） */
  | { by: 'rowRef'; tableCol: string; idCol: string };

export interface VaultRows {
  flag: string;
  cipherCols: readonly string[];
  plainColsMustBeNull: readonly string[];
  neutralCols?: readonly string[] | undefined;
}

export interface ManifestTable {
  name: string;
  schema: 'public' | 'private';
  /** true：同步到设备（挂 touch()、有 rev）；'tombstone'：墓碑表；false：不同步 */
  sync: boolean | 'tombstone';
  softDelete?: boolean | undefined;
  onAccountDelete?: 'cascade' | 'explicit' | 'keep-id-only' | undefined;
  clientWritable?: readonly string[] | undefined;
  systemCols?: readonly string[] | undefined;
  vaultRows?: VaultRows | undefined;
  userLookup?: UserLookup | undefined;
  noUserData?: true | undefined;
}

export interface OrphanSweep {
  /** 多久以前的孤儿才清（'24 hours'） */
  after: string;
  table: string;
  col: string;
}

export interface ManifestBucket {
  name: string;
  /** 例如 '<user_id>/anniv/' */
  pathPrefix?: string | undefined;
  pathPattern?: string | undefined;
  orphanSweep?: OrphanSweep | null | undefined;
  /** 临时桶的最长存活时间，例如 vault-preview 的“链接有效期 + 1 分钟” */
  maxLifetime?: string | undefined;
  userLookup?: UserLookup | undefined;
  noUserData?: true | undefined;
}

/** 本机 IndexedDB 里不对应服务器表的仓（meta、outbox、drafts…，数据字典 10 节） */
export interface LocalStore {
  name: string;
  rebuildable?: boolean | undefined;
}

export interface Manifest {
  feature: string;
  owner: string;
  tables: readonly ManifestTable[];
  buckets?: readonly ManifestBucket[] | undefined;
  localStores?: readonly LocalStore[] | undefined;
}
