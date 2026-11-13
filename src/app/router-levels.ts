// 只有懒加载的页面才用的几个路由函数，从 router.ts 挪出来、不进首屏（R-372 首屏额度）：
// 日历的 replaceInPage（日历内部一律原地换，R-372 ②）、编辑页的路由槽位 useEditRoute（三个编辑页的唯一出口，架构 10.1）、子页的返回 backOr。
// 历史的 state、深度、编号仍由 router.ts 管
import { useCallback, useReducer, useRef } from 'react';
import { canGoBack, commit, goBack, hrefOf, noteEntry, parseHash, replaceRoute, stateFor, useRoute, type RouteName } from './router.ts';


/**
 * 同一页面里换参数（月历翻月翻周、“今天”、年月选择、点某天进周视图、非法参数规整）：原地换这条历史，**不起 View Transition**，直接画新状态。
 * 日历内部算同一层（R-372 ②，负责人选“算同一层（推荐）”）：不记步数，左滑直接回到进日历之前那一层。
 * 页面自己决定要不要动（月历按钮翻页横滑、滑动跟手、键盘和“今天”直接切换，架构 5.12 第 3 点“动效”；B2 FA-3 代码复审 N1）
 */
export function replaceInPage(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    window.history.replaceState(stateFor(0), '', href);
    noteEntry();
  }, 'none');
}

/**
 * 同一页面里新压一条、不起 View Transition（纪念日列表 → 盖在上面的编辑层，B5）：编辑层自己从底部滑上来，再叠整页淡入淡出是两层动画；
 * 而且编辑层挂上时锁滚动（useScrollLock），过渡途中文档从能滚变成不能滚，WebKit 会整页崩（CI-webkit-crash 同一类，B5 e2e 实测关编辑层时崩）。
 * 关的时候退一步（backOr），App 按 samePageAs 认出同一页、也不起过渡。深度 + 1，canGoBack 为真
 */
export function pushInPage(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    window.history.pushState(stateFor(1), '', href);
    noteEntry();
  }, 'none');
}

/** 只改地址、不重画（新建保存后把 #/todo/new 换成这一条的 id，代码审查 S7）；深度不变 */
export function replaceAddress(name: RouteName, ...params: string[]): void {
  window.history.replaceState(stateFor(0), '', hrefOf(name, ...params));
  noteEntry();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let newSeq = 0;

/**
 * 编辑页的路由槽位（#/todo、#/event、#/note 后面跟 id 或 new；不像 id 的当 'missing'）：key 给编辑器当 React key。
 * 新建保存后地址换成这一条的 id，编辑器不重挂（key 不变，焦点里的草稿不丢，代码审查 S7）；换别的记录、再点“新建”才换一张。
 * 保存可能晚到：用户已经换到下一张新建表（key 变了）或已经离开这一页，就只存不换地址
 */
export function useEditRoute(name: 'todo' | 'event' | 'note' | 'anniv'): { id: string; key: string; onCreated(id: string): void } {
  const raw = useRoute().params[0] ?? 'new';
  const id = raw === 'new' || UUID.test(raw) ? raw : 'missing';
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
      // slot.id 也换成新 id（key 不变）：之后再点“新建”路由回到 'new'，和 slot.id 不同，才会换一张空表（代码审查 N2）
      cur.created = cid;
      cur.id = cid;
      const now = parseHash(window.location.hash);
      if (now.name !== name || now.params[0] !== 'new') return;
      replaceAddress(name, cid);
      // replaceAddress 不通知路由的订阅者：外层重画一次，记下新地址（不然再 navigate 到 new 时地址看起来没变，不会重画）
      bump();
    },
    [key, name],
  );
  return { id, key, onCreated };
}

/** 子页的“‹ 返回”：直接打开的（推送、书签、刷新）没有上一页，原地换成 fallback */
export function backOr(fallback: RouteName): void {
  if (canGoBack()) goBack();
  else void replaceRoute(fallback);
}
