// 查找面板的状态（B4b-2；架构 5.13 第 6 点“查询流程”；线框 s12、sFind）
// • 关键词：每次改字当场在本机缓存里查（data/find-local.ts），马上出结果
// • 意思相近：停 SEM_DEBOUNCE_MS（400 ms）、归一后至少 2 个字、在线、AI 开着且同意没过期 → note-search；补上来以后合并（mergeFind）
//   没网 → 只按关键词（offline）；AI 关着或同意过期 → consent；服务器回的 consent / quota / timeout 照原样；“再试一次”只对 timeout
// • 运行日志（全局运行日志，R-398）：只记字数、条数、原因和耗时，不记查询文字（A23）：
//   find kw len= n= ms=（停下来以后记一次，不是每个字记一次）、find sem n= add= ms=、find fallback reason= code=
// • AI 开着 = ai.enabled 为 true 且同意版本没明确过期（和“＋”打字、录音同一判断，plus/hooks/useCaptureCtx.ts）
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import type { SettingRow } from '../../../core/setting-read.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { useOnline } from '../../../kit/hooks/useOnline.ts';
import { aiOnFor } from '../../../kit/hooks/ai-on.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { readSessionId } from '../../../platform/session.ts';
import type { FallbackReason } from '../../../../shared/schema/search.ts';
export { SEARCH_Q_MAX } from '../../../../shared/schema/search.ts';
import {
  buildIndex, countKinds, findLocal, inRange, mergeFind, onlyKind, rangeOf, semReady,
  type FindGroups, type FindKind, type Row, type SemHit, type TimeFilter,
} from '../data/find-local.ts';
import { addRecent, loadRecent, recentSnapshot, subscribeRecent } from '../data/find-recent.ts';
import { noteSearch, type SemResult } from '../data/note-search-api.ts';

// ui 不能直接引自己的 data（ESLint boundaries，架构 2.1），面板要的常量、高亮函数和类型从这里转出去
export { FIND_KINDS, markRanges, type FindHit, type FindKind, type TimeFilter } from '../data/find-local.ts';

export const SEM_DEBOUNCE_MS = 400;

/** done 带上是哪一句查出来的：刚改字那一次渲染里旧结果不和新关键词拼在一起 */
export type SemState = { s: 'idle' } | { s: 'wait' } | { s: 'done'; q: string; hits: SemHit[] } | { s: 'fallback'; reason: FallbackReason };

export interface FindDeps {
  search?: (q: string, signal: AbortSignal) => Promise<SemResult>;
}

export function useFind(initial: string, deps: FindDeps = {}) {
  const [q, setQ] = useState(initial);
  const [kind, setKind] = useState<FindKind | 'all'>('all');
  const [time, setTime] = useState<TimeFilter>('any');
  const [retry, setRetry] = useState(0);
  const [sem, setSem] = useState<SemState>({ s: 'idle' });
  const events = useCollection<Row>('events');
  const todos = useCollection<Row>('todos');
  const anniversaries = useCollection<Row>('anniversaries');
  const notes = useCollection<Row>('notes');
  const images = useCollection<Row>('note_images');
  const files = useCollection<Row>('note_files');
  const settings = useCollection<SettingRow & { id: string }>('settings');
  const online = useOnline();
  const now = useMinuteNow();
  const tz = currentTz();
  const aiOn = aiOnFor(settings, readSessionId());
  const recent = useSyncExternalStore(subscribeRecent, recentSnapshot, recentSnapshot);
  useEffect(() => void loadRecent(), []);

  const index = useMemo(
    () => buildIndex({ events, todos, anniversaries, notes, note_images: images, note_files: files }, tz),
    [events, todos, anniversaries, notes, images, files, tz],
  );
  const range = useMemo(() => rangeOf(time, now, tz), [time, now, tz]);
  const scoped = useMemo(() => inRange(index, range), [index, range]);
  // 关键词查找的耗时记在结果旁边，停下来以后才写日志（不是每个字写一次）
  const kw = useMemo(() => {
    const t0 = performance.now();
    const hits = findLocal(scoped, q);
    return { hits, ms: Math.round(performance.now() - t0) };
  }, [scoped, q]);
  useEffect(() => {
    const len = [...q.trim()].length;
    if (len === 0) return undefined;
    const id = setTimeout(() => rlog(`find kw len=${len} n=${kw.hits.length} ms=${kw.ms}`), SEM_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [kw, q]);

  const search = deps.search ?? noteSearch;
  useEffect(() => {
    const text = q.trim();
    if (!semReady(text)) {
      setSem({ s: 'idle' });
      return undefined;
    }
    if (!online) {
      setSem({ s: 'fallback', reason: 'offline' });
      return undefined;
    }
    if (!aiOn) {
      setSem({ s: 'fallback', reason: 'consent' });
      return undefined;
    }
    setSem({ s: 'wait' });
    const ac = new AbortController();
    const id = setTimeout(() => {
      const t0 = clock.now();
      void search(text, ac.signal).then((r) => {
        if (ac.signal.aborted) return;
        const ms = clock.now() - t0;
        if (r.ok) {
          rlog(`find sem n=${r.hits.length} ms=${ms}`);
          setSem({ s: 'done', q: text, hits: r.hits });
        } else {
          rlog(`find fallback reason=${r.reason} code=${r.code} ms=${ms}`);
          setSem({ s: 'fallback', reason: r.reason });
        }
      });
    }, SEM_DEBOUNCE_MS);
    return () => {
      clearTimeout(id);
      ac.abort();
    };
  }, [q, online, aiOn, retry, search]);

  // 本地判出来的退路也记一行（只在原因变了时）
  const lastFb = useRef<string>('');
  useEffect(() => {
    const r = sem.s === 'fallback' && (sem.reason === 'offline' || sem.reason === 'consent') ? sem.reason : '';
    if (r !== '' && r !== lastFb.current) rlog(`find fallback reason=${r} code=local`);
    lastFb.current = r;
  }, [sem]);

  const semHits = sem.s === 'done' && sem.q === q.trim() ? sem.hits : null;
  const groups: FindGroups = useMemo(() => mergeFind(kw.hits, semHits, scoped, q), [kw, semHits, scoped, q]);
  // 补上来几条（日志）：每次服务器回来只记一次，之后同步来了新数据、groups 变了不再记
  const loggedSem = useRef<SemState | null>(null);
  useEffect(() => {
    if (sem.s !== 'done' || loggedSem.current === sem) return;
    loggedSem.current = sem;
    rlog(`find sem add=${groups.sem.length} top=${groups.top.length}`);
  }, [sem, groups]);
  const counts = useMemo(() => countKinds(groups), [groups]);
  const shown = useMemo(() => onlyKind(groups, kind), [groups, kind]);

  const remember = useCallback(() => addRecent(q), [q]);
  const again = useCallback(() => setRetry((n) => n + 1), []);
  return { q, setQ, kind, setKind, time, setTime, sem, groups: shown, counts, recent, remember, again };
}
