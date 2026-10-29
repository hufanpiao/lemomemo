// 本机库来自更新的版本（TC-B1-49，接手清单 K6-ver-new）：整屏提示只给“去更新 / 刷新”，读屏可用，减少动态效果时不做动画
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpgradeCenter } from '../../core/upgrade.ts';
import type { SwUpdateResult } from '../../platform/sw-register.ts';
import { CacheTooNewFallback } from '../CacheTooNewFallback.tsx';
import { CacheTooNewScreen } from '../CacheTooNewScreen.tsx';
import { ErrorBoundary } from '../ErrorBoundary.tsx';

function center(result: SwUpdateResult = 'failed') {
  let resolve: (r: SwUpdateResult) => void = () => undefined;
  const swUpdate = vi.fn(() => new Promise<SwUpdateResult>((r) => (resolve = r)));
  const u = createUpgradeCenter({ appVersion: '4.0.0', reload: vi.fn(), swUpdate, attempt: { get: () => null, set: () => undefined } });
  u.setCacheTooNew();
  return { u, swUpdate, finish: () => act(async () => resolve(result)) };
}

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.rm;
});

describe('CacheTooNewScreen', () => {
  it('alertdialog，有标题和说明；只有“去更新”“刷新”两个按钮，焦点落在“去更新”', () => {
    const { u } = center();
    render(<CacheTooNewScreen upgrade={u} onRefresh={vi.fn()} />);
    const dlg = screen.getByRole('alertdialog', { name: '本机数据是新版本写的，请更新 App' });
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.getAttribute('aria-describedby')).toBe('cache-too-new-body');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['去更新', '刷新']);
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('点“去更新”：调升级中心，进度和失败用 role=status 播报；更新中再点不重复调', async () => {
    const { u, swUpdate, finish } = center('failed');
    render(<CacheTooNewScreen upgrade={u} onRefresh={vi.fn()} />);
    const go = screen.getByRole('button', { name: '去更新' });
    fireEvent.click(go);
    expect(swUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('正在更新…');
    expect(go.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(go);
    expect(swUpdate).toHaveBeenCalledTimes(1);
    await finish();
    expect(screen.getByRole('status').textContent).toBe('更新失败 · 联网后再试');
  });

  it('没有新版本：提示已是最新', async () => {
    const { u, finish } = center('no_update');
    render(<CacheTooNewScreen upgrade={u} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '去更新' }));
    await finish();
    expect(screen.getByRole('status').textContent).toBe('已是最新版本，请稍后再试');
  });

  it('点“刷新”调 onRefresh', () => {
    const { u } = center();
    const onRefresh = vi.fn();
    render(<CacheTooNewScreen upgrade={u} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('动效：平时用 Appear 进场；减少动态效果时不包 Appear、直接出现', () => {
    const { u } = center();
    const a = render(<CacheTooNewScreen upgrade={u} onRefresh={vi.fn()} />);
    expect(a.container.querySelector('[data-appear="page"]')).not.toBeNull();
    a.unmount();
    document.documentElement.dataset.rm = '1';
    const b = render(<CacheTooNewScreen upgrade={u} onRefresh={vi.fn()} />);
    expect(b.container.querySelector('[data-appear]')).toBeNull();
    expect(screen.getByTestId('cache-too-new')).toBeTruthy();
  });

  it('静态回退（懒加载失败、整屏组件出错时用，复审 S1、S2）：alertdialog、只有“刷新”、焦点在“刷新”', () => {
    const onRefresh = vi.fn();
    render(<CacheTooNewFallback onRefresh={onRefresh} />);
    expect(screen.getByRole('alertdialog', { name: '本机数据是新版本写的，请更新 App' })).toBeTruthy();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['刷新']);
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('整屏组件渲染出错：ErrorBoundary 换成静态回退，不白屏', () => {
    const broken = { getState: () => { throw new Error('boom'); }, subscribe: () => () => undefined } as unknown as ReturnType<typeof createUpgradeCenter>;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary fallback={<CacheTooNewFallback onRefresh={vi.fn()} />}>
        <CacheTooNewScreen upgrade={broken} onRefresh={vi.fn()} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('cache-too-new-fallback')).toBeTruthy();
    err.mockRestore();
  });
});
