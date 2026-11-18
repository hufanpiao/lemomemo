// 待办行上的两个 kit 小部件（主持人 11-17 评审）：
// • PrioCycle：手指、鼠标点在哪一格就设成哪一档（点当前那一档什么都不做）；键盘、读屏按下去（click 的 detail 为 0）照旧换下一档
// • CheckCircle：子任务做到几成的档（partStage）——全做完、主待办没勾时是 3，方框满填、不画脸；勾上那一圈小点播完就拿掉，不重播
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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

  // jsdom 的样式里没有 animation 属性，React 按带前缀的名字监听：两个名字都发一次（真浏览器只有不带前缀的那个）
  const animEnd = (el: Element) =>
    act(() => {
      for (const type of ['animationend', 'webkitAnimationEnd']) el.dispatchEvent(new Event(type, { bubbles: true }));
    });
  const box = (checked: boolean, fresh?: boolean) => <CheckCircle checked={checked} label="完成" onChange={() => undefined} testId="c" fresh={fresh} />;
  /** 画面层（label 里的 .face）：.pop 挂在这一层，回弹的 animationend 也在这一层（11-18 点击区不缩以后） */
  const face = () => document.querySelector('label > span') as HTMLElement;
  /** 和页面一样：点了当场就按“刚点的值”画（TodoRow 经 useDoneFlow 同一拍改 checked）；set 是“照数据改”（撤销、写入失败退回） */
  let set: (v: boolean) => void = () => undefined;
  function Live() {
    const [on, setOn] = useState(false);
    set = setOn;
    return <CheckCircle checked={on} label="完成" onChange={setOn} testId="c" />;
  }

  it('亲手勾上（负责人 11-18 定稿乙4）：回弹、14 个小点（每 360/14 度一个）和细正圆；小点、细正圆先播完不清，方框自己的回弹播完（最后结束）才拿掉', () => {
    render(<Live />);
    fireEvent.click(screen.getByTestId('c'));
    const burst = document.querySelector('label > span > span:last-child') as Element;
    const dots = [...burst.querySelectorAll<HTMLElement>('i')];
    expect(dots).toHaveLength(14);
    expect(Number.parseFloat(dots[1]!.style.getPropertyValue('--a'))).toBeCloseTo(360 / 14, 6);
    expect(burst.querySelector('b')).not.toBeNull();
    expect(face().className).toMatch(/pop/);
    animEnd(dots[13]!);
    animEnd(burst.querySelector('b')!);
    expect(face().className).toMatch(/pop/);
    animEnd(face());
    expect(document.querySelectorAll('label i')).toHaveLength(0);
    expect(face().className).not.toMatch(/pop/);
  });

  it('减弱动态效果（动画不播、animationend 一直不来）：撤销以后照数据再显示成勾上，不重播', () => {
    render(<Live />);
    fireEvent.click(screen.getByTestId('c'));
    expect(face().className).toMatch(/pop/);
    // 不发 animationend：停留期间、收起以后一直勾着，.pop 留着（CSS 里是 animation: none、小点 display: none，什么都不画）
    act(() => set(false));
    expect(face().className).not.toMatch(/pop/);
    act(() => set(true));
    expect(face().className).not.toMatch(/pop/);
    expect(document.querySelectorAll('label i')).toHaveLength(0);
  });

  it('动画没播完就变回没勾上（撤销、写入失败照数据退回）：清零；之后照数据再显示成勾上不重播', () => {
    render(<Live />);
    fireEvent.click(screen.getByTestId('c'));
    expect(face().className).toMatch(/pop/);
    act(() => set(false));
    act(() => set(true));
    expect(face().className).not.toMatch(/pop/);
    expect(document.querySelectorAll('label i')).toHaveLength(0);
  });

  it('亮色（fresh）：勾上而且使用方说还在原位才打 data-fresh；没勾上、不给 fresh 都不打', () => {
    const { rerender } = render(box(true, true));
    expect(document.querySelector('label')!.hasAttribute('data-fresh')).toBe(true);
    rerender(box(true));
    expect(document.querySelector('label')!.hasAttribute('data-fresh')).toBe(false);
    rerender(box(false, true));
    expect(document.querySelector('label')!.hasAttribute('data-fresh')).toBe(false);
  });
});
