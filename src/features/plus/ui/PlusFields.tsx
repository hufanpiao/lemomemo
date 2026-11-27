// 打字条输入框下面那排签：分类、日期、提醒（样子和交互照方案页）
// • 三个签一排：签上就是这一刻会记成的样子。浅黄 = 从这句话里认出来的（auto），柠檬黄 = 手点的或默认亮的（on），
//   没填是浅灰底；日历页没说日子时日期签照旧写选中的那天，不上色（记下时补那天）
// • 点分类签展开：不分类、已有的分类（和 useCaptureCtx 同一份：待办、日程里出现过的 project）、末尾“＋”新建（回车选中，写进 project）；点一个就收起
// • 点日期签展开：今天、明天、后天、下周一、“其他日期”（pickDate，DayTimePick.tsx 占位）；时刻：不定 / 全天、09:00、14:00、19:00、“其他时刻”（pickTime）；
//   日程有时刻选时长（30 分、1 小时、2 小时），全天选跨几天（就一天、2 天、3 天、1 周，选了跨天清掉时刻）；待办注明没有“一段时间”
// • 提醒签是开关（aria-pressed），有时刻默认亮
// • 签下面一行小字：打了字“浅黄 = 认出来的，点一下能改”，没打字给一句例子（方案页原样）
// • 点签不收键盘：打字条的 form 拦了按钮上的 mousedown（keepFieldFocus）；新建分类的小输入框原地聚焦，回车或选完把焦点还给主输入框
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { parseDate, weekdayOf, type DateStr } from '../../../../shared/core/date.ts';
import { PROJECT_MAX } from '../../../../shared/schema/rows.ts';
import { focusInPlace } from '../../../platform/in-place-focus.ts';
import { usePlusLine, usePlusT, type PlusMsgKey } from '../hooks/usePlusT.ts';
import { dayChoices, DUR_CHOICES, SPAN_CHOICES, TIME_CHOICES, type DayChoice, type Fields, type Picks } from '../hooks/useTypeBar.ts';
import { pickDate, pickTime, WD_KEYS } from './DayTimePick.tsx';
import styles from './PlusFields.module.css';

export interface PlusFieldsProps {
  fields: Fields;
  /** 打字条输入框里有没有字（签下面那行小字用哪句） */
  typed: boolean;
  /** 日历页选中的那天；别的页为 null */
  day: DateStr | null;
  today: DateStr;
  projects: readonly string[];
  pick(p: Picks): void;
  addProject(name: string): void;
  /** 打字条主输入框（新建分类完把焦点还回去） */
  field: RefObject<HTMLInputElement | null>;
}

type Open = 'proj' | 'date' | null;

const DAY_KEY: Record<DayChoice, PlusMsgKey> = { today: 'plus.f.today', tomorrow: 'plus.f.tomorrow', after: 'plus.f.after', nextMon: 'plus.f.nextMon' };

/** 签的底色：填了的分认出来的（浅黄）和手点 / 默认亮的（柠檬黄） */
const tone = (filled: boolean, auto: boolean): string => (filled ? ((auto ? styles.auto : styles.on) ?? '') : '');
const cls = (...c: (string | false | undefined)[]): string => c.filter(Boolean).join(' ');

const TagIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 12V4h8l10 10-8 8L3 12z" /><circle cx="7.5" cy="7.5" r="1.2" /></svg>
);
const CalIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
);
const BellIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2zM10 21h4" /></svg>
);

/** 新建分类的小输入框：挂上原地聚焦；回车（不在输入法组字中）交上去，不提交打字条 */
function NewProject({ onDone }: { onDone(name: string): void }) {
  const t = usePlusT();
  const el = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => focusInPlace(el.current, 'newproj'), []);
  const key = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    onDone(e.currentTarget.value.trim());
  };
  return (
    <span className={styles.chip}>
      <input ref={el} className={styles.newIn} placeholder={t('plus.f.newPh', {})} aria-label={t('plus.f.newProject', {})} maxLength={PROJECT_MAX} enterKeyHint="done" onKeyDown={key} data-testid="field-newproj" />
    </span>
  );
}

export function PlusFields({ fields: f, typed, day, today, projects, pick, addProject, field }: PlusFieldsProps) {
  const t = usePlusT();
  // 运行时才定的键（今天 / 明天、周几）经 usePlusLine 查
  const line = usePlusLine();
  const [open, setOpen] = useState<Open>(null);
  const [making, setMaking] = useState(false);
  const [other, setOther] = useState<'date' | 'time' | null>(null);
  const event = f.kind === 'event';
  const md = (d: DateStr): string => {
    const { m, d: dd } = parseDate(d);
    return `${m}/${dd}`;
  };
  /** “11/22 明天”：今天、明天、后天写相对说法，别的写周几 */
  const short = (d: DateStr): string => {
    const rel = dayChoices(today).slice(0, 3).find((c) => c.date === d);
    return t('plus.f.dayLabel', { md: md(d), rel: line(rel ? DAY_KEY[rel.key] : (WD_KEYS[weekdayOf(d)] ?? 'plus.f.wd.0'), {}) });
  };
  const durText = (n: number): string => (n < 60 ? t('plus.f.durMin', { n }) : t('plus.f.durHour', { n: n / 60 }));
  const spanText = (n: number): string => (n === 7 ? t('plus.f.spanWeek', {}) : t('plus.f.spanN', { n }));
  const filledDate = f.date !== null || f.time !== null || (event && f.span > 1);
  const dateLabel = (): string => {
    if (!filledDate) return day !== null ? short(day) : t('plus.f.date', {});
    const base = f.date !== null ? short(f.date) : day !== null ? short(day) : t('plus.f.today', {});
    if (f.time !== null) return `${base} ${f.time}${event ? ` · ${durText(f.dur)}` : ''}`;
    return event && f.span > 1 ? t('plus.f.spanFrom', { date: base, n: f.span }) : base;
  };
  const toggle = (o: Exclude<Open, null>): void => {
    setOpen((was) => (was === o ? null : o));
    setMaking(false);
    setOther(null);
  };
  const back = (): void => focusInPlace(field.current, 'fields');
  const choose = (p: Picks): void => {
    pick(p);
    setOpen(null);
    setMaking(false);
  };

  const chip = (label: string, on: boolean, act: () => void, extra = '', id?: string) => (
    <button key={id ?? label} type="button" className={cls(styles.chip, on && styles.on, extra)} aria-pressed={on} onClick={act} data-testid={id}>
      {label}
    </button>
  );

  return (
    <div className={styles.wrap} data-testid="type-fields">
      <div className={styles.row}>
        <button type="button" className={cls(styles.chip, tone(f.project !== null, f.auto.project))} aria-expanded={open === 'proj'} onClick={() => toggle('proj')} data-testid="field-project">
          <TagIcon />
          {f.project ?? t('plus.f.project', {})}
        </button>
        <button type="button" className={cls(styles.chip, tone(filledDate, f.auto.date))} aria-expanded={open === 'date'} onClick={() => toggle('date')} data-testid="field-date">
          <CalIcon />
          <span className={styles.num}>{dateLabel()}</span>
        </button>
        <button type="button" className={cls(styles.chip, tone(f.remind, f.auto.remind))} aria-pressed={f.remind} onClick={() => pick({ remind: !f.remind })} data-testid="field-remind">
          <BellIcon />
          {t('plus.f.remind', {})}
        </button>
      </div>
      {open === 'proj' ? (
        <div className={styles.tray} data-testid="tray-project">
          <div className={styles.row}>
            {chip(t('plus.f.noProject', {}), f.project === null, () => choose({ project: null }))}
            {projects.map((p) => (
              <button key={p} type="button" className={cls(styles.chip, tone(f.project === p, f.auto.project))} aria-pressed={f.project === p} onClick={() => choose({ project: p })}>
                {p}
              </button>
            ))}
            {making ? (
              <NewProject onDone={(name) => {
                if (name !== '') addProject(name);
                setMaking(false);
                setOpen(null);
                back();
              }} />
            ) : (
              <button type="button" className={cls(styles.chip, styles.ghost)} aria-label={t('plus.f.newProject', {})} onClick={() => setMaking(true)} data-testid="field-addproj">＋</button>
            )}
          </div>
        </div>
      ) : null}
      {open === 'date' ? (
        <div className={styles.tray} data-testid="tray-date">
          <div className={styles.row}>
            {dayChoices(today).map((c) => (
              <button key={c.key} type="button" className={cls(styles.chip, tone(f.date === c.date, f.auto.date))} aria-pressed={f.date === c.date} onClick={() => pick({ date: c.date })}>
                {line(DAY_KEY[c.key], {})}
              </button>
            ))}
            {/* 签上的日子不在上面四个里：这一格写那天（方案页系统框里显示当前值的位置），上色同日期签 */}
            {(() => {
              const own = f.date !== null && !dayChoices(today).some((c) => c.date === f.date) ? f.date : null;
              return chip(own ? short(own) : t('plus.f.otherDay', {}), other === 'date', () => setOther((o) => (o === 'date' ? null : 'date')), own ? tone(true, f.auto.date) : styles.ghost, 'field-otherday');
            })()}
          </div>
          {other === 'date' ? pickDate({ value: f.date, today, onPick: (d) => pick({ date: d }) }) : null}
          <div className={styles.hint}>{t(event ? 'plus.f.timeEvent' : 'plus.f.timeTodo', {})}</div>
          <div className={styles.row}>
            {chip(t(event ? 'plus.f.allDay' : 'plus.f.noTime', {}), f.time === null, () => pick({ time: null }))}
            {TIME_CHOICES.map((x) => (
              <button key={x} type="button" className={cls(styles.chip, styles.num, tone(f.time === x, f.auto.date))} aria-pressed={f.time === x} onClick={() => pick(event ? { time: x, span: 1 } : { time: x })}>
                {x}
              </button>
            ))}
            {(() => {
              const own = f.time !== null && !TIME_CHOICES.some((x) => x === f.time) ? f.time : null;
              return chip(own ?? t('plus.f.otherTime', {}), other === 'time', () => setOther((o) => (o === 'time' ? null : 'time')), own ? cls(styles.num, tone(true, f.auto.date)) : styles.ghost, 'field-othertime');
            })()}
          </div>
          {other === 'time' ? pickTime({ value: f.time, onPick: (x) => pick(event ? { time: x, span: 1 } : { time: x }) }) : null}
          {event && f.time !== null ? (
            <>
              <div className={styles.hint}>{t('plus.f.dur', {})}</div>
              <div className={styles.row}>{DUR_CHOICES.map((n) => chip(durText(n), f.dur === n, () => pick({ dur: n })))}</div>
            </>
          ) : null}
          {event && f.time === null ? (
            <>
              <div className={styles.hint}>{t('plus.f.span', {})}</div>
              <div className={styles.row}>
                {chip(t('plus.f.oneDay', {}), f.span === 1, () => pick({ span: 1 }))}
                {SPAN_CHOICES.map((n) => chip(spanText(n), f.span === n, () => pick({ span: n, time: null })))}
              </div>
            </>
          ) : null}
          {event ? null : <p className={styles.note}>{t('plus.f.noSpan', {})}</p>}
        </div>
      ) : null}
      <p className={styles.note}>{t(typed ? 'plus.f.auto' : 'plus.f.try', {})}</p>
    </div>
  );
}
