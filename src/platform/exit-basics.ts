// 退出流程里首屏也要用的几样小工具（11-07 B2-UI-a 首屏瘦身 U7，主持人定 A）：从 platform/sign-out.ts 原样搬来，一行没改。
// 首屏的 core/cache.ts（deleteLocalDb）、platform/account-status.ts、onboarding 的 consent-api.ts（withTimeout）只用到这几样，
// 改从这里引以后 sign-out.ts 本体不再被首屏带进来，只跟设置页、登录页的分包一起下载（那两页本来就静态引它，没有新的“下载失败”路径）。
// sign-out.ts 把这里的东西原样转出，原有的 import 不用改
/** 本机库名（= core/cache.ts 的 DB_NAME；platform 不引 core，测试守着两边一致） */
export const LOCAL_DB_NAME = 'planner-v4';
/** 删库最多等多久（别的标签页开着库时浏览器会等它关） */
export const DELETE_WAIT_MS = 3000;

/**
 * 到点还没返回就用 fallback() 的值；run 抛错（同步或异步）也用 fallback()。fallback 只给值，不要有副作用。
 * 原来的请求不取消：它在超时以后才回来时调一次 onLate
 */
export function withTimeout<T>(run: () => Promise<T>, ms: number, fallback: () => T, onLate?: () => void): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const req = Promise.resolve().then(run);
  const late = (): void => {
    if (timedOut) onLate?.();
  };
  req.then(late, late);
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(fallback());
    }, ms);
  });
  return Promise.race([req.catch(() => fallback()), timeout]).finally(() => clearTimeout(timer));
}

export type DeleteDbResult = 'deleted' | 'blocked' | 'error' | 'unavailable';

/** 按库名删掉本机库；永远 resolve。别的标签页没关库（blocked）时最多等 waitMs，删库请求留在浏览器里，那边一关就删 */
export function deleteLocalDb(
  factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB,
  name: string = LOCAL_DB_NAME,
  waitMs: number = DELETE_WAIT_MS,
): Promise<DeleteDbResult> {
  if (!factory) return Promise.resolve('unavailable');
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: DeleteDbResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish('blocked'), waitMs);
    try {
      const req = factory.deleteDatabase(name);
      req.onsuccess = () => finish('deleted');
      req.onerror = () => finish('error');
    } catch {
      finish('error');
    }
  });
}
