// 下拉搜索的状态（R-437）：订阅本页的集合，打一个字就地筛一次（data/pull-local.ts），秒出；点“用 AI 按意思找”交给查找面板（openFind，现有的意思相近查找）
// • 筛选用 useDeferredValue 包过的查询（评审第 6 条）：输入框先跟手，记录多时筛选那一次重画可以让路；高亮也用同一个值，和结果对得上
// • 运行日志（kit 的 useDebouncedLog，停 SEM_DEBOUNCE_MS 记一次、收起时补记）：pull find <页> len= n= shown= ms=（n 命中几条，shown 页面上就地筛完画出来几条，
//   R-447 起待办页默认不画已完成的、项目胶囊照样筛，两个数可以不一样）；点 AI：pull ai <页> n=。不记打的字
// • 归一化（每打一个字，每条记录的字段都重新 normalizeForSearch）先不缓存（评审第 6 条，主持人定先不做）；耗时记在日志 ms= 里，慢了再在建索引那一步存归一后的字段
import { useDeferredValue, useMemo } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useDebouncedLog } from '../../../kit/hooks/useDebouncedLog.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { PULL_TABLES, pullFind, pullIndex, type PullScope } from '../data/pull-local.ts';
import type { Row } from '../data/find-local.ts';
import { SEM_DEBOUNCE_MS } from './find-consts.ts';
import { openFind } from './find-open.ts';

export { PULL_MAX, type PullScope } from '../data/pull-local.ts';

/** 没有附表的页订一个不存在的集合名：拿到的是空数组（hooks 不能按条件调用） */
const NO_TABLE = 'pull.none';

/** shown：页面上真正画出来几条（就地筛的页给；不给按命中数记） */
export function usePullFind(scope: PullScope, q: string, shown?: number) {
  const [main, sub] = PULL_TABLES[scope];
  const rows = useCollection<Row>(main);
  const extra = useCollection<Row>(sub ?? NO_TABLE);
  const tz = currentTz();
  const dq = useDeferredValue(q);
  const index = useMemo(() => pullIndex(scope, rows, extra, tz), [scope, rows, extra, tz]);
  const r = useMemo(() => {
    const t0 = performance.now();
    const hits = pullFind(index, dq);
    return { hits, ms: Math.round(performance.now() - t0) };
  }, [index, dq]);
  const total = r.hits.length;
  const len = [...dq.trim()].length;
  useDebouncedLog(dq, len === 0 ? null : `pull find ${scope} len=${len} n=${total} shown=${shown ?? total} ms=${r.ms}`, SEM_DEBOUNCE_MS);
  return { q: dq, hits: r.hits, total };
}

/** “用 AI 按意思找”：打开查找面板（现有的关键词 + 意思相近，R-112），带上打的字；n 是这一刻页面上的条数 */
export function askAi(scope: PullScope, q: string, n: number): void {
  rlog(`pull ai ${scope} n=${n}`);
  openFind(q.trim(), 'pull');
}
