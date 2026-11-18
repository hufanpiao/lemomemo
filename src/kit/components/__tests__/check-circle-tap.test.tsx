// CheckCircle 手指抬起就切换（负责人 11-18“待办点击完成还是会有点完延迟或者不执行”，运行日志 preview.405：
// pointerup 当下到，click 晚 0.2～0.26 秒或两下快点只来一个）：触摸抬手当下回调一次，之后系统补发的 click 不再切；
// 滑远了不算轻点；鼠标、键盘照旧走 input 自己的 click。真机上的时差只能真机看
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** 手指下的真开关问“这一下要不要震”（platform/fx-api.ts 的 takeBuzz）：测试里直接给答案 */
let buzz = false;
const takeBuzz = vi.fn((keep?: boolean) => {
  const ok = buzz;
  if (!keep) buzz = false;
  return ok;
});
vi.mock('../../hooks/tapBuzz.ts', () => ({ takeBuzz: (keep?: boolean) => takeBuzz(keep) }));
const { CheckCircle } = await import('../CheckCircle.tsx');

afterEach(() => {
  cleanup();
  buzz = false;
  takeBuzz.mockClear();
});

function setup(checked = false) {
  const onChange = vi.fn();
  render(<CheckCircle checked={checked} label="交报告" onChange={onChange} testId="ck" />);
  const input = screen.getByTestId('ck') as HTMLInputElement;
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

// 震动（负责人 11-18 iOS 26.6 真机：只有手指真点到 <input type="checkbox" switch> 才震）：checkbox 带 switch 属性、读屏照旧是复选框；
// 补发的 click 该震（抬手时调过该震的 fx）就放它真的切一下开关，React 不再切、下一帧前状态放回；不该震照旧 preventDefault
describe('CheckCircle 手指下的真开关', () => {
  it('checkbox 带 switch 属性，role 写死 checkbox，读屏名字不变', () => {
    const { input } = setup(false);
    expect(input.hasAttribute('switch')).toBe(true);
    expect(screen.getByRole('checkbox', { name: '交报告' })).toBe(input);
  });

  it('该震：补发的 click 不 preventDefault（系统真的切开关出触感），不再回调；下一帧前状态放回 React 的值', async () => {
    const { onChange, input, label } = setup(false);
    tap(label, 'touch');
    buzz = true;
    expect(fireEvent.click(input), '没被 preventDefault').toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input.checked, '系统切成了反的').toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(input.checked, '放回 React 的值（父组件没改 checked，还是 false）').toBe(false);
  });

  it('不该震（取消勾选、只读拦下、声音和触感关着）：补发的 click 照旧 preventDefault', () => {
    const { onChange, input, label } = setup(true);
    tap(label, 'touch');
    expect(fireEvent.click(input)).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input.checked).toBe(true);
  });

  it('点在外扩区（click 落在 label 上）：该震就放 label 转给 checkbox、只在转来的那次取走记号；不该震整个拦掉', () => {
    const { onChange, input, label } = setup(false);
    tap(label, 'touch');
    buzz = true;
    fireEvent.click(label);
    expect(takeBuzz).toHaveBeenCalledWith(true);
    expect(takeBuzz).toHaveBeenLastCalledWith(undefined);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input.checked, 'label 转给了开关').toBe(true);
    cleanup();
    const b = setup(false);
    tap(b.label, 'touch');
    expect(fireEvent.click(b.label)).toBe(false);
    expect(b.input.checked).toBe(false);
  });
});
