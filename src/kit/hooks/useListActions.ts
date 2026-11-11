// 列表页的打勾、删除和撤销、只读拦截、出错条只在这里做（架构 10.1）：今天页、待办页共用；提示条画在 kit 的 ListToasts.tsx
// • 打勾：先留住按下之前的列表 --dur-ui（页面的 useHoldView，圆圈在原地填满），留着的期间圆圈按“刚点成什么”画（picked），几条连着点就一起挪
// • 只读行（core 的只读 id）：打勾、删除统一拦下，出“这条要新版本才能修改 · 更新”（useReadonlyGuard）；写入回 readonly 也拦
// • 写入回 failed 出页面的出错条；silent（switching）不提示。撤销条、出错条、只读提示条同一个位置，同时只出一条
// 这个文件在首屏（今天页）：只放判断和状态，不包 useCallback（拿去用的地方不靠函数身份）
import { useState } from 'react';
import type { ActionResult } from '../../core/action-result.ts';
import { useReadonlyGuard } from './useReadonly.ts';

export type ListToast = { kind: 'undo'; id: string } | { kind: 'error' };

/** 页面 useHoldView 的那三样（motion 的 hook 由页面调，kit/hooks 不碰 motion） */
interface Hold {
  holding: boolean;
  hold(): void;
  release(): void;
}

export function useListActions(hv: Hold, act: { toggle(id: string, on: boolean): Promise<ActionResult>; remove(id: string, deleted: boolean): Promise<ActionResult> }) {
  const g = useReadonlyGuard<ListToast>();
  const [picked, setPicked] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const isRo = (id: string) => g.isRo('todo', id);
  const report = (r: ActionResult) => {
    if (r === 'readonly') g.block();
    else if (r === 'failed') g.show({ kind: 'error' });
  };
  return {
    g,
    isRo,
    tick(id: string, on: boolean) {
      if (isRo(id)) return g.block();
      setPicked((m) => new Map(hv.holding ? m : []).set(id, on));
      hv.hold();
      void act.toggle(id, on).then(report);
    },
    shown: (id: string, done: boolean) => (hv.holding ? (picked.get(id) ?? done) : done),
    async del(id: string) {
      if (isRo(id)) return g.block();
      hv.release();
      const r = await act.remove(id, true);
      if (r === 'ok') g.show({ kind: 'undo', id });
      else report(r);
    },
    undo: (id: string) => void act.remove(id, false).then(report),
  };
}

export type ListActions = ReturnType<typeof useListActions>;
