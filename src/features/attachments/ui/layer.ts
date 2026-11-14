// 附件区两个整窗浮层（PreviewLayer 文档预览、ImageViewer 看图）共用的外壳：样式在 layer.module.css（scrim / box / full），行为在 useLayer——
// 打开时焦点放到关闭按钮、锁住后面页面的滚动、后面的 #root 设 inert（Tab 出不去、读屏只读浮层）、
// Esc 关（捕获阶段 stopPropagation，同时 preventDefault，两种“谁先处理 Esc”的约定都挡住抽屉；输入法组字时不算）、
// 关了把焦点还给打开它的元素
// back：打开它的元素。不传时用打开那一刻的 document.activeElement（WebKit 点按钮不给按钮焦点，看图页由调用方显式传入）
// Esc 和焦点在同一个 useLayoutEffect 里挂：焦点一到关闭按钮就能按 Esc 关（e2e 运行日志见过 Esc 早于普通 useEffect 挂上的情况）
import { useLayoutEffect, useRef } from 'react';
import { useScrollLock } from '../../../kit/components/Dialog.tsx';

export function useLayer(onClose: () => void, back?: HTMLElement | null) {
  const closeBtn = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  useScrollLock(true);

  useLayoutEffect(() => {
    const from = back ?? document.activeElement;
    const app = document.getElementById('root');
    const wasInert = app?.hasAttribute('inert') ?? true;
    if (app && !wasInert) app.setAttribute('inert', '');
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.stopPropagation();
      e.preventDefault();
      close.current();
    };
    window.addEventListener('keydown', key, true);
    closeBtn.current?.focus();
    return () => {
      window.removeEventListener('keydown', key, true);
      if (app && !wasInert) app.removeAttribute('inert');
      if (from instanceof HTMLElement && from.isConnected) from.focus();
    };
    // 只在打开、关上时各做一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return closeBtn;
}
