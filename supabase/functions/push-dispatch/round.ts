// push-dispatch 一轮的处理（架构 5.3 第 0～8 步、“push-dispatch 的超时、预算和不重复”、6.1；B2 任务单 BE-2；架构审 D3、D6、D7；
// B2 安全审查“留给 BE-2 的条件”、六之四补的 Topic 条件；代码审查 BE-1 S10、R1）。
// 数据库、共享 logic、发送都由调用方注入（core.ts 的 handle、index.ts 接线），Vitest 直接测这一份。不 import npm 包、不碰 Deno 全局。
//
// 第 0 步（原 tz-recalc，D6）：private.remind_queue_pop 出队即删（≤ QUEUE_POP_LIMIT；孤儿在函数里删，账号不可用的不出队，见迁移
//   20261103130000）→ 按行重算 remind_at：待办用 profiles.current_tz，有时间的日程用它自己的 tz；**一律传这一行现在的 remind_at 作
//   prevRemindAt**（代码审查 BE-1 R1：漏传就退回“回落”，按过“稍后”后重算会吞掉这次提醒）；纪念日交 anniv 钩子（B5 填实现）。
//   时区不认识的那一行跳过、记 logs tz_invalid（code：日程自己的 tz 不认识写表名 events，current_tz 不认识写 profiles（11-04）；不写时区串和标题；每人每小时最多一条），不影响同批（D7）。
//   写回带乐观条件（remind_at 还是读到的值）；写回失败、没更新到、时间预算到了没处理的插回队列；profiles 里没有这个人的丢弃（记原因码）。
//   出队即删：插回之前进程崩溃，这一项就丢了，要等这一行下次被改才再入队（风险和兜底写在架构 5.3 第 0 步、接手清单）。
// 第 1 步：due_at = greatest(remind_at, snooze_at, defer_until)，now − 60 分钟 < due_at ≤ now + 60 秒，deleted_at 为空、undone 为假、
//   待办 done 为假，coalesce(pushed_for, 0) ≠ due_at、coalesce(notified_for, 0) ≠ remind_at（remind_at 为空的按 SQL 语义不算到点）；
//   以上在 SQL 里精确判（private.remind_due，迁移 20261103140000），只回可用账号的，每人最多 PER_USER_PER_MINUTE 条（按 due_at 先后），
//   全轮最多 DUE_LIMIT 条；回来再用 isDue、filterUsable 判一遍。
// 第 2 步：免打扰按 current_tz（设置 remind.dnd）：落在里面的写 defer_until = 免打扰结束，这一轮跳过。current_tz 不认识时，有时刻的
//   日程改用它自己的 tz 照常推，待办、纪念日、全天日程这一轮跳过（R-316），都记 tz_invalid。
// 第 3 步：先认领再发——条件更新 pushed_for = due_at（pushed_for is distinct from due_at），更新到 1 行才发；认领、发送、写回各是独立的
//   语句，不在事务里等外部调用，不加全局锁。**最多一次**：认领后发出前出错，这一条不再推（pushed_for 已经等于 due_at），App 的“错过的提醒”兜底。
// 第 4 步：文案 notify-text → t(key, params, ui_locale)；写不写标题看 push_show_title ?? remind.show_title ?? true；source = chat 加“来自 Claude ·”。
// 第 5 步：发给这个人所有设备（devices 里 deleted_at 为空、有订阅的），只经 _shared/push/send.ts 的 deliver：
//   ok → last_push_ok_at、push_fail_count 归 0；gone（404、410）→ 删订阅（三列置空）；bad_endpoint、bad_keys → 三列置空、记 push_bad_endpoint；
//   vapid_rejected（401、403）和其余失败 → 只加 push_fail_count、不删订阅。一台设备这一轮被删了订阅，后面的条目不再发给它。
//   **不发 Topic 头**（安全审查六之四补：Topic 是明文，不能用条目 id 或 tag；每次提醒的 tag 都不同，用不上合并，所以干脆不带）。
// 第 5 步之二：Edge 的 resolve——上一次推过（pushed_for 在 60 分钟窗口内）、之后在别处处理了（notified_for = remind_at；按了“稍后”、
//   改了时间或关了提醒，due_at 已不等于 pushed_for；R-317：待办完成、条目删除或撤销）的（private.remind_pushed 精确判），条件更新 pushed_for = null（只有一轮拿得到），再给这个人**端点主机不属于 *.push.apple.com** 的设备发
//   resolve（按 checkEndpoint 的 apple 判断，不看 devices.platform，0.49 第 1 条）。排在提醒之后、同样受预算和条数上限约束。
// 第 6 步：纪念日推过以后由 anniv 钩子算下一次（B5 填实现；钩子回 null 就不写）。
// 第 7 步：logs（push_ok、push_failed、push_bad_endpoint、tz_invalid），只写原因码、表名、条目和设备 id，**不写标题、地址、响应内容**。
// 第 8 步：心跳 detail 记 claimed、sent、failed、budget_hit（按条目计：一条认领了、至少一台设备 ok 算 sent，一台都没成算 failed；
//   claimed − sent − failed 就是认领后没发出去的，lemo-ops 照 6.1 判断）。
// 时间预算：一轮最长 limits.budgetMs 墙钟，到点不再认领新条目（第 0 步也不再处理新行），已认领的发完；发送并发 limits.concurrency；
//   每轮发送（deliver 调用）最多 limits.sendLimit 次；预算或条数到了 budget_hit 为真，left 是没来得及认领的到点条目数（上界，见第 2 步）。
// 11-03 拆分（REMIND-round-split，只搬家、不改行为）：类型和常量在 round-types.ts，小工具和 filterUsable 在 round-util.ts，
//   第 0 步在 round-step0.ts，第 1～8 步在 round-dispatch.ts；这里留 runRound、写 logs，并照旧导出原来的全部名字。
import type { LogRow, RoundCtx, RoundResult } from './round-types.ts';
import { steps1to8 } from './round-dispatch.ts';
import { step0 } from './round-step0.ts';

export * from './round-types.ts';
export { dueAtOf, filterUsable, isDue, isHandledAfterPush, parseDnd, pool, renderText, showTitleOf } from './round-util.ts';

// ---------------- 一轮 ----------------

export async function runRound(c: RoundCtx): Promise<RoundResult> {
  const logs: LogRow[] = [];
  const res: RoundResult = { claimed: 0, sent: 0, failed: 0, budget_hit: false, left: 0 };
  const overBudget = () => c.now() - c.t0 >= c.limits.budgetMs;

  await step0(c, logs, overBudget);
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
  } catch {
    if (batch.length <= 20) {
      c.log('logs_failed');
      return;
    }
  }
  for (let i = 0; i < batch.length; i += 20) {
    try {
      await c.store.insertLogs(batch.slice(i, i + 20));
    } catch {
      c.log('logs_failed');
    }
  }
}
