// 下拉搜索：随手记、待办、日历页列表滚到顶再往下拉（或 Tab 到标题行的“搜索”），标题下面露出的那一块；
// 三页统一查日程、待办、随手记，不分组，搜索框里不放提示字
// • 露不露、打的字在 kit 的 usePullReveal（页面持有），挂法在 kit 的 PullSlot；这里只在露出时挂（smart-search/index.ts 懒加载），一整块：
//   一条整宽的扁搜索框（放大镜、输入、清除“×”，竖线后面文字“取消”；输入框里不放提示字；外形和放大镜用 kit 的 pullBarClass、PullGlass，同占位框一份），
//   打了字框下一行小字条数，下面列结果，再下面“用 AI 按意思找 ›”；搜不到时一个小点 + “没有‘发票’。”居中。条数、提示、链接用同一个（deferred 的）q 和条数
// • 三页同一种：打了字把本页藏起来（PullSlot 的 keep，不卸），结果在这里列，日程、待办、随手记混在一起按命中排、不分组
//   （hooks/usePullFind.ts → data/pull-local.ts）；行和查找面板同一份 HitBody，高亮换成 kit 的短下划线；点一条：本页这一类按页面给的 own 打开（只读拦下、电脑版抽屉），别的类按类换页（find-parts 的 openItem）
// • “用 AI 按意思找”：打开查找面板（askAi → openFind(q, 'pull')，现有的关键词 + 意思相近），不另写一套
// • “取消”或输入框里按 Esc：清空并收起（焦点回“搜索”）；“×”只清空
// • 从“搜索”打开的（via=key）挂上就聚焦输入框；下拉打开的不聚焦（手指还按着，这时弹键盘会顶乱页面）
// • 读屏：输入框 aria-label“搜索”；条数写进一个常驻的 role="status"（没打字时是空的），停 SEM_DEBOUNCE_MS 才写，免得每个字播一遍；看得见的条数照常跟手
// • 搜不到的提示居中：App 里空态一律左对齐，这一处是定稿时接受的例外，别的空态照旧左对齐
import { useEffect, useRef, useState } from 'react';
import { useUi } from '../../../kit/state/ui-store.ts';
import { composing } from '../../../kit/hooks/ime.ts';
import type { PullReveal } from '../../../kit/hooks/usePullReveal.ts';
import { PullGlass, pullBarClass } from '../../../kit/components/PullSlot.tsx';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import { SEARCH_Q_MAX, SEM_DEBOUNCE_MS } from '../hooks/find-consts.ts';
import type { FindKind } from '../hooks/useFind.ts';
import { askAi, usePullFind, PULL_MAX } from '../hooks/usePullFind.ts';
import { doneAttr, HitBody, openItem, useFindT } from './find-parts.tsx';
import find from './FindPanel.module.css';
import styles from './PullSearch.module.css';

export interface PullSearchProps {
  pull: PullReveal;
  /** 本页这一类的结果怎么打开（日历页的日程、待办页的待办、随手记页的随手记：只读行拦下、电脑版进右边抽屉）；别的类按类换页（find-parts 的 openItem） */
  own?: { kind: FindKind; open(id: string): void } | undefined;
}

export default function PullSearch({ pull, own }: PullSearchProps) {
  const t = useFindT();
  const locale = useUi((s) => s.locale);
  const { setQ, close, searching } = pull;
  const { q, hits, total } = usePullFind(pull.tag, pull.q);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pull.via === 'key') input.current?.focus();
  }, [pull.via]);

  const count = t('pull.n', { n: total });
  const [said, setSaid] = useState('');
  const sayNow = searching ? count : '';
  useEffect(() => {
    const id = setTimeout(() => setSaid(sayNow), SEM_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [sayNow]);

  return (
    <section aria-label={t('pull.label', {})} data-testid="pull-search">
      <div className={`${pullBarClass} ${styles.bar}`} role="search" data-via={pull.via ?? undefined}>
        <PullGlass />
        <input
          ref={input}
          className={styles.input}
          type="search"
          enterKeyHint="search"
          value={pull.q}
          maxLength={SEARCH_Q_MAX}
          aria-label={t('pull.label', {})}
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
            // 清空后“×”会卸掉，焦点放回输入框，不掉到 body 上
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
          <NumIn text={count} num={String(total)} />
        </p>
      ) : null}
      {searching && hits.length > 0 ? (
        <div data-testid="pull-results">
          <ul className={find.list}>
            {hits.slice(0, PULL_MAX).map((h) => (
              <li key={`${h.item.kind}:${h.item.id}`}>
                <button type="button" className={find.row} data-done={doneAttr(h.item)} onClick={() => (own?.kind === h.item.kind ? own.open(h.item.id) : openItem(h.item))} data-testid={`pull-row-${h.item.id}`}>
                  <HitBody h={h} q={q} t={t} locale={locale} hl={styles.hit} />
                </button>
              </li>
            ))}
          </ul>
          {total > PULL_MAX ? <p className={styles.count}><NumIn text={t('pull.more', { n: PULL_MAX })} num={String(PULL_MAX)} /></p> : null}
        </div>
      ) : null}
      {/* deferred 的 q 还没跟上第一个字时不画，免得闪一下“没有“””（条数和提示同一个 q） */}
      {searching && q.trim() !== '' ? <Foot tag={pull.tag} q={q} n={total} t={t} /> : null}
    </section>
  );
}

/** 结果下面：“用 AI 按意思找 ›”；一条都没有时换成居中的提示 + 同一个链接 */
function Foot({ tag, q, n, t }: { tag: string; q: string; n: number; t: ReturnType<typeof useFindT> }) {
  const ai = (
    <button type="button" className={styles.ai} onClick={() => askAi(tag, q, n)} data-testid="pull-ai">
      {t('pull.ai', {})}
      <span aria-hidden="true"> ›</span>
    </button>
  );
  if (n > 0) return <div className={styles.foot}>{ai}</div>;
  return (
    <div className={styles.empty} data-testid="pull-empty">
      <span className={styles.emptyDot} aria-hidden="true" />
      <p className={styles.emptyText}>{t('pull.empty', { q: q.trim() })}</p>
      {ai}
    </div>
  );
}
