// Supabase Storage 列一层目录（不递归）的分页循环：backup-daily、backup-manifest、account-purge 原来各写一份（B7a 评审第 15 条），收到这里。
// 每页 1000 个、按名字升序；id 为 null 的是子目录（Storage 的 list 对“文件夹”回 id: null）。出错一律抛 storage。
// 不 import npm 包：只要求 supabase-js 的 storage.from(桶) 有 list 这一个方法。

export const STORAGE_LIST_LIMIT = 1000;

interface RawItem {
  name: string;
  id: string | null;
  updated_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** supabase-js 的 storage.from(桶) */
export interface StorageLister {
  list(path: string, options: { limit: number; offset: number; sortBy: { column: string; order: string } }): PromiseLike<{ data: RawItem[] | null; error: unknown }>;
}

export interface StorageItem {
  name: string;
  folder: boolean;
  /** 文件大小（metadata.size）；目录、没有时为 null */
  bytes: number | null;
  updatedAt: string | null;
}

export async function listDir(bucket: () => StorageLister, dir: string): Promise<StorageItem[]> {
  const out: StorageItem[] = [];
  for (let offset = 0; ; offset += STORAGE_LIST_LIMIT) {
    const { data, error } = await bucket().list(dir, { limit: STORAGE_LIST_LIMIT, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error('storage');
    const page = data ?? [];
    for (const o of page) {
      const size = (o.metadata as { size?: unknown } | null | undefined)?.size;
      out.push({ name: o.name, folder: o.id === null, bytes: typeof size === 'number' ? size : null, updatedAt: o.updated_at ?? null });
    }
    if (page.length < STORAGE_LIST_LIMIT) return out;
  }
}
