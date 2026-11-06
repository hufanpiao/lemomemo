// 错过的提醒的底部弹层（线框 MISSSHEET；TC-B2-26）：从 MissedReminders.tsx 拆出来（首屏瘦身 H1 第三轮），点开那一行才下载；
// 弹层（Radix Dialog 和它带的 es2015、tslib）、按钮、整本提醒词典都在这个分包里，首屏不带。
// 标题“错过的提醒 N”，“全部知道了”在右上（只有 1 条时不出，和这一条的“知道了”重复；负责人 11-04 定，设计复审 L2）；
// 每条一张小卡（“今天 12:50 · 记号 日程（已经开始过了）”+ 粗体标题 + 按类型的按钮，设计 M4）；已经开始过的日程只给“知道了”；点标题进整页提醒
import { useState } from 'react';
import { todayOf } from '../../../../shared/core/date.ts';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { Pressable } from '../../../motion/components.ts';
import { openReminder } from '../../../platform/native-bridge.ts';
import type { RemindPrefs } from '../hooks/remind-list.ts';
import { dayMsg, eventStart, timeOf, type Reminder } from '../hooks/remind-view.ts';
import { actionsOf, useRemindActions } from '../hooks/useReminders.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import { pcClass } from './pc-class.ts';
import { RemindButtons } from './RemindButtons.tsx';
import styles from './Remind.module.css';

export interface MissedSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly Reminder[];
  now: number;
  tz: string;
  prefs: RemindPrefs;
  /** 退路（Dialog L-2）：“全部知道了”以后那一行没了，焦点还不回去时给它 */
  returnFocus?: () => HTMLElement | null;
}

export default function MissedSheet({ open, onOpenChange, items, now, tz, prefs, returnFocus }: MissedSheetProps) {
  const t = useRemindT();
  const setOpen = onOpenChange;
  const [failed, setFailed] = useState(false);
  const { ackAll } = useRemindActions();
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
    <Dialog open={open} onOpenChange={setOpen} {...(returnFocus ? { returnFocus } : {})} title={t('remind.missed.titleN', { n: items.length })} description={t('remind.missed.note', {})}>
      {items.length > 1 && (
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
  );
}
