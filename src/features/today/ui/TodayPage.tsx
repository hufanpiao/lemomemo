// 今天页（B2 FA-2；定稿线框 s1、皮肤视觉稿“现在”卡方案 K、R-118、R-131、R-133、R-134、R-136）
// 从上到下：日期一行 →“现在”卡（四种状态）→ 没赶上（逾期待办）→ 今天的安排（日程和今天截止的待办）
// • 字重：只有页顶日期、“现在”卡进行中那一件的标题加粗；普通日程和待办标题 400（R-134、R-136，TC-B2-06）
// • 固定时刻的日程换算成当前时区；和记录时的时区不同时加注“14:00（韩国时间 15:00）”（4.6）；全天不换算
// • 点一行进编辑页；打勾就保存；删除后出撤销条（8 秒）；写不进去时出提示条，只读行提示“要新版本才能修改”
// • 动效（17.1，B2 FA-5；设计审查 M1～M3 返工 11-04）：打勾时圆圈在原地填满（kit CheckCircle），列表先不动（useHoldView 留住
//   按下之前的两张列表 --dur-ui）；然后这一行淡出、同时下面的行收上来，挪到的地方等让开了再淡入（motion 的 AppearList）；第一次画不播
// • 液态玻璃底栏、“＋”、时间河、错过的提醒、提醒按钮条不在这一段（FA-4、FA-7）
import { useState } from 'react';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { navigate } from '../../../app/router.ts';
import { CheckCircle } from '../../../kit/components/CheckCircle.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { AppearItem, AppearList, Pressable, useHoldView } from '../../../motion/components.ts';
import { useLocale, useTodayT, zoneName } from '../hooks/useTodayT.ts';
import { useToday, type ActionResult } from '../hooks/useToday.ts';
import { NowCard } from './NowCard.tsx';
import styles from './TodayPage.module.css';

type Toast = { kind: 'undo'; id: string } | { kind: 'error'; readonly: boolean } | null;

export default function TodayPage() {
  const t = useTodayT();
  const locale = useLocale();
  const d = useToday();
  const [toast, setToast] = useState<Toast>(null);
  // 打勾：先留住按下之前的两张列表 --dur-ui（圆圈在原地填满），再换成新的（没赶上 → 今天的安排）；
  // 留着的期间圆圈按“刚点成什么”画（picked），几条连着点就一起挪
  const hv = useHoldView({ late: d.late, events: d.events, todos: d.todos });
  const v = hv.view;
  const [picked, setPicked] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const tick = (id: string, on: boolean) => {
    setPicked((m) => new Map(hv.holding ? m : []).set(id, on));
    hv.hold();
    void d.toggleDone(id, on).then(report);
  };
  const shown = (id: string, done: boolean) => (hv.holding ? (picked.get(id) ?? done) : done);

  const report = (r: ActionResult) => {
    if (r === 'failed' || r === 'readonly') setToast({ kind: 'error', readonly: r === 'readonly' });
  };
  const del = async (id: string) => {
    hv.release();
    const r = await d.remove('todos', id, true);
    if (r === 'ok') setToast({ kind: 'undo', id });
    else report(r);
  };

  return (
    <main className={styles.page} data-feature="today" data-testid="today">
      <h1 className={styles.date}>{fmtDay(d.today, locale, 'monthDayWeek')}</h1>

      <NowCard card={d.card} now={d.now} tz={d.tz} today={d.today} tomorrowFirst={d.tomorrowFirst} />

      {/* 两块放在同一个 AppearList 里：没赶上最后一条离开时整组跟着淡出（不然 section 一卸载，那一行的退出动画就被截断），
          下面“今天的安排”用 layout 平移收上来，不跳 */}
      <AppearList as="div">
        {v.late.length ? (
          <AppearItem as="section" key="late" className={styles.late} aria-labelledby="today-late" data-testid="today-late">
            <h2 id="today-late" className={styles.h2}>{t('late.title', {})}</h2>
            <AppearList as="ul" className={styles.list}>
              {v.late.map(({ todo, days }) => (
                <AppearItem key={todo.id} className={styles.row}>
                  <CheckCircle checked={shown(todo.id, false)} label={shown(todo.id, false) ? t('list.undoDone', {}) : t('list.done', {})} onChange={(v) => tick(todo.id, v)} testId={`today-done-${todo.id}`} />
                  <button type="button" className={styles.main} onClick={() => void navigate('todo', todo.id)}>
                    <span className={styles.title}>{todo.title}</span>
                    <span className={styles.lateTag}>{days > 0 ? t('late.days', { n: days }) : t('late.passed', { t: todo.dueTime ?? '' })}</span>
                  </button>
                </AppearItem>
              ))}
            </AppearList>
          </AppearItem>
        ) : null}

        <AppearItem as="section" key="list" aria-labelledby="today-list" data-testid="today-list">
          <h2 id="today-list" className={styles.h2}>{t('list.title', {})}</h2>
          {v.events.length === 0 && v.todos.length === 0 ? <p className={styles.empty}>{t('list.empty', {})}</p> : null}
          <AppearList as="ul" className={styles.list}>
            {v.events.map((o) => (
              <AppearItem key={`e:${o.id}`} className={styles.row} data-testid={`today-event-${o.id}`}>
                <span className={styles.time}>{o.time ?? t('list.allDay', {})}</span>
                <button type="button" className={styles.main} onClick={() => void navigate('event', o.id)}>
                  <span className={styles.title}>{o.title}</span>
                  {o.origin ? <span className={styles.sub}>{t('list.origin', { zone: zoneName(o.origin.tz, locale), t: o.origin.time })}</span> : null}
                </button>
              </AppearItem>
            ))}
            {v.todos.map((td) => (
              <AppearItem key={`t:${td.id}`} className={styles.row} data-testid={`today-todo-${td.id}`} data-done={td.done ? '' : undefined}>
                <CheckCircle
                  checked={shown(td.id, td.done)}
                  label={shown(td.id, td.done) ? t('list.undoDone', {}) : t('list.done', {})}
                  onChange={(v) => tick(td.id, v)}
                  testId={`today-done-${td.id}`}
                />
                <button type="button" className={styles.main} onClick={() => void navigate('todo', td.id)}>
                  <span className={styles.title}>{td.title}</span>
                  <span className={styles.sub}>{td.dueTime ? t('list.due', { t: td.dueTime }) : t('list.dueDay', {})}</span>
                </button>
                <Pressable className={styles.del} aria-label={t('list.delete', {})} onClick={() => void del(td.id)} data-testid={`today-del-${td.id}`}>
                  ×
                </Pressable>
              </AppearItem>
            ))}
          </AppearList>
        </AppearItem>
      </AppearList>

      {toast?.kind === 'undo' ? (
        <UndoToast
          key={toast.id}
          message={t('toast.deleted', {})}
          undoLabel={t('toast.undo', {})}
          onUndo={() => void d.remove('todos', toast.id, false).then(report)}
          onClose={() => setToast((x) => (x === toast ? null : x))}
          data-testid="today-toast"
        />
      ) : toast?.kind === 'error' ? (
        <p className={styles.error} role="alert" data-testid="today-error">
          {toast.readonly ? t('err.readonly', {}) : t('err.save', {})}
        </p>
      ) : null}
    </main>
  );
}
