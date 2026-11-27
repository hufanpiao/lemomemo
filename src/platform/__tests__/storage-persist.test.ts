// 申请持久存储（platform/storage-persist.ts）：不弹东西、结果只进运行日志；不支持、抛错都不影响启动
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RL_SLOT } from '../run-log-api.ts';
import { askPersistStorage } from '../storage-persist.ts';

const lines: string[] = [];
const g = globalThis as unknown as Record<string, { q: unknown[]; sink?: (l: string) => void } | undefined>;
g[RL_SLOT] = { q: [], sink: (l) => void lines.push(l) };
afterEach(() => {
  lines.length = 0;
});

describe('askPersistStorage', () => {
  it('给了、没给、不支持、抛错各记一行', async () => {
    const persist = vi.fn(async () => true);
    await askPersistStorage({ persist } as unknown as StorageManager);
    expect(persist).toHaveBeenCalledOnce();
    await askPersistStorage({ persist: async () => false } as unknown as StorageManager);
    await askPersistStorage({} as StorageManager);
    await askPersistStorage({ persist: () => Promise.reject(new Error('x')) } as unknown as StorageManager);
    expect(lines).toEqual(['storage persist granted', 'storage persist denied', 'storage persist none', 'storage persist error']);
  });
});
