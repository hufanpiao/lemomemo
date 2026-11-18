// TapSwitch（R-471，负责人 11-18 iOS 26.6 真机：只有手指真点到系统开关才震）：按钮里藏一个真开关，click 照样冒泡到按钮、onClick 照常；
// 按钮 onClick 里调了该震的 fx（takeBuzz 为 true）才放这次 click 切开关，不然 preventDefault；读屏只读按钮本身
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let buzz = false;
vi.mock('../../hooks/tapBuzz.ts', () => ({
  takeBuzz: () => {
    const ok = buzz;
    buzz = false;
    return ok;
  },
}));
const { TapSwitch } = await import('../TapSwitch.tsx');

afterEach(() => {
  cleanup();
  buzz = false;
});

function setup(onClick: () => void) {
  render(
    <button type="button" onClick={onClick} data-testid="b">
      删除
      <TapSwitch />
    </button>,
  );
  const btn = screen.getByTestId('b');
  const sw = btn.querySelector('input') as HTMLInputElement;
  return { btn, sw };
}

describe('TapSwitch', () => {
  it('真开关：type checkbox、带 switch，aria-hidden、tabIndex -1；读屏只有按钮、名字不变', () => {
    const { sw } = setup(() => undefined);
    expect(sw.type).toBe('checkbox');
    expect(sw.hasAttribute('switch')).toBe(true);
    expect(sw.getAttribute('aria-hidden')).toBe('true');
    expect(sw.tabIndex).toBe(-1);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
  });

  it('点到开关：按钮 onClick 照常；onClick 里调了该震的 fx 就放它切（出触感），没调就 preventDefault', () => {
    const onClick = vi.fn(() => {
      buzz = true;
    });
    const { sw } = setup(onClick);
    expect(fireEvent.click(sw)).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(sw.checked).toBe(true);
    onClick.mockImplementation(() => undefined);
    expect(fireEvent.click(sw), '这次 onClick 没调 fx').toBe(false);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('点到开关时焦点交给按钮', () => {
    const { btn, sw } = setup(() => undefined);
    sw.focus();
    expect(document.activeElement).toBe(btn);
  });
});
