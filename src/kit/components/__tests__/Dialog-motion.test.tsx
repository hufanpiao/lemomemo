// 弹层进出场（架构 17.1、17.4 B2“Dialog.tsx 的遮罩和内容进出真的有动画，退出动画播完才卸载”；UI-4 L-2、接手清单 M4）
// jsdom 不画画面，这里证明结构和参数：遮罩、内容各包一层 <Appear>；关上后先留着播退出动画、播完才卸载；
// 减少动态效果时内容不滑、只淡入淡出；时长（遮罩、内容都减半）在 src/motion/__tests__/reduced-motion.test.tsx 里测（0.31 第 6 条：这里不准引 motion 内部文件）。真浏览器里的手感由 ②b 录屏确认
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog } from '../Dialog.tsx';
import { loadMotionFeatures } from '../../../motion/index.ts';

// 动效功能包异步加载（B2 FA-6 ②）：这里测的是功能包到了以后的手感（真实页面里首屏画完马上就到，打开弹层时早已到了），先等它到
await loadMotionFeatures();

const html = document.documentElement;

let setOpen: (o: boolean) => void = () => undefined;
function Harness({ initial = true }: { initial?: boolean }) {
  const [open, set] = useState(initial);
  setOpen = set;
  return <Dialog open={open} onOpenChange={set} title="标题" description="说明" />;
}

const sheet = () => document.querySelector<HTMLElement>('[data-appear="sheet"]');
const scrim = () => document.querySelector<HTMLElement>('[data-appear="scrim"]');

afterEach(() => {
  cleanup();
  delete html.dataset['rm'];
});

describe('Dialog 进出场（UI-4 L-2）', () => {
  it('没打开过：遮罩、内容都不在页面上', () => {
    render(<Harness initial={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sheet()).toBeNull();
    expect(scrim()).toBeNull();
  });

  it('遮罩对读屏隐藏（aria-hidden="true"，代码审查 S8），内容不隐藏', () => {
    render(<Harness />);
    expect(scrim()?.getAttribute('aria-hidden')).toBe('true');
    expect(sheet()?.hasAttribute('aria-hidden')).toBe(false);
  });

  it('打开：遮罩（scrim）和内容（sheet）各包一层 Appear，内容从底部滑入（起点 translateY(100%)）', () => {
    render(<Harness />);
    const dlg = screen.getByRole('dialog');
    expect(sheet()?.contains(dlg)).toBe(true);
    expect(scrim()).not.toBeNull();
    expect(scrim()?.contains(dlg)).toBe(false);
    expect(sheet()?.style.transform).toContain('translateY(100%)');
    expect(scrim()?.style.opacity).toBe('0');
    expect(sheet()?.className).toContain('dock');
    expect(sheet()?.dataset['state']).toBeUndefined();
  });

  it('关闭：先留着播退出动画（期间不接点按），播完才卸载', async () => {
    render(<Harness />);
    act(() => setOpen(false));
    // 刚关上：还在，两层都是 data-state="leaving"（Dialog.module.css 里 pointer-events: none）
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeNull();
    expect(sheet()?.dataset['state']).toBe('leaving');
    expect(scrim()?.dataset['state']).toBe('leaving');
    await waitFor(() => expect(sheet()).toBeNull());
    expect(scrim()).toBeNull();
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  });

  it('关闭途中又打开：不卸载，回到打开状态', async () => {
    render(<Harness />);
    act(() => setOpen(false));
    act(() => setOpen(true));
    expect(sheet()?.dataset['state']).toBeUndefined();
    // 等过一整段弹层时长（--dur-sheet 远小于 1 秒）：重新打开后不会被先前的退出动画卸载
    await new Promise((r) => setTimeout(r, 1000));
    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  it('减少动态效果（data-rm="1"）：内容不滑，只从透明度 0 淡入', () => {
    html.dataset['rm'] = '1';
    render(<Harness />);
    const t = sheet()?.style.transform ?? '';
    expect(t === '' || t === 'none').toBe(true);
    expect(sheet()?.style.opacity).toBe('0');
  });
});
