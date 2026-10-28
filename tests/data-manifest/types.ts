// 生成器读的清单形状（架构 3.5 第 1 点）。只写生成器用到的字段，按结构匹配：
// 后端的 shared/schema/manifest.ts（zod 推出来的类型）就位后，它的清单对象应当能直接传进来；
// 字段名对不上时以后端的类型为准，改这里和 generate.ts。

/** “这个人的数据怎么找”（3.5 userLookup） */
export type UserLookup =
  | { by: 'column'; col: string }
  | { by: 'keyPattern'; col: string; pattern: string }
  | { by: 'emailHash'; col: string }
  | { by: 'registry'; table: string; col: string; pathCol?: string }
  | { by: 'pathPattern'; segment?: number };

export interface VaultRows {
  flag: string;
  cipherCols: readonly string[];
  plainColsMustBeNull: readonly string[];
  neutralCols?: readonly string[];
}

export interface ManifestTable {
  name: string;
  schema: 'public' | 'private';
  /** true：同步到设备（挂 touch()、有 rev）；'tombstone'：墓碑表；false：不同步 */
  sync: boolean | 'tombstone';
  softDelete?: boolean;
  onAccountDelete?: 'cascade' | 'explicit' | 'keep-id-only';
  clientWritable?: readonly string[];
  systemCols?: readonly string[];
  vaultRows?: VaultRows;
  userLookup?: UserLookup;
  noUserData?: true;
}

export interface OrphanSweep {
  olderThan: string;
  table: string;
  col: string;
}

export interface ManifestBucket {
  name: string;
  /** 例如 '<user_id>/anniv/' */
  pathPrefix?: string;
  pathPattern?: string;
  orphanSweep?: OrphanSweep;
  /** 临时桶的最长存活时间，例如 vault-preview 的“链接有效期 + 1 分钟” */
  maxLifetime?: string;
  userLookup?: UserLookup;
  noUserData?: true;
}

/** 本机 IndexedDB 里不对应服务器表的仓（meta、outbox、drafts…，数据字典 10 节） */
export interface LocalStore {
  name: string;
  rebuildable?: boolean;
}

export interface Manifest {
  feature: string;
  owner: string;
  tables: readonly ManifestTable[];
  buckets?: readonly ManifestBucket[];
  localStores?: readonly LocalStore[];
}
