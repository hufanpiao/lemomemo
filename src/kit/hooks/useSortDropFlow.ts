// 长按拖动放下以后页面那一段（R-429 评审第 10 条合成这一份；R-461 起整页一串：按天分组时也按这一串算，拖过组界就是换到那一天的组里）：
// 只读行拦下 → 按邻居 id 在此刻的列表里找下标（kit SortDrag 的 dropAt；拖动中列表变了、邻居不在了当取消，运行日志 sort <页> drop lost）→ 写 →
// 有一笔没写成整批撤回、出错条 → 写成了出“已移动 · 撤销”。里面没有 React 状态，每次渲染给一个新函数就行
import type { ActionResult } from '../../core/action-result.ts';
import { dropAt, type SortDrop } from '../components/SortDrag.tsx';

/** 放下以后要写的一笔：index 是页面按邻居 id 在此刻的列表里找到的下标（dropAt） */
export interface SortMove {
  id: string;
  index: number;
}

/** 交给 useSortDrag 的 onDrop（流程见文件头）；plan 是页面自己的“写了什么”（撤销照它写回），moved 出“已移动 · 撤销” */
export function useSortDropFlow<P>(o: {
  tag: string;
  log(line: string): void;
  ro(id: string): boolean;
  block(): void;
  /** 此刻的 id 顺序（和页面上画的一致） */
  order(): readonly string[];
  move(m: SortMove): Promise<{ res: ActionResult; plan: P } | null>;
  undo(plan: P): Promise<ActionResult>;
  report(r: ActionResult): void;
  moved(plan: P): void;
}): (d: SortDrop) => void {
  return (d) => {
    if (o.ro(d.id)) return o.block();
    const index = dropAt(o.order(), d);
    if (index === null) return o.log(`sort ${o.tag} drop lost`);
    void o.move({ id: d.id, index }).then((r) => {
      if (!r) return;
      // 有一笔没写成（只读行、离线满了）：整批撤回，不留半截顺序
      if (r.res !== 'ok') return void o.undo(r.plan).then(() => o.report(r.res));
      o.moved(r.plan);
    });
  };
}
