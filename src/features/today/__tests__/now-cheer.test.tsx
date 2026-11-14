// “现在”卡的暖心句和浅色卡（负责人 11-14：“没有日程的时候可以显示一些鼓励的句子或者暖心句子”）：
// • cheerIndex：按当天日期固定选一句，同一天同一句、第二天换下一句，到头绕回；中韩句数一样、每句不超过 20 个字、不重复
// • ② 下一件在时间尺窗口外：浅色卡（data-state="calm"），第一行暖心句，第二行“下一件 17:00 逛街 · 4 小时 20 分后”只出一次，不画时间尺
// • ② 下一件在窗口里：照旧黄卡加时间尺，没有暖心句、卡底不重复写“下一件……”
// • ④ 今天没有日程：浅色卡，写暖心句（不再写“今天没有日程”）；③ 都结束了照旧一行
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { cheerIndex, nowCard, type EventOcc } from '../data/today-model.ts';
import { cheerKo } from '../i18n/cheer-ko.ts';
import { cheerZh } from '../i18n/cheer-zh.ts';
import { cheerText } from '../hooks/useTodayT.ts';
import { NowCard } from '../ui/NowCard.tsx';

const TZ = 'Asia/Seoul';
const DAY = '2026-11-14';
const at = (h: number, m = 0) => msAt(DAY, h * 60 + m, TZ);
const ev = (id: string, title: string, h: number, durMin = 60): EventOcc => ({
  kind: 'event', id, title, project: '', date: DAY, allDay: false, start: at(h), end: at(h) + durMin * 60_000,
  time: `${String(h).padStart(2, '0')}:00`, origin: null,
});
const allDay = (id: string, title: string): EventOcc => ({ kind: 'event', id, title, project: '', date: DAY, allDay: true, start: null, end: null, time: null, origin: null });

function show(events: EventOcc[], now: number) {
  render(<NowCard card={nowCard(events, now, TZ, DAY)} now={now} tz={TZ} today={DAY} tomorrowFirst={null} />);
  return screen.getByTestId('now-card');
}

beforeEach(() => uiStore.getState().setLocale('zh-CN'));
afterEach(cleanup);

describe('暖心句', () => {
  it('同一天同一句，第二天换下一句，到头绕回', () => {
    expect(cheerIndex('2026-11-14', 30)).toBe(cheerIndex('2026-11-14', 30));
    expect((cheerIndex('2026-11-14', 30) + 1) % 30).toBe(cheerIndex('2026-11-15', 30));
    expect(cheerIndex('1970-01-31', 30)).toBe(0);
    expect(cheerIndex('1969-12-31', 30)).toBe(29);
    expect(cheerIndex('2026-11-14', 0)).toBe(0);
    expect(cheerText('2026-11-14', 'zh-CN')).toBe(cheerZh[cheerIndex('2026-11-14', 30)]);
    expect(cheerText('2026-11-14', 'ko-KR')).toBe(cheerKo[cheerIndex('2026-11-14', 30)]);
  });

  it('中韩各 30 句，一样多、每句不超过 20 个字、不重复', () => {
    for (const list of [cheerZh, cheerKo]) {
      expect(list.length).toBe(30);
      expect(new Set(list).size).toBe(list.length);
      for (const s of list) expect([...s].length).toBeLessThanOrEqual(20);
    }
  });
});

describe('“现在”卡的浅色卡', () => {
  it('② 下一件在时间尺窗口外（12:40，只有 17:00 逛街和一个全天的）：浅色卡，暖心句 + 下一件只写一次，不画时间尺', () => {
    const card = show([ev('e1', '逛街', 17), allDay('e2', '逛街')], at(12, 40));
    expect(card.getAttribute('data-state')).toBe('calm');
    expect(screen.getByTestId('now-cheer').textContent).toBe(cheerText(DAY, 'zh-CN'));
    expect(screen.getByTestId('now-hint').textContent).toBe('下一件 17:00 逛街 · 4 小时 20 分后');
    expect(card.textContent?.split('逛街').length).toBe(2);
    expect(screen.queryByTestId('now-ruler')).toBeNull();
    expect(screen.queryByTestId('now-title')).toBeNull();
  });

  it('② 下一件在窗口里：照旧黄卡和时间尺，没有暖心句，卡底不重复写“下一件……”', () => {
    const card = show([ev('e1', '逛街', 14)], at(12, 40));
    expect(card.getAttribute('data-state')).toBe('idle');
    expect(screen.getByTestId('now-ruler')).toBeTruthy();
    expect(screen.getByTestId('now-title').textContent).toBe('14:00 逛街');
    expect(screen.queryByTestId('now-cheer')).toBeNull();
    expect(screen.queryByTestId('now-hint')).toBeNull();
  });

  it('① 进行中而下一件在窗口外：照旧黄卡，时间尺下面写一次下一件', () => {
    const card = show([ev('e1', '开会', 12), ev('e2', '逛街', 17)], at(12, 40));
    expect(card.getAttribute('data-state')).toBe('live');
    expect(screen.getByTestId('now-hint').textContent).toBe('下一件 17:00 逛街 · 4 小时 20 分后');
    expect(screen.queryByTestId('now-cheer')).toBeNull();
  });

  it('④ 今天没有日程：浅色卡写暖心句（韩文界面用韩文句），不写“今天没有日程”', () => {
    const card = show([], at(9, 5));
    expect(card.getAttribute('data-state')).toBe('empty');
    expect(screen.getByTestId('now-cheer').textContent).toBe(cheerText(DAY, 'zh-CN'));
    expect(card.textContent).not.toContain('今天没有日程');
    cleanup();
    uiStore.getState().setLocale('ko-KR');
    show([], at(9, 5));
    expect(screen.getByTestId('now-cheer').textContent).toBe(cheerText(DAY, 'ko-KR'));
  });

  it('③ 今天的日程都结束了：照旧一行，没有暖心句', () => {
    const card = show([ev('e1', '逛街', 9)], at(21, 40));
    expect(card.getAttribute('data-state')).toBe('done');
    expect(card.textContent).toBe('今天的日程都结束了');
  });
});
