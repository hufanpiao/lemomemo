// 层栈的 React 入口和还焦点（kit/hooks/layers.ts 的另一半；只有懒加载的层用，不进首屏）
// • useLayer(open, spec)：open 为 true 时在栈里；spec 每次渲染换成最新的（onEsc 等不用 useCallback）
// • 出栈分两步：layout 阶段出栈、撤 inert（Esc 马上归下一层），passive 阶段才还焦点
//   （Radix FocusScope 锁焦点的监听在同一次提交的 passive 清理里才摘，早还会被它拉回去；kit Dialog 文件头 L-1）
// • 还焦点：焦点还在层里、或掉到了 body，就按 spec.back 给的顺序（默认只有打开它的元素）还给第一个还在文档里、没禁用、真聚焦上的；
//   焦点已经在层外别处（用户点走了）不抢
// • refocus()：层的 DOM 真卸掉以后调（kit Dialog 的 onCloseAutoFocus）：焦点还掉在 body 就再还一次（关上时打开按钮还禁用着）；
//   还停在出栈时还的那个元素上就重新聚焦一次，让读屏补报（提前还时 Radix 的 aria-hidden 还没撤）
import { useEffect, useLayoutEffect, useRef } from 'react';
import { pushLayer, topLayer, type Layer, type LayerHandle, type LayerSpec } from './layers.ts';

const canFocus = (el: unknown): el is HTMLElement =>
  el instanceof HTMLElement && el.isConnected && el !== document.body && !(el as HTMLElement & { disabled?: boolean }).disabled;

/** 焦点还在层里或掉了（body、已卸掉）：按 back 的顺序还；真聚焦上了才算，返回它 */
function giveBack(layer: Layer): HTMLElement | null {
  const a = document.activeElement;
  const spec = layer.get();
  if (canFocus(a) && !(spec.el?.()?.contains(a) ?? false)) return null;
  for (const c of spec.back ? spec.back(layer.opener) : [layer.opener]) {
    if (!canFocus(c)) continue;
    c.focus();
    if (document.activeElement === c) return c;
  }
  return null;
}

export interface LayerRef extends LayerHandle {
  refocus(): void;
}

export function useLayer(open: boolean, spec: LayerSpec): LayerRef {
  const cur = useRef(spec);
  cur.current = spec;
  const h = useRef<(LayerRef & { back: Layer | null; gone: Layer | null; last: HTMLElement | null }) | null>(null);
  h.current ??= {
    layer: null,
    back: null,
    gone: null,
    last: null,
    refocus() {
      const me = h.current;
      if (!me?.gone) return;
      const a = document.activeElement;
      if (me.last && a === me.last) {
        me.last.blur();
        me.last.focus();
      } else if (!canFocus(a)) giveBack(me.gone);
      me.gone = null;
      me.last = null;
    },
  };
  useLayoutEffect(() => {
    const me = h.current;
    if (!open || !me) return undefined;
    const pop = pushLayer(() => cur.current);
    const layer = topLayer();
    me.layer = layer;
    return () => {
      pop();
      me.gone = layer;
      me.layer = null;
      me.back = layer;
    };
  }, [open]);
  useEffect(
    () => () => {
      const me = h.current;
      if (!me?.back) return;
      me.last = giveBack(me.back);
      me.back = null;
    },
    [open],
  );
  return h.current;
}

