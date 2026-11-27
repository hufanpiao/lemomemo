// 只有懒加载的页面才用的几个路由函数，从 router.ts 挪出来、不进首屏。返回栈仍由 router.ts 管
import { useCallback, useReducer, useRef } from 'react';
import { isUuid } from '../../shared/core/uuid.ts';
import { canGoBack, commit, goBack, hrefOf, LEVELS, parseHash, upTo, useRoute, writeEntry, type DockPage, type RouteName } from './router.ts';

/**
 * 网页版宽屏时这一页右边有没有常驻 AI 栏、按哪一页说：ChatHost 挂不挂、kit Desk 让不让右边都只看它（不进首屏）。sub 是路径第一段
 */
export function dockOf(name: RouteName, sub = ''): DockPage | undefined {
  const l = LEVELS[name];
  return (l.main === 'bare' && sub) || l.dock === null ? undefined : (l.dock ?? l.bar?.tab);
}


/**
 * 同一页面里换参数（翻月、“今天”、进周视图、非法参数规整）：原地换这条历史，**不起 View Transition**。
 * 日历内部算同一层：不记步数，左滑直接回到进日历之前那一层。要不要动由页面自己决定
 */
export function replaceInPage(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => writeEntry(href), 'none');
}

/** 只改地址、不重画（新建保存后把 #/todo/new 换成这一条的 id）；返回栈不变 */
export function replaceAddress(name: RouteName, ...params: string[]): void {
  writeEntry(hrefOf(name, ...params));
}

let newSeq = 0;

/**
 * 编辑页的路由槽位（id 或 new；不像 id 的当 'missing'）：key 给编辑器当 React key。
 * 新建保存后地址换成新 id，编辑器不重挂（key 不变，草稿不丢）；换别的记录、再点“新建”才换一张。
 * 保存晚到时已换到下一张新建表或离开这一页，就只存不换地址
 */
export function useEditRoute(name: 'todo' | 'event' | 'note' | 'anniv' | 'vault'): { id: string; key: string; onCreated(id: string): void } {
  const raw = useRoute().params[0] ?? 'new';
  const id = raw === 'new' || isUuid(raw) ? raw : 'missing';
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const slot = useRef<{ id: string; key: string; created: string | null } | null>(null);
  if (slot.current === null || (id !== slot.current.id && id !== slot.current.created)) {
    slot.current = { id, key: id === 'new' ? `new:${++newSeq}` : id, created: null };
  }
  const key = slot.current.key;
  const onCreated = useCallback(
    (cid: string) => {
      const cur = slot.current;
      if (!cur || cur.key !== key) return;
      // slot.id 也换成新 id：之后再点“新建”回到 'new' 才会换一张空表
      cur.created = cid;
      cur.id = cid;
      const now = parseHash(window.location.hash);
      if (now.name !== name || now.params[0] !== 'new') return;
      replaceAddress(name, cid);
      // replaceAddress 不通知订阅者：外层重画一次记下新地址，不然再 navigate 到 new 时不会重画
      bump();
    },
    [key, name],
  );
  return { id, key, onCreated };
}

/** 子页的“‹ 返回”：返回栈里有上一页就退一步；直接打开的（推送、书签）没有，原地换成 fallback */
export function backOr(fallback: RouteName): void {
  if (canGoBack()) goBack();
  else void upTo(fallback);
}
