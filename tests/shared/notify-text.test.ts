// shared/logic/notify-text.ts（架构 5.3 第 4 步；R-46、R-188 保留项；B2 任务单 BE-2）：只返回词典键和参数，t() 由调用方按 ui_locale 生成。
// 不看进程时区（test:tz 三个时区各跑一遍、Deno 也跑）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../shared/core/date.ts';
import { t } from '../../shared/i18n/i18n.ts';
import { actionsFor, hhmm, NOTIFY_ACTIONS, notifyText, SNOOZE_MIN, type NotifyInput } from '../../shared/logic/notify-text.ts';

const SEOUL = 'Asia/Seoul';
const at = msAt('2026-11-03', 15 * 60, SEOUL);
const base: NotifyInput = { kind: 'todo', title: '买柠檬', source: 'page', showTitle: true, timeMs: at, dueTime: null, tz: SEOUL };

describe('notifyText', () => {
  it('时刻按传入的时区显示 HH:MM', () => {
    expect(hhmm(at, SEOUL)).toBe('15:00');
    expect(hhmm(at, 'UTC')).toBe('06:00');
    expect(hhmm(at, 'America/Los_Angeles')).toBe('22:00');
  });
  it('日程：标题“{time} {title}”，不带正文', () => {
    const n = notifyText({ ...base, kind: 'event', title: 'NEOX 会议' });
    expect(n).toEqual({ title: { key: 'remind.push.event', params: { time: '15:00', title: 'NEOX 会议' } }, fromClaude: false, body: null });
    expect(t('remind.push.event', { time: '15:00', title: 'NEOX 会议' }, 'zh-CN')).toBe('15:00 NEOX 会议');
  });
  describe('全天日程（R-333）：不写时刻，前一天“明天 · 名称”、当天“今天 · 名称”', () => {
    const ev = (date: string, atMs: number, tz = SEOUL): NotifyInput => ({ ...base, kind: 'event', title: '团建', tz, timeMs: atMs, allDay: { date, at: atMs } });
    const LA = 'America/Los_Angeles';
    it('前一天 20:00 提醒：明天 · 团建；当天 09:00：今天 · 团建；中韩文案', () => {
      const eve = msAt('2026-11-04', 20 * 60, SEOUL);
      expect(notifyText(ev('2026-11-05', eve))).toEqual({ title: { key: 'remind.push.allDayTomorrow', params: { title: '团建' } }, fromClaude: false, body: null });
      expect(notifyText(ev('2026-11-05', msAt('2026-11-05', 9 * 60, SEOUL))).title).toEqual({ key: 'remind.push.allDayToday', params: { title: '团建' } });
      expect(t('remind.push.allDayTomorrow', { title: '团建' }, 'zh-CN')).toBe('明天 · 团建');
      expect(t('remind.push.allDayToday', { title: '团建' }, 'zh-CN')).toBe('今天 · 团建');
      expect(t('remind.push.allDayTomorrow', { title: '워크숍' }, 'ko-KR')).toBe('내일 · 워크숍');
      expect(t('remind.push.allDayToday', { title: '워크숍' }, 'ko-KR')).toBe('오늘 · 워크숍');
    });
    it('按 current_tz 判断哪天：同一时刻在首尔是 11-05、在洛杉矶还是 11-04', () => {
      const ms = msAt('2026-11-05', 9 * 60, SEOUL);   // 洛杉矶 11-04 16:00
      expect(notifyText(ev('2026-11-05', ms, SEOUL)).title.key).toBe('remind.push.allDayToday');
      expect(notifyText(ev('2026-11-05', ms, LA)).title.key).toBe('remind.push.allDayTomorrow');
    });
    it('前一天 20:00 被免打扰推迟到当天 07:00：按推迟后的时刻写“今天”', () => {
      expect(notifyText(ev('2026-11-05', msAt('2026-11-05', 7 * 60, SEOUL))).title.key).toBe('remind.push.allDayToday');
    });
    it('稍后推迟到日程过后、或提前不止一天：只写标题，不加今天 / 明天', () => {
      expect(notifyText(ev('2026-11-05', msAt('2026-11-06', 9 * 60, SEOUL))).title).toEqual({ key: null, params: { text: '团建' } });
      expect(notifyText(ev('2026-11-05', msAt('2026-11-03', 9 * 60, SEOUL))).title).toEqual({ key: null, params: { text: '团建' } });
    });
    it('不写标题（R-334）：也不写时刻——前一天“明天有 1 项日程”、当天“今天有 1 项日程”、其余“有 1 项日程”；中韩', () => {
      const hid = (date: string, atMs: number, tz = SEOUL) => notifyText({ ...ev(date, atMs, tz), showTitle: false });
      expect(hid('2026-11-05', msAt('2026-11-04', 20 * 60, SEOUL))).toEqual({ title: { key: 'remind.push.hiddenAllDayTomorrow', params: {} }, fromClaude: false, body: null });
      expect(hid('2026-11-05', msAt('2026-11-05', 9 * 60, SEOUL)).title).toEqual({ key: 'remind.push.hiddenAllDayToday', params: {} });
      expect(hid('2026-11-05', msAt('2026-11-06', 9 * 60, SEOUL)).title).toEqual({ key: 'remind.push.hiddenAllDay', params: {} });
      expect(hid('2026-11-05', msAt('2026-11-03', 9 * 60, SEOUL)).title).toEqual({ key: 'remind.push.hiddenAllDay', params: {} });
      // 同一时刻按 current_tz：首尔已是当天、洛杉矶还是前一天
      const ms = msAt('2026-11-05', 9 * 60, SEOUL);
      expect(hid('2026-11-05', ms, LA).title.key).toBe('remind.push.hiddenAllDayTomorrow');
      expect(t('remind.push.hiddenAllDayTomorrow', {}, 'zh-CN')).toBe('明天有 1 项日程');
      expect(t('remind.push.hiddenAllDayToday', {}, 'zh-CN')).toBe('今天有 1 项日程');
      expect(t('remind.push.hiddenAllDay', {}, 'zh-CN')).toBe('有 1 项日程');
      expect(t('remind.push.hiddenAllDayTomorrow', {}, 'ko-KR')).toBe('내일 일정 1개');
      expect(t('remind.push.hiddenAllDayToday', {}, 'ko-KR')).toBe('오늘 일정 1개');
      expect(t('remind.push.hiddenAllDay', {}, 'ko-KR')).toBe('일정 1개');
    });
    it('经 Claude 记下的全天日程：写不写标题都加前缀标记', () => {
      expect(notifyText({ ...ev('2026-11-05', msAt('2026-11-04', 20 * 60, SEOUL)), source: 'chat' }).fromClaude).toBe(true);
      expect(notifyText({ ...ev('2026-11-05', msAt('2026-11-04', 20 * 60, SEOUL)), source: 'chat', showTitle: false }).fromClaude).toBe(true);
    });
    it('有时刻的日程不传 allDay（或传 null）时照旧“{time} {title}”', () => {
      expect(notifyText({ ...base, kind: 'event', title: '会', allDay: null }).title).toEqual({ key: 'remind.push.event', params: { time: '15:00', title: '会' } });
    });
  });
  it('待办：标题原样；有截止时刻时正文“17:00 截止”', () => {
    expect(notifyText(base)).toEqual({ title: { key: null, params: { text: '买柠檬' } }, fromClaude: false, body: null });
    expect(notifyText({ ...base, dueTime: '17:00' }).body).toEqual({ key: 'remind.push.todoDue', params: { time: '17:00' } });
    expect(t('remind.push.todoDue', { time: '17:00' }, 'zh-CN')).toBe('17:00 截止');
  });
  it('不写标题（R-294、R-308）：日程“有 1 项日程”、待办“有 1 项待办”、纪念日“有 1 项纪念日”；都不带截止时刻、不带正文', () => {
    expect(notifyText({ ...base, kind: 'event', showTitle: false, dueTime: '17:00' })).toEqual({ title: { key: 'remind.push.hidden', params: { time: '15:00' } }, fromClaude: false, body: null });
    expect(notifyText({ ...base, kind: 'anniv', showTitle: false })).toEqual({ title: { key: 'remind.push.hiddenAnniv', params: { time: '15:00' } }, fromClaude: false, body: null });
    expect(t('remind.push.hiddenAnniv', { time: '15:00' }, 'zh-CN')).toBe('15:00 有 1 项纪念日');
    expect(t('remind.push.hiddenAnniv', { time: '15:00' }, 'ko-KR')).toBe('15:00 기념일 1개');
    expect(notifyText({ ...base, showTitle: false, dueTime: '17:00' })).toEqual({ title: { key: 'remind.push.hiddenTodo', params: { time: '15:00' } }, fromClaude: false, body: null });
    expect(t('remind.push.hidden', { time: '15:00' }, 'zh-CN')).toBe('15:00 有 1 项日程');
    expect(t('remind.push.hiddenTodo', { time: '15:00' }, 'zh-CN')).toBe('15:00 有 1 项待办');
    expect(t('remind.push.hiddenTodo', { time: '15:00' }, 'ko-KR')).toBe('15:00 할 일 1개');
  });
  it('按钮（R-294、R-307、R-308）：待办“推迟 + 完成”、日程和纪念日“推迟 + 知道了”；推迟 10 分钟；中韩文案', () => {
    expect(actionsFor('todo')).toEqual(['snooze', 'done']);
    expect(actionsFor('event')).toEqual(['snooze', 'ack']);
    expect(actionsFor('anniv')).toEqual(['snooze', 'ack']);
    expect(SNOOZE_MIN).toBe(10);
    for (const k of ['todo', 'event', 'anniv'] as const) for (const a of actionsFor(k)) expect(NOTIFY_ACTIONS[a].action).toBe(a);
    expect(t('remind.push.action.snooze', {}, 'zh-CN')).toBe('推迟');
    expect(t('remind.push.action.done', {}, 'zh-CN')).toBe('完成');
    expect(t('remind.push.action.ack', {}, 'zh-CN')).toBe('知道了');
    expect(t('remind.push.action.ack', {}, 'ko-KR')).toBe('확인');
    expect(t('remind.push.action.snooze', {}, 'ko-KR')).toBe('미루기');
    expect(t('remind.push.action.done', {}, 'ko-KR')).toBe('완료');
  });
  it('source = chat 标记“来自 Claude ·”（写不写标题都标）', () => {
    expect(notifyText({ ...base, source: 'chat' }).fromClaude).toBe(true);
    expect(notifyText({ ...base, source: 'chat', showTitle: false }).fromClaude).toBe(true);
    expect(notifyText({ ...base, source: 'voice' }).fromClaude).toBe(false);
    expect(t('remind.push.fromClaude', { text: '买柠檬' }, 'zh-CN')).toBe('来自 Claude · 买柠檬');
  });
  it('纪念日：标题是名字（B5 再补“明天是…生日”的写法）', () => {
    expect(notifyText({ ...base, kind: 'anniv', title: '妈妈生日' }).title).toEqual({ key: null, params: { text: '妈妈生日' } });
  });
});
