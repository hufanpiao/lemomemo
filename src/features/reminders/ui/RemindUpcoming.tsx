// 设置 › 提醒与通知 › 未来 7 天的提醒（B2 FA-4；架构 5.9“未来 7 天的提醒清单”；线框 sR7；设计 M5；TC-B2-66）
// • 页顶总览：“现在 14:17 之后 · 共 8 条 · 10月28日 没有提醒”（没有提醒的日子也写出来）
// • 今天起 7 天（含今天）里还没过、没处理的提醒，按天分组：组头“今天 · 10月24日 周六”，右边“3 条”
// • 每条：到点时刻、类型记号（日程竖条 / 待办圆圈，项目色）、标题、副行（日程“15:30 开始 · 提前 15 分钟”，待办“待办 · 截止前 1 小时”）、›
// • 点一条进这一条的编辑页改提醒（#/event/<id>、#/todo/<id>），不进整页提醒（提醒没到点）
// • 时刻就是本机现算的到点时刻（remindAtOf，和服务器同一份 shared/logic）；第 8 天的、关了提醒的不在里面
// 顶栏和返回由设置页画，这里只画正文
import { addDays, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import { navigate } from '../../../app/router.ts';
import { Pressable } from '../../../motion/components.ts';
import { dayMsg, eventStart, modeOf, timeOf, upcoming, wdKey, type Reminder } from '../hooks/remind-view.ts';
import { useMinuteNow, useReminderList } from '../hooks/useReminders.ts';
import { useRemindT, type RemindT } from '../hooks/useRemindT.ts';
import { pcClass } from './pc-class.ts';
import rs from './Remind.module.css';
import styles from './RemindSettings.module.css';

/** 未来几天（含今天） */
const DAYS = 7;

const md = (t: RemindT, date: DateStr): string => {
  const [, m, d] = date.split('-').map(Number);
  return t('remind.day.date', { m: m ?? 0, d: d ?? 0 });
};

function dayHead(t: RemindT, date: DateStr, today: DateStr): string {
  const dm = dayMsg(date, today);
  const full = t('remind.up.date', { date: md(t, date), wd: t(wdKey(date), {}) });
  return dm.key === 'remind.day.today' || dm.key === 'remind.day.tomorrow' ? t('remind.up.dayRel', { label: t(dm.key, {}), full }) : full;
}

function subOf(t: RemindT, r: Reminder, tz: string, defaultTime: string): string {
  const m = modeOf(r);
  const mode = t(m.key, m.params as never);
  if (r.kind !== 'event') return t('remind.up.tdSub', { mode });
  const s = eventStart(r, tz, defaultTime);
  return s === null ? mode : t('remind.up.evSub', { time: timeOf(s, tz), mode });
}

export default function RemindUpcoming() {
  const t = useRemindT();
  const now = useMinuteNow();
  const { list, tz, prefs } = useReminderList(now);
  const days = upcoming(list, now, tz);
  const today = todayOf(now, tz);
  const total = days.reduce((n, d) => n + d.items.length, 0);
  const has = new Set(days.map((d) => d.date));
  const none = Array.from({ length: DAYS }, (_, i) => addDays(today, i)).filter((d) => !has.has(d));
  const summary = [
    t('remind.up.summary', { time: timeOf(now, tz), n: total }),
    ...(none.length > 0 && none.length < DAYS ? [t('remind.up.noneOn', { days: none.map((d) => md(t, d)).join(t('remind.up.sep', {})) })] : []),
  ].join(' · ');

  return (
    <div data-testid="remind-upcoming">
      <p className={styles.upSummary} data-testid="remind-upcoming-summary">
        {summary}
      </p>
      {days.length === 0 && (
        <p className={styles.sn} data-testid="remind-upcoming-empty">
          {t('remind.up.empty', {})}
        </p>
      )}
      {days.map((d) => (
        <section key={d.date} aria-labelledby={`remind-up-${d.date}`} data-testid="remind-upcoming-day" data-date={d.date}>
          <h2 id={`remind-up-${d.date}`} className={`${styles.gt} ${styles.upHead}`}>
            <span className={styles.upDay}>{dayHead(t, d.date, today)}</span>
            <span>{t('remind.up.count', { n: d.items.length })}</span>
          </h2>
          <ul className={styles.grp}>
            {d.items.map((r) => {
              const project = typeof r.row['project'] === 'string' ? r.row['project'] : '';
              return (
                <li key={r.tag} className={styles.rowLi} data-testid="remind-upcoming-item" data-kind={r.kind}>
                  <Pressable type="button" className={styles.upRow} onClick={() => void navigate(r.kind === 'event' ? 'event' : 'todo', r.id)} data-testid="remind-upcoming-open">
                    <span className={styles.upTime}>{timeOf(r.dueAt, tz)}</span>
                    <span className={styles.upMk}>
                      <span className={`${r.kind === 'event' ? rs.mkEv : rs.mkTd} ${pcClass(project)}`} aria-hidden="true" />
                    </span>
                    <span className={styles.upText}>
                      <b>{r.title}</b>
                      <small>{subOf(t, r, tz, prefs.defaultTime)}</small>
                    </span>
                    <span className={styles.chev} aria-hidden="true">
                      ›
                    </span>
                  </Pressable>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
