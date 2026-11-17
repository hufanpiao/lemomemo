// 待办行上的两个 kit 小部件（主持人 11-17 评审）：
// • PrioCycle：手指、鼠标点在哪一格就设成哪一档（点当前那一档什么都不做）；键盘、读屏按下去（click 的 detail 为 0）照旧换下一档
// • CheckCircle：子任务做到几成的档（partStage）——全做完、主待办没勾时是 3，方框满填、不画脸；勾上那一圈小点播完就拿掉，不重播
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckCircle, partStage } from '../CheckCircle.tsx';
import { PrioCycle } from '../Priority.tsx';

afterEach(cleanup);

describe('PrioCycle 点格设档', () => {
  const setup = () => {
    const onChange = vi.fn();
    render(<PrioCycle p="mid" label="优先级" onChange={onChange} testId="pc" />);
    const btn = screen.getByTestId('pc');
    // jsdom 不排版：给按钮一个 60 宽的盒子（三格各 20）
    btn.getBoundingClientRect = () => ({ left: 100, width: 60, top: 0, height: 24, right: 160, bottom: 24, x: 100, y: 0, toJSON: () => ({}) });
    return { btn, onChange };
  };

  it('点在第一格设成高、第三格设成低（不按轮换）；点到外扩区按横向位置算；点当前那一档（中）不回调、不写库', () => {
    const { btn, onChange } = setup();
    fireEvent.click(btn, { detail: 1, clientX: 105 });
    fireEvent.click(btn, { detail: 1, clientX: 155 });
    fireEvent.click(btn, { detail: 1, clientX: 130 });
    fireEvent.click(btn, { detail: 1, clientX: 170 });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['high', 'low', 'low']);
  });

  it('键盘、读屏（detail 为 0）照旧换下一档：中 → 低', () => {
    const { btn, onChange } = setup();
    fireEvent.click(btn, { detail: 0, clientX: 0 });
    expect(onChange).toHaveBeenCalledWith('low');
  });
});

describe('CheckCircle 子任务进度和小点', () => {
  it('partStage：没开始 0、不到一半 1、一半及以上 2、全做完 3', () => {
    expect([partStage(0, 3), partStage(1, 3), partStage(2, 3), partStage(3, 3), partStage(0, 0)]).toEqual([0, 1, 2, 3, 0]);
  });

  it('全做完、主待办没勾：方框满填（--part 1）、data-stage 3（样式里不画脸）', () => {
    render(<CheckCircle checked={false} label="完成" onChange={() => undefined} testId="c" progress={{ done: 3, total: 3 }} />);
    const part = document.querySelector<HTMLElement>('[data-stage]');
    expect(part?.dataset['stage']).toBe('3');
    expect(part?.style.getPropertyValue('--part')).toBe('1');
  });

  it('亲手勾上放大过头、播一圈小点和外圈，外圈播完（animationend）拿掉', () => {
    const { rerender } = render(<CheckCircle checked={false} label="完成" onChange={() => undefined} testId="c" />);
    fireEvent.click(screen.getByTestId('c'));
    rerender(<CheckCircle checked label="完成" onChange={() => undefined} testId="c" />);
    const burst = document.querySelector('label > span:last-child');
    expect(burst?.querySelectorAll('i')).toHaveLength(8);
    expect(document.querySelector('label')?.className).toMatch(/pop/);
    // jsdom 的样式里没有 animation 属性，React 按带前缀的名字监听：两个名字都发一次（真浏览器只有不带前缀的那个）
    const ring = burst?.querySelector('b') as Element;
    act(() => {
      for (const type of ['animationend', 'webkitAnimationEnd']) ring.dispatchEvent(new Event(type, { bubbles: true }));
    });
    expect(document.querySelectorAll('label i')).toHaveLength(0);
    expect(document.querySelector('label')?.className).not.toMatch(/pop/);
  });
});
