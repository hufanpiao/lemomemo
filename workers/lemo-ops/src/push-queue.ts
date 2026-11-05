// lemo-ops 里 push-dispatch 第 0 步（提醒时刻重算队列）的两条提示（租约出队审查返工，安全审查必改 3、代码审查 L3；11-04 主持人定口径）。
// usage-report 按 DETAIL_FIELDS_BY_NAME['push-dispatch'] 白名单转发 push-dispatch 心跳里的 queue_ok、queue_poison（只是个数，没有任何条目、账号标识）。
// 只做纯计算；rules.ts 的 evaluateHeartbeat 调这里，去重、宽限期和发信在 alerts.ts。
//
// 口径（push-dispatch/core.ts 的 HeartbeatDetail 注释）：
//   • queue_ok：push-dispatch 最近一轮第 0 步出队、读行、收尾都没出错是 1，否则 0。心跳每分钟一轮、lemo-ops 15 分钟抽一次，
//     偶发的一轮失败多半抽不到，也不该提示（租约过期后下一轮会重取）；**连续 3 次抽查都是 0**（约 45 分钟）才提示：
//     多半是回滚到了租约版之前的 push-dispatch（调不到新签名，第 0 步每轮都跳过），或出队函数持续出错——
//     这时到点推送照常，但编辑过的提醒一直不重算，不提示就没人知道。
//     **心跳里有 sent 却没有 queue_ok 也按 0 算**：租约版之前的 push-dispatch 不写这个数，迁移 20261104130000 上了以后
//     只有回滚到那之前的函数才会这样写，而它的第 0 步每轮都调不到新签名、一直跳过（上线手册第 2 层）。
//     只回滚 push-dispatch、lemo-ops 和 usage-report 还是新版时靠这一条发现；连 lemo-ops 一起回滚到旧 tag 时它也没了，手册里另写了怎么查。
//   • queue_poison：首尔当天累计丢掉的有毒项个数（同一项取过 5 次都没处理完，每次都把函数弄死）。> 0 当天提示：
//     这些项的提醒时刻没重算，要等用户再改一次才会重新入队；要人看函数日志里的 queue_poison、round_failed，找出一算就崩的原因。
//     首尔 0 点后 push-dispatch 从 0 重新算，这件事随后报“已恢复”。
// 标题不带个数（个数变了不算“情况有变”反复发信，同 purge-detail.ts）；正文只写个数。
import type { Issue } from './rules.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export const PUSH_QUEUE_STALLED = 'push-queue:stalled';
export const PUSH_QUEUE_POISON = 'push-queue:poison';
/** queue_ok = 0 连续几次抽查才提示（lemo-ops 15 分钟一轮，3 轮约 45 分钟） */
export const PUSH_QUEUE_STALLED_ROUNDS = 3;

/** push-dispatch 心跳 detail 的两条提示；detail 不是对象、字段缺或不是非负整数的，那一条就不判 */
export function evaluatePushQueue(detail: unknown): Issue[] {
  if (!isObj(detail)) return [];
  const out: Issue[] = [];
  const ok = detail['queue_ok'];
  const poison = detail['queue_poison'];
  const legacy = ok === undefined && isCount(detail['sent']);   // 租约版之前的 push-dispatch：不写 queue_ok
  if ((isCount(ok) && ok === 0) || legacy) {
    out.push({
      key: PUSH_QUEUE_STALLED,
      title: '推送服务的提醒时刻重算一直失败',
      lines: [
        legacy
          ? 'push-dispatch 的心跳里连续 3 次抽查（约 45 分钟）都没有 queue_ok：在跑的是租约版之前的 push-dispatch，第 0 步（按队列重算提醒时刻）每轮都跳过。到点推送照常，但用户编辑过的提醒一直不重算，可能按旧时刻响或不响。'
          : 'push-dispatch 的第 0 步（按队列重算提醒时刻）连续 3 次抽查（约 45 分钟）都失败了。到点推送照常，但用户编辑过的提醒一直不重算，可能按旧时刻响或不响。',
        '常见原因：push-dispatch 回滚到了租约版之前（调不到 remind_queue_pop(int, int, boolean)），或出队、收尾函数持续出错。',
        '请看函数日志里的 queue_pop_failed、queue_finish_failed、recalc_read_failed；回滚的话尽快重新部署租约版，积压的项之后每轮最多 500 项（每人 50 项）逐轮消化（见上线与回滚手册第 2 层）。',
      ],
      minRounds: PUSH_QUEUE_STALLED_ROUNDS,
    });
  }
  if (isCount(poison) && poison > 0) {
    out.push({
      key: PUSH_QUEUE_POISON,
      title: '有提醒的重算被当成有毒项丢掉了',
      lines: [
        `push-dispatch 今天（首尔时间）丢掉了 ${poison} 项：同一项取过 5 次都没处理完（每次都把函数弄死，例如 CPU 超限、数据坏了）。`,
        '这些项的提醒时刻没有重算，要等用户再改一次这一行才会重新入队；同批别的项不受影响（一项一项单独重试）。',
        '请看函数日志里的 queue_poison、round_failed 和同一时间的 CPU 超限记录，找出一算就崩的原因。首尔 0 点后从 0 重新计数。',
      ],
    });
  }
  return out;
}
