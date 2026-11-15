// 下拉搜索（R-437）：随手记、待办、日历页列表滚到顶再往下拉，标题下面露出的一条搜索框和结果（同 iPhone 备忘录，平时不占地方）
// • 露不露、打的字在 kit 的 usePullReveal（页面持有，页面按 searching 把本页列表换成这里的结果）；这里只在露出时挂（smart-search/index.ts 懒加载）
// • 打一个字就地筛本页（hooks/usePullFind.ts → data/pull-local.ts），秒出；结果行和查找面板同一套（Lead、Marked、metaOf，FindPanel.module.css 的 .row）
// • 结果最底下一行“用 AI 按意思找”：点了才打开查找面板（openFind(q, 'pull')，现有的关键词 + 意思相近，R-112），不另写一套
// • 点一条：交给页面的 onOpen（页面自己管只读拦截、电脑抽屉）；“取消”清空并收起；“×”只清空
// • 不自动聚焦：下拉的手指还按着，这时弹键盘会顶乱页面；点一下输入框再打字
import { useUi } from '../../../kit/state/ui-store.ts';
import type { PullReveal } from '../../../kit/hooks/usePullReveal.ts';
import { SEARCH_Q_MAX } from '../hooks/useFind.ts';
import { usePullFind, PULL_MAX, type PullScope } from '../hooks/usePullFind.ts';
import { Lead, Marked, metaOf, useFindT } from './find-parts.tsx';
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
  const { q, setQ, close, searching } = pull;
  const { hits, total, ai } = usePullFind(scope, q);
  return (
    <section aria-label={t('pull.label', {})} data-testid="pull-search">
      <div className={styles.bar} role="search">
        <label className={styles.field}>
          <span className={styles.glass} aria-hidden="true" />
          <input
            className={styles.input}
            type="search"
            enterKeyHint="search"
            value={q}
            maxLength={SEARCH_Q_MAX}
            placeholder={t(`pull.ph.${scope}`, {})}
            aria-label={t(`pull.ph.${scope}`, {})}
            onChange={(e) => setQ(e.target.value)}
            data-testid="pull-input"
          />
          {q !== '' ? (
            <button type="button" className={styles.clear} aria-label={t('pull.clear', {})} onClick={() => setQ('')} data-testid="pull-clear">
              ×
            </button>
          ) : null}
        </label>
        <button type="button" className={styles.cancel} onClick={close} data-testid="pull-cancel">
          {t('pull.cancel', {})}
        </button>
      </div>
      {searching ? (
        <div data-testid="pull-results">
          <p className={styles.count} role="status" data-testid="pull-count">
            {total === 0 ? t('pull.none', {}) : t('pull.n', { n: total })}
          </p>
          {hits.length ? (
            <ul className={find.list}>
              {hits.map((h) => {
                const it = h.item;
                const meta = it.kind === 'todo' && h.snippet !== null ? t('pull.sub', { t: h.snippet }) : metaOf(h, t, locale);
                return (
                  <li key={it.id}>
                    <button type="button" className={find.row} data-done={it.done ? '' : undefined} onClick={() => onOpen(it.id)} data-testid={`pull-row-${it.id}`}>
                      <Lead kind={it.kind} done={it.done} />
                      <span className={find.text}>
                        <span className={find.title}><Marked text={it.title || t('find.noTitle', {})} q={q} /></span>
                        {meta !== '' ? <span className={find.meta}><Marked text={meta} q={q} /></span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
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
