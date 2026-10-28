// 清单共用的片段：公共列、找人方式（只放常量，不放逻辑）

/** 有公共列的表（3.2）都有这几列；隐私记行的 neutralCols 都含它们 */
export const COMMON_COLS = ['id', 'user_id', 'rev', 'fv', 'deleted_at', 'undone', 'synced_at', 'legacy_id'] as const;

/** 按 user_id 找人 */
export const BY_USER = { by: 'column', col: 'user_id' } as const;

/** 客户端只在 update 时写的公共列（删除、撤销，0.29 P-40） */
export const SOFT_DELETE_COLS = ['deleted_at', 'undone'] as const;

/** uuid 段（存储策略的正则写法，和 3.3 G 一字不差） */
export const UUID_RE = '[0-9a-f-]{36}';
