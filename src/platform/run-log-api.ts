// 全局运行日志的“记一行”入口（platform/run-log.ts 首屏画完后才下载；在那之前记的先排在 globalThis 的小队列里，下载好以后补进去）
// 业务代码（打字条提交、随手记提交等）用 rlog 记“这一步做了什么、结果怎样”；只记长度、状态、原因，不记用户输入的文字。
// 11-28 起正式版也常开（负责人贴正式版诊断问“为啥关于没有发送log跟复制log”，弹窗选“正式版也带”；原来 R-398 定的是正式版不带、整段摇掉）
interface RunLogSlot {
  q: Array<[number, string]>;
  sink?: ((line: string) => void) | undefined;
}

export const RL_SLOT = '__lemoRunLog';
/** 诊断找底栏用的选择器（kit GlassBar 的 data-testid；运行日志、冷启动高度校正、诊断信息都用这一份） */
export const BAR_SELECTOR = '[data-testid="tabbar"]';
const MAX_EARLY = 300;

/** 运行日志开着没有：11-28 起各版都开（常量 true）。参数要读版面、排定时器的日志仍先判它，以后要关只改这一处 */
export const RLOG_ON: boolean = true;

export function rlog(line: string): void {
  if (!RLOG_ON) return;
  const g = globalThis as unknown as Record<string, RunLogSlot | undefined>;
  const slot = (g[RL_SLOT] ??= { q: [] });
  if (slot.sink) slot.sink(line);
  else if (slot.q.length < MAX_EARLY) slot.q.push([Date.now(), line]);
}
