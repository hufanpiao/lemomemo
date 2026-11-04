// 错过的提醒（B2 FA-4；架构 5.9“错过的提醒”；线框 MISSROW、MISSSHEET；TC-B2-26）：今天页顶部挂这一个
// • 最近 7 天里已到点、没按“知道了”、不在正在响的队列里的（收起的、打开 App 前就到点的都算），有才显示一行：
//   1.5px 墨色描边、铃铛、粗体“错过 N 条提醒”、“查看 ›”（设计 M3）
// • 点开底部弹层：标题“错过的提醒 N”，“全部知道了”在右上；每条一张小卡（“今天 12:50 · 记号 日程（已经开始过了）”+ 粗体标题 + 按类型的按钮，设计 M4）；
//   已经开始过的日程只给“知道了”（线框）；纪念日（含“生成待办”）归 B5，本批不出；点标题进整页提醒
import { useMemo, useState } from 'react';
import { todayOf } from '../../../../shared/core/date.ts';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { useRemindQueue } from '../../../kit/state/remind-queue.ts';
import { Pressable } from '../../../motion/components.ts';
import { openReminder } from '../../../platform/native-bridge.ts';
import { dayMsg, eventStart, missed, timeOf, type Reminder } from '../hooks/remind-view.ts';
import { actionsOf, useMinuteNow, useReminderList, useRemindActions } from '../hooks/useReminders.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import { Bell } from './Bell.tsx';
import { pcClass } from './pc-class.ts';
import { RemindButtons } from './RemindButtons.tsx';
import styles from './Remind.module.css';

export default function MissedReminders() {
  const t = useRemindT();
  const now = useMinuteNow();
  const { list, tz, prefs } = useReminderList(now);
  const entries = useRemindQueue((s) => s.entries);
  const ringTags = useMemo(() => new Set(entries.map((e) => e.tag)), [entries]);
  const items = useMemo(() => missed(list, now, ringTags), [list, now, ringTags]);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const { ackAll } = useRemindActions();
  if (items.length === 0 && !open) return null;
  const today = todayOf(now, tz);

  const started = (r: Reminder): boolean => {
    if (r.kind !== 'event') return false;
    const s = eventStart(r, tz, prefs.defaultTime);
    return s !== null && s <= now;
  };
  const head = (r: Reminder): string => {
    const d = dayMsg(todayOf(r.dueAt, tz), today);
    return `${t('remind.missed.head', { day: t(d.key, d.params as never), time: timeOf(r.dueAt, tz) })} `;
  };

  return (
    <>
      {items.length > 0 && (
        <Pressable type="button" className={styles.missRow} onClick={() => setOpen(true)} data-testid="remind-missed-row">
          <Bell className={styles.bell} />
          <b className={styles.grow}>{t('remind.missed.row', { n: items.length })}</b>
          <span>{t('remind.missed.open', {})}</span>
        </Pressable>
      )}
      <Dialog open={open} onOpenChange={setOpen} title={t('remind.missed.titleN', { n: items.length })} description={t('remind.missed.note', {})}>
        {items.length > 0 && (
          <Pressable
            type="button"
            className={styles.sheetTopAct}
            data-testid="remind-missed-all"
            onClick={async () => {
              const n = await ackAll(items);
              setFailed(n > 0);
              if (n === 0) setOpen(false);
            }}
          >
            {t('remind.missed.allAck', {})}
          </Pressable>
        )}
        {items.length === 0 ? (
          <p className={styles.dim}>{t('remind.missed.empty', {})}</p>
        ) : (
          <ul className={styles.list} data-testid="remind-missed-list">
            {items.map((r) => {
              const project = typeof r.row['project'] === 'string' ? r.row['project'] : '';
              const acts = actionsOf(r, now, tz, prefs);
              return (
                <li key={r.tag} className={styles.missCard} data-testid="remind-missed-item">
                  <button
                    type="button"
                    className={styles.rowBtn}
                    onClick={() => {
                      setOpen(false);
                      void openReminder(r.kind, r.id, r.tagDue);
                    }}
                  >
                    <span className={styles.itemText}>
                      <span className={styles.dim}>
                        {head(r)}
                        <span className={`${r.kind === 'event' ? styles.mkEvSm : styles.mkTdSm} ${pcClass(project)}`} aria-hidden="true" />{' '}
                        {t(r.kind === 'event' ? 'remind.kindName.event' : 'remind.kindName.todo', {})}
                        {started(r) ? t('remind.missed.started', {}) : ''}
                      </span>
                      <b>{r.title}</b>
                    </span>
                  </button>
                  <div className={styles.missBtns}>
                    <RemindButtons r={r} actions={started(r) ? acts.filter((a) => a.key === 'ack') : acts} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {failed && (
          <p className={styles.error} role="alert">
            {t('remind.saveFailed', {})}
          </p>
        )}
      </Dialog>
    </>
  );
}
