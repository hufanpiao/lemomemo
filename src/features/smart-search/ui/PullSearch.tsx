// 下拉搜索（R-437；R-447 负责人 11-17 选 S-B“原列表筛选”、“搜索框要样式按照kenotex的那种扁的”）：随手记、待办、日历页列表滚到顶再往下拉
// （或 Tab 到标题行的“搜索本页”），标题下面露出的那一块
// • 露不露、打的字在 kit 的 usePullReveal（页面持有），挂法在 kit 的 PullSlot；这里只在露出时挂（smart-search/index.ts 懒加载）。PullSlot 挂两处：
//   part=head 在列表上面：一条整宽的扁搜索框（放大镜、输入、清除“×”，竖线后面文字“取消”），打了字框下一行小字条数；
//   part=foot 在列表下面（打了字才挂）：“用 AI 按意思找 ›”，搜不到时一个小点 + “待办里没有‘发票’。”居中
// • 就地筛（found 给了的页：随手记、待办）：打一个字算出本页命中的 id（hooks/usePullFind.ts → data/pull-local.ts），setFound 交给 kit，
//   页面照原来的分组和行画、只画命中的、命中的字加短下划线（kit PullHit）；条数用页面上真正画出来的 found（项目、分类胶囊照样筛，待办默认不画已完成的）
// • 日历页不给 found（月历、日清单不是一整串记录，没法就地筛）：PullSlot inPlace=false 把本页藏起来，结果在 head 里列（行和查找面板同一份 HitBody，
//   高亮换成同一道短下划线），点一条交给页面的 onOpen
// • 待办页给 done：条数后面一个小下拉“全部未完成 / 含已完成”（方案图“3 未完成 · 全部未完成⌄”），选的值页面自己记
// • “用 AI 按意思找”：打开查找面板（askAi → openFind(q, 'pull')，现有的关键词 + 意思相近，R-112），不另写一套
// • “取消”或输入框里按 Esc：清空并收起（焦点回“搜索本页”）；“×”只清空
// • 从“搜索本页”打开的（via=key）挂上就聚焦输入框；下拉打开的不聚焦（手指还按着，这时弹键盘会顶乱页面）
// • 读屏：条数写进一个常驻的 role="status"（没打字时是空的），停 SEM_DEBOUNCE_MS 才写，免得每个字播一遍（评审第 4 条）；看得见的条数照常跟手
// • 搜不到的提示居中：App 里空态一律左对齐（U6），这一处是负责人 11-17 选 S-B 时一并接受的例外（R-447），别的空态照旧左对齐
import { useEffect, useMemo, useRef, useState } from 'react';
import { queryTerms } from '../../../../shared/logic/search.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { composing } from '../../../kit/hooks/ime.ts';
import type { PullReveal } from '../../../kit/hooks/usePullReveal.ts';
import { pullHitClass, type PullPart } from '../../../kit/components/PullSlot.tsx';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import { SEARCH_Q_MAX, SEM_DEBOUNCE_MS } from '../hooks/find-consts.ts';
import { askAi, usePullFind, PULL_MAX, type PullScope } from '../hooks/usePullFind.ts';
import { doneAttr, HitBody, useFindT } from './find-parts.tsx';
import find from './FindPanel.module.css';
import styles from './PullSearch.module.css';

export interface PullSearchProps {
  part: PullPart;
  pull: PullReveal;
  scope: PullScope;
  /** 就地筛的页给：页面上筛完真正画出来几条。不给 = 这一页不就地筛（日历），结果在这一块里列 */
  found?: number | undefined;
  /** 待办页：只看未完成（默认）还是含已完成 */
  done?: { all: boolean; set(all: boolean): void } | undefined;
  /** 点开一条（只有不就地筛的日历页用：日程 id） */
  onOpen?: ((id: string) => void) | undefined;
}

export default function PullSearch(p: PullSearchProps) {
  return p.part === 'head' ? <Head {...p} /> : <Foot {...p} />;
}

function Head({ pull, scope, found, done, onOpen }: PullSearchProps) {
  const t = useFindT();
  const locale = useUi((s) => s.locale);
  const { setQ, close, searching, setFound } = pull;
  const { q, hits, total } = usePullFind(scope, pull.q, found);
  const ids = useMemo(() => new Set(hits.map((h) => h.item.id)), [hits]);
  useEffect(() => {
    setFound(queryTerms(q).length === 0 ? null : { q, ids });
  }, [q, ids, setFound]);
  useEffect(() => () => setFound(null), [setFound]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pull.via === 'key') input.current?.focus();
  }, [pull.via]);

  const n = found ?? total;
  const count = done && !done.all ? t('pull.open', { n }) : t('pull.n', { n });
  const [said, setSaid] = useState('');
  const sayNow = searching ? count : '';
  useEffect(() => {
    const id = setTimeout(() => setSaid(sayNow), SEM_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [sayNow]);

  return (
    <section aria-label={t('pull.label', {})} data-testid="pull-search">
      <div className={styles.bar} role="search" data-via={pull.via ?? undefined}>
        <span className={styles.glass} aria-hidden="true" />
        <input
          ref={input}
          className={styles.input}
          type="search"
          enterKeyHint="search"
          value={pull.q}
          maxLength={SEARCH_Q_MAX}
          placeholder={t(`pull.ph.${scope}`, {})}
          aria-label={t(`pull.ph.${scope}`, {})}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // 组字中的 Esc 是撤掉候选，不收起（判断只在 kit/hooks/ime.ts 一份）
            if (e.key !== 'Escape' || composing(e.nativeEvent)) return;
            e.preventDefault();
            close();
          }}
          data-testid="pull-input"
        />
        {pull.q !== '' ? (
          <button type="button" className={styles.clear} aria-label={t('pull.clear', {})} onClick={() => {
            // 清空后“×”会卸掉，焦点放回输入框，不掉到 body 上（R-447 评审第 4 条）
            setQ('');
            input.current?.focus();
          }} data-testid="pull-clear">
            ×
          </button>
        ) : null}
        <span className={styles.sep} aria-hidden="true" />
        <button type="button" className={styles.cancel} onClick={close} data-testid="pull-cancel">
          {t('pull.cancel', {})}
        </button>
      </div>
      <p className={styles.sr} role="status" data-testid="pull-status">{said}</p>
      {searching ? (
        <p className={styles.count} data-testid="pull-count">
          <NumIn text={count} num={String(n)} />
          {done ? (
            <>
              <span className={styles.dot} aria-hidden="true">·</span>
              {/* 看得见的是 12px 小字；真的 select 透明盖在上面、字号 16px（iPhone 点字号 < 16px 的控件会整页放大，src/app/__tests__/input-font-size.test.ts） */}
              <span className={styles.scope}>
                <span aria-hidden="true">{t(done.all ? 'pull.scope.all' : 'pull.scope.open', {})}</span>
                <select
                  className={styles.scopeSel}
                  value={done.all ? 'all' : 'open'}
                  aria-label={t('pull.scope', {})}
                  onChange={(e) => done.set(e.target.value === 'all')}
                  data-testid="pull-scope"
                >
                  <option value="open">{t('pull.scope.open', {})}</option>
                  <option value="all">{t('pull.scope.all', {})}</option>
                </select>
                <span className={styles.chev} aria-hidden="true" />
              </span>
            </>
          ) : null}
        </p>
      ) : null}
      {searching && found === undefined && hits.length > 0 ? (
        <div data-testid="pull-results">
          <ul className={find.list}>
            {hits.slice(0, PULL_MAX).map((h) => (
              <li key={h.item.id}>
                <button type="button" className={find.row} data-done={doneAttr(h.item)} onClick={() => onOpen?.(h.item.id)} data-testid={`pull-row-${h.item.id}`}>
                  <HitBody h={h} q={q} t={t} locale={locale} hl={pullHitClass} />
                </button>
              </li>
            ))}
          </ul>
          {total > PULL_MAX ? <p className={styles.count}><NumIn text={t('pull.more', { n: PULL_MAX })} num={String(PULL_MAX)} /></p> : null}
        </div>
      ) : null}
    </section>
  );
}

/** 列表下面：“用 AI 按意思找 ›”；页面上一条都没画出来时换成居中的提示 + 同一个链接。命中还没算出来（head 刚挂上）时不画，免得闪一下“没有” */
function Foot({ pull, scope, found }: PullSearchProps) {
  const t = useFindT();
  if (pull.found === null) return null;
  const n = found ?? pull.found.ids.size;
  const ai = (
    <button type="button" className={styles.ai} onClick={() => askAi(scope, pull.q, n)} data-testid="pull-ai">
      {t('pull.ai', {})}
      <span aria-hidden="true"> ›</span>
    </button>
  );
  if (n > 0) return <div className={styles.foot}>{ai}</div>;
  return (
    <div className={styles.empty} data-testid="pull-empty">
      <span className={styles.emptyDot} aria-hidden="true" />
      <p className={styles.emptyText}>{t(`pull.empty.${scope}`, { q: pull.q.trim() })}</p>
      {ai}
    </div>
  );
}
