// QuietBoundary（今天页待办 代码审查 M1；代码复审 N1）：里面出错只把这一块去掉、页面照常；按 name 记进日志总线（quiet_error_<name>），同一个 name 这一页只记一次
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLogBusForTest, setLogSink } from '../../../../shared/core/log-bus.ts';
import { QUIET_NAME, QuietBoundary, resetQuietErrorLogForTest } from '../QuietBoundary.tsx';

function Boom(): never {
  throw new Error('boom');
}

beforeEach(() => {
  resetQuietErrorLogForTest();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  resetLogBusForTest();
  vi.restoreAllMocks();
});

describe('QuietBoundary', () => {
  it('里面出错：这一块不画，旁边照常；按 name 记一条，同一个 name 只记一次', () => {
    const log = vi.fn();
    setLogSink(log);
    render(
      <div>
        <p>日程</p>
        <QuietBoundary name="unsynced-mark"><Boom /></QuietBoundary>
        <QuietBoundary name="unsynced-mark"><Boom /></QuietBoundary>
        <QuietBoundary name="missed"><Boom /></QuietBoundary>
      </div>,
    );
    expect(screen.getByText('日程')).toBeTruthy();
    expect(log.mock.calls.map((c) => c[0])).toEqual(['quiet_error_unsynced-mark', 'quiet_error_missed']);
    expect(log.mock.calls[0]?.[1]?.error).toBeInstanceOf(Error);
  });

  it('没接日志、日志自己出错：都不挡页面', () => {
    render(<QuietBoundary name="a"><Boom /></QuietBoundary>);
    setLogSink(() => {
      throw new Error('log down');
    });
    render(<div><QuietBoundary name="b"><Boom /></QuietBoundary><p>照常</p></div>);
    expect(screen.getByText('照常')).toBeTruthy();
  });

  it('给了 fallback：出错时画它（电脑版布局分包下不来时退回手机排法，B6）', () => {
    render(<QuietBoundary name="today-desk" fallback={<p>一列</p>}><Boom /></QuietBoundary>);
    expect(screen.getByText('一列')).toBeTruthy();
  });

  it('没出错：原样画', () => {
    render(<QuietBoundary name="c"><p>内容</p></QuietBoundary>);
    expect(screen.getByText('内容')).toBeTruthy();
  });

  it('各处用的 name 都合约定（小写字母、数字、连字符，不超过 20 个），拼成 quiet_error_<name> 不超过 32 个字符（logs.act 的上限；L5）', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, '../../../');
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx$/.test(f) && !/__tests__/.test(f));
    const names = files.flatMap((f) => [...readFileSync(join(root, f), 'utf8').matchAll(/<QuietBoundary[^>]*\sname=("[^"]*"|\{[^}]*\}|\S+?)[\s/>]/g)].map((m) => m[1] ?? ''));
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const raw of names) {
      expect(raw, '写成字符串常量 name="…"，扫得到').toMatch(/^"[^"]*"$/);
      const n = raw.slice(1, -1);
      expect(n, n).toMatch(QUIET_NAME);
      expect(`quiet_error_${n}`.length, n).toBeLessThanOrEqual(32);
    }
  });

  it('不合约定的 name（太长、带大写或中文）按 bad-name 记', () => {
    const log = vi.fn();
    setLogSink(log);
    render(<QuietBoundary name="this-name-is-way-too-long-for-logs"><Boom /></QuietBoundary>);
    render(<QuietBoundary name="错过"><Boom /></QuietBoundary>);
    expect(log.mock.calls.map((c) => c[0])).toEqual(['quiet_error_bad-name']);
  });
});
