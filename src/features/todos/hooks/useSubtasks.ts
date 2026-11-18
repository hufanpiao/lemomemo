// 待办子任务的 hook（R-350）：按主待办分组的子任务（订阅 todo_items 集合）、列表页的收起状态
// • 收起状态（方案第 3 节、5.4，Q4）：每台设备各记各的、不同步，存本机库 meta 仓的 ui.todo_collapsed（待办 id → true 收起 / false 展开），
//   只存用户点过的；没点过的按默认：未完成展开、已完成收起。最多 COLLAPSED_MAX 个，写时剔掉已不在的待办、超了丢最早的。
//   读不到（没启动、库已关）就全按默认；不写 localStorage（4.1：localStorage 只留 install_id）
// • “已完成”组整组展开没有（负责人 11-15“完成的待办怎么隐藏”）另记在本机 meta 的 ui.todo_done_open（true / false），没点过默认收起；
//   不放进上面的收起表（审查 11-15 第 6 条：那张表只认待办 id，写时按 id 剔掉不在的）。两样放在同一个模块状态里、一次读回来
// • 勾子任务的写入（useTodoSubtasks）：待办页、今天页和日历日清单的就地展开（ui/InlineSubtasks.tsx，R-442、R-443）共用这一份；
//   主待办跟着改的规则在 data/todo-items.ts 的 autoTodo（planAuto 让页面先知道会不会挪卡片）、撤销“自动完成”是 undoAutoDone（Q1：刚勾的那项和主待办一起撤回）
// • 收起状态放在模块里（离开待办页再回来不闪一下默认值）；第一次用时从 meta 读一次，读回来之前点过的以点过的为准
import { useEffect, useState, useSyncExternalStore } from 'react';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import { getBoot } from '../../../core/boot.ts';
import { collection } from '../../../core/store.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { clock } from '../../../platform/clock.ts';
import { subProgress } from '../../../../shared/logic/todo-row.ts';
import { autoTodo, groupSubtasks, ITEMS_TABLE, moveSubtask, tickSubtask, undoAutoDone, type Subtask } from '../data/todo-items.ts';
import type { Row } from '../data/todo-list.ts';

export type { Subtask } from '../data/todo-items.ts';

/** 按主待办分组的子任务（每组按排序键排；删了的不在里面） */
export function useSubtaskGroups(): ReadonlyMap<string, readonly Subtask[]> {
  return groupsOf(useCollection<Row>(ITEMS_TABLE));
}

/** 每条待办的子任务做了几项、共几项（方框进度、副行“大半 3/4”；计数在 shared/logic/todo-row.ts 的 subProgress，今天页同一个） */
export function useSubProgress(): ReadonlyMap<string, { done: number; total: number }> {
  const rows = useCollection<Row>(ITEMS_TABLE);
  let m = counted.get(rows);
  if (!m) counted.set(rows, (m = subProgress(rows)));
  return m;
}
const counted = new WeakMap<readonly Row[], ReadonlyMap<string, { done: number; total: number }>>();

/** 同一份集合快照只分一次组（今天页、日历每条待办各挂一个 InlineSubtasks，不各算一遍） */
const grouped = new WeakMap<readonly Row[], ReadonlyMap<string, readonly Subtask[]>>();
function groupsOf(rows: readonly Row[]): ReadonlyMap<string, readonly Subtask[]> {
  let g = grouped.get(rows);
  if (!g) grouped.set(rows, (g = groupSubtasks(rows)));
  return g;
}

/** 勾一项子任务写完以后交给页面的（ui/InlineSubtasks.tsx 的 onResult） */
export interface SubTickResult {
  /** 写之前算的：勾这一项会不会顺带改主待办（true 完成、false 改回未完成、null 不动） */
  plan: boolean | null;
  res: ActionResult;
  /** 主待办实际跟着改了没有：true 自动完成、false 改回未完成、null 没动 */
  auto: boolean | null;
  /** 撤销“自动完成”（Q1：刚勾的那项和主待办一起撤回） */
  undo(): Promise<ActionResult>;
  /** 自动完成那条撤销条的文案 */
  message: string;
}

/**
 * 一条待办的子任务和勾选写入（见文件头）：items 没有子任务时为 undefined。
 * 主待办完成没有由调用方给（行上本来就有，主持人 11-17 复审第 6 条：原来每一行各订阅整张 todos 表再查找）；
 * 写的时候才从集合快照里取主待办那一行（不订阅，写入函数本来也按快照里最新的那份判断）
 */
export function useTodoSubtasks(todoId: string, todoDone: boolean) {
  const items = useSubtaskGroups().get(todoId);
  const rowNow = (): Row | undefined => collection<Row>('todos').getSnapshot().find((x) => x.id === todoId);
  return {
    items,
    /** 勾这一项会不会顺带改主待办（true 完成、false 改回未完成、null 不动）：会改的话页面先留住列表再挪 */
    planAuto: (itemId: string, on: boolean): boolean | null => (items ? autoTodo(todoDone, items, itemId, on) : null),
    async tick(itemId: string, on: boolean): Promise<{ res: ActionResult; auto: boolean | null }> {
      const r = rowNow();
      if (!r || !items) return { res: 'failed', auto: null };
      const x = await tickSubtask(r, items, itemId, on, clock.now(), currentTz());
      return { res: actionResult(x.out), auto: x.auto };
    },
    /** 列表卡片拖动排序放下（R-476）：按新顺序写 sort，编辑页同一个 moveSubtask */
    move: async (from: number, to: number): Promise<ActionResult> => (items ? actionResult(await moveSubtask(items, from, to, clock.now())) : 'failed'),
    undoAuto: async (itemId: string): Promise<ActionResult> => {
      const r = rowNow();
      return r ? actionResult(await undoAutoDone(r, itemId, clock.now(), currentTz())) : 'failed';
    },
  };
}

/**
 * 勾下去当下就按“刚点的值”画（不等保存回来；同主待办的 shown）：pick(id, v) 记下，shown(item) 先看记下的；
 * 集合跟上了（或这一项没了）就丢掉。列表页卡片、编辑页共用
 */
export function usePicked(items: readonly Subtask[]): { shown(i: Subtask): boolean; pick(id: string, v: boolean): void } {
  const [picked, setPicked] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  useEffect(() => {
    setPicked((m) => {
      const keep = [...m].filter(([id, v]) => items.some((i) => i.id === id && i.done !== v));
      return keep.length === m.size ? m : new Map(keep);
    });
  }, [items]);
  return { shown: (i) => picked.get(i.id) ?? i.done, pick: (id, v) => setPicked((m) => new Map(m).set(id, v)) };
}

const META_KEY = 'ui.todo_collapsed';
/** 待办页“已完成”组展开没有（负责人 11-15“完成的待办怎么隐藏”）：单独一个键，不和子任务收起表混在一起（审查 11-15 第 6 条） */
const DONE_OPEN_KEY = 'ui.todo_done_open';
export const COLLAPSED_MAX = 500;

/** 本机记着的两样：子任务收起表、“已完成”组展开没有（null 是没点过，按默认收起）。整份换新对象，useSyncExternalStore 认得出变了 */
interface FoldState {
  collapsed: Readonly<Record<string, boolean>>;
  doneOpen: boolean | null;
  /** 本机那份读过了没有（读到、读不到、还没启动好按默认画，都算读过）：待办页等它再画列表（负责人 11-18 录屏“冷启动第一次进待办的时候下面的一部分待办飞上来”：
   *  原来先按默认“未完成展开”画、几毫秒后读到“已收起”再缩回，下面的行跟着播挪位动画） */
  ready: boolean;
}
let state: FoldState = { collapsed: {}, doneOpen: null, ready: false };
/** 标成读过了（按默认画）：只在第一次变的时候通知 */
const markReady = (): void => {
  if (state.ready) return;
  state = { ...state, ready: true };
  emit();
};
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => state;

function openCache() {
  const c = getBoot()?.cache;
  return c && !c.isClosed() ? c : null;
}

function load(): Promise<void> {
  loading ??= (async () => {
    try {
      const c = openCache();
      if (!c) {
        loading = null;   // 还没启动好：先按默认画，下次进待办页再读
        markReady();
        return;
      }
      const [v, open] = await Promise.all([c.getMeta(META_KEY), c.getMeta(DONE_OPEN_KEY)]);
      // 读回来之前点过的以点过的为准
      state = {
        collapsed: v && typeof v === 'object' ? { ...v, ...state.collapsed } : state.collapsed,
        doneOpen: state.doneOpen ?? (typeof open === 'boolean' ? open : null),
        ready: true,
      };
      emit();
    } catch {
      loading = null;   // 读不到先按默认（meta 可重建），下次再试
      markReady();
    }
  })();
  return loading;
}

/** 记下一条的收起状态：剔掉已不在的待办（live），超过上限丢最早记的；写 meta 失败不提示（下次打开回到默认） */
export function setCollapsed(id: string, value: boolean, live: ReadonlySet<string>): void {
  const keep = Object.entries(state.collapsed).filter(([k]) => k !== id && live.has(k));
  keep.push([id, value]);
  state = { ...state, collapsed: Object.fromEntries(keep.slice(-COLLAPSED_MAX)) };
  emit();
  void openCache()?.setMeta(META_KEY, state.collapsed).catch(() => undefined);
}

/** 记下“已完成”组展开没有；写 meta 失败不提示（下次打开回到默认收起） */
export function setDoneOpen(open: boolean): void {
  state = { ...state, doneOpen: open };
  emit();
  void openCache()?.setMeta(DONE_OPEN_KEY, open).catch(() => undefined);
}

/** 测试用：清掉模块里的状态 */
export function resetCollapsedForTest(): void {
  state = { collapsed: {}, doneOpen: null, ready: false };
  loading = null;
}

function useFoldState(): FoldState {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    void load();
  }, []);
  return s;
}

/** 列表页：这条待办的子任务收起没有（点过的按点过的；没点过的已完成收起、未完成展开） */
export function useCollapsed(): (id: string, done: boolean) => boolean {
  const s = useFoldState();
  return (id, done) => s.collapsed[id] ?? done;
}

/** 提前读本机那份（待办页代码一下载、执行就调：冷启动后台预加载时已经读好，R-478） */
export function preloadFold(): void {
  void load();
}

/** 本机那份读过了没有：待办页读好以前不画列表，免得先按默认摊开、再缩回 */
export function useFoldReady(): boolean {
  return useFoldState().ready;
}

/** 待办页“已完成”组展开没有（没点过默认收起） */
export function useDoneOpen(): boolean {
  return useFoldState().doneOpen ?? false;
}
