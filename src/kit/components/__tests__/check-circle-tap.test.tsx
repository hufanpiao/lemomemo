// CheckCircle 手指抬起就切换（负责人 11-18“待办点击完成还是会有点完延迟或者不执行”，运行日志 preview.405：
// pointerup 当下到，click 晚 0.2～0.26 秒或两下快点只来一个）：触摸抬手当下回调一次，之后系统补发的 click 不再切；
// 滑远了不算轻点；鼠标、键盘照旧走 input 自己的 click。真机上的时差只能真机看
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckCircle } from '../CheckCircle.tsx';

afterEach(cleanup);

function setup(checked = false) {
  const onChange = vi.fn();
  render(<CheckCircle checked={checked} label="交报告" onChange={onChange} testId="ck" />);
  const input = screen.getByTestId('ck');
  const label = input.closest('label') as HTMLLabelElement;
  return { onChange, input, label };
}

function tap(el: Element, type: string, dx = 0, id = 1): void {
  fireEvent.pointerDown(el, { pointerId: id, pointerType: type, button: 0, clientX: 20, clientY: 20 });
  fireEvent.pointerUp(window, { pointerId: id, pointerType: type, button: 0, clientX: 20 + dx, clientY: 20 });
}

describe('CheckCircle 抬手切换', () => {
  it('触摸抬手当下切换一次，补发的 click 被拦掉', () => {
    const { onChange, input, label } = setup(false);
    tap(label, 'touch');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('已勾上的抬手切回没勾上', () => {
    const { onChange, label } = setup(true);
    tap(label, 'touch');
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('两下快点各算一下，系统只补一个 click 也不多切', () => {
    const { onChange, input, label } = setup(false);
    tap(label, 'touch', 0, 1);
    tap(label, 'touch', 0, 2);
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('手指滑出 10 px 不算轻点', () => {
    const { onChange, label } = setup(false);
    tap(label, 'touch', 30);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('取消（被列表滚动接走）不切换', () => {
    const { onChange, label } = setup(false);
    fireEvent.pointerDown(label, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerCancel(window, { pointerId: 1, pointerType: 'touch' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('鼠标照旧靠 click', () => {
    const { onChange, input, label } = setup(false);
    tap(label, 'mouse');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('没有抬手在先的 click（键盘空格）照常切换', () => {
    const { onChange, input } = setup(false);
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
