// “现在”卡的暖心句（负责人 11-14：“没有日程的时候可以显示一些鼓励的句子或者暖心句子”；11-15：“跟有日程的时候一样的样式！不是一个小框加一句话”）：
// • cheerIndex / pickCheer：每小时换一句（负责人 11-17：“没有日程的时候暖心语句一个小时更换一条，给我准备50条”），同一小时同一句、下一个整点换下一句、跨天接着往下、到头绕回；中韩各 50 句、每句不超过 20 个字、不重复
// • 所有状态都是同一张大卡：页头标签 + “现在 HH:MM”、标题行、时间尺；没有浅色小卡
// • ② 下一件在时间尺窗口外（far）：标签“下一件”，标题行写暖心句，时间尺下面“下一件 17:00 逛街 · 4 小时 20 分后”只出一次
// • ② 下一件在窗口里：照旧黄卡加时间尺，没有暖心句、卡底不重复写“下一件……”
// • ④ 今天没有日程：标签“今天没有日程”，标题行写暖心句，照样画此刻前后的时间尺
// • ③ 都结束了（负责人 11-14 22:17“框也没有做”）：标签“今天的日程都结束了”，标题行暖心句，有明天第一件时时间尺下面写“明天 11:00 …”
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { cheerIndex, nowCard, type EventOcc } from '../data/today-model.ts';
import { cheerKo } from '../i18n/cheer-ko.ts';
import { cheerZh } from '../i18n/cheer-zh.ts';
import { pickCheer } from '../hooks/useTodayT.ts';
import { NowCard } from '../ui/NowCard.tsx';

const TZ = 'Asia/Seoul';
const DAY = '2026-11-14';
const at = (h: number, m = 0) => msAt(DAY, h * 60 + m, TZ);
const ev = (id: string, title: string, h: number, durMin = 60): EventOcc => ({
  kind: 'event', id, title, project: '', date: DAY, lastDate: DAY, allDay: false, start: at(h), end: at(h) + durMin * 60_000,
  time: `${String(h).padStart(2, '0')}:00`, origin: null,
  place: { allDay: false, date: DAY, lastDate: DAY, startMs: at(h), endMs: at(h) + durMin * 60_000, startMin: h * 60 },
});
const allDay = (id: string, title: string): EventOcc => ({ kind: 'event', id, title, project: '', date: DAY, lastDate: DAY, allDay: true, start: null, end: null, time: null, origin: null, place: { allDay: true, date: DAY, lastDate: DAY } });

function show(events: EventOcc[], now: number, tomorrowFirst: EventOcc | null = null) {
  render(<NowCard card={nowCard(events, now, TZ, DAY, tomorrowFirst)} today={DAY} />);
  return screen.getByTestId('now-card');
}

beforeEach(() => uiStore.getState().setLocale('zh-CN'));
afterEach(cleanup);

describe('暖心句', () => {
  it('同一小时同一句，下一个整点换下一句，跨天接着往下，到头绕回', () => {
    expect(cheerIndex('2026-11-14', 30)).toBe(cheerIndex('2026-11-14', 30));
    expect((cheerIndex('2026-11-14', 30) + 1) % 30).toBe(cheerIndex('2026-11-15', 30));
    expect(cheerIndex('1970-01-31', 30)).toBe(0);
    expect(cheerIndex('1969-12-31', 30)).toBe(29);
    expect(cheerIndex('2026-11-14', 0)).toBe(0);
    const n = cheerZh.length;
    const slot = (day: string, h: number) => cheerZh.indexOf(pickCheer(cheerZh, day, h));
    // 1970-01-01 0 点是第 0 句、1 点第 1 句；第 2 天 0 点接着是第 24 句
    expect(slot('1970-01-01', 0)).toBe(0);
    expect(slot('1970-01-01', 1)).toBe(1);
    expect(slot('1970-01-02', 0)).toBe(24 % n);
    // 同一天里每个整点都换一句：23 点到第二天 0 点也只往下走一句
    for (let h = 0; h < 23; h += 1) expect(slot('2026-11-14', h + 1)).toBe((slot('2026-11-14', h) + 1) % n);
    expect(slot('2026-11-15', 0)).toBe((slot('2026-11-14', 23) + 1) % n);
    // 连着 50 个小时 50 句各出一次，不重复
    const seen = new Set<string>();
    for (let k = 0; k < n; k += 1) seen.add(pickCheer(cheerZh, k < 24 ? '2026-11-14' : k < 48 ? '2026-11-15' : '2026-11-16', k % 24));
    expect(seen.size).toBe(n);
    expect(pickCheer([], '2026-11-14', 9)).toBe('');
    expect(pickCheer(cheerKo, '2026-11-14', 9)).toBe(cheerKo[(cheerIndex('2026-11-14', cheerKo.length) * 24 + 9) % cheerKo.length]);
  });

  it('中韩各 50 句，一样多、每句不超过 20 个字、不重复', () => {
    for (const list of [cheerZh, cheerKo]) {
      expect(list.length).toBe(50);
      expect(new Set(list).size).toBe(list.length);
      for (const s of list) expect([...s].length).toBeLessThanOrEqual(20);
    }
  });
});

/** 和有日程时同一张大卡：页头写标签和“现在 HH:MM”，标题行位置是暖心句，下面照样有时间尺 */
function sameBigCard(card: HTMLElement, label: string, nowWord = '现在 '): void {
  const head = card.firstElementChild;
  expect(head?.textContent).toContain(label);
  expect(head?.textContent).toContain(nowWord);
  expect(head?.nextElementSibling?.getAttribute('data-testid')).toBe('now-cheer');
  expect(card.querySelector('[data-testid="now-ruler"]')).toBeTruthy();
}

describe('“现在”卡：没有日程时也是同一张大卡', () => {
  it('② 下一件在时间尺窗口外（12:40，只有 17:00 逛街和一个全天的）：标签“下一件”，标题行暖心句，下一件只写一次', async () => {
    const card = show([ev('e1', '逛街', 17), allDay('e2', '逛街')], at(12, 40));
    expect(card.getAttribute('data-state')).toBe('far');
    sameBigCard(card, '下一件');
    await waitFor(() => expect(screen.getByTestId('now-cheer').textContent).toBe(pickCheer(cheerZh, DAY, 12)));
    expect(screen.getByTestId('now-hint').textContent).toBe('下一件 17:00 逛街 · 4 小时 20 分后');
    expect(card.textContent?.split('逛街').length).toBe(2);
    expect(card.textContent?.split('4 小时 20 分后').length).toBe(2);
    expect(screen.queryByTestId('now-left')).toBeNull();
    expect(screen.queryByTestId('now-title')).toBeNull();
  });

  it('② 下一件在窗口里：标题写下一件，没有暖心句，卡底不重复写“下一件……”', () => {
    const card = show([ev('e1', '逛街', 14)], at(12, 40));
    expect(card.getAttribute('data-state')).toBe('idle');
    expect(screen.getByTestId('now-ruler')).toBeTruthy();
    expect(screen.getByTestId('now-title').textContent).toBe('14:00 逛街');
    expect(screen.queryByTestId('now-cheer')).toBeNull();
    expect(screen.queryByTestId('now-hint')).toBeNull();
  });

  it('① 进行中而下一件在窗口外：时间尺下面写一次下一件，没有暖心句', () => {
    const card = show([ev('e1', '开会', 12), ev('e2', '逛街', 17)], at(12, 40));
    expect(card.getAttribute('data-state')).toBe('live');
    expect(screen.getByTestId('now-hint').textContent).toBe('下一件 17:00 逛街 · 4 小时 20 分后');
    expect(screen.queryByTestId('now-cheer')).toBeNull();
  });

  it('④ 今天没有日程：同一张大卡，标签“今天没有日程”，标题行暖心句（韩文界面用韩文句和韩文标签）', async () => {
    const card = show([], at(9, 5));
    expect(card.getAttribute('data-state')).toBe('empty');
    sameBigCard(card, '今天没有日程');
    expect(card.querySelector('p')?.textContent).toContain('现在 09:05');
    await waitFor(() => expect(screen.getByTestId('now-cheer').textContent).toBe(pickCheer(cheerZh, DAY, 9)));
    cleanup();
    uiStore.getState().setLocale('ko-KR');
    const ko = show([], at(9, 5));
    sameBigCard(ko, '오늘 일정 없음', '지금 ');
    await waitFor(() => expect(screen.getByTestId('now-cheer').textContent).toBe(pickCheer(cheerKo, DAY, 9)));
  });

  it('③ 今天的日程都结束了：同一张大卡，标签“今天的日程都结束了”，标题行暖心句，有明天第一件时写明天', async () => {
    const card = show([ev('e1', '逛街', 9)], at(21, 40), { ...ev('t1', '开会', 11), date: '2026-11-15' });
    expect(card.getAttribute('data-state')).toBe('done');
    sameBigCard(card, '今天的日程都结束了');
    await waitFor(() => expect(screen.getByTestId('now-cheer').textContent).toBe(pickCheer(cheerZh, DAY, 21)));
    expect(card.textContent).toContain('明天 11:00 开会');
  });

  it('③ 没有明天第一件：页头一行 + 暖心句一行，不写明天', async () => {
    const card = show([ev('e1', '逛街', 9)], at(21, 40));
    await waitFor(() => expect(screen.getByTestId('now-cheer').textContent).toBe(pickCheer(cheerZh, DAY, 21)));
    expect(screen.queryByTestId('now-tomorrow')).toBeNull();
    expect(card.textContent).not.toContain('明天');
  });

  it('只有全天日程：同一张大卡，页头“全天 · 休假”（两件以上“全天 N 件”），标题行写暖心句', async () => {
    const card = show([allDay('a1', '休假')], at(10));
    expect(card.getAttribute('data-state')).toBe('allday');
    sameBigCard(card, '全天 · 休假');
    await waitFor(() => expect(screen.getByTestId('now-cheer').textContent).toBe(pickCheer(cheerZh, DAY, 10)));
    cleanup();
    sameBigCard(show([allDay('a1', '休假'), allDay('a2', '搬家')], at(10)), '全天 2 件');
    cleanup();
    uiStore.getState().setLocale('ko-KR');
    sameBigCard(show([allDay('a1', '휴가')], at(10)), '종일 · 휴가', '지금 ');
  });
});

describe('“现在”卡：有日程时', () => {
  it('两件同时进行：页头“进行中 2 件”，第二件写一行“同时：…”，时间尺画两条轨道、第二件用自己的颜色类', () => {
    const card = show([ev('e1', '短会', 14, 30), ev('e2', '长会', 13, 120)], at(14, 17));
    expect(card.firstElementChild?.textContent).toContain('进行中 2 件');
    expect(screen.getByTestId('now-title').textContent).toBe('短会');
    expect(screen.getByTestId('now-left').textContent).toBe('还剩 13 分钟');
    expect(screen.getByTestId('now-also').textContent).toBe('同时：长会 · 到 15:00 · 还剩 43 分钟');
    const ruler = screen.getByTestId('now-ruler');
    expect(ruler.getAttribute('data-lanes')).toBe('2');
    expect(ruler.style.getPropertyValue('--lh')).toBe('30px');
    const segs = [...ruler.querySelectorAll<HTMLElement>('[data-kind]')];
    expect(segs.map((el) => [el.dataset.kind, el.style.getPropertyValue('--t'), el.style.getPropertyValue('--h')])).toEqual([
      ['cur', '4px', '13px'],
      ['co', '21px', '13px'],
    ]);
    expect(segs[0]?.className).not.toBe(segs[1]?.className);
  });

  it('一件进行中：一条轨道 20px，色块位置用百分比', () => {
    show([ev('e1', '开会', 14, 30)], at(14, 17));
    const ruler = screen.getByTestId('now-ruler');
    expect(ruler.getAttribute('data-lanes')).toBe('1');
    expect(ruler.style.getPropertyValue('--lh')).toBe('20px');
    const seg = ruler.querySelector<HTMLElement>('[data-kind="cur"]');
    expect([seg?.style.getPropertyValue('--t'), seg?.style.getPropertyValue('--h')]).toEqual(['4px', '20px']);
    expect(seg?.style.left).toMatch(/%$/);
  });

  it('下一件：标题前的时刻用数字字体；竖条用项目色，没有项目用次要文字色', () => {
    show([{ ...ev('e1', '逛街', 15), project: 'NEOX' }], at(14, 17));
    expect(screen.getByTestId('now-title').textContent).toBe('15:00 逛街');
    expect(screen.getByTestId('now-title').querySelector('span')?.textContent).toBe('15:00 ');
    const nxt = screen.getByTestId('now-ruler').querySelector<HTMLElement>('[data-kind="nxt"]');
    expect(nxt?.style.getPropertyValue('--pc')).toMatch(/^var\(--p[1-6]s\)$/);
    cleanup();
    show([ev('e1', '逛街', 15)], at(14, 17));
    expect(screen.getByTestId('now-ruler').querySelector<HTMLElement>('[data-kind="nxt"]')?.style.getPropertyValue('--pc')).toBe('var(--k-fg2)');
  });

  it('进行中、下一件在时间尺里：读屏能听到“下一件 …”（时间尺 aria-hidden）；下一件在尺外时只写卡底那一行', () => {
    const card = show([ev('e1', '开会', 14, 30), ev('e2', '逛街', 15)], at(14, 17));
    const sr = [...card.querySelectorAll('span')].find((el) => el.textContent === '下一件 15:00 逛街 · 43 分钟后');
    expect(sr).toBeTruthy();
    expect(sr?.closest('[aria-hidden="true"]')).toBeNull();
    cleanup();
    const far = show([ev('e1', '开会', 12), ev('e2', '逛街', 17)], at(12, 40));
    expect(far.textContent?.split('下一件 17:00 逛街').length).toBe(2);
  });

  it('全天日程标题很长：页头不换行，标签可以省略，“现在 HH:MM”还在', () => {
    const card = show([allDay('a1', '去釜山参加大学同学的婚礼然后顺便看海住两晚')], at(10));
    expect(card.firstElementChild?.textContent).toContain('现在 10:00');
  });
});
