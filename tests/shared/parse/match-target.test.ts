// matchTarget：取消、改期、完成找候选（TC-B4b3-47、TC-B4b3-48 ⑤⑧ 的单元部分；架构 5.14 第 7 点），含首尔、洛杉矶、UTC 三个时区。
import { describe, expect, it } from 'vitest';
import { BATCH_MAX, matchTarget, SINGLE_MAX, type TargetEvent, type TargetTodo } from '../../../shared/logic/parse/match-target.ts';
import type { PlusTarget } from '../../../shared/logic/parse/resolve-target.ts';

const SEOUL = 'Asia/Seoul';
const LA = 'America/Los_Angeles';
const UTC = 'UTC';
/** 句库基准：2026-11-02（周一）10:00 首尔 */
const NOW = Date.UTC(2026, 10, 2, 1, 0);
const T = '2026-11-02';
const TM = '2026-11-03';

const ev = (id: string, title: string, date: string, time: string | null, o: Partial<TargetEvent> = {}): TargetEvent => ({
  id, title, date, time, short: null, project: '', tz: SEOUL, duration_min: 60, created_at: 0, location: '', ...o,
});
const td = (id: string, title: string, due: string | null, o: Partial<TargetTodo> = {}): TargetTodo => ({
  id, title, due, due_time: null, done: false, short: null, project: '', created_at: 0, ...o,
});
const tg = (o: Partial<PlusTarget>): PlusTarget => ({ text: '', date: null, time: null, kinds: ['event', 'todo'], ...o });
const ids = (r: ReturnType<typeof matchTarget>) => r.hits.map((h) => h.id);

describe('单条：放宽后的待办范围（TC-B4b3-47）', () => {
  const todos = [
    td('printer', '采购打印纸', null),
    td('chair', '采购办公椅', '2026-10-20'),
    td('coffee', '采购咖啡豆', '2026-11-10'),
    td('monitor', '采购显示器', '2026-11-30'),
    td('rent', '交房租', '2026-11-05'),
  ];
  const events = [ev('review', '采购评审会', '2026-11-20', '10:00')];
  const items = { events, todos };

  it('只说事由：没截止日的、已过期的、超过 14 天的都能找到', () => {
    for (const [text, id] of [['采购办公椅', 'chair'], ['采购打印纸', 'printer'], ['采购显示器', 'monitor']] as const) {
      expect(ids(matchTarget(tg({ text }), items, NOW, SEOUL)), text).toEqual([id]);
      expect(ids(matchTarget(tg({ text, kinds: ['todo'] }), items, NOW, SEOUL)), text).toEqual([id]);
    }
  });
  it('“采购”没说日子：按离今天近排，没截止日的最后被截掉，“交房租”不出现', () => {
    const r = matchTarget(tg({ text: '采购' }), items, NOW, SEOUL);
    expect(ids(r)).toEqual(['coffee', 'chair', 'monitor']);
    expect(r.hits).toHaveLength(SINGLE_MAX);
    expect(r.more).toBe(0);
  });
  it('with_overdue、今天：只看截止日 ≤ 今天的（打印纸、咖啡豆不算）', () => {
    expect(ids(matchTarget(tg({ text: '采购', date: T, with_overdue: true, kinds: ['todo'] }), items, NOW, SEOUL))).toEqual(['chair']);
    expect(ids(matchTarget(tg({ text: '采购', with_overdue: true, kinds: ['todo'] }), items, NOW, SEOUL))).toEqual(['chair']);
  });
  it('日程仍按今天起 14 天的窗口；说了日子只看那一天', () => {
    const at = (date: string) => ({ events: [ev('review', '采购评审会', date, '10:00')], todos: [] });
    expect(ids(matchTarget(tg({ text: '采购评审会' }), at('2026-11-16'), NOW, SEOUL))).toEqual(['review']);
    expect(ids(matchTarget(tg({ text: '采购评审会' }), at('2026-11-20'), NOW, SEOUL))).toEqual([]);
    expect(ids(matchTarget(tg({ text: '采购评审会', date: '2026-11-20' }), at('2026-11-20'), NOW, SEOUL))).toEqual(['review']);
    expect(ids(matchTarget(tg({ text: '采购评审会', date: '2026-11-19' }), at('2026-11-20'), NOW, SEOUL))).toEqual([]);
  });
  it('待办说了日子只看截止日正好是那天的', () => {
    expect(ids(matchTarget(tg({ text: '采购', date: '2026-11-10' }), items, NOW, SEOUL))).toEqual(['coffee']);
  });
});

describe('单条：命中关', () => {
  it('① 10 条近期待办只有 1 条含“牛奶”：只出这 1 条', () => {
    const todos = ['交报告', '订会议室', '回邮件', '交水费', '整理发票', '买咖啡', '洗车', '取快递', '交房租'].map((t, i) => td(`n${i}`, t, `2026-11-0${(i % 7) + 2}`));
    todos.push(td('milk', '买牛奶', TM));
    expect(ids(matchTarget(tg({ text: '买牛奶' }), { events: [], todos }, NOW, SEOUL))).toEqual(['milk']);
  });
  const slot = {
    events: [ev('e15', '设计评审', TM, '15:00'), ev('e10', '晨会', TM, '10:00'), ev('e15b', '设计评审', '2026-11-04', '15:00')],
    todos: [td('t17', '提交报销单', TM, { due_time: '17:00' }), td('t15', '交水费', TM, { due_time: '15:00' }), td('tn', '交电费', TM)],
  };
  it('② text 为空 + 日子 + 时刻：只出同一天同一时刻的（日程按设备时区、待办按截止时刻）', () => {
    const r = matchTarget(tg({ date: TM, time: '15:00' }), slot, NOW, SEOUL);
    expect(ids(r)).toEqual(['e15', 't15']);
    expect(r.hits[0]).toEqual({ kind: 'event', id: 'e15', date: TM, time: '15:00' });
    expect(r.hits[1]).toEqual({ kind: 'todo', id: 't15', date: TM, time: '15:00' });
  });
  it('② text 为空，只有日子或只有时刻：没有候选', () => {
    expect(matchTarget(tg({ date: TM }), slot, NOW, SEOUL)).toEqual({ hits: [], more: 0 });
    expect(matchTarget(tg({ time: '15:00' }), slot, NOW, SEOUL)).toEqual({ hits: [], more: 0 });
  });
  it('泛指词“거”+ 日子 + 时刻：和空一样要同日同刻', () => {
    expect(ids(matchTarget(tg({ text: '거', date: TM, time: '15:00' }), slot, NOW, SEOUL))).toEqual(['e15', 't15']);
    expect(ids(matchTarget(tg({ text: '거', date: TM }), slot, NOW, SEOUL))).toEqual([]);
  });
  it('说了时刻：同一天两条都命中关键词，同一时刻的排第一', () => {
    const items = { events: [ev('am', '周会', TM, '10:00'), ev('pm', '周会', TM, '15:00')], todos: [] };
    expect(ids(matchTarget(tg({ text: '周会', date: TM, time: '15:00' }), items, NOW, SEOUL))).toEqual(['pm', 'am']);
  });
  it('地点含关键词的日程也进候选，排在标题命中的后面', () => {
    const items = { events: [ev('loc', '季度评审', TM, '09:00', { location: '采购部' }), ev('ttl', '采购评审', '2026-11-05', '09:00')], todos: [] };
    expect(ids(matchTarget(tg({ text: '采购' }), items, NOW, SEOUL))).toEqual(['ttl', 'loc']);
  });
  it('关键词归一同 search.ts：全角、大小写、韩文助词', () => {
    const items = { events: [ev('abc', 'ＡＢＣ会议', TM, '09:00'), ev('ko', '회의', TM, '11:00')], todos: [] };
    expect(ids(matchTarget(tg({ text: 'abc会议' }), items, NOW, SEOUL))).toEqual(['abc']);
    expect(ids(matchTarget(tg({ text: '회의를' }), items, NOW, SEOUL))).toEqual(['ko']);
  });
  it('已删除、已撤销的日程待办和已完成的待办都不出', () => {
    const items = {
      events: [ev('del', '买牛奶', TM, '09:00', { deleted_at: 1 }), ev('undo', '买牛奶', TM, '10:00', { undone: true })],
      todos: [td('done', '买牛奶', TM, { done: true }), td('tdel', '买牛奶', null, { deleted_at: 1 }), td('tun', '买牛奶', null, { undone: true }), td('ok', '买牛奶', null)],
    };
    expect(ids(matchTarget(tg({ text: '买牛奶' }), items, NOW, SEOUL))).toEqual(['ok']);
  });
  it('kinds 只有 todo 时日程不出，只有 event 时待办不出', () => {
    const items = { events: [ev('e', '牛奶品鉴会', TM, '15:00')], todos: [td('t', '买牛奶', null)] };
    expect(ids(matchTarget(tg({ text: '牛奶', kinds: ['todo'] }), items, NOW, SEOUL))).toEqual(['t']);
    expect(ids(matchTarget(tg({ text: '牛奶', kinds: ['event'] }), items, NOW, SEOUL))).toEqual(['e']);
  });
  it('设备时区无效时抛 bad_tz', () => {
    expect(() => matchTarget(tg({ text: '牛奶' }), { events: [], todos: [] }, NOW, 'Foo/Bar')).toThrow('bad_tz');
  });
});

describe('时区（日程按设备时区换算，全天日程不换算）', () => {
  const items = { events: [ev('seoul9', '体检', TM, '09:00'), ev('allday', '体检日', TM, null)], todos: [] };
  it('首尔记的 11-03 09:00，在洛杉矶是 11-02 16:00', () => {
    expect(matchTarget(tg({ text: '体检', date: T }), items, NOW, LA).hits).toEqual([{ kind: 'event', id: 'seoul9', date: T, time: '16:00' }]);
    expect(ids(matchTarget(tg({ text: '体检', date: TM }), items, NOW, LA))).toEqual(['allday']);
    expect(ids(matchTarget(tg({ date: T, time: '16:00' }), items, NOW, LA))).toEqual(['seoul9']);
  });
  it('同一条在 UTC 是 11-03 00:00、在首尔是 11-03 09:00；全天日程日期不变', () => {
    expect(matchTarget(tg({ text: '体检', date: TM }), items, NOW, UTC).hits).toEqual([
      { kind: 'event', id: 'seoul9', date: TM, time: '00:00' },
      { kind: 'event', id: 'allday', date: TM, time: null },
    ]);
    expect(matchTarget(tg({ text: '体检', date: TM }), items, NOW, SEOUL).hits[0]).toEqual({ kind: 'event', id: 'seoul9', date: TM, time: '09:00' });
  });
});

describe('批量（all）', () => {
  const overdue = {
    events: [ev('ev', '部门会议', T, '15:00')],
    todos: [
      td('d1031n', '采购打印纸', '2026-10-31'),
      td('d1028', '交周报', '2026-10-28'),
      td('d1031t', '采购任务确认', '2026-10-31', { due_time: '09:00' }),
      td('d1030', '整理发票', '2026-10-30'),
      td('d1101', '回复邮件', '2026-11-01'),
      td('d1102', '办公用品采购', T, { due_time: '17:00' }),
      td('d1103', '采购咖啡豆', TM),
      td('none', '学英语', null),
      td('done', '交水费', '2026-11-01', { done: true }),
      td('del', '订机票', '2026-10-31', { deleted_at: 1 }),
    ],
  };
  const all = (o: Partial<PlusTarget>) => tg({ all: true, ...o });

  it('⑧ 泛指词 + with_overdue + 今天：出 6 条，按截止日先后，同一天有截止时刻的在前', () => {
    const r = matchTarget(all({ text: '任务', date: T, with_overdue: true, kinds: ['todo'] }), overdue, NOW, SEOUL);
    expect(ids(r)).toEqual(['d1028', 'd1030', 'd1031t', 'd1031n', 'd1101', 'd1102']);
    expect(r.more).toBe(0);
  });
  it('⑧ 具体词“采购”只出标题含“采购”的；“采购任务”结果一样', () => {
    for (const text of ['采购', '采购任务']) {
      expect(ids(matchTarget(all({ text, date: T, with_overdue: true, kinds: ['todo'] }), overdue, NOW, SEOUL)), text).toEqual(['d1031t', 'd1031n', 'd1102']);
    }
  });
  it('⑤ kinds [event]、明天、text“会”：明天的会都出、按时刻先后，待办不出', () => {
    const items = {
      events: [ev('m16', '项目评审会', TM, '16:00'), ev('m09', '周会', TM, '09:30'), ev('m14', '客户会议', TM, '14:00'), ev('m04', '周会', '2026-11-04', '09:30')],
      todos: [td('tm', '准备会议材料', TM)],
    };
    expect(ids(matchTarget(all({ text: '会', date: TM, kinds: ['event'] }), items, NOW, SEOUL))).toEqual(['m09', 'm14', 'm16']);
  });
  it('没有 with_overdue、date 11-06：只出截止日正好是 11-06 的待办，过期的不出', () => {
    const items = { events: [], todos: [td('f1', '交报价单', '2026-11-06'), td('f2', '交周报', '2026-10-30'), td('f3', '买牛奶', '2026-11-05')] };
    expect(ids(matchTarget(all({ text: '待办', date: '2026-11-06', kinds: ['todo'] }), items, NOW, SEOUL))).toEqual(['f1']);
  });
  it('55 条：出 50 条、more = 5；一条也没有：空、more = 0', () => {
    const todos = Array.from({ length: 55 }, (_, i) => td(`t${String(i).padStart(2, '0')}`, `事项${i}`, T));
    const r = matchTarget(all({ date: T, kinds: ['todo'] }), { events: [], todos }, NOW, SEOUL);
    expect(r.hits).toHaveLength(BATCH_MAX);
    expect(r.more).toBe(5);
    expect(matchTarget(all({ date: '2026-12-01', kinds: ['todo'] }), { events: [], todos }, NOW, SEOUL)).toEqual({ hits: [], more: 0 });
  });
  it('kinds 只有 todo 时日程不出', () => {
    expect(ids(matchTarget(all({ date: T, kinds: ['todo'] }), overdue, NOW, SEOUL))).toEqual(['d1102']);
    expect(ids(matchTarget(all({ date: T, kinds: ['event'] }), overdue, NOW, SEOUL))).toEqual(['ev']);
  });
});
