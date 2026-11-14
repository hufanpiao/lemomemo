// 存导出文件（platform/save-file.ts；R-256 ②）：电脑 download；iPhone 主屏幕版能分享就分享（canShare 判断），失败退回 download。
// 真机上的分享面板（存到“文件”App）待真机验证，这里只测分支
import { describe, expect, it, vi } from 'vitest';
import { canShareFiles, saveFile, shareFile, type SaveEnv } from '../save-file.ts';

const blob = new Blob(['gz'], { type: 'application/gzip' });
const NAME = 'lemomemo-export-2026-10-30.json.gz';

function env(over: Partial<SaveEnv> = {}) {
  return {
    isIosStandalone: vi.fn(() => true),
    share: vi.fn(async (_d: { files: File[] }) => undefined),
    canShare: vi.fn((_d: { files: File[] }) => true),
    download: vi.fn((_b: Blob, _n: string) => undefined),
    ...over,
  };
}

const err = (name: string): Error => Object.assign(new Error(name), { name });

describe('saveFile', () => {
  it('不是 iPhone 主屏幕版：直接 download，文件名照传', async () => {
    const e = env({ isIosStandalone: vi.fn(() => false) });
    expect(await saveFile(blob, NAME, 'application/gzip', e)).toBe('downloaded');
    expect(e.download).toHaveBeenCalledWith(blob, NAME, 60_000);
    expect(e.share).not.toHaveBeenCalled();
  });

  it('blob URL 回收时间可以传短（隐私记的明文）', async () => {
    const e = env({ isIosStandalone: vi.fn(() => false) });
    await saveFile(blob, NAME, 'application/gzip', e, 10_000);
    expect(e.download).toHaveBeenCalledWith(blob, NAME, 10_000);
  });

  it('iPhone 主屏幕版、canShare 认：用 navigator.share 分享一个同名文件，不再 download', async () => {
    const e = env();
    expect(await saveFile(blob, NAME, 'application/gzip', e)).toBe('shared');
    const files = (vi.mocked(e.share).mock.calls[0]?.[0] as { files: File[] } | undefined)?.files ?? [];
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe(NAME);
    expect(files[0]?.type).toBe('application/gzip');
    expect(e.download).not.toHaveBeenCalled();
  });

  it('canShare 不认、没有 share：退回 download', async () => {
    const a = env({ canShare: vi.fn(() => false) });
    expect(await saveFile(blob, NAME, 'application/gzip', a)).toBe('downloaded');
    expect(a.share).not.toHaveBeenCalled();
    const { share: _s, ...rest } = env();
    const b = { ...rest };
    expect(await saveFile(blob, NAME, 'application/gzip', b)).toBe('downloaded');
    expect(b.download).toHaveBeenCalledTimes(1);
  });

  it('主屏幕版分享被拒（NotAllowedError，等回包太久用户激活过期）：不退回 download（存不进“文件”App），返回 needs_tap 让用户再点一下', async () => {
    const e = env({ share: vi.fn(async () => Promise.reject(err('NotAllowedError'))) });
    expect(await saveFile(blob, NAME, 'application/gzip', e)).toBe('needs_tap');
    expect(e.download).not.toHaveBeenCalled();
    const other = env({ share: vi.fn(async () => Promise.reject(err('DataError'))) });
    expect(await saveFile(blob, NAME, 'application/gzip', other)).toBe('needs_tap');
    expect(other.download).not.toHaveBeenCalled();
  });

  it('不是主屏幕版（电脑、Safari 网页）：即使有 share 也照旧走 download', async () => {
    const e = env({ isIosStandalone: vi.fn(() => false), share: vi.fn(async () => Promise.reject(err('NotAllowedError'))) });
    expect(await saveFile(blob, NAME, 'application/gzip', e)).toBe('downloaded');
    expect(e.share).not.toHaveBeenCalled();
    expect(e.download).toHaveBeenCalledTimes(1);
  });

  it('用户在分享面板里点了取消（AbortError）：返回 cancelled，不 download（界面给“再存一次”）', async () => {
    const e = env({ share: vi.fn(async () => Promise.reject(err('AbortError'))) });
    expect(await saveFile(blob, NAME, 'application/gzip', e)).toBe('cancelled');
    expect(e.download).not.toHaveBeenCalled();
  });
});

describe('用其他 App 打开（shareFile、canShareFiles）', () => {
  it('不管是不是主屏幕版都走分享；取消回 cancelled、被拒回 needs_tap', async () => {
    const e = env({ isIosStandalone: vi.fn(() => false) });
    expect(await shareFile(blob, NAME, 'application/gzip', e)).toBe('shared');
    expect(e.download).not.toHaveBeenCalled();
    expect(await shareFile(blob, NAME, 'application/gzip', env({ share: vi.fn(async () => Promise.reject(err('AbortError'))) }))).toBe('cancelled');
    expect(await shareFile(blob, NAME, 'application/gzip', env({ share: vi.fn(async () => Promise.reject(err('NotAllowedError'))) }))).toBe('needs_tap');
  });
  it('没有 share、canShare 不认或抛错：unsupported，不退回下载', async () => {
    const { share: _s, ...noShare } = env();
    expect(await shareFile(blob, NAME, 'application/gzip', noShare)).toBe('unsupported');
    const no = env({ canShare: vi.fn(() => false) });
    expect(await shareFile(blob, NAME, 'application/gzip', no)).toBe('unsupported');
    expect(no.download).not.toHaveBeenCalled();
    expect(await shareFile(blob, NAME, 'application/gzip', env({ canShare: vi.fn(() => { throw new Error('x'); }) }))).toBe('unsupported');
  });
  it('canShareFiles：有 share 且 canShare 认文件才是 true', () => {
    expect(canShareFiles(env())).toBe(true);
    expect(canShareFiles(env({ canShare: vi.fn(() => false) }))).toBe(false);
    const { canShare: _c, ...noCan } = env();
    expect(canShareFiles(noCan)).toBe(false);
  });
});
