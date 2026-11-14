// 附件区两个整窗浮层（PreviewLayer 文档预览、ImageViewer 看图）共用的外壳：样式在 layer.module.css（scrim / box / full），行为在 useShellLayer——
// 挂着就是层栈（kit/hooks/layers.ts）里的一层（模态）：Esc 只在它是栈顶时关、锁住后面页面的滚动、后面的 #root 等 inert（Tab 出不去、读屏只读浮层）、
// 关了把焦点还给打开它的元素；这里只多做一件：打开时焦点放到关闭按钮
// back：打开它的元素。不传时用打开那一刻的 document.activeElement（WebKit 点按钮不给按钮焦点，看图页由调用方显式传入）
// 入栈和挪焦点都在 layout 阶段：焦点一到关闭按钮就能按 Esc 关（e2e 运行日志见过 Esc 早于普通 useEffect 挂上的情况）
import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { LayerHandle } from '../../../kit/hooks/layers.ts';
import { useLayer } from '../../../kit/hooks/useLayer.ts';

export function useShellLayer(name: string, onClose: () => void, back?: HTMLElement | null): { closeBtn: RefObject<HTMLButtonElement | null>; layer: LayerHandle } {
  const closeBtn = useRef<HTMLButtonElement>(null);
  const layer = useLayer(true, {
    name,
    modal: true,
    // 浮层 createPortal 到 body 下，层的根是挂在 body 下的那一块（遮罩）
    el: () => closeBtn.current?.closest('body > *') ?? null,
    onEsc: onClose,
    back: (opener) => [back ?? opener],
  });
  useLayoutEffect(() => {
    closeBtn.current?.focus();
  }, []);
  return { closeBtn, layer };
}
