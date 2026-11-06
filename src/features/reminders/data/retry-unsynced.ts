// “未同步”的重试（接手清单 UNSYNCED-retry-ui；负责人 11-05 定：只加“重试”，不加“放弃”）
// • 对象：给定记录（`${table}:${id}`，一般就是 outbox 状态的 remindRecs）里发送失败的项，不分带不带提醒——
//   同一条记录前后几次修改要按顺序一起重发；只重发带提醒的那几项会打乱顺序
// • gone（另一台设备已删）不在这里重试：retryFailed 本来也跳过它，要走冲突卡的“恢复并保留我的修改”另发 patch；
//   重发必然同样失败的码（本机校验不过、数据字典 10.4b 标“不能”的）也不重试。判断和 outbox 状态的 retryRecs 共用 core 的 canRetryUnsynced
// • 待发、在途的项不用动：它们本来就在队列里；retryFailed 改回 pending 以后 outbox 通知订阅者，同步主页的引擎随即发送
// • 库已关、已封存（换账号、被移除，CacheClosedError）：当作“停下”，不报错（outbox 规则，见 core/outbox-types.ts）
import { CacheClosedError } from '../../../core/cache.ts';
import { canRetryUnsynced } from '../../../core/outbox-logic.ts';
import type { Outbox } from '../../../core/outbox-types.ts';

export type RetryOutbox = Pick<Outbox, 'list' | 'retryFailed'>;

/** 重试这些记录里能重试的发送失败项；返回重试了几项（没有可重试的、库已关都返回 0） */
export async function retryUnsynced(outbox: RetryOutbox, recs: ReadonlySet<string>): Promise<number> {
  try {
    const ids = (await outbox.list()).filter((i) => canRetryUnsynced(i) && recs.has(i.rec)).map((i) => i.op_id);
    if (ids.length === 0) return 0;
    await outbox.retryFailed(ids);
    return ids.length;
  } catch (e) {
    if (e instanceof CacheClosedError) return 0;
    throw e;
  }
}
