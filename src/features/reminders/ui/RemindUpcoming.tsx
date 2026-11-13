// 设置 › 提醒与通知 › 未来 7 天的提醒（B2 FA-4；架构 5.9“未来 7 天的提醒清单”；线框 sR7；设计 M5；TC-B2-66）
// • 页顶总览：“现在 14:17 之后 · 共 8 条 · 10月28日 没有提醒”（没有提醒的日子也写出来）；靠左排，连着的几天合并写
//   （“11月6日、8～10日 没有提醒”），每个日期、每段日期不从中间折行（设计复审 M1）
// • 今天起 7 天（含今天）里还没过、没处理的提醒，按天分组：组头“今天 · 10月24日 周六”，右边“3 条”
// • 每条：到点时刻、类型记号（日程竖条 / 待办圆圈，项目色；纪念日是圆形头像，ui/KindMark.tsx）、标题、副行（日程“15:30 开始 · 提前 15 分钟”，待办“待办 · 截止前 1 小时”）、›
// • 点一条进这一条的编辑页改提醒（#/event/<id>、#/todo/<id>），不进整页提醒（提醒没到点）
// • 时刻就是本机现算的到点时刻（remindAtOf，和服务器同一份 shared/logic）；第 8 天的、关了提醒的不在里面
// 顶栏和返回由设置页画，这里只画正文
import { addDays, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import { navigate } from '../../../app/router.ts';
import { Pressable } from '../../../motion/components.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { dayMsg, eventStart, modeOf, timeOf, upcoming, wdKey, whenMsg, type Reminder } from '../hooks/remind-view.ts';
import { useReminderList } from '../hooks/useReminders.ts';
import { useRemindT, type RemindT } from '../hooks/useRemindT.ts';
import { KindMark } from './KindMark.tsx';
import styles from './RemindSettings.module.css';

/** 切开“{days} 没有提醒”用的记号（不会出现在文案里） */
const DAYS_MARK = '@@days@@';
/** 未来几天（含今天） */
const DAYS = 7;

const md = (t: RemindT, date: DateStr): string => {
  const [, m, d] = date.split('-').map(Number);
  return t('remind.day.date', { m: m ?? 0, d: d ?? 0 });
};

/** 没有提醒的日子：连着的几天并成一段（同一个月“11月8～10日”，跨月“10月31日～11月2日”），一天的照写 */
export function noneRuns(t: RemindT, dates: readonly DateStr[]): string[] {
  const runs: DateStr[][] = [];
  for (const d of dates) {
    const last = runs[runs.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev && addDays(prev, 1) === d) last.push(d);
    else runs.push([d]);
  }
  return runs.map((r) => {
    const a = r[0] as DateStr;
    const b = r[r.length - 1] as DateStr;
    if (a === b) return md(t, a);
    const [, ma, da] = a.split('-').map(Number);
    const [, mb, db] = b.split('-').map(Number);
    return ma === mb
      ? t('remind.up.rangeMonth', { m: ma ?? 0, d1: da ?? 0, d2: db ?? 0 })
      : t('remind.up.range', { from: md(t, a), to: md(t, b) });
  });
}

function dayHead(t: RemindT, date: DateStr, today: DateStr): string {
  const dm = dayMsg(date, today);
  const full = t('remind.up.date', { date: md(t, date), wd: t(wdKey(date), {}) });
  return dm.key === 'remind.day.today' || dm.key === 'remind.day.tomorrow' ? t('remind.up.dayRel', { label: t(dm.key, {}), full }) : full;
}

/**
 * 每条下面那一小行。日程写几点开始；开始那天和这一组（提醒响的那天）不是同一天时（跨午夜、提前一天提醒），前面加上是哪天：
 * “明天 00:00 开始”，再往后“11月6日 00:00 开始”（设计复审第二轮 N3：只写“00:00 开始”放在“今天”组里，像是今天凌晨）
 */
export function subOf(t: RemindT, r: Reminder, tz: string, defaultTime: string, group: DateStr, today: DateStr): string {
  const m = modeOf(r, defaultTime);
  const mode = t(m.key, m.params as never);
  if (r.kind === 'anniv') {
    // 纪念日（B5）：“纪念日 · 7 天后”（按提醒响的那一刻算）
    const w = whenMsg(r, r.dueAt, tz);
    return t('remind.up.avSub', { when: t(w.key, w.params as never) });
  }
  if (r.kind !== 'event') return t('remind.up.tdSub', { mode });
  const s = eventStart(r, tz, defaultTime);
  if (s === null) return mode;
  const day = todayOf(s, tz);
  if (day === group) return t('remind.up.evSub', { time: timeOf(s, tz), mode });
  const dm = dayMsg(day, today);
  return t('remind.up.evSubDay', { day: t(dm.key, dm.params as never), time: timeOf(s, tz), mode });
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
  const runs = none.length > 0 && none.length < DAYS ? noneRuns(t, none) : [];
  const sep = t('remind.up.sep', {});
  // “{days} 没有提醒”：把 {days} 换成一段一段不折行的日期（词典里 {days} 的位置中韩都在最前，这里按占位符切开，不写死顺序）
  const [noneHead = '', noneTail = ''] = t('remind.up.noneOn', { days: DAYS_MARK }).split(DAYS_MARK);

  return (
    <div data-testid="remind-upcoming">
      <p className={styles.upSummary} data-testid="remind-upcoming-summary">
        <span className={styles.nowrap}>{t('remind.up.summary', { time: timeOf(now, tz), n: total })}</span>
        {runs.length > 0 && (
          <>
            {' · '}
            {noneHead}
            {runs.map((r, i) => (
              <span key={r}>
                {i > 0 ? sep : ''}
                <span className={styles.nowrap}>{r}</span>
              </span>
            ))}
            {noneTail}
          </>
        )}
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
          <ul className={styles.upCard}>
            {d.items.map((r) => {
              return (
                <li key={r.tag} className={styles.rowLi} data-testid="remind-upcoming-item" data-kind={r.kind}>
                  <Pressable type="button" className={styles.upRow} onClick={() => void navigate(r.kind, r.id)} data-testid="remind-upcoming-open">
                    <span className={styles.upTime}>{timeOf(r.dueAt, tz)}</span>
                    <span className={styles.upMk}>
                      <KindMark r={r} />
                    </span>
                    <span className={styles.upText}>
                      <b>{r.title}</b>
                      <small>{subOf(t, r, tz, prefs.defaultTime, d.date, today)}</small>
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
