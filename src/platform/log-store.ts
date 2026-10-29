// 日志上传队列的本机存放（架构 0.38 第 68 条；接手清单 K8-logs）：localStorage 的 lemo.logq.<user_id>，一个账号一个键
// • 不进 IndexedDB（4.1“logs 不进缓存，只放在上传队列里”），不升 DB_VERSION；队列的规矩（上限、丢最旧、上传）在 core/log
// • 读写一律包 try/catch：读失败返回 undefined、写失败返回 false，调用方退回只放内存
// • 退出登录时清（platform/sign-out.ts 的 signOutThisDevice）；被移除、停用、注销冷静期时清（app/main.tsx 交给 wireSync 的 clearLogs）
export const LOG_QUEUE_PREFIX = 'lemo.logq.';

export const logQueueKey = (userId: string): string => `${LOG_QUEUE_PREFIX}${userId}`;

/** 一个账号的队列在 localStorage 里的读写（存的是 JSON 文本，格式由 core/log 定） */
export interface LogQueueStore {
  /** 没有为 null；读不了（隐私模式、被禁用）为 undefined */
  read(): string | null | undefined;
  /** 写成功 true；配额满、被禁用 false */
  write(text: string): boolean;
}

export function logQueueStore(userId: string, storage?: Storage): LogQueueStore {
  const key = logQueueKey(userId);
  return {
    read() {
      try {
        return (storage ?? localStorage).getItem(key);
      } catch {
        return undefined;
      }
    },
    write(text) {
      try {
        (storage ?? localStorage).setItem(key, text);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** 清掉日志队列：给了 userId 只清这个账号的，没给（读不到是谁）清全部 lemo.logq.*；不抛 */
export function clearLogQueue(userId: string | null, storage?: Storage): void {
  try {
    const s = storage ?? localStorage;
    if (userId) {
      s.removeItem(logQueueKey(userId));
      return;
    }
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(LOG_QUEUE_PREFIX)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    // 存储不可用：本来也存不下
  }
}

/** 换了账号：清掉别的账号留下的队列（旧账号没传完的日志不再传，和 outbox 换账号时直接丢一致）；不抛 */
export function clearOtherLogQueues(userId: string, storage?: Storage): void {
  try {
    const s = storage ?? localStorage;
    const mine = logQueueKey(userId);
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(LOG_QUEUE_PREFIX) && k !== mine) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    // 同上
  }
}
