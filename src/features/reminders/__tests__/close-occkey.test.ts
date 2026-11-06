// 撤回判定按 occurrenceKey（REMIND-close-occkey 前端一半；方案第 6 节、修订 1 L1，第 9 节第 7 条里 App 那部分；SW 那部分归前端 A）
// • shouldCloseShown：通知带了 key 先按 key 判——等于这一次的留着、不等就关，不看 tag（默认时刻 20:00 时“D 当天”和“D+1 前一天”同一个时刻）；
//   没带 key 照旧（tag 相同留着、不同按天推断）
// • closeHandledNotifications：从通知 data 读 occurrence_key，validOccurrenceKey 校验，不合格当没带
import { describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { closeHandledNotifications } from '../../../platform/notifications.ts';
import { shouldCloseShown } from '../data/local-notify.ts';
import { allReminders, occurrenceKey } from '../data/reminder-model.ts';

const SEOUL = 'Asia/Seoul';
const ID = '0b6f4f1e-2c7d-4a7e-9a55-111111111111';
const at = (d: string, hm: string): number => msAt(d, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), SEOUL);
const row = (over: Record<string, unknown>) => ({ id: ID, title: '体检', time: null, tz: null, deleted_at: null, notified_for: null, ...over });
const list = (over: Record<string, unknown>, now: number, defaultTime: string) => allReminders([row(over)], [], now, SEOUL, null, defaultTime);

describe('shouldCloseShown 带 key', () => {
  it('L7 的例子：旧通知 key 是 …:allday:D:1，现在是 …:allday:D−1:0（默认时刻 20:00，tag 相同）：关掉；key 相同留着', () => {
    // 现在：11-05 当天 20:00；旧通知：11-06 的前一天提醒（11-05 20:00），同一个时刻
    const l = list({ date: '2026-11-05', remind_days: 0 }, at('2026-11-05', '20:10'), '20:00');
    const r = l[0];
    if (!r) throw new Error('no reminder');
    const due = at('2026-11-05', '20:00');
    expect(r.tag).toBe(`event:${ID}:${due}`);
    const t = { kind: 'event', id: ID, dueAt: due };
    expect(shouldCloseShown({ ...t, occurrenceKey: `event:${ID}:allday:2026-11-06:1` }, l, true, SEOUL)).toBe(true);
    expect(shouldCloseShown({ ...t, occurrenceKey: occurrenceKey(r) }, l, true, SEOUL)).toBe(false);
    // 没带 key：tag 相同就留着（旧行为，拿不到 data 的平台）
    expect(shouldCloseShown(t, l, true, SEOUL)).toBe(false);
    expect(shouldCloseShown({ ...t, occurrenceKey: null }, l, true, SEOUL)).toBe(false);
  });

  it('带 key、key 相同但 tag 不同（改了默认时刻，R-336 ①）：留着；已处理的照旧关；找不到这一行按 rowKnown', () => {
    const l = list({ date: '2026-11-05', remind_days: 0 }, at('2026-11-05', '07:30'), '07:20');
    const r = l[0];
    if (!r) throw new Error('no reminder');
    const old = { kind: 'event', id: ID, dueAt: at('2026-11-05', '07:00'), occurrenceKey: occurrenceKey(r) };
    expect(shouldCloseShown(old, l, true, SEOUL)).toBe(false);
    const acked = list({ date: '2026-11-05', remind_days: 0, notified_for: at('2026-11-05', '07:00') }, at('2026-11-05', '07:30'), '07:20');
    expect(shouldCloseShown(old, acked, true, SEOUL)).toBe(true);
    expect(shouldCloseShown(old, [], false, SEOUL)).toBe(false);
  });
});

describe('closeHandledNotifications 读通知 data 的 occurrence_key', () => {
  const mk = (tag: string, data?: unknown) => ({ tag, data, close: vi.fn() });
  it('合格的 key 交给判断函数；不合格（别的 id、日期不存在、不是字符串）当没带', async () => {
    const due = at('2026-11-05', '20:00');
    const tag = `event:${ID}:${due}`;
    const seen: Array<string | null | undefined> = [];
    const ns = [
      mk(tag, { occurrence_key: `event:${ID}:allday:2026-11-06:1` }),
      mk(tag, { occurrence_key: `event:0b6f4f1e-2c7d-4a7e-9a55-222222222222:allday:2026-11-06:1` }),
      mk(tag, { occurrence_key: `event:${ID}:allday:2026-02-30:0` }),
      mk(tag, { occurrence_key: 42 }),
      mk(tag),
    ];
    await closeHandledNotifications(
      (t) => {
        seen.push(t.occurrenceKey);
        return false;
      },
      { registration: async () => ({ getNotifications: async () => ns }) },
    );
    expect(seen).toEqual([`event:${ID}:allday:2026-11-06:1`, null, null, null, null]);
  });
});
