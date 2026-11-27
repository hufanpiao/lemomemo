// 提醒里每条前面的类型记号（ui/KindMark.tsx；B5 整块评审第 18 条，R-121、R-125、架构 5.4）：
// 纪念日画圆形头像（没头像是名字第一个字加类型颜色的圆），不再是菱形；日程、待办照旧是项目色的记号
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Reminder } from '../hooks/remind-view.ts';
import { KindMark } from '../ui/KindMark.tsx';

const rem = (kind: Reminder['kind'], row: Record<string, unknown>, title = '妈妈生日') => ({ kind, id: 'a1', title, row }) as unknown as Reminder;

afterEach(cleanup);

describe('KindMark', () => {
  it('纪念日：圆形头像（懒加载 AnnivFace），没头像时是名字第一个字、生日的颜色', async () => {
    render(<KindMark r={rem('anniv', { kind: 'birthday', avatar_id: null })} />);
    const av = await screen.findByTestId('anniv-avatar');
    expect(av.textContent).toBe('妈');
    expect(av.className).toMatch(/p1/);
  });
  it('待办、日程：没有头像，是类型记号', () => {
    const { container } = render(<KindMark r={rem('todo', { project: '' }, '买柠檬')} sm />);
    expect(screen.queryByTestId('anniv-avatar')).toBeNull();
    expect(container.querySelector('span[aria-hidden="true"]')).not.toBeNull();
  });
});
