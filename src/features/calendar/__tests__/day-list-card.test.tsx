// DayList 面板最上面那张卡片的位置（主持人 11-22 评审第 3 条）：面板画不画不按 card 是否为 null 判断（页面恒给 FortuneSlot）
// • 卡片什么都不渲染（算法下载失败、fortuneOf 回 null）时外层 .card / .cardOnly 是空的：靠 CSS :empty 不占位，分隔线只跟在有内容的 .card 后面
// • 只有待办、没有日程行：不画日程面板（R-443 原样），卡片单独一块 .cardOnly；卡片也空了就整块不显示
// jsdom 不算样式，DOM 结构在这里断言，CSS 规则读 DayList.module.css 原文核对；真浏览器里的占位在 e2e b2-fortune-card
import { readFileSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CalItems, CalTodo } from '../../../../shared/logic/calendar/cal-items.ts';
import { useCalViewT } from '../hooks/useCalViewT.ts';
import { DayList } from '../ui/DayList.tsx';
import { styles } from './css-of.ts';

const DATE = '2026-11-21';
const TODO: CalTodo = { id: 't1', title: '买菜', short: null, short_by: null, project: '', due: DATE, done: false, created_at: 0, deleted_at: null, undone: false } as CalTodo;
const Nothing = (): null => null;

function Host({ items, card }: { items: CalItems; card: ReactNode }) {
  const t = useCalViewT();
  return <DayList date={DATE} items={items} tz="Asia/Seoul" t={t} card={card} onOpen={() => undefined} isRo={() => false} openId={null} />;
}

afterEach(cleanup);

describe('DayList 的卡片位置', () => {
  it('卡片什么都不渲染、当天没事：外层 .card 是空的（:empty 不占位），下面照旧是空状态', () => {
    render(<Host items={{ events: [], todos: [] }} card={<Nothing />} />);
    const list = screen.getByTestId('cal-day-list');
    const box = list.querySelector(`.${styles['card']}`);
    expect(box).not.toBeNull();
    expect(box?.childNodes).toHaveLength(0);
    expect(list.querySelector(`.${styles['cardOnly']}`)).toBeNull();
  });

  it('只有待办：不画日程面板（没有空状态那一行），卡片单独一块 .cardOnly；卡片空了它也是空的', () => {
    const { rerender } = render(<Host items={{ events: [], todos: [TODO] }} card={<i data-testid="c" />} />);
    const list = screen.getByTestId('cal-day-list');
    const only = list.querySelector(`.${styles['cardOnly']}`);
    expect(only?.querySelector('[data-testid="c"]')).not.toBeNull();
    expect(list.querySelector(`.${styles['card']}`)).toBeNull();
    expect(list.textContent).not.toContain('这一天没有安排');
    rerender(<Host items={{ events: [], todos: [TODO] }} card={<Nothing />} />);
    expect(list.querySelector(`.${styles['cardOnly']}`)?.childNodes).toHaveLength(0);
  });

  it('CSS：空的 .card、.cardOnly 不显示；日程行上面的分隔线只跟在有内容的 .card 后面', () => {
    const css = readFileSync('src/features/calendar/ui/DayList.module.css', 'utf8');
    expect(css).toMatch(/\.card:empty,\s*\.cardOnly:empty\s*\{\s*display:\s*none;\s*\}/);
    expect(css).toMatch(/\.card:not\(:empty\)\s*\+\s*\.dayListRows\s*\{[^}]*border-top:/);
    // 不许有不看 :empty、无条件给日程行画上边线的规则
    expect(css).not.toMatch(/(^|\})\s*\.card\s*\+\s*\.dayListRows/);
  });
});
