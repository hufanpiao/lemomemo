// 纪念日的提醒（B5 S15）：这一次的提醒时刻（shared 的 annivRemindFrom）、进提醒列表、按钮、说明文字、生成待办的整行
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { actionsFor } from '../../../../shared/logic/remind-actions.ts';
import { reminderTag } from '../../../../shared/logic/remind-route.ts';
import { whenMsg } from '../data/remind-format.ts';
import { annivTodoDue, annivTodoRow } from '../data/remind-write.ts';
import { dndOf } from '../data/remind-settings.ts';
import { actionsOf } from '../hooks/useReminders.ts';
import { allReminders, MISSED_WINDOW_MS, missed, modeOf, upcoming, type AnnivAt } from '../data/reminder-model.ts';

// next-date 带农历表，src 里只准按需加载（check_arch LUNAR）
const { annivRemindFrom } = await import('../../../../shared/logic/anniv/next-date.ts');
const TZ = 'Asia/Seoul';
const at = (d: string, hm: string): number => msAt(d as never, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), TZ);
const row = (x: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000001', kind: 'birthday', name: '김지민', calendar: 'solar', lunar_variant: 'cn', month: 11, day: 20,
  is_leap: false, year: 1997, after_due: 'archive', remind_offsets: null, remind_time: null, created_at: Date.UTC(2020, 0, 1),
  notified_for: null, snooze_at: null, deleted_at: null, undone: false, ...x,
});
const annivAt: AnnivAt = (r, now) => annivRemindFrom(r, TZ, now, {}, MISSED_WINDOW_MS);

describe('纪念日这一次的提醒时刻（annivRemindFrom）', () => {
  it('默认提前 7 天、前一天 09:00；没按知道了的过了点还在（同一个时刻），按了就往后走', () => {
    const now = at('2026-11-13', '10:00');
    const a = annivRemindFrom(row(), TZ, now, {}, MISSED_WINDOW_MS);
    expect(a).toEqual({ at: at('2026-11-13', '09:00'), date: '2026-11-20' });
    const b = annivRemindFrom(row({ notified_for: a?.at }), TZ, now, {}, MISSED_WINDOW_MS);
    expect(b).toEqual({ at: at('2026-11-19', '09:00'), date: '2026-11-20' });
  });

  it('D-7 没按知道了、到了 D-1：取窗口里最新的一个（D-1），不停在 D-7（整块评审第 2 条）', () => {
    const now = at('2026-11-19', '10:00');
    expect(annivRemindFrom(row(), TZ, now, {}, MISSED_WINDOW_MS)).toEqual({ at: at('2026-11-19', '09:00'), date: '2026-11-20' });
    // D-1 的点还没到：窗口里只有 D-7，还是它
    expect(annivRemindFrom(row(), TZ, at('2026-11-19', '08:00'), {}, MISSED_WINDOW_MS)?.at).toBe(at('2026-11-13', '09:00'));
    // D-7 按过知道了、D-1 到了：D-1
    expect(annivRemindFrom(row({ notified_for: at('2026-11-13', '09:00') }), TZ, now, {}, MISSED_WINDOW_MS)?.at).toBe(at('2026-11-19', '09:00'));
  });

  it('建这一条之前的提醒不算；设置里的默认值和这一条自己的设置都认', () => {
    const now = at('2026-11-13', '10:00');
    expect(annivRemindFrom(row({ created_at: at('2026-11-13', '09:30') }), TZ, now, {}, MISSED_WINDOW_MS)?.at).toBe(at('2026-11-19', '09:00'));
    expect(annivRemindFrom(row(), TZ, now, { 'anniv.default_offsets': [3], 'anniv.default_time': '20:00' }, MISSED_WINDOW_MS)?.at).toBe(at('2026-11-17', '20:00'));
    expect(annivRemindFrom(row({ remind_offsets: [0], remind_time: '08:00' }), TZ, now, {}, MISSED_WINDOW_MS)?.at).toBe(at('2026-11-20', '08:00'));
  });

  it('韩国阴历、认不出的行、已过去的倒数日不提醒', () => {
    const now = at('2026-11-13', '10:00');
    expect(annivRemindFrom(row({ calendar: 'lunar', lunar_variant: 'kr' }), TZ, now, {}, MISSED_WINDOW_MS)).toBeNull();
    expect(annivRemindFrom(row({ kind: 'x' }), TZ, now, {}, MISSED_WINDOW_MS)).toBeNull();
    expect(annivRemindFrom(row({ kind: 'countdown', year: 2026, month: 11, day: 1 }), TZ, now, {}, MISSED_WINDOW_MS)).toBeNull();
  });
});

describe('纪念日进提醒列表（reminder-model）', () => {
  it('标题取 name、tag 用这一次的时刻、带对应的纪念日；推算没加载好（不传）时不算', () => {
    const now = at('2026-11-13', '10:00');
    const [r] = allReminders([], [], now, TZ, null, undefined, { rows: [row()], at: annivAt });
    expect(r).toMatchObject({ kind: 'anniv', title: '김지민', remindAt: at('2026-11-13', '09:00'), annivDate: '2026-11-20', handled: false });
    expect(r?.tag).toBe(reminderTag('anniv', row().id, at('2026-11-13', '09:00')));
    expect(allReminders([], [], now, TZ)).toEqual([]);
  });

  it('打开前到点没处理的进错过的提醒；未来 7 天里列出下一次；提醒方式写“纪念日提醒”', () => {
    const now = at('2026-11-13', '10:00');
    const list = allReminders([], [], now, TZ, null, undefined, { rows: [row()], at: annivAt });
    expect(missed(list, now).map((r) => r.kind)).toEqual(['anniv']);
    const later = allReminders([], [], now, TZ, null, undefined, { rows: [row({ notified_for: at('2026-11-13', '09:00') })], at: annivAt });
    expect(upcoming(later, now, TZ).map((d) => d.date)).toEqual(['2026-11-19']);
    expect(modeOf(later[0] as never)).toEqual({ key: 'remind.mode.anniv', params: {} });
  });

  it('说明文字：7 天后 / 明天 / 就是今天', () => {
    const list = allReminders([], [], at('2026-11-13', '10:00'), TZ, null, undefined, { rows: [row()], at: annivAt });
    const r = list[0] as never;
    expect(whenMsg(r, at('2026-11-13', '10:00'), TZ)).toEqual({ key: 'remind.when.annivIn', params: { n: 7 } });
    expect(whenMsg(r, at('2026-11-19', '10:00'), TZ)).toEqual({ key: 'remind.when.annivTomorrow', params: {} });
    expect(whenMsg(r, at('2026-11-20', '10:00'), TZ)).toEqual({ key: 'remind.when.annivToday', params: {} });
  });
});

describe('纪念日的按钮和生成待办', () => {
  it('知道了 / 明天再提醒（用纪念日的提醒时刻）/ 生成待办', () => {
    const now = at('2026-11-13', '10:00');
    expect(actionsFor({}, 'anniv', now, TZ, { annivTime: '08:30' })).toEqual([
      { key: 'ack', at: null },
      { key: 'tomorrow', at: at('2026-11-14', '08:30') },
      { key: 'genTodo', at: null },
    ]);
  });

  it('提醒页的“明天再提醒”时刻：这一条的 remind_time ?? anniv.default_time ?? 09:00，不合格的跳过（整块评审第 22 条：和推算同一个 remindTimeOf）', () => {
    const now = at('2026-11-13', '10:00');
    const rem = (remind_time: unknown) => ({ kind: 'anniv', row: { remind_time } }) as unknown as Parameters<typeof actionsOf>[0];
    const tomorrow = (r: ReturnType<typeof rem>, annivDefault: unknown) =>
      actionsOf(r, now, TZ, { dnd: dndOf(null), defaultTime: '09:00', annivDefault }).find((x) => x.key === 'tomorrow')?.at;
    expect(tomorrow(rem('06:15'), '07:30')).toBe(at('2026-11-14', '06:15'));
    expect(tomorrow(rem(null), '07:30')).toBe(at('2026-11-14', '07:30'));
    expect(tomorrow(rem('25:99'), '07:30')).toBe(at('2026-11-14', '07:30'));
    expect(tomorrow(rem(null), 'bad')).toBe(at('2026-11-14', '09:00'));
  });

  it('生成的待办：截止日、来源、当天 09:00 提醒，其余列和新建待办一样', () => {
    // 截止：纪念日前一天；当天或已过按的，取今天（整块评审第 14 条）
    expect(annivTodoDue('2026-11-20', '2026-11-13')).toBe('2026-11-19');
    expect(annivTodoDue('2026-11-20', '2026-11-19')).toBe('2026-11-19');
    expect(annivTodoDue('2026-11-20', '2026-11-20')).toBe('2026-11-20');
    expect(annivTodoDue('2026-11-20', '2026-11-21')).toBe('2026-11-21');
    const r = annivTodoRow('00000000-0000-4000-8000-000000000002', '准备：김지민', '2026-11-19', row().id, 5);
    expect(r).toMatchObject({ title: '准备：김지민', due: '2026-11-19', from_anniv_id: row().id, done: false, remind_days: 0, remind_time: '09:00', source: 'page', created_at: 5 });
    // 整行钉住（todos 加列只改 shared/logic/todo-row.ts 一处）
    expect(r).toStrictEqual({
      id: '00000000-0000-4000-8000-000000000002', title: '准备：김지민', done: false, important: false, due: '2026-11-19', due_time: null, remind_before_min: null,
      remind_days: 0, remind_time: '09:00', project: '', note: '', source: 'page', raw_text: '', batch_id: null, from_note_id: null, from_anniv_id: row().id,
      short: null, short_by: null, done_at: 0, push_show_title: null, notified_for: null, snooze_at: null, created_at: 5, updated_at: 5,
    });
  });
});
