// 列表页的打勾、删除和撤销、只读拦截、出错条只在这里做（架构 10.1）：今天页、待办页、随手记页共用；今天页、待办页的提示条画在 kit 的 ListToasts.tsx
// • 只读行：按 table 查 core 的只读 id；打勾、删除统一拦下，出“这条要新版本才能修改 · 更新”（useReadonlyGuard）；写入回 readonly 也拦
// • 打勾（只有传了 toggle 的页）：先留住按下之前的列表 --dur-ui（页面的 useHoldView），留着的期间圆圈按“刚点成什么”画（picked）
// • 写入回 failed 出页面的出错条；silent（switching）不提示。撤销条、出错条、只读提示条、页面自己加的提示（X）同一个位置，同时只出一条
// 这个文件在首屏（今天页）：只放判断和状态，不包 useCallback（拿去用的地方不靠函数身份）
import { useState } from 'react';
import type { ActionResult } from '../../core/action-result.ts';
import { useReadonlyGuard, useReadonlyIds } from './useReadonly.ts';

export type ListToast = { kind: 'undo'; id: string } | { kind: 'error' };

/** 页面 useHoldView 的那三样（motion 的 hook 由页面调，kit/hooks 不碰 motion）；不打勾的页不传 */
interface Hold {
  holding: boolean;
  hold(): void;
  release(): void;
}

interface Acts {
  remove(id: string, deleted: boolean): Promise<ActionResult>;
  toggle?(id: string, on: boolean): Promise<ActionResult>;
}

/** X：页面自己另加的提示条（随手记的插图提示），和撤销条、出错条共用一个位置 */
export function useListActions<X = never>(table: string, act: Acts, hv?: Hold) {
  const g = useReadonlyGuard<ListToast | X>();
  const ro = useReadonlyIds(table);
  const [picked, setPicked] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const isRo = (id: string) => ro.has(id);
  const holding = hv?.holding ?? false;
  const report = (r: ActionResult) => {
    if (r === 'readonly') g.block();
    else if (r === 'failed') g.show({ kind: 'error' });
  };
  return {
    g,
    isRo,
    report,
    tick(id: string, on: boolean) {
      if (isRo(id)) return g.block();
      if (!act.toggle) return;
      setPicked((m) => new Map(holding ? m : []).set(id, on));
      hv?.hold();
      void act.toggle(id, on).then(report);
    },
    shown: (id: string, done: boolean) => (holding ? (picked.get(id) ?? done) : done),
    async del(id: string) {
      if (isRo(id)) return g.block();
      hv?.release();
      const r = await act.remove(id, true);
      if (r === 'ok') g.show({ kind: 'undo', id });
      else report(r);
    },
    undo: (id: string) => void act.remove(id, false).then(report),
  };
}
