// 申请持久存储（navigator.storage.persist）：浏览器空间紧张时不先清本站的本机库（离线写入还没上传的都在里面）。
// 启动同步时调一次（app/sync-wiring.ts），不弹任何东西：有的浏览器自己决定给不给，不支持就跳过；结果只记运行日志（granted / denied / none / error）
// 不在首屏：sync-wiring 是首屏画完后才下载的那一批
import { rlog } from './run-log-api.ts';

export async function askPersistStorage(storage: StorageManager | undefined = globalThis.navigator?.storage): Promise<void> {
  try {
    if (!storage?.persist) return rlog('storage persist none');
    rlog(`storage persist ${(await storage.persist()) ? 'granted' : 'denied'}`);
  } catch {
    rlog('storage persist error');
  }
}
