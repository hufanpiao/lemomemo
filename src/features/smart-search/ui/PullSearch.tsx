// 下拉搜索（R-437）：随手记、待办、日历页列表滚到顶再往下拉（或 Tab 到标题行的“搜索本页”），标题下面露出的一条搜索框和结果（同 iPhone 备忘录，平时不占地方）
// • 露不露、打的字在 kit 的 usePullReveal（页面持有），挂法在 kit 的 PullSlot（打了字把本页列表藏起来）；这里只在露出时挂（smart-search/index.ts 懒加载）
// • 打一个字就地筛本页（hooks/usePullFind.ts → data/pull-local.ts），秒出；搜索框用查找面板的 .field / .input，结果行和查找面板同一份 HitBody
// • 结果最底下一行“用 AI 按意思找”：点了才打开查找面板（openFind(q, 'pull')，现有的关键词 + 意思相近，R-112），不另写一套
// • 点一条：交给页面的 onOpen（页面自己管只读拦截、电脑抽屉）；“取消”或输入框里按 Esc：清空并收起（焦点回“搜索本页”）；“×”只清空
// • 从“搜索本页”打开的（via=key）挂上就聚焦输入框；下拉打开的不聚焦（手指还按着，这时弹键盘会顶乱页面）
// • 读屏：条数写进一个常驻的 role="status"（没打字时是空的），停 SEM_DEBOUNCE_MS 才写，免得每个字播一遍（评审第 4 条）；看得见的条数照常跟手
import { useEffect, useRef, useState } from 'react';
import { useUi } from '../../../kit/state/ui-store.ts';
import type { PullReveal } from '../../../kit/hooks/usePullReveal.ts';
import { SEARCH_Q_MAX, SEM_DEBOUNCE_MS } from '../hooks/find-consts.ts';
import { usePullFind, PULL_MAX, type PullScope } from '../hooks/usePullFind.ts';
import { doneAttr, HitBody, useFindT } from './find-parts.tsx';
import find from './FindPanel.module.css';
import styles from './PullSearch.module.css';

export interface PullSearchProps {
  pull: PullReveal;
  scope: PullScope;
  /** 点开一条（随手记、待办、日程的 id） */
  onOpen(id: string): void;
}

export default function PullSearch({ pull, scope, onOpen }: PullSearchProps) {
  const t = useFindT();
  const locale = useUi((s) => s.locale);
  const { setQ, close, searching } = pull;
  const { q, hits, total, ai } = usePullFind(scope, pull.q);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pull.via === 'key') input.current?.focus();
  }, [pull.via]);

  const count = total === 0 ? t('pull.none', {}) : t('pull.n', { n: total });
  const [said, setSaid] = useState('');
  const sayNow = searching ? count : '';
  useEffect(() => {
    const id = setTimeout(() => setSaid(sayNow), SEM_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [sayNow]);

  return (
    <section aria-label={t('pull.label', {})} data-testid="pull-search">
      <div className={styles.bar} role="search">
        <label className={find.field}>
          <span className={styles.glass} aria-hidden="true" />
          <input
            ref={input}
            className={find.input}
            type="search"
            enterKeyHint="search"
            value={pull.q}
            maxLength={SEARCH_Q_MAX}
            placeholder={t(`pull.ph.${scope}`, {})}
            aria-label={t(`pull.ph.${scope}`, {})}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              close();
            }}
            data-testid="pull-input"
          />
          {pull.q !== '' ? (
            <button type="button" className={styles.clear} aria-label={t('pull.clear', {})} onClick={() => setQ('')} data-testid="pull-clear">
              ×
            </button>
          ) : null}
        </label>
        <button type="button" className={styles.cancel} onClick={close} data-testid="pull-cancel">
          {t('pull.cancel', {})}
        </button>
      </div>
      <p className={styles.sr} role="status" data-testid="pull-status">{said}</p>
      {searching ? (
        <div data-testid="pull-results">
          <p className={styles.count} data-testid="pull-count">{count}</p>
          {hits.length ? (
            <ul className={find.list}>
              {hits.map((h) => (
                <li key={h.item.id}>
                  <button type="button" className={find.row} data-done={doneAttr(h.item)} onClick={() => onOpen(h.item.id)} data-testid={`pull-row-${h.item.id}`}>
                    <HitBody h={h} q={q} t={t} locale={locale} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {total > PULL_MAX ? <p className={styles.count}>{t('pull.more', { n: PULL_MAX })}</p> : null}
          <button type="button" className={styles.ai} onClick={ai} data-testid="pull-ai">
            <span>{t('pull.ai', {})}</span>
            <span aria-hidden="true">›</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}
