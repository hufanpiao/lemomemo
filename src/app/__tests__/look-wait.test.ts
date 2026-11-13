// 渲染前等外观最多 600 毫秒（皮肤字体整块评审 11-14 第 2 条）：app/look-wait.ts。
// look.ts 分包一直不到（弱网、分包请求挂住）时 600 毫秒后照样往下渲染（先按入口页默认皮肤），晚到的 look 照样套上（look.ts 自己套，不靠这里）
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOOK_WAIT_MS, waitLook } from '../look-wait.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('waitLook', () => {
  it('上限是 600 毫秒', () => {
    expect(LOOK_WAIT_MS).toBe(600);
  });

  it('look 一直挂着：600 毫秒后照样放行，599 毫秒时还在等', async () => {
    vi.useFakeTimers();
    let done = false;
    void waitLook(new Promise(() => undefined)).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(599);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('look 先到：马上放行，不等满 600 毫秒', async () => {
    vi.useFakeTimers();
    let done = false;
    void waitLook(Promise.resolve()).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it('look 加载失败：同样放行，不抛', async () => {
    await expect(waitLook(Promise.reject(new Error('chunk')))).resolves.toBeUndefined();
  });
});

describe('main.tsx 渲染前用的是 waitLook', () => {
  it('await waitLook(look)，没有直接 await look', () => {
    const main = readFileSync('src/app/main.tsx', 'utf8').replace(/\/\/.*$/gm, '');
    expect(main).toMatch(/await waitLook\(look\);/);
    expect(main).not.toMatch(/await look\b/);
  });
});
