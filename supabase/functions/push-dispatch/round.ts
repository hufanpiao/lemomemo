// push-dispatch 一轮（架构 5.3 第 0～8 步、方案-提醒队列重写 3.5～3.7）：数据库、共享 logic、发送都由 core.ts 注入，Vitest 直接测这一份。
// 第 0 步（打租约出队、重算 remind_at、按租约收尾）在 round-step0.ts；第 1、2 步（到点、收回、免打扰）在 round-dispatch.ts；
// 第 3～8 步（认领、发送、resolve、设备结果）在 round-send.ts；类型和上限在 round-types.ts，小工具在 round-util.ts。这里留 runRound 和写 logs。
// 推送“最多一次”：先认领（pushed_for = due_at）再发，认领后出错不再推（App 的“错过的提醒”兜底）。日志只记原因码，不记标题、地址、响应内容。
import type { LogRow, RoundCtx, RoundResult } from './round-types.ts';
import { steps1to8 } from './round-dispatch.ts';
import { step0 } from './round-step0.ts';
import { failCode } from './round-util.ts';

export * from './round-types.ts';
export { dueAtOf, filterUsable, isDue, isHandledAfterPush, parseDnd, pool, renderText, showTitleOf } from './round-util.ts';

// ---------------- 一轮 ----------------

export async function runRound(c: RoundCtx): Promise<RoundResult> {
  const logs: LogRow[] = [];
  const res: RoundResult = { claimed: 0, sent: 0, failed: 0, budget_hit: false, left: 0, queue_ok: 1, queue_poison: 0, recalc_written: 0, recalc_r336: 0, recalc_failed: 0 };
  const overBudget = () => c.now() - c.t0 >= c.limits.budgetMs;

  const q = await step0(c, logs, overBudget);
  res.queue_ok = q.ok ? 1 : 0;
  res.queue_poison = q.poison;
  res.recalc_written = q.written;
  res.recalc_r336 = q.r336;
  res.recalc_failed = q.failed;
  await steps1to8(c, logs, res, overBudget);

  if (logs.length) {
    for (let i = 0; i < logs.length; i += 200) await insertLogsSplit(c, logs.slice(i, i + 200));
  }
  return res;
}

/** 批插失败时拆成 20 条一批重试（代码审查建议 ⑥：一行不合格不连累同批 199 行）；20 条的小批再失败才记 logs_failed */
async function insertLogsSplit(c: RoundCtx, batch: readonly LogRow[]): Promise<void> {
  try {
    await c.store.insertLogs(batch);
    return;
  } catch (e) {
    if (batch.length <= 20) {
      c.log(failCode('logs_failed', e));
      return;
    }
  }
  for (let i = 0; i < batch.length; i += 20) {
    try {
      await c.store.insertLogs(batch.slice(i, i + 20));
    } catch (e) {
      c.log(failCode('logs_failed', e));
    }
  }
}
