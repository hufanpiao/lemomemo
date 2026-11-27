// 日历页点“＋”或按 Ctrl+N 带上选中的那天（B2 FA-7 第 5 项，hooks/new-date.ts；B3 S24）：
// 日历页挂着时登记“选中的是哪天”（useNewDateSource），App 打开打字条时读 calendarSel.day；选中的变了读到新的；卸掉以后读不到
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DateStr } from '../../../../shared/core/date.ts';
import { calendarSel } from '../../../kit/state/new-item.ts';
import { clearNewDate, useNewDateSource } from '../hooks/new-date.ts';

afterEach(() => {
  cleanup();
  clearNewDate();
});

describe('useNewDateSource', () => {
  it('挂着时读到当前选中的那天（换了选中读到新的）；卸掉以后读不到', () => {
    const { rerender, unmount } = renderHook(({ sel }: { sel: DateStr | null }) => useNewDateSource(sel), { initialProps: { sel: '2026-11-09' as DateStr | null } });
    expect(calendarSel.day?.()).toBe('2026-11-09');
    rerender({ sel: '2026-11-12' });
    expect(calendarSel.day?.()).toBe('2026-11-12');
    rerender({ sel: null });
    expect(calendarSel.day?.()).toBeNull();
    unmount();
    expect(calendarSel.day).toBeUndefined();
  });
});
