// 公共词典按语言懒加载（首屏瘦身 D，11-17；platform/doc-locale.ts、shared/i18n/i18n.ts 的 sharedT）：
// 只下载要的那一种；同一种正在下载时是同一次；下载失败 reject、下次重新下载；入口用的 ensureSharedDict 失败改下另一种、再失败也放行；
// 查找顺序：要的那份 → 另一份 → 启动兜底（App 名、退出屏、出错屏、升级整屏提示）→ 键名；放进新的一份时通知订阅者（独立评审 11-17 第 2、3、5 条）
// 公共准备（tests/fakes/shared-dicts-setup.ts）放了中文一份，这里 vi.resetModules 换一份空的
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ko } from '../../../shared/i18n/ko.ts';
import { zh } from '../../../shared/i18n/zh.ts';

async function fresh() {
  vi.resetModules();
  const i18n = await import('../../../shared/i18n/i18n.ts');
  const doc = await import('../doc-locale.ts');
  return { ...i18n, ...doc };
}

const failChunk = (path: string): void => {
  vi.doMock(path, () => {
    throw new Error('chunk_load_failed');
  });
};

afterEach(() => {
  vi.doUnmock('../../../shared/i18n/zh.ts');
  vi.doUnmock('../../../shared/i18n/ko.ts');
  vi.resetModules();
});

describe('loadSharedDict（公共词典只下载当前语言）', () => {
  it('只下载要的那一份；同时调两次是同一次下载；下载好以后回 null（当场接着做）', async () => {
    const m = await fresh();
    expect(m.hasSharedDict('zh-CN')).toBe(false);
    expect(m.hasSharedDict('ko-KR')).toBe(false);
    const p = m.loadSharedDict('ko-KR');
    expect(p).not.toBeNull();
    expect(m.loadSharedDict('ko-KR')).toBe(p);
    await p;
    expect(m.hasSharedDict('ko-KR')).toBe(true);
    expect(m.hasSharedDict('zh-CN')).toBe(false);
    expect(m.loadSharedDict('ko-KR')).toBeNull();
  });

  it('下载失败：reject，词典仍没有；下次再调重新下载', async () => {
    failChunk('../../../shared/i18n/zh.ts');
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

describe('ensureSharedDict（入口用：失败改下另一种，再失败也放行）', () => {
  it('当前语言那份下载失败（如发版后旧块 404）：改下另一种，界面用另一种语言的字，不出键名；记一行日志', async () => {
    failChunk('../../../shared/i18n/ko.ts');
    const m = await fresh();
    const log = vi.fn();
    await m.ensureSharedDict('ko-KR', log);
    expect(log).toHaveBeenCalledWith('i18n err=load locale=ko-KR');
    expect(m.hasSharedDict('ko-KR')).toBe(false);
    expect(m.hasSharedDict('zh-CN')).toBe(true);
    expect(m.sharedT('fmt.dur.mTail', { n: 5 }, 'ko-KR')).toBe(zh['fmt.dur.mTail'].replace('{n}', '5'));
  });

  it('两种都下载失败：照样 resolve；App 名、退出屏、出错屏、升级整屏提示走启动兜底（按要的语言），别的词条才回键名', async () => {
    failChunk('../../../shared/i18n/ko.ts');
    failChunk('../../../shared/i18n/zh.ts');
    const m = await fresh();
    const log = vi.fn();
    await expect(m.ensureSharedDict('ko-KR', log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
    for (const key of ['app.name', 'app.crashed.title', 'exit.incomplete.retry', 'exit.unavailable.title', 'update.blocked.title', 'update.tooNew.title'] as const) {
      expect(m.sharedT(key, {}, 'ko-KR')).toBe(ko[key]);
      expect(m.sharedT(key, {}, 'zh-CN')).toBe(zh[key]);
    }
    expect(m.sharedT('fmt.dur.mTail', { n: 5 }, 'zh-CN')).toBe('fmt.dur.mTail');
  });

  it('当前语言下载成功：不下另一种', async () => {
    const m = await fresh();
    await m.ensureSharedDict('zh-CN');
    expect(m.hasSharedDict('zh-CN')).toBe(true);
    expect(m.hasSharedDict('ko-KR')).toBe(false);
  });
});

describe('sharedT 查找顺序与订阅', () => {
  it('只有韩文一份：要中文时用韩文；中文到了改用中文，并通知订阅者', async () => {
    const m = await fresh();
    m.provideSharedDict('ko-KR', ko);
    expect(m.sharedT('fmt.dur.mTail', { n: 3 }, 'zh-CN')).toBe(ko['fmt.dur.mTail'].replace('{n}', '3'));
    const seen = vi.fn();
    const before = m.sharedDictSnapshot();
    const off = m.subscribeSharedDict(seen);
    m.provideSharedDict('zh-CN', zh);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(m.sharedDictSnapshot()).not.toBe(before);
    expect(m.sharedT('fmt.dur.mTail', { n: 3 }, 'zh-CN')).toBe(zh['fmt.dur.mTail'].replace('{n}', '3'));
    off();
    m.resetSharedDictsForTest();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
