// 本环境的四个 R2 桶（0.32 R-213；清单里 store: 'r2' 的桶）。storage-sweep 逐桶清理、usage-report 数字节、account-purge 注销时清空都用这一份；
// 本机拉回的 tools/backup/backup-lib.ps1 有一份同样的名字（$script:R2Buckets），tests/build/backup-format-sync.test.ts 核对两边一致、
// tests/functions/storage-sweep.test.ts 和清单比对。顺序就是 storage-sweep 轮换起点的顺序。
export const R2_BUCKETS = ['images', 'vault-images', 'files', 'vault-files'] as const;
export type R2Bucket = (typeof R2_BUCKETS)[number];
