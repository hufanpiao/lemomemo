// 最多 n 个并发跑完一批（纯 TS，不引 npm 包）：push-dispatch 发送、判可用账号；anniv-roll 判可用账号（11-14 从 push-dispatch/round-util.ts 挪来，整块评审第 10、25 条）
/** 最多 n 个并发跑完 items（顺序领取；fn 自己吞错） */
export async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const it = items.values();   // 几个 worker 共用一个迭代器，各取下一项
  const worker = async () => {
    for (let x = it.next(); !x.done; x = it.next()) await fn(x.value);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}
