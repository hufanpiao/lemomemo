// 公共词典按语言懒加载（首屏瘦身 D，11-17；platform/doc-locale.ts 的 loadSharedDict、shared/i18n/i18n.ts 的 sharedT）：
// 只下载要的那一种；下载好以前 sharedT 用另一份、两份都没有回键名；下载好以后不再等；下载失败 reject、下次重新下载。
// 公共准备（tests/fakes/shared-dicts-setup.ts）放好了两份，这里 vi.resetModules 换一份空的
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ko } from '../../../shared/i18n/ko.ts';

async function fresh() {
  vi.resetModules();
  const i18n = await import('../../../shared/i18n/i18n.ts');
  const doc = await import('../doc-locale.ts');
  return { ...i18n, ...doc };
}

afterEach(() => {
  vi.doUnmock('../../../shared/i18n/zh.ts');
  vi.resetModules();
});

describe('loadSharedDict（公共词典只下载当前语言）', () => {
  it('只下载要的那一份；同时调两次是同一次下载；下载好以后回 null（当场接着做）', async () => {
    const m = await fresh();
    expect(m.hasSharedDict('zh-CN')).toBe(false);
    expect(m.hasSharedDict('ko-KR')).toBe(false);
    expect(m.sharedT('app.name', {}, 'zh-CN')).toBe('app.name');
    const p = m.loadSharedDict('ko-KR');
    expect(p).not.toBeNull();
    expect(m.loadSharedDict('ko-KR')).toBe(p);
    await p;
    expect(m.hasSharedDict('ko-KR')).toBe(true);
    expect(m.hasSharedDict('zh-CN')).toBe(false);
    expect(m.loadSharedDict('ko-KR')).toBeNull();
    expect(m.sharedT('app.name', {}, 'ko-KR')).toBe(ko['app.name']);
    // 中文那份没下载：用已有的韩文，不出键名
    expect(m.sharedT('app.name', {}, 'zh-CN')).toBe(ko['app.name']);
  });

  it('下载失败：reject，词典仍没有；下次再调重新下载', async () => {
    vi.doMock('../../../shared/i18n/zh.ts', () => {
      throw new Error('chunk_load_failed');
    });
    const m = await fresh();
    await expect(m.loadSharedDict('zh-CN')).rejects.toThrow();
    expect(m.hasSharedDict('zh-CN')).toBe(false);
    vi.doUnmock('../../../shared/i18n/zh.ts');
    const again = m.loadSharedDict('zh-CN');
    expect(again).not.toBeNull();
    await again;
    expect(m.hasSharedDict('zh-CN')).toBe(true);
  });
});
