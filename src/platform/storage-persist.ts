// 申请持久存储：浏览器空间紧张时不先清本机库（还没上传的离线写入都在里面）。
// 启动同步时调一次（sync-wiring.ts），不弹任何东西，不支持就跳过；结果只记运行日志。不在首屏
import { rlog } from './run-log-api.ts';

export async function askPersistStorage(storage: StorageManager | undefined = globalThis.navigator?.storage): Promise<void> {
  try {
    if (!storage?.persist) return rlog('storage persist none');
    rlog(`storage persist ${(await storage.persist()) ? 'granted' : 'denied'}`);
  } catch {
    rlog('storage persist error');
  }
}
