// 待办列表页（B2 FA-2；定稿线框 s6；架构 5.9“项目筛选”；R-134、R-136）
// • 顶部项目筛选条：“全部 / 各项目 + 条数”，只作用于这一页（不写 settings）
// • 分组：过期（标红：逾 N 天 / 已过 17:00）→ 今天 → 明天 → 7 天内按日期 → 以后 → 没有日期 → 已完成
// • 每行：打勾（就地保存）、标题（常规字重）、截止标签（“今天 17:00 截止”）、删除（软删 + 8 秒撤销条）；点标题进编辑页
// • 只读行的行尾标记、左滑、多选在后面一段（要 core 暴露 ro 标记，见回报里的接口建议）
// • 动效（17.1“勾选完成”“列表增删”，B2 FA-5；设计审查 M1～M3 返工 11-04）：打勾时圆圈在原地填满（CSS，--dur-ui），
//   列表先不动（useHoldView 留住按下之前的分组）；然后这一条从原来的组淡出、同时下面的行收上来，“已完成”组让开位置后它再淡入。
//   删除：淡出和收拢同时；撤销恢复：先让开位置再淡入（不和别的行叠着）。第一次画列表不播。分组整组出现、消失同样淡入淡出。
//   打勾没有撤销条（只有删除有）：点错了在圆圈填满的那 --dur-ui 里还能再点回去，开始离开以后要到“已完成”组里再点
import { useState } from 'react';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { navigate } from '../../../app/router.ts';
import { CheckCircle } from '../../../kit/components/CheckCircle.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { AppearItem, AppearList, Pressable, useHoldView } from '../../../motion/components.ts';
import { useListT, useTodoList, type ActionResult, type DueTag, type Group } from '../hooks/useTodoList.ts';
import styles from './TodosPage.module.css';

type Toast = { kind: 'undo'; id: string } | { kind: 'error'; readonly: boolean } | null;

export default function TodosPage() {
  const t = useListT();
  const locale = useUi((s) => s.locale);
  const l = useTodoList();
  const [toast, setToast] = useState<Toast>(null);
  // 打勾：先留住按下之前的分组 --dur-ui（圆圈在原地填满，17.1 勾选完成），再换成新的；
  // 留着的期间圆圈按“刚点成什么”画（picked，不等保存回来），几条连着点就一起挪
  const hv = useHoldView(l.groups);
  const [picked, setPicked] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  const report = (r: ActionResult) => {
    if (r === 'failed' || r === 'readonly') setToast({ kind: 'error', readonly: r === 'readonly' });
  };
  const tick = (id: string, on: boolean) => {
    setPicked((m) => new Map(hv.holding ? m : []).set(id, on));
    hv.hold();
    void l.toggleDone(id, on).then(report);
  };
  const shown = (id: string, done: boolean) => (hv.holding ? (picked.get(id) ?? done) : done);
  const del = async (id: string) => {
    hv.release();
    const r = await l.remove(id, true);
    if (r === 'ok') setToast({ kind: 'undo', id });
    else report(r);
  };

  const groupTitle = (g: Group): string => {
    switch (g.key) {
      case 'late': return t('list.g.late', {});
      case 'today': return t('list.g.today', {});
      case 'tomorrow': return t('list.g.tomorrow', {});
      case 'day': return fmtDay(g.date ?? '', locale, 'monthDayWeek');
      case 'later': return t('list.g.later', {});
      case 'nodate': return t('list.g.nodate', {});
      case 'done': return t('list.g.done', {});
    }
  };
  const tagText = (tag: DueTag): string => {
    switch (tag.kind) {
      case 'none': return '';
      case 'late': return tag.days > 0 ? t('list.tag.late', { n: tag.days }) : t('list.tag.passed', { t: tag.dueTime ?? '' });
      case 'today': return tag.dueTime ? t('list.tag.todayAt', { t: tag.dueTime }) : t('list.tag.today', {});
      case 'tomorrow': return tag.dueTime ? t('list.tag.tomorrowAt', { t: tag.dueTime }) : t('list.tag.tomorrow', {});
      case 'date': {
        const date = fmtDay(tag.date, locale, 'monthDay');
        return tag.dueTime ? t('list.tag.dateAt', { date, t: tag.dueTime }) : t('list.tag.date', { date });
      }
    }
  };

  return (
    <main className={styles.page} data-feature="todos" data-testid="todos">
      <header className={styles.top}>
        <h1 className={styles.h1}>{t('list.title', {})}</h1>
        <Pressable className={styles.add} onClick={() => void navigate('todo', 'new')} data-testid="todos-new">
          {t('list.new', {})}
        </Pressable>
      </header>

      {l.projects.length ? (
        <div className={styles.filter} role="group" aria-label={t('list.filter', {})} data-testid="todos-filter">
          <Chip on={l.project === null} onClick={() => l.setProject(null)} label={t('list.all', {})} testId="todos-filter-all" />
          {l.projects.map((p) => (
            <Chip key={p.project} on={l.project === p.project} onClick={() => l.setProject(p.project)} label={`${p.project} ${p.count}`} testId={`todos-filter-${p.project}`} />
          ))}
        </div>
      ) : null}

      {hv.view.length === 0 ? <p className={styles.empty}>{t('list.empty', {})}</p> : null}
      <AppearList as="div">
        {hv.view.map((g) => (
          <AppearItem
            as="section"
            key={`${g.key}:${g.date ?? ''}`}
            className={g.key === 'late' ? `${styles.group} ${styles.late}` : styles.group} data-testid={`todos-g-${g.key}${g.date ? `-${g.date}` : ''}`}>
            <h2 className={styles.h2}>{groupTitle(g)}</h2>
            <AppearList as="ul" className={styles.list}>
              {g.items.map(({ todo, tag }) => (
                <AppearItem key={todo.id} className={styles.row} data-done={todo.done ? '' : undefined} data-testid={`todos-row-${todo.id}`}>
                  <CheckCircle
                    checked={shown(todo.id, todo.done)}
                    label={shown(todo.id, todo.done) ? t('list.undoDone', {}) : t('list.done', {})}
                    onChange={(v) => tick(todo.id, v)}
                    testId={`todos-done-${todo.id}`}
                  />
                  <button type="button" className={styles.main} onClick={() => void navigate('todo', todo.id)}>
                    <span className={styles.title}>{todo.title}</span>
                    <span className={tag.kind === 'late' ? styles.tagLate : styles.tag} data-testid={`todos-tag-${todo.id}`}>
                      {[todo.important ? t('list.important', {}) : '', todo.project, tagText(tag)].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                  <Pressable className={styles.del} aria-label={t('list.delete', {})} onClick={() => void del(todo.id)} data-testid={`todos-del-${todo.id}`}>
                    ×
                  </Pressable>
                </AppearItem>
              ))}
            </AppearList>
          </AppearItem>
        ))}
      </AppearList>

      {toast?.kind === 'undo' ? (
        <UndoToast
          key={toast.id}
          message={t('list.deleted', {})}
          undoLabel={t('list.undo', {})}
          onUndo={() => void l.remove(toast.id, false).then(report)}
          onClose={() => setToast((x) => (x === toast ? null : x))}
          data-testid="todos-toast"
        />
      ) : toast?.kind === 'error' ? (
        <p className={styles.error} role="alert" data-testid="todos-error">
          {toast.readonly ? t('list.err.readonly', {}) : t('list.err.save', {})}
        </p>
      ) : null}
    </main>
  );
}

function Chip({ on, onClick, label, testId }: { on: boolean; onClick(): void; label: string; testId: string }) {
  return (
    <Pressable className={on ? styles.chipOn : styles.chip} aria-pressed={on} onClick={onClick} data-testid={testId}>
      {label}
    </Pressable>
  );
}
