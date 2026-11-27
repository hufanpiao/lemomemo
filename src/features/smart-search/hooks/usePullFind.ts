// 下拉搜索的状态（三页都查日程、待办、随手记三类，见 data/pull-local.ts）：订阅这五个集合，打一个字查一次，秒出；点“用 AI 按意思找”交给查找面板（openFind，现有的意思相近查找）
// • 筛选用 useDeferredValue 包过的查询：输入框先跟手，记录多时筛选那一次重画可以让路；高亮也用同一个值，和结果对得上
// • 运行日志（kit 的 useDebouncedLog，停 SEM_DEBOUNCE_MS 记一次、收起时补记）：pull find <页> len= n= ms=（n 命中几条）；点 AI：pull ai <页> n=。不记打的字
// • 归一化（每打一个字，每条记录的字段都重新 normalizeForSearch）先不缓存；耗时记在日志 ms= 里，慢了再在建索引那一步存归一后的字段
import { useDeferredValue, useMemo } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useDebouncedLog } from '../../../kit/hooks/useDebouncedLog.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { pullIndex } from '../data/pull-local.ts';
import { findLocal, type Row } from '../data/find-local.ts';
import { SEM_DEBOUNCE_MS } from './find-consts.ts';
import { openFind } from './find-open.ts';

export { PULL_MAX } from '../data/pull-local.ts';

/** tag：打开搜索框的是哪一页（usePullReveal 的页名，只进运行日志） */
export function usePullFind(tag: string, q: string) {
  const events = useCollection<Row>('events');
  const todos = useCollection<Row>('todos');
  const todoItems = useCollection<Row>('todo_items');
  const notes = useCollection<Row>('notes');
  const categories = useCollection<Row>('categories');
  const tz = currentTz();
  const dq = useDeferredValue(q);
  const index = useMemo(() => pullIndex({ events, todos, todo_items: todoItems, notes, categories }, tz), [events, todos, todoItems, notes, categories, tz]);
  const r = useMemo(() => {
    const t0 = performance.now();
    const hits = findLocal(index, dq);
    return { hits, ms: Math.round(performance.now() - t0) };
  }, [index, dq]);
  const total = r.hits.length;
  const len = [...dq.trim()].length;
  useDebouncedLog(dq, len === 0 ? null : `pull find ${tag} len=${len} n=${total} ms=${r.ms}`, SEM_DEBOUNCE_MS);
  return { q: dq, hits: r.hits, total };
}

/** “用 AI 按意思找”：打开查找面板（现有的关键词 + 意思相近），带上打的字；n 是这一刻页面上的条数 */
export function askAi(tag: string, q: string, n: number): void {
  rlog(`pull ai ${tag} n=${n}`);
  openFind(q.trim(), 'pull');
}
