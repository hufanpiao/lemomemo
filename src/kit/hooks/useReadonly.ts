// 只读行：带不认识的值的行只读显示
// • useReadonlyIds(table)：这张表里只读的行 id（core/store 的 readonlyIds，数据层随 view 一起推进来）
// • useReadonlyGuard()：列表页统一拦只读行用——isRo(kind, id) 判断；any：日程、待办里有没有只读行（有才挂重复事项横幅，
//   条数在横幅里数：./useRepeatPending.ts，按需下载）；block() 出“这条要新版本才能修改 · 更新”提示条
//   （toastAt 是这次的时刻，连点几次都重新计时；提示条本身是 kit 的 ReadonlyToast），update() 走 platform 的 requestAppUpdate；
//   页面自己的撤销条、出错条也放在这里（toast、show、dismiss），和只读提示条同一个位置、同时只出一条；
//   出错条这类 TOAST_MS 后自己收起（useExpire），撤销条 show(x, null)、由 UndoToast 自己计时
// • 以后加左滑、多选：同样先 isRo 再 block
// 这个文件在首屏（今天页），只放判断和状态；画的东西都按需下载（首屏预算 150 KB）
// kit/hooks 是除功能 hooks 外唯一能同时碰 React 和数据层的地方
import { useEffect, useState, useSyncExternalStore } from 'react';
import { TOAST_MS } from '../../../shared/logic/toast.ts';
import { readonlyIds } from '../../core/store.ts';
import { requestAppUpdate } from '../../platform/native-bridge.ts';

/**
 * 提示条到点自己收起的唯一一份（出错条统一 TOAST_MS 收起）：
 * key 不为 null 时开始计 ms，key 换了重新计；key 变回 null 或 ms 为 null 不计。useReadonlyGuard 的 show、最近删除页的提示都用它
 */
export function useExpire(key: unknown, onExpire: () => void, ms: number | null = TOAST_MS): void {
  useEffect(() => {
    if (key === null || ms === null) return undefined;
    const id = setTimeout(onExpire, ms);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onExpire 每次重画都是新函数，放进去计时会每画一次就重来；它只按 key 那一次收
  }, [key, ms]);
}

/** 只读提示里的“更新”：拉新版本（kit 的组件不能直接碰 platform，经这里） */
export const appUpdate = (): void => void requestAppUpdate();

export function useReadonlyIds(table: string): ReadonlySet<string> {
  const r = readonlyIds(table);
  return useSyncExternalStore(r.subscribe, r.getSnapshot, r.getSnapshot);
}

export interface ReadonlyGuard<T = never> {
  isRo(kind: 'event' | 'todo', id: string): boolean;
  /** 日程、待办里有没有只读行 */
  any: boolean;
  /** 只读提示条出来的时刻；没出为 null */
  toastAt: number | null;
  /** 拦下：收起页面自己的提示条（撤销条、出错条），出“这条要新版本才能修改 · 更新”；连点几次都重新计时 */
  block(): void;
  /** 收起 at 那一次的只读提示条（只收自己那一次，免得收掉后来又出的）；不给 at 就收起 */
  close(at?: number): void;
  update(): void;
  /** 页面自己的提示条（和只读提示条同一个位置，同时只出一条） */
  toast: T | null;
  /**
   * 出页面自己的提示条：只读提示条先收起。ms 后自己收起（默认 TOAST_MS，5 秒）；
   * 撤销条传 null：它画成 kit 的 UndoToast，自己计时（悬停重新计），这里不收
   */
  show(x: T, ms?: number | null): void;
  /** 收起页面自己的那一条（只收 x 那一次） */
  dismiss(x: T): void;
}

export function useReadonlyGuard<T = never>(): ReadonlyGuard<T> {
  const roE = useReadonlyIds('events');
  const roT = useReadonlyIds('todos');
  const [toastAt, setToastAt] = useState<number | null>(null);
  // 每 show 一次是新的一份（同样的 x 连出两次也重新计时）
  const [cur, setCur] = useState<{ x: T; ms: number | null } | null>(null);
  useExpire(cur, () => setCur((c) => (c === cur ? null : c)), cur?.ms ?? null);
  const toast = cur === null ? null : cur.x;
  // 不包 useCallback：拿去用的地方都不靠函数身份（首屏预算）
  return {
    isRo: (kind, id) => (kind === 'event' ? roE : roT).has(id),
    any: roE.size + roT.size > 0,
    toastAt,
    block() {
      setCur(null);
      setToastAt(Date.now());
    },
    close: (at) => setToastAt((x) => (at === undefined || x === at ? null : x)),
    update: appUpdate,
    toast,
    show(x, ms = TOAST_MS) {
      setToastAt(null);
      setCur({ x, ms });
    },
    dismiss: (x) => setCur((c) => (c?.x === x ? null : c)),
  };
}
