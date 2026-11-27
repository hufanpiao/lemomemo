// 看图页的存图按钮（台账 #383；ui/ImageViewer.tsx）：样式、位置照附件预览——手机底部一整条（能分享文件写“存到相册”，不能写“下载”），电脑顶行“下载”；
// 调用方不给 onSave 不出按钮。点了交回的是正在看的那张 id
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: () => undefined }));

const { default: ImageViewer } = await import('../ui/ImageViewer.tsx');

const A = '0199a000-0000-7000-8000-000000000001';
const B = '0199a000-0000-7000-8000-000000000002';

const stubShare = (ok: boolean) => {
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator) as Navigator, { share: async () => undefined, canShare: () => ok }));
};
const stubDesk = (desk: boolean) => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: desk, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
};

describe('看图页存图按钮', () => {
  beforeEach(() => {
    if (!document.getElementById('root')) document.body.append(Object.assign(document.createElement('div'), { id: 'root' }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const open = (onSave?: (id: string, phone: boolean) => void) =>
    render(<ImageViewer ids={[A, B]} start={1} back={null} onClose={vi.fn()} {...(onSave ? { onSave } : {})} render={(id) => <i>{id}</i>} />);

  it('手机、能分享文件：底部“存到相册”，点了交回正在看的那张、phone=true', () => {
    stubShare(true);
    const onSave = vi.fn();
    open(onSave);
    const btn = screen.getByTestId('img-view-save');
    expect(btn.textContent).toBe('存到相册');
    expect(btn.parentElement?.className).toMatch(/foot/);
    fireEvent.click(btn);
    expect(onSave).toHaveBeenCalledWith(B, true);
  });

  it('手机、浏览器分享不了文件：写“下载”', () => {
    stubShare(false);
    open(vi.fn());
    expect(screen.getByTestId('img-view-save').textContent).toBe('下载');
  });

  it('电脑：顶行“下载”，phone=false', () => {
    stubDesk(true);
    const onSave = vi.fn();
    open(onSave);
    const btn = screen.getByTestId('img-view-save');
    expect(btn.textContent).toBe('下载');
    expect(btn.parentElement?.className).toMatch(/tools/);
    fireEvent.click(btn);
    expect(onSave).toHaveBeenCalledWith(B, false);
  });

  it('不给 onSave：没有按钮', () => {
    open();
    expect(screen.queryByTestId('img-view-save')).toBeNull();
  });
});
