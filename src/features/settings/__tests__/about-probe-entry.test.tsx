// 设置 › 关于：非正式版多一行“录音探测（试验）”，点了去 #/dev-csp/voice（B3 FA-0，11-10：主屏幕版没有地址栏）
// 正式版里这一行整块删掉，由 build/check_no_probe.mjs 扫正式产物兜底（testid 带 csp-lab 标记）
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toSub = vi.fn();
vi.mock('../../../app/router-sub.ts', () => ({ navigateSub: (...a: unknown[]) => toSub(...a) }));
const { AboutSection } = await import('../ui/AboutSection.tsx');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('关于页的录音探测入口', () => {
  it('非正式版（测试环境）显示这一行，testid 带 check_no_probe 的标记 csp-lab', () => {
    expect(import.meta.env.MODE).not.toBe('production');
    render(<AboutSection />);
    const row = screen.getByTestId('csp-lab-entry');
    expect(row.textContent).toContain('录音探测（试验）');
  });

  it('点了去 #/dev-csp/voice', () => {
    render(<AboutSection />);
    const row = screen.getByTestId('csp-lab-entry');
    fireEvent.click(row.querySelector('button') ?? row);
    expect(toSub).toHaveBeenCalledWith('dev-csp', 'voice');
  });
});
