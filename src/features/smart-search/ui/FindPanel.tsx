// 查找面板（B4b-2；定稿线框 s12“查找（经＋）”、sFind“查找结果：关键词先出，意思相近随后补上”；R-112、R-118）
// • 打开方式：“＋”打字条判成查找后回车（features/plus 的 TypeBar），电脑 Ctrl+K（features/plus 的 TypeBarPreload 挂的 FindHost）；整块懒加载，不进首屏
// • 手机：整屏一层；电脑（≥ 900px）：磨砂遮罩上居中一块，左结果右预览，↑↓ 选、Enter 打开、Tab 切类型、Esc 关
// • 分组：最相关（关键词和意思都对上）→ 关键词找到 → 意思相近；每组先给 GROUP_SHOW 条，多的点“还有 N 条”展开（代定：线框画了每组 2～3 条和“全部 ›”）
// • 顶上一行“现在只按关键词找 · 原因”（没网、没同意、次数用完、超时 + 再试一次），四种分开写（架构 5.13 第 6 点末条）
// • 打开一条：日程、待办、纪念日进各自的编辑页；随手记、图片、文档进所在随手记；同时记进“最近找过”。不保存、不改任何数据
// • 焦点锁定、Esc 关闭、读屏标注用 Radix Dialog（不用 Overlay：CSP 拦它的内联 style，见 kit Dialog.tsx 文件头），滚动锁用 kit 的 useScrollLock
// • B4b-3：每行右边“⋯”（ui/RowMenu.tsx，完成 / 推迟 / 删除后出“撤销”）；“最相关”里的图片横排缩略图（随手记的 TodayNotes part="thumb"）；
//   有结果时底部也给“最近找过”；隐私记设过密码时出一行“隐私记锁着，里面的不在结果里”（vault 的 findrow）；
//   “＋”判成内容类查找打开的（assist）：排除刚保存的这一批，页脚多“改成记下”“总结一下”（总结换成结果层 AssistPanel）
// • 运行日志：find open / close（只记从哪打开、开了多久），find act（菜单写了什么、成没成），查询中的日志在 useFind
import * as RD from '@radix-ui/react-dialog';
import { Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { navigateSub } from '../../../app/router-sub.ts';
import { useScrollLock } from '../../../kit/components/Dialog.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { TodayNotes } from '../../notes/index.ts';
import { VaultParts } from '../../vault/index.ts';
import { openAssist, type AssistReq, type FindFrom } from '../hooks/find-open.ts';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { actRow, FIND_KINDS, SEARCH_Q_MAX, undoTarget, useFind, type Applied, type FindHit, type FindKind, type RowAct, type TimeFilter } from '../hooks/useFind.ts';
import { RowMenu } from './RowMenu.tsx';
import styles from './FindPanel.module.css';
import { Lead, Marked, metaOf, openItem, Preview, useFindT } from './find-parts.tsx';

/** 每组先显示几条 */
export const GROUP_SHOW = 5;
const TIMES: readonly TimeFilter[] = ['any', 'lastWeek', 'thisMonth'];

export interface FindPanelProps {
  /** 打开时输入框里的字（打字条交过来的查询；Ctrl+K 为空） */
  query: string;
  /** 从哪打开（运行日志）：plus 打字条、ctrlk 快捷键、voice 按住说话、quick 全局打字框、notice 提示条 */
  from: FindFrom;
  /** “＋”判成内容类查找打开的（B4b-3）；别的为 null */
  assist?: AssistReq | null | undefined;
  onClose(): void;
}

interface Group {
  key: 'top' | 'kw' | 'sem';
  head: string;
  sub: string;
  hits: FindHit[];
}

export default function FindPanel({ query, from, assist = null, onClose }: FindPanelProps) {
  const t = useFindT();
  const locale = useUi((s) => s.locale);
  const f = useFind(query, { exclude: assist?.exclude });
  // 菜单写完的撤销条（同一时间一条）
  const [done, setDone] = useState<{ act: RowAct; a: Applied; n: number } | null>(null);
  const act = (h: FindHit, a: RowAct): void => {
    const it = h.item;
    if (it.kind === 'image' || it.kind === 'file') return;
    void actRow(a, it.kind, it.id, { date: it.date, time: it.time }).then((r) => {
      rlog(`find act ${a} kind=${it.kind} ok=${r.ok}`);
      setDone((d) => ({ act: a, a: r, n: (d?.n ?? 0) + 1 }));
    });
  };
  const desk = useMedia(MQ_SIDEBAR);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // 关掉 = onClose（FindHost 的 closeFind 直接卸掉这一块），所以这里一直是开着的
  useScrollLock(true);
  useEffect(() => {
    const t0 = clock.now();
    rlog(`find open from=${from} len=${[...query.trim()].length}`);
    return () => rlog(`find close ms=${clock.now() - t0}`);
  }, [from, query]);

  const q = f.q.trim();
  const groups: Group[] = useMemo(() => {
    const g = f.groups;
    const sem = f.sem.s === 'wait' ? t('find.g.semWaitSub', {}) : '';
    return [
      { key: 'top' as const, head: t('find.g.top', { n: g.top.length }), sub: t('find.g.topSub', {}), hits: g.top },
      { key: 'kw' as const, head: t('find.g.kw', { n: g.kw.length }), sub: '', hits: g.kw },
      { key: 'sem' as const, head: f.sem.s === 'wait' ? t('find.g.semWait', {}) : t('find.g.sem', { n: g.sem.length }), sub: sem, hits: g.sem },
    ];
  }, [f.groups, f.sem.s, t]);
  const visible = useMemo(
    () => groups.flatMap((g) => (more[g.key] ? g.hits : g.hits.slice(0, GROUP_SHOW))),
    [groups, more],
  );
  // 换了查询、类型、时间：选中回到第一条
  useEffect(() => setSel(0), [f.q, f.kind, f.time]);
  const picked = visible[Math.min(sel, visible.length - 1)] ?? null;
  const total = f.counts.all;

  const close = onClose;
  const go = (h: FindHit): void => {
    f.remember();
    rlog(`find pick kind=${h.item.kind}`);
    close();
    openItem(h.item);
  };
  const kinds = FIND_KINDS.filter((k) => f.counts[k] > 0 || f.kind === k);
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = visible.length;
      if (n > 0) setSel((s) => (e.key === 'ArrowDown' ? (s + 1) % n : (s - 1 + n) % n));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (picked) go(picked);
    } else if (e.key === 'Tab' && !e.shiftKey && desk && q !== '') {
      // 线框 s12 电脑版“Tab 切换类型”：只在输入框里、有查询时接，Shift+Tab 照常
      e.preventDefault();
      const order: (FindKind | 'all')[] = ['all', ...kinds];
      f.setKind(order[(order.indexOf(f.kind) + 1) % order.length] ?? 'all');
    }
  };

  const fb = f.sem.s === 'fallback' ? f.sem.reason : null;
  const fbLine = fb === null ? null : (
    <p className={styles.fb} role="status" data-testid="find-fallback" data-reason={fb}>
      <span>{t('find.fb.head', {})} · {t(`find.fb.${fb}`, {})}</span>
      {fb === 'consent' ? (
        <button type="button" className={styles.link} onClick={() => { close(); void navigateSub('onboarding', 'ai'); }}>{t('find.fb.consentGo', {})}</button>
      ) : null}
      {fb === 'timeout' ? (
        <button type="button" className={styles.link} onClick={f.again} data-testid="find-retry">{t('find.fb.retry', {})}</button>
      ) : null}
    </p>
  );

  const chips = q === '' ? null : (
    <div className={styles.chips} role="group" aria-label={t('find.label', {})}>
      <button type="button" className={f.kind === 'all' ? styles.chipOn : styles.chip} aria-pressed={f.kind === 'all'} onClick={() => f.setKind('all')} data-testid="find-kind-all">
        {t('find.k.all', { n: total })}
      </button>
      {kinds.map((k) => (
        <button key={k} type="button" className={f.kind === k ? styles.chipOn : styles.chip} aria-pressed={f.kind === k} onClick={() => f.setKind(k)} data-testid={`find-kind-${k}`}>
          {t('find.kn', { k: t(`find.k.${k}`, {}), n: f.counts[k] })}
        </button>
      ))}
    </div>
  );
  const times = q === '' || desk ? null : (
    <div className={styles.chips} role="group" aria-label={t('find.t.any', {})}>
      {TIMES.map((x) => (
        <button key={x} type="button" className={f.time === x ? styles.chipOn : styles.chip} aria-pressed={f.time === x} onClick={() => f.setTime(x)} data-testid={`find-time-${x}`}>
          {t(`find.t.${x}`, {})}
        </button>
      ))}
    </div>
  );

  let idx = -1;
  const row = (h: FindHit): ReactNode => {
    idx += 1;
    const i = idx;
    return (
      <li key={`${h.item.kind}:${h.item.id}`} className={styles.item}>
        <button
          type="button"
          className={styles.row}
          aria-current={desk && i === sel ? 'true' : undefined}
          onClick={() => go(h)}
          onMouseEnter={desk ? () => setSel(i) : undefined}
          data-testid="find-row"
          data-kind={h.item.kind}
        >
          <Lead kind={h.item.kind} />
          <span className={styles.text}>
            <span className={styles.title}><Marked text={h.item.title || t('find.noTitle', {})} q={q} /></span>
            <span className={styles.meta}><Marked text={metaOf(h, t, locale)} q={q} /></span>
          </span>
        </button>
        <RowMenu it={h.item} onOpen={() => go(h)} onAct={(a) => act(h, a)} />
      </li>
    );
  };

  // “最相关”里的图片横排（线框 sFind THUMBS）：有缩略图的图片排成一行三列，点了同点那一行
  const isThumb = (h: FindHit): boolean => h.item.kind === 'image' && h.item.hasThumb && h.item.noteId !== null;
  const thumbs = (hits: FindHit[]): ReactNode => {
    const pics = hits.filter(isThumb);
    if (pics.length === 0) return null;
    return (
      <div className={styles.thumbs} data-testid="find-thumbs">
        {pics.map((h) => (
          <button key={h.item.id} type="button" className={styles.thumb} onClick={() => go(h)} data-testid="find-thumb">
            <span className={styles.thumbBox}>
              <Suspense fallback={null}><TodayNotes part="thumb" noteId={h.item.noteId ?? ''} imageId={h.item.id} /></Suspense>
            </span>
            <span className={styles.thumbT}>{h.item.extra || h.item.title}</span>
          </button>
        ))}
      </div>
    );
  };

  // “＋”判成查找打开的：页脚“总结一下”（换成结果层，总结这些；一条都没找到时不出）、“改成记下”（原话按记下保存，B4b-3）
  const rec = assist?.record ?? null;
  const foot = (withSum: boolean) => assist === null ? null : (
    <div className={styles.foot}>
      {withSum ? (
        <button type="button" className={styles.chip} onClick={() => {
          rlog('find to_summary');
          if ('query' in assist.ask) openAssist({ ...assist, ask: { intent: 'summarize', query: { ...assist.ask.query, text: q } } });
        }} data-testid="find-summarize">{t('as.sum.btn', {})}</button>
      ) : null}
      {rec ? (
        <button type="button" className={styles.chip} onClick={() => {
          rlog('find to_record');
          void rec();
          close();
        }} data-testid="find-record">{t('as.record', {})}</button>
      ) : null}
      {assist.aiUsed > 0 ? <span className={styles.footN}>{t('as.ai', { n: assist.aiUsed })}</span> : null}
    </div>
  );
  const anyHit = groups.some((g) => g.hits.length > 0);
  const recent = f.recent.length > 0 ? (
    <>
      <div className={styles.gh}><b>{t('find.recent', {})}</b></div>
      <div className={styles.chips}>
        {f.recent.map((r) => (
          <button key={r} type="button" className={styles.chip} onClick={() => f.setQ(r)} data-testid="find-recent">{r}</button>
        ))}
      </div>
    </>
  ) : null;
  const vaultRow = <Suspense fallback={null}><VaultParts part="findrow" onGo={close} /></Suspense>;
  const results = q === '' ? (
    <>
      <p className={styles.start}>{t('find.start', {})}</p>
      {recent}
    </>
  ) : !anyHit && f.sem.s !== 'wait' ? (
    <div className={styles.empty} data-testid="find-empty">
      <div className={styles.emptyT}>{t('find.empty', { q })}</div>
      <div className={styles.emptyS}>
        {f.sem.s === 'done' ? <>{t('find.emptyAll', {})}<br /></> : null}
        {t('find.emptyHint', {})}
      </div>
      {vaultRow}
      {foot(false)}
    </div>
  ) : (
    <>
    {groups.map((g) => {
      if (g.hits.length === 0 && !(g.key === 'sem' && f.sem.s === 'wait')) return null;
      const hidden = more[g.key] ? 0 : g.hits.length - GROUP_SHOW;
      return (
        <section key={g.key} aria-label={g.head} data-testid={`find-group-${g.key}`}>
          <div className={styles.gh}><b>{g.head}</b>{g.sub ? <span>{g.sub}</span> : null}</div>
          {g.key === 'sem' && f.sem.s === 'wait' ? (
            <div className={styles.skel} aria-hidden="true"><i /><i /></div>
          ) : (
            <>
              {g.key === 'top' ? thumbs(g.hits) : null}
              <ul className={styles.list}>{(more[g.key] ? g.hits : g.hits.slice(0, GROUP_SHOW)).filter((h) => !(g.key === 'top' && isThumb(h))).map(row)}</ul>
            </>
          )}
          {hidden > 0 ? (
            <button type="button" className={styles.more} onClick={() => setMore((m) => ({ ...m, [g.key]: true }))}>{t('find.more', { n: hidden })}</button>
          ) : null}
        </section>
      );
    })}
    {foot(anyHit)}
    {recent}
    </>
  );

  const field = (
    <div className={styles.field}>
      <span className={styles.plus} aria-hidden="true">＋</span>
      <input
        ref={input}
        className={styles.input}
        value={f.q}
        onChange={(e) => f.setQ(e.target.value)}
        onKeyDown={onKey}
        placeholder={t('find.ph', {})}
        aria-label={t('find.label', {})}
        enterKeyHint="search"
        maxLength={SEARCH_Q_MAX}
        data-testid="find-input"
      />
    </div>
  );

  return (
    <RD.Root open onOpenChange={(o) => (o ? undefined : close())}>
      <RD.Portal>
        {desk ? <div className={styles.scrim} onClick={close} aria-hidden="true" data-testid="find-scrim" /> : null}
        <RD.Content
          className={desk ? styles.desk : styles.phone}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
          }}
          data-testid="find-panel"
        >
          <RD.Title className={styles.sr}>{t('find.results', {})}</RD.Title>
          {desk ? (
            <>
              <div className={styles.head}>{field}{chips}</div>
              {fbLine ? <div className={styles.deskFb}>{fbLine}</div> : null}
              {q !== '' && anyHit ? <div className={styles.deskFb}>{vaultRow}</div> : null}
              <div className={styles.cols}>
                <div className={styles.body}>{results}</div>
                <aside className={styles.side} aria-label={t('find.desk.none', {})} data-testid="find-preview">
                  {picked ? <Preview h={picked} q={q} t={t} locale={locale} /> : <p className={styles.pk}>{t('find.desk.none', {})}</p>}
                  <p className={styles.keys}>{t('find.desk.keys', {})}</p>
                </aside>
              </div>
            </>
          ) : (
            <>
              <div className={styles.head}>
                {field}
                <button type="button" className={styles.close} onClick={close} data-testid="find-close">{t('find.close', {})}</button>
              </div>
              {chips}
              {times}
              {fbLine}
              {q !== '' && anyHit ? vaultRow : null}
              <div className={styles.body}>{results}</div>
            </>
          )}
          {done ? (
            <UndoToast
              key={done.n}
              message={done.a.ok > 0 ? t(done.act === 'delete' ? 'find.m.ok.del' : done.act === 'done' ? 'find.m.ok.done' : 'find.m.ok.tomorrow', {}) : t('find.m.fail', {})}
              // 一条都没写成：没有可撤销的，只出提示（alert，读屏马上读）
              role={done.a.ok > 0 ? 'status' : 'alert'}
              undoLabel={done.a.ok > 0 ? t('find.undo', {}) : undefined}
              onUndo={done.a.ok > 0 ? () => {
                const a = done.a;
                void undoTarget(a, clock.now()).then((n) => rlog(`find act undo n=${n}`));
              } : undefined}
              onClose={() => setDone(null)}
              data-testid="find-undo"
            />
          ) : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
