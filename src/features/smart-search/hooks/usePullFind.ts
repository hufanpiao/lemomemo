// 下拉搜索的状态（R-437）：订阅本页的集合，打一个字就地筛一次（data/pull-local.ts），秒出；点“用 AI 按意思找”交给查找面板（openFind，现有的意思相近查找）
// • 运行日志：pull find <页> len= n= ms=（停 SEM_DEBOUNCE_MS 以后记一次，不记打的字）、pull ai <页> n=
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { PULL_MAX, PULL_TABLES, pullFind, pullIndex, type PullScope } from '../data/pull-local.ts';
import type { Row } from '../data/find-local.ts';
import { openFind } from './find-open.ts';
import { SEM_DEBOUNCE_MS } from './useFind.ts';

export { PULL_MAX, type PullScope } from '../data/pull-local.ts';

/** 没有附表的页订一个不存在的集合名：拿到的是空数组（hooks 不能按条件调用） */
const NO_TABLE = 'pull.none';

export function usePullFind(scope: PullScope, q: string) {
  const [main, sub] = PULL_TABLES[scope];
  const rows = useCollection<Row>(main);
  const extra = useCollection<Row>(sub ?? NO_TABLE);
  const tz = currentTz();
  const index = useMemo(() => pullIndex(scope, rows, extra, tz), [scope, rows, extra, tz]);
  const r = useMemo(() => {
    const t0 = performance.now();
    const hits = pullFind(index, q);
    return { hits, ms: Math.round(performance.now() - t0) };
  }, [index, q]);

  const now = useRef(r);
  useEffect(() => {
    now.current = r;
  }, [r]);
  useEffect(() => {
    const len = [...q.trim()].length;
    if (len === 0) return undefined;
    const id = setTimeout(() => rlog(`pull find ${scope} len=${len} n=${now.current.hits.length} ms=${now.current.ms}`), SEM_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [q, scope]);

  const total = r.hits.length;
  const ai = useCallback(() => {
    rlog(`pull ai ${scope} n=${total}`);
    openFind(q.trim(), 'pull');
  }, [q, scope, total]);
  return { hits: r.hits.slice(0, PULL_MAX), total, ai };
}
