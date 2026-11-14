// 层栈的 React 入口和还焦点（kit/hooks/layers.ts 的另一半；只有懒加载的层用，不进首屏）
// • useLayer(open, spec)：open 为 true 时在栈里；spec 每次渲染换成最新的（onEsc 等不用 useCallback）
// • 打开它的元素（opener）在 open 由 false 变 true 的那次渲染记：早于这次提交里层内元素在 layout 阶段挪焦点（抽屉、附件浮层都会挪）
// • 出栈分两步：layout 阶段出栈、撤 inert（Esc 马上归下一层），passive 阶段才还焦点
//   （Radix FocusScope 锁焦点的监听在同一次提交的 passive 清理里才摘，早还会被它拉回去；kit Dialog 文件头 L-1）
// • 还焦点（giveBack）：焦点还在层里、或掉到了 body，就按 spec.back 给的顺序（默认只有打开它的元素）；打开它的元素已经卸掉时再退到下面各层的 opener，
//   还给第一个还在文档里、没禁用、真聚焦上的；焦点已经在层外别处（用户点走了）不抢
import { useEffect, useLayoutEffect, useRef } from 'react';
import { pushLayer, type Layer, type LayerHandle, type LayerSpec } from './layers.ts';

export const canFocus = (el: unknown): el is HTMLElement =>
  el instanceof HTMLElement && el.isConnected && el !== document.body && !(el as HTMLElement & { disabled?: boolean }).disabled;

/** Radix 的 onCloseAutoFocus 等：不要它的默认动作（焦点由层栈还） */
export const prevent = (e: Event): void => e.preventDefault();

/** 焦点还在层里或掉了（body、已卸掉）：按 back 的顺序还（打开它的元素卸掉了再按下面各层打开它们的元素）；真聚焦上了才算 */
export function giveBack(layer: Layer): void {
  const a = document.activeElement;
  const spec = layer.get();
  if (canFocus(a) && !(spec.el?.()?.contains(a) ?? false)) return;
  const list = spec.back ? spec.back(layer.opener) : [layer.opener];
  // 打开它的元素已经卸掉（下层先关、跟着没了）才退到下面各层的；只是暂时禁用着的不退（kit Dialog 卸载后会再补一次）
  if (list.length > 0 && !(layer.opener?.isConnected ?? false)) for (let l = layer.below; l; l = l.below) list.push(l.opener);
  for (const c of list) {
    if (!canFocus(c)) continue;
    c.focus();
    if (document.activeElement === c) return;
  }
}

export function useLayer(open: boolean, spec: LayerSpec): LayerHandle {
  const cur = useRef(spec);
  cur.current = spec;
  const h = useRef<LayerHandle>({ layer: null }).current;
  const was = useRef(false);
  const opener = useRef<Element | null>(null);
  if (open && !was.current) opener.current = document.activeElement;
  was.current = open;
  useLayoutEffect(() => {
    if (!open) return undefined;
    const { layer, pop } = pushLayer(() => cur.current, opener.current);
    h.layer = layer;
    return pop;
  }, [open, h]);
  useEffect(() => {
    const layer = h.layer;
    if (!open || !layer) return undefined;
    return () => giveBack(layer);
  }, [open, h]);
  return h;
}
