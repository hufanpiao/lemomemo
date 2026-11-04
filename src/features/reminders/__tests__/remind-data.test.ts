// 提醒功能的纯函数（B2 FA-4）：整页提醒地址校验（FE-3）、设置读写（remind.dnd 和 push-dispatch 同一口径）、本机通知（TC-B2-78、TC-B6X-11 的逻辑部分）、
// push-test 结果、推送被占着的提示（TC-B2-71）、写入（知道了 / 稍后）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { reminderTag } from '../../../../shared/logic/remind-route.ts';

const savePatch = vi.fn(async (..._a: unknown[]) => 'saved' as const);
vi.mock('../../../core/edit-save.ts', () => ({ savePatch: (...a: unknown[]) => savePatch(...a) }));

const { parseReminderHash } = await import('../data/remind-route.ts');
const { dndOf, dndSettingOf, dndValue, settingWrite, showTitleOf } = await import('../data/remind-settings.ts');
const { localDue, localText, shouldCloseShown, staleTags } = await import('../data/local-notify.ts');
const { allReminders, reminderOf } = await import('../data/reminder-model.ts');
const { pushTestResultOf } = await import('../data/push-test.ts');
const { pushNoticeOf, removeHolder, enableNotifications, localInstallId } = await import('../data/push-setup.ts');
const { ackReminder, snoozeReminder, ackAll } = await import('../data/remind-write.ts');
const { dayMsg, whenMsg } = await import('../data/remind-format.ts');

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (date: string, hm: string, tz = SEOUL): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(date, (h ?? 0) * 60 + (m ?? 0), tz);
};
const ID = '0b6f4f1e-2c7d-4a7e-9a55-111111111111';
const todoRow = (over: Record<string, unknown> = {}) => ({
  id: ID, title: '回复 박 대리 的邮件', due: DAY, due_time: '17:00', remind_before_min: 60, remind_days: null, remind_time: null,
  done: false, deleted_at: null, undone: false, notified_for: null, snooze_at: null, defer_until: null, source: 'app', push_show_title: null,
  remind_at: at(DAY, '16:00'),   // 已同步回来的行（没有这一列时走新建回落，见 reminder-model.test.ts）
  ...over,
});

beforeEach(() => savePatch.mockClear());

describe('整页提醒地址（FE-3）', () => {
  it('合格的地址', () => {
    expect(parseReminderHash(`#/remind/todo/${ID}?due=1762156800000`)).toEqual({ kind: 'todo', id: ID, dueAt: 1762156800000 });
  });
  it('多带参数、大写 UUID、due 为 0 或负数、超出安全整数、别的类型：一律不认', () => {
    for (const h of [
      `#/remind/todo/${ID}?due=1&next=/x`,
      `#/remind/todo/${ID}?due=1&url=https://evil`,
      `#/remind/todo/${ID.toUpperCase()}?due=1`,
      `#/remind/todo/${ID}?due=0`,
      `#/remind/todo/${ID}?due=-5`,
      `#/remind/todo/${ID}?due=99999999999999999999`,
      `#/remind/note/${ID}?due=1`,
      `#/remind/todo/${ID}`,
    ]) expect(parseReminderHash(h), h).toBeNull();
  });
});

describe('设置 remind.*', () => {
  it('免打扰和 push-dispatch 的 parseDnd 同一口径', () => {
    expect(dndOf({ start: '23:00', end: '08:00' })).toEqual({ start: '23:00', end: '08:00' });
    expect(dndOf({ start: '23:00', end: '08:00', enabled: false })).toBeNull();
    expect(dndOf({ start: '23:00', end: '23:00' })).toBeNull();
    expect(dndOf({ start: '7:00', end: '08:00' })).toBeNull();
    expect(dndOf('23:00-08:00')).toBeNull();
    expect(dndOf(undefined)).toBeNull();
  });
  it('关掉时保留时段（enabled: false），再打开还是原来的时段；没设过默认 23:00–08:00', () => {
    expect(dndValue({ enabled: false, start: '22:00', end: '07:00' })).toEqual({ start: '22:00', end: '07:00', enabled: false });
    expect(dndSettingOf({ start: '22:00', end: '07:00', enabled: false })).toEqual({ enabled: false, start: '22:00', end: '07:00' });
    expect(dndSettingOf(undefined)).toEqual({ enabled: false, start: '23:00', end: '08:00' });
  });
  it('remind.show_title 默认 true', () => {
    expect(showTitleOf(undefined)).toBe(true);
    expect(showTitleOf(false)).toBe(false);
  });
  it('写设置：没有就 insert，值一样不写，对象值按内容比较，软删过的顺带恢复', () => {
    expect(settingWrite([], 'remind.show_title', false)).toEqual({ op: 'insert', data: { key: 'remind.show_title', value: false } });
    const rows = [{ id: 's1', key: 'remind.dnd', value: { start: '23:00', end: '08:00' }, deleted_at: null, undone: false }];
    expect(settingWrite(rows, 'remind.dnd', { start: '23:00', end: '08:00' })).toBeNull();
    expect(settingWrite(rows, 'remind.dnd', { start: '22:00', end: '08:00' })).toEqual({ op: 'patch', id: 's1', data: { value: { start: '22:00', end: '08:00' } } });
    const del = [{ id: 's2', key: 'remind.show_title', value: true, deleted_at: 5, undone: false }];
    expect(settingWrite(del, 'remind.show_title', true)).toEqual({ op: 'patch', id: 's2', data: { value: true, deleted_at: null } });
  });
});

describe('本机通知（exe 每分钟检查；TC-B2-78）', () => {
  const now = at(DAY, '16:00');
  const list = (over: Record<string, unknown> = {}) => allReminders([], [todoRow(over)], now, SEOUL);
  it('到点、60 分钟内、没处理、没弹过的才弹；弹过的不再弹', () => {
    const l = list();
    expect(localDue(l, now, new Set()).length).toBe(1);
    expect(localDue(l, now, new Set([l[0]!.tag]))).toEqual([]);
    expect(localDue(l, now + 61 * 60_000, new Set())).toEqual([]);
    expect(localDue(list({ notified_for: at(DAY, '16:00') }), now, new Set())).toEqual([]);
  });
  it('别处处理了（知道了、完成、删除、稍后）：撤回弹过的 tag', () => {
    const tag = list()[0]!.tag;
    expect(staleTags(new Set([tag]), list({ notified_for: at(DAY, '16:00') }))).toEqual([tag]);
    expect(staleTags(new Set([tag]), list({ done: true }))).toEqual([tag]);
    expect(staleTags(new Set([tag]), list({ snooze_at: at(DAY, '16:10') }))).toEqual([tag]);
    expect(staleTags(new Set([tag]), list())).toEqual([]);
  });
  it('对照组：写标题，正文“17:00 截止”（中韩）', () => {
    const r = list()[0]!;
    expect(localText(r, { showTitle: true, tz: SEOUL, locale: 'zh-CN' })).toEqual({ title: '回复 박 대리 的邮件', body: '17:00 截止' });
    expect(localText(r, { showTitle: true, tz: SEOUL, locale: 'ko-KR' }).body).toContain('17:00');
  });
  it('remind.show_title = false（条目为空）、或条目 push_show_title = false：不带标题、不带截止时刻', () => {
    for (const [over, set] of [[{}, false], [{ push_show_title: false }, true]] as const) {
      const r = list(over)[0]!;
      for (const locale of ['zh-CN', 'ko-KR'] as const) {
        const x = localText(r, { showTitle: set, tz: SEOUL, locale });
        expect(x.title).not.toContain('박 대리');
        expect(x.title).toContain('16:00');
        expect(x.body).toBe('');
      }
      expect(localText(r, { showTitle: set, tz: SEOUL, locale: 'zh-CN' }).title).toBe('16:00 有 1 项待办');
    }
  });
  it('条目 push_show_title = true 压过设置', () => {
    const r = list({ push_show_title: true })[0]!;
    expect(localText(r, { showTitle: false, tz: SEOUL, locale: 'zh-CN' }).title).toBe('回复 박 대리 的邮件');
  });
  it('经 Claude 记下的加“来自 Claude ·”', () => {
    const r = list({ source: 'chat' })[0]!;
    expect(localText(r, { showTitle: true, tz: SEOUL, locale: 'zh-CN' }).title).toBe('来自 Claude · 回复 박 대리 的邮件');
  });
});

describe('TC-B2-64：本机通知文案和推送同一份 notify-text（日程“15:00 牙医”）', () => {
  const now = at(DAY, '15:00');
  const ev = (over: Record<string, unknown> = {}) =>
    reminderOf('event', { id: ID, title: '牙医', date: DAY, time: '15:00', tz: SEOUL, remind_min: 0, source: 'app', push_show_title: null, ...over }, now, SEOUL)!;
  it('① 直接写标题；② source = chat 加“来自 Claude ·”；tag 是 <kind>:<id>:<due_at>', () => {
    // notify-text 对日程写“15:00 牙医”（时刻 + 标题，和服务器推送同一份）
    expect(localText(ev(), { showTitle: true, tz: SEOUL, locale: 'zh-CN' }).title).toBe('15:00 牙医');
    expect(localText(ev({ source: 'chat' }), { showTitle: true, tz: SEOUL, locale: 'zh-CN' }).title).toBe('来自 Claude · 15:00 牙医');
    expect(localText(ev({ source: 'chat' }), { showTitle: true, tz: SEOUL, locale: 'ko-KR' }).title).toContain('Claude');
    expect(ev().tag).toBe(`event:${ID}:${at(DAY, '15:00')}`);
  });
  it('③ remind.show_title = false、④ 这一条 push_show_title = false：只写“15:00 有 1 项日程”', () => {
    for (const [over, set] of [[{}, false], [{ push_show_title: false }, true]] as const) {
      const zh = localText(ev(over), { showTitle: set, tz: SEOUL, locale: 'zh-CN' });
      expect(zh).toEqual({ title: '15:00 有 1 项日程', body: '' });
      const ko = localText(ev(over), { showTitle: set, tz: SEOUL, locale: 'ko-KR' });
      expect(ko.title).not.toContain('牙医');
      expect(ko.title).toContain('15:00');
    }
  });
});

describe('打开 App 时关掉已处理的系统通知', () => {
  const now = at(DAY, '16:05');
  const due = at(DAY, '16:00');
  it('处理了、改了时间的关；还在响的不关；本机没有这一行的不动；纪念日不动', () => {
    const live = allReminders([], [todoRow()], now, SEOUL);
    expect(shouldCloseShown({ kind: 'todo', id: ID, dueAt: due }, live, true)).toBe(false);
    expect(shouldCloseShown({ kind: 'todo', id: ID, dueAt: due - 60_000 }, live, true)).toBe(true);
    const acked = allReminders([], [todoRow({ notified_for: due })], now, SEOUL);
    expect(shouldCloseShown({ kind: 'todo', id: ID, dueAt: due }, acked, true)).toBe(true);
    const done = allReminders([], [todoRow({ done: true })], now, SEOUL);
    expect(shouldCloseShown({ kind: 'todo', id: ID, dueAt: due }, done, true)).toBe(true);
    expect(shouldCloseShown({ kind: 'todo', id: ID, dueAt: due }, [], false)).toBe(false);
    expect(shouldCloseShown({ kind: 'anniv', id: ID, dueAt: due }, [], true)).toBe(false);
  });
  it('tag 规则和推送一致', () => {
    expect(reminderOf('todo', todoRow(), now, SEOUL)?.tag).toBe(reminderTag('todo', ID, due));
  });
});

describe('push-test 结果（D1-5 只回枚举）', () => {
  const ok = (results: unknown) => ({ data: { results }, status: 200, networkError: false });
  it('至少一台 ok → sent；没有设备 → no_device；全是 gone / bad_endpoint → resubscribe', () => {
    expect(pushTestResultOf(ok([{ device_id: 'a', result: 'failed' }, { device_id: 'b', result: 'ok' }]))).toBe('sent');
    expect(pushTestResultOf(ok([]))).toBe('no_device');
    expect(pushTestResultOf(ok([{ device_id: 'a', result: 'gone' }, { device_id: 'b', result: 'bad_endpoint' }]))).toBe('resubscribe');
    expect(pushTestResultOf(ok([{ device_id: 'a', result: 'failed' }]))).toBe('failed');
  });
  it('429 → rate_limited；断网 → offline；别的错、认不出的回包 → failed', () => {
    expect(pushTestResultOf({ data: null, status: 429, networkError: false })).toBe('rate_limited');
    expect(pushTestResultOf({ data: null, status: null, networkError: true })).toBe('offline');
    expect(pushTestResultOf({ data: null, status: 500, networkError: false })).toBe('failed');
    expect(pushTestResultOf({ data: 'x', status: 200, networkError: false })).toBe('failed');
  });
});

describe('TC-B2-71：推送被同账号另一条设备记录占着', () => {
  const holder = { id: 'd-old', label: 'Y 的 Edge', last_seen_at: '2026-10-30T01:00:00Z', install_id: 'inst-1' };
  it('install_id 和本机一样 → self；不一样 → other；不自动移除', () => {
    expect(pushNoticeOf({ result: 'endpoint_in_use', holder }, 'inst-1')).toEqual({ kind: 'in_use', holder, self: true });
    expect(pushNoticeOf({ result: 'endpoint_in_use', holder }, 'inst-2')).toEqual({ kind: 'in_use', holder, self: false });
    expect(pushNoticeOf({ result: 'endpoint_in_use', holder }, null)).toEqual({ kind: 'in_use', holder, self: false });
    expect(pushNoticeOf({ result: 'resubscribe_failed' }, null)).toEqual({ kind: 'resubscribe' });
    expect(pushNoticeOf({ result: 'not_supported' }, null)).toEqual({ kind: 'not_supported' });
    expect(pushNoticeOf({ result: 'claimed' }, null)).toBeNull();
  });
  it('点“移除它”：remove_device 成功后自动再认领一次', async () => {
    const remove = vi.fn(async () => 'ok' as const);
    const claim = vi.fn(async () => ({ result: 'claimed' as const }));
    expect(await removeHolder('d-old', { remove, claim })).toBe('ok');
    expect(remove).toHaveBeenCalledWith('d-old');
    expect(claim).toHaveBeenCalledTimes(1);
  });
  it('移除失败不再认领；再认领没成功单独报', async () => {
    const claim = vi.fn(async () => ({ result: 'claimed' as const }));
    expect(await removeHolder('d', { remove: async () => 'failed', claim })).toBe('failed');
    expect(claim).not.toHaveBeenCalled();
    expect(await removeHolder('d', { remove: async () => 'ok', claim: async () => ({ result: 'claim_failed' }) })).toBe('reclaim_failed');
  });
  it('本机 install_id 只读不生成', () => {
    const store = { getItem: vi.fn(() => null) };
    expect(localInstallId(store)).toBeNull();
    expect(localInstallId({ getItem: () => 'ABC' })).toBe('abc');
  });
});

describe('打开通知（点按里请求权限）', () => {
  it('给了就认领；拒了不认领', async () => {
    const claim = vi.fn(async () => ({ result: 'claimed' as const }));
    expect(await enableNotifications({ request: async () => 'granted', claim })).toBe('granted');
    expect(claim).toHaveBeenCalledTimes(1);
    expect(await enableNotifications({ request: async () => 'denied', claim })).toBe('denied');
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

describe('写入：知道了写 notified_for，稍后写 snooze_at，都带 remind 标记', () => {
  const now = at(DAY, '16:01');
  const r = reminderOf('todo', todoRow(), now, SEOUL)!;
  it('知道了', async () => {
    await ackReminder(r, now);
    expect(savePatch).toHaveBeenCalledWith('todos', ID, { notified_for: at(DAY, '16:00'), updated_at: now }, true);
  });
  it('稍后', async () => {
    await snoozeReminder(r, now + 600_000, now);
    expect(savePatch).toHaveBeenCalledWith('todos', ID, { snooze_at: now + 600_000, updated_at: now }, true);
  });
  it('只有“稍后”、没有提醒时刻的：知道了清 snooze_at', async () => {
    const only = reminderOf('todo', todoRow({ due: null, snooze_at: at(DAY, '16:00') }), now, SEOUL)!;
    expect(only.remindAt).toBeNull();
    await ackReminder(only, now);
    expect(savePatch).toHaveBeenCalledWith('todos', ID, { snooze_at: null, updated_at: now }, true);
  });
  it('全部知道了：只返回写进去的那几条的 tag（调用方只把这些移出队列）', async () => {
    const other = { ...r, tag: 'todo:x:1' };
    savePatch.mockResolvedValueOnce('saved').mockResolvedValueOnce('local_unavailable' as never);
    expect(await ackAll([r, other], now)).toEqual([r.tag]);
  });
});

describe('说明文字', () => {
  it('日程“15 分钟后开始”“已经开始”，待办“今天 17:00 截止”', () => {
    const ev = reminderOf('event', { id: ID, title: 'x', date: DAY, time: '15:30', tz: SEOUL, remind_min: 15 }, at(DAY, '15:15'), SEOUL)!;
    expect(whenMsg(ev, at(DAY, '15:15'), SEOUL)).toEqual({ key: 'remind.when.startIn', params: { n: 15 } });
    expect(whenMsg(ev, at(DAY, '15:31'), SEOUL)).toEqual({ key: 'remind.when.started', params: {} });
    const td = reminderOf('todo', todoRow(), at(DAY, '16:00'), SEOUL)!;
    expect(whenMsg(td, at(DAY, '16:00'), SEOUL)).toEqual({ key: 'remind.when.dueAt', params: { time: '17:00' } });
    expect(whenMsg(td, at(DAY, '17:30'), SEOUL)).toEqual({ key: 'remind.when.overdue', params: {} });
  });
  it('今天、昨天、明天', () => {
    expect(dayMsg(DAY, DAY).key).toBe('remind.day.today');
    expect(dayMsg('2026-11-02', DAY).key).toBe('remind.day.yesterday');
    expect(dayMsg('2026-11-04', DAY).key).toBe('remind.day.tomorrow');
    expect(dayMsg('2026-11-10', DAY)).toEqual({ key: 'remind.day.date', params: { m: 11, d: 10 } });
  });
});
