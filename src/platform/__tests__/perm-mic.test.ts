// 麦克风权限状态（B3 S23）：记最近一次结果、Permissions API 优先、问不到用记下的
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastMicResult, MIC_PERM_KEY, micPermission, micResultOf, rememberMicResult } from '../perm-mic.ts';

beforeEach(() => localStorage.removeItem(MIC_PERM_KEY));
afterEach(() => vi.unstubAllGlobals());

const withPerm = (query: () => Promise<{ state: string }>): void => {
  vi.stubGlobal('navigator', { ...navigator, permissions: { query } });
};

describe('micResultOf', () => {
  it('成功 → granted；拒绝类错误 → denied；别的错不记', () => {
    expect(micResultOf(null)).toBe('granted');
    expect(micResultOf(new DOMException('x', 'NotAllowedError'))).toBe('denied');
    expect(micResultOf(new DOMException('x', 'SecurityError'))).toBe('denied');
    expect(micResultOf(new DOMException('x', 'NotFoundError'))).toBeNull();
    expect(micResultOf('weird')).toBeNull();
  });
});

describe('记下的结果', () => {
  it('没记过 → unknown；记了能读回', () => {
    expect(lastMicResult()).toBe('unknown');
    rememberMicResult('denied');
    expect(lastMicResult()).toBe('denied');
  });

  it('存的值不认识 → unknown', () => {
    localStorage.setItem(MIC_PERM_KEY, 'maybe');
    expect(lastMicResult()).toBe('unknown');
  });
});

describe('micPermission', () => {
  it('Permissions API 回 granted / denied 就用它并记下', async () => {
    withPerm(async () => ({ state: 'denied' }));
    expect(await micPermission()).toBe('denied');
    expect(lastMicResult()).toBe('denied');
  });

  it('回 prompt → unknown，清掉以前记的“已拒绝”', async () => {
    rememberMicResult('denied');
    withPerm(async () => ({ state: 'prompt' }));
    expect(await micPermission()).toBe('unknown');
    expect(lastMicResult()).toBe('unknown');
  });

  it('回 prompt 时记下的“已允许”留着（11-13：iPhone 主屏幕版每次启动都回 prompt，清掉会每次先出说明卡）', async () => {
    rememberMicResult('granted');
    withPerm(async () => ({ state: 'prompt' }));
    expect(await micPermission()).toBe('granted');
    expect(lastMicResult()).toBe('granted');
  });

  it('回 prompt、什么都没记过 → unknown', async () => {
    withPerm(async () => ({ state: 'prompt' }));
    expect(await micPermission()).toBe('unknown');
    expect(lastMicResult()).toBe('unknown');
  });

  it('不认 microphone（抛错）→ 用记下的', async () => {
    rememberMicResult('granted');
    withPerm(async () => {
      throw new TypeError('microphone is not a valid PermissionName');
    });
    expect(await micPermission()).toBe('granted');
  });

  it('没有 Permissions API → 用记下的', async () => {
    rememberMicResult('denied');
    vi.stubGlobal('navigator', { ...navigator, permissions: undefined });
    expect(await micPermission()).toBe('denied');
  });
});
