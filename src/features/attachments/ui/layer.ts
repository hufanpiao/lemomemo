// 附件区两个整窗浮层（PreviewLayer 文档预览、ImageViewer 看图）共用的外壳行为：
// 打开时焦点放到关闭按钮、锁住后面页面的滚动、Esc 关（捕获阶段，先于抽屉的 Esc）、关了把焦点还给打开它的元素
// back：打开它的元素。不传时用打开那一刻的 document.activeElement（WebKit 点按钮不给按钮焦点，看图页由调用方显式传入）
// Esc 和焦点在同一个 useLayoutEffect 里挂：焦点一到关闭按钮就能按 Esc 关（e2e 运行日志见过 Esc 早于普通 useEffect 挂上的情况）
import { useLayoutEffect, useRef } from 'react';
import { useScrollLock } from '../../../kit/components/Dialog.tsx';

export function useLayer(onClose: () => void, back?: HTMLElement | null) {
  const closeBtn = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useScrollLock(true);

  useLayoutEffect(() => {
    const from = back ?? document.activeElement;
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener('keydown', key, true);
    closeBtn.current?.focus();
    return () => {
      window.removeEventListener('keydown', key, true);
      if (from instanceof HTMLElement && from.isConnected) from.focus();
    };
    // 只在打开、关上时各做一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return closeBtn;
}
