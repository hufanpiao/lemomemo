// 全局运行日志的“记一行”入口（platform/run-log.ts 首屏画完后才下载；在那之前记的先排在 globalThis 的小队列里，下载好以后补进去）
// 业务代码（打字条提交、随手记提交等）用 rlog 记“这一步做了什么、结果怎样”；只记长度、状态、原因，不记用户输入的文字。
// 正式构建靠 MODE 常量整段摇掉
interface RunLogSlot {
  q: Array<[number, string]>;
  sink?: ((line: string) => void) | undefined;
}

export const RL_SLOT = '__lemoRunLog';
/** 诊断找底栏用的选择器（kit GlassBar 的 data-testid；运行日志、冷启动高度校正、冷启动时间线、诊断信息都用这一份） */
export const BAR_SELECTOR = '[data-testid="tabbar"]';
const MAX_EARLY = 300;

export function rlog(line: string): void {
  if (import.meta.env.MODE === 'production') return;
  const g = globalThis as unknown as Record<string, RunLogSlot | undefined>;
  const slot = (g[RL_SLOT] ??= { q: [] });
  if (slot.sink) slot.sink(line);
  else if (slot.q.length < MAX_EARLY) slot.q.push([Date.now(), line]);
}

/** 进日志的错误类型名：` type=<名>`，只收字母；认不出返回空串。错误的 message 可能带用户内容，不记 */
export function errTag(err: unknown): string {
  const name = typeof err === 'object' && err !== null && 'name' in err ? (err as { name: unknown }).name : null;
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? ` type=${name}` : '';
}
