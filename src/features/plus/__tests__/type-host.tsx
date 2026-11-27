// 打字条单测的外壳（全 app 评审 四.高.3 起提示条外挂）：照 App / app/plus-slot.tsx / TypeBarPreload 的挂法——
// “已记下 · 撤销”提示条（ui/TypeNotice.tsx）一直挂着，打字条开着才挂、onClose 就卸掉；reopen() = 再点一次“＋”（重新挂上打字条）
import { act, render, type RenderResult } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import TypeBar, { type TypeBarProps } from '../ui/TypeBar.tsx';
import { TypeNotice } from '../ui/TypeNotice.tsx';

export type HostProps = Omit<TypeBarProps, 'onClose' | 'onExpand'> & Partial<Pick<TypeBarProps, 'onClose' | 'onExpand'>>;

let reopenNow: (() => void) | null = null;

function Host(p: HostProps) {
  const [open, setOpen] = useState(true);
  reopenNow = () => setOpen(true);
  const close = (): void => {
    p.onClose?.();
    setOpen(false);
  };
  return (
    <>
      <TypeNotice />
      {open ? <TypeBar {...p} onExpand={p.onExpand ?? (() => undefined)} onClose={close} /> : null}
    </>
  );
}

/** 外壳的元素（套 StrictMode 等用） */
export const typeHost = (p: HostProps): ReactElement => <Host {...p} />;

/** 挂上外壳；reopen：再点“＋”（同一次渲染里挂上打字条、聚焦） */
export function renderTypeHost(p: HostProps, wrap: (el: ReactElement) => ReactElement = (el) => el): RenderResult & { reopen(): void } {
  const r = render(wrap(typeHost(p)));
  return { ...r, reopen: () => act(() => reopenNow?.()) };
}
