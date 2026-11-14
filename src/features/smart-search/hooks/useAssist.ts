// 结果层的状态（B4b-3；架构 5.14 第 3、4、7 点）：时间类查找、总结、取消 / 改期 / 完成的确认卡片
// • 列表：data/assist-list.ts 的 listQuery（本机缓存，不调 AI）；排除刚保存的这一批（exclude）
// • 总结：意图是总结时打开就调一次 ai-summarize；查找时点“总结一下”才调。离线、AI 没开不调，直接给原因。
//   送之前等这几条发出去（最多 3 秒），送哪些见 refsOf（最多 50 条）
// • 取消、改期、完成：候选在第一次算出来时定住（写了以后行变了，卡片不跟着变）；批量默认全勾；点了才写，写完能撤
// • 运行日志（只记数量、原因、耗时，不记原话和标题，A23）：assist list / assist sum / assist target / assist act / assist undo
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { todayOf } from '../../../../shared/core/date.ts';
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { byDay, isOverdue, listQuery, refsOf } from '../data/assist-list.ts';
import { summarize, waitSent, type SumFail, type SumReq, type SumResult } from '../data/summarize-api.ts';
import { applyTarget, candidates, moveTo, undoTarget, type Applied, type Row, type TargetHit } from '../data/target-act.ts';
import { useFindSource } from './useFind.ts';

export { byDay, isOverdue, moveTo, type TargetHit };
export type { FindItem } from '../data/find-local.ts';

export type SumState =
  | { s: 'idle' }
  | { s: 'wait' }
  | { s: 'done'; summary: string; cited: ReadonlySet<string>; missing: number; quotaLeft: number }
  | { s: 'fail'; reason: SumFail | 'offline' | 'off' };

export type ActState = { s: 'idle' } | { s: 'busy' } | { s: 'done'; a: Applied } | { s: 'undone'; n: number };

export interface AssistDeps {
  sum?: (req: SumReq, signal: AbortSignal) => Promise<SumResult>;
  wait?: typeof waitSent;
}

export function useAssist(ask: AssistAsk, exclude: readonly string[], deps: AssistDeps = {}) {
  const src = useFindSource();
  const locale = useUi((s) => s.locale);
  const ex = useMemo(() => new Set(exclude), [exclude]);
  const today = todayOf(src.now, src.tz);

  const items = useMemo(() => ('query' in ask ? listQuery(src.index, ask.query, ex) : []), [ask, src.index, ex]);
  const overdue = useMemo(() => items.filter((it) => isOverdue(it, today)).length, [items, today]);
  useEffect(() => {
    if ('query' in ask) rlog(`assist list intent=${ask.intent} n=${items.length} range=${ask.query.range ? 1 : 0} kinds=${ask.query.kinds.join('+') || 'all'}`);
    // 只在打开时记一次（之后同步来了新数据不再记）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 总结 ——
  const [sum, setSum] = useState<SumState>({ s: 'idle' });
  const ac = useRef<AbortController | null>(null);
  useEffect(() => () => ac.current?.abort(), []);
  const run = useCallback(() => {
    if (!('query' in ask)) return;
    if (!src.online) return setSum({ s: 'fail', reason: 'offline' });
    if (!src.aiOn) return setSum({ s: 'fail', reason: 'off' });
    const { refs, more } = refsOf(items);
    if (refs.length === 0) return setSum({ s: 'idle' });
    ac.current?.abort();
    const c = new AbortController();
    ac.current = c;
    setSum({ s: 'wait' });
    const t0 = clock.now();
    void (async () => {
      const left = await (deps.wait ?? waitSent)(refs, c.signal);
      if (c.signal.aborted) return;
      const r = await (deps.sum ?? summarize)({ ids: refs, ask: ask.query.text, now: clock.now(), tz: src.tz, locale }, c.signal);
      if (c.signal.aborted) return;
      const ms = clock.now() - t0;
      if (r.ok) {
        rlog(`assist sum ok n=${refs.length} more=${more} cited=${r.cited.length} missing=${r.missing.length} unsent=${left ? 1 : 0} ms=${ms}`);
        setSum({ s: 'done', summary: r.summary, cited: new Set(r.cited), missing: r.missing.length, quotaLeft: r.quotaLeft });
      } else {
        rlog(`assist sum fail reason=${r.reason} code=${r.code} n=${refs.length} ms=${ms}`);
        setSum({ s: 'fail', reason: r.reason });
      }
    })();
  }, [ask, items, src.online, src.aiOn, src.tz, locale, deps.sum, deps.wait]);
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current || ask.intent !== 'summarize') return;
    auto.current = true;
    run();
  }, [ask.intent, run]);

  // —— 取消、改期、完成 ——
  const fixed = useRef<ReturnType<typeof candidates> | null>(null);
  if ('target' in ask && fixed.current === null && !ask.bulkRefused) {
    fixed.current = candidates(ask.target, src.events, src.todos, src.now, src.tz);
    rlog(`assist target intent=${ask.intent} hits=${fixed.current.hits.length} more=${fixed.current.more} all=${ask.target.all === true ? 1 : 0}`);
  }
  const match = fixed.current ?? { hits: [], more: 0 };
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((id: string) => setOff((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  }), []);
  const [act, setAct] = useState<ActState>({ s: 'idle' });
  const rows = useMemo(() => new Map<string, Row>([...src.events, ...src.todos].map((r) => [r.id, r])), [src.events, src.todos]);
  const confirm = useCallback(async (only: TargetHit[]): Promise<Applied | null> => {
    if (!('target' in ask) || act.s === 'busy') return null;
    setAct({ s: 'busy' });
    const a = await applyTarget(ask.intent, only, rows, ask.to, clock.now(), src.tz);
    rlog(`assist act intent=${ask.intent} ok=${a.ok} failed=${a.failed}`);
    setAct({ s: 'done', a });
    return a;
  }, [ask, act.s, rows, src.tz]);
  const undo = useCallback(async () => {
    if (act.s !== 'done') return;
    const n = await undoTarget(act.a, clock.now());
    rlog(`assist undo n=${n} of=${act.a.undo.length}`);
    setAct({ s: 'undone', n });
  }, [act]);

  const titleOf = useCallback((id: string): string => {
    const v = rows.get(id)?.['title'];
    return typeof v === 'string' ? v : '';
  }, [rows]);

  return { titleOf, items, overdue, today, sum, summarize: run, match, off, toggle, act, confirm, undo, online: src.online, aiOn: src.aiOn };
}

/** 提示条下面“也帮你找了一下：N 条”的 N（本机缓存里数，同 useAssist；取消、改期、完成数候选，泛指词的取消、标完成不数） */
export function useAssistCount(ask: AssistAsk, exclude: readonly string[]): number {
  const src = useFindSource();
  return useMemo(() => {
    const ex = new Set(exclude);
    if ('query' in ask) return listQuery(src.index, ask.query, ex).length;
    if (ask.bulkRefused) return 0;
    return candidates(ask.target, src.events.filter((r) => !ex.has(r.id)), src.todos.filter((r) => !ex.has(r.id)), src.now, src.tz).hits.length;
  }, [ask, exclude, src.index, src.events, src.todos, src.now, src.tz]);
}
