// kit 选择器：替换 iOS 默认的日期、时间框和下拉框。一周日期条 + 时、分两条横排；下拉单选是折行的小胶囊。
// 四种用法，一套外观：
//   • DateTimeField mode="date" / "time" / "datetime"：编辑页的值按钮（看得见 32 高、点按区 44），点了在这一行下面就地展开选择器，
//     “确定”才交（onDone）；能清空的格子（onClear）左上角多一个灰字“清空”；hint 给提示行（bad 时“确定”变灰、提示红字）
//   • Select：代替原生下拉框（iOS 系统菜单），点一下选中就收起，不用“确定”
//   • OptionPick：只有选项那一块（随手记分类、下拉搜索范围放进 kit 的 Popover 里用，见 PickPopover.tsx）
//   • DateTimePick：只有选择器那一块，不带值按钮和展开格（给“＋”面板这类自己定位置的地方：mode、label、date / time、onDone、onClear 照传）
// 外观（28 高的小块、44 点按区、选中色、今天色）见 Pick.module.css 文件头。一周从哪天排起跟日历设置 cal.week_start 走（kit/hooks/usePick.ts）。
// 读屏和键盘：日、时、分、选项各是一组 radiogroup，格子是 radio + aria-checked；一组里只有一个能 Tab 到（选中的那个，
//   没有就第一个能选的），方向键在组里挪焦点，空格 / 回车选中；日期格的读屏名带“今天”。
// 收起和焦点：展开的那一块是层栈里的非模态层（kit/hooks/useLayer.ts），Esc 只收起它（在详情抽屉里也只收它、抽屉不关）；
//   Esc、确定、清空、选中收起时焦点还给打开它的那个按钮（日期 + 时刻两个按钮，点哪个还哪个）；点了别的格子、外面的值变了（直接收起）不抢焦点。
// 跳月：周条上面的“X 月”标题是按钮（aria-expanded），点了周条那一行换成月份列表（下拉单选同款小胶囊），
//   点某月跳到含那个月 1 号的那一周、列表收起（草稿日期不动，还要点一天）；范围按 min / max，没给就往前 12、往后 24 个月（pick-logic.ts 的 monthSpan）。
//   没有动画；运行日志记“pick months open|close”和“pick month jump d=跳了几个月”，不记日子
// 日期滑条：日期一行和时、分一样横排左右滑，一屏 7 天，排满月份列表的整个范围；
//   最左那天就是标题、‹ ›（挪 7 天）、跳月共用的 first，手滑停到哪天标题跟到哪天。
// 规则（周、范围、分钟格、月份列表）在 pick-logic.ts；编辑页字段行的展开格、同一组只开一个由 Form.tsx 的 PickArea 给
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { weekdayOf } from '../../../../shared/core/date.ts';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { nextFrame } from '../../../motion/index.ts';
import { useLayer } from '../../hooks/useLayer.ts';
import { pickLog, usePickT, usePickToday, usePickWeekStart } from '../../hooks/usePick.ts';
import { useUi } from '../../state/ui-store.ts';
import { useFieldSlot, usePickScope } from '../Form.tsx';
import {
  dayRange, draftOf, HOURS, minutesOf, monthDiff, monthJump, monthOfWeek, monthSpan, outOfRange, weekArrows, weekOf, withHour, withMinute, type PickMode, type PickValue,
} from './pick-logic.ts';
import { weekSpan } from '../../../../shared/logic/calendar/week-view.ts';
import s from './Pick.module.css';

export type { PickMode, PickValue } from './pick-logic.ts';

/** 提示行：bad 为真时红字、“确定”变灰（免打扰“从”“到”一样、日程超过最长天数） */
export interface PickHint {
  text: string;
  bad?: boolean;
}

/** 开着没有：在 FormGroup / PickArea 里同一组只开一个，不在就各管各的 */
export function usePickOpen(): { id: string; open: boolean; toggle(): void; close(): void } {
  const id = useId();
  const scope = usePickScope();
  const [own, setOwn] = useState(false);
  const open = scope ? scope.open === id : own;
  const set = (o: boolean): void => {
    if (scope) scope.setOpen(o ? id : scope.open === id ? null : scope.open);
    else setOwn(o);
  };
  return { id, open, toggle: () => set(!open), close: () => set(false) };
}

/** 值按钮 + 展开的那一块：记下是哪个按钮打开的；done() 收起并把焦点还给它，drop() 只收起（外面的值变了） */
function usePickPanel(key: string) {
  const pk = usePickOpen();
  const by = useRef<HTMLElement | null>(null);
  const ret = useRef(false);
  const seen = useRef(key);
  // 开着的时候外面的值变了（别处改了、同步进来），草稿已经对不上，直接收起
  useEffect(() => {
    if (seen.current === key) return;
    seen.current = key;
    if (pk.open) {
      ret.current = false;
      pk.close();
    }
  });
  return {
    id: pk.id,
    open: pk.open,
    toggle(e: MouseEvent<HTMLElement>): void {
      by.current = e.currentTarget;
      ret.current = false;
      pk.toggle();
    },
    done(): void {
      ret.current = true;
      pk.close();
    },
    back: (): (HTMLElement | null)[] => (ret.current ? [by.current] : []),
  };
}

const ARL = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M10 3L5 8l5 5" />
  </svg>
);
const ARR = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 3l5 5-5 5" />
  </svg>
);

/** 一组里哪一格能 Tab 到：选中的那格，没有（这一周里没有草稿那天）就第一个能选的 */
function tabIndexOf(cells: readonly { on: boolean; disabled?: boolean | undefined }[]): number {
  const i = cells.findIndex((c) => c.on && !c.disabled);
  return i >= 0 ? i : cells.findIndex((c) => !c.disabled);
}

/** 方向键在一组 radio 里挪焦点（不选中，空格 / 回车才选：下拉选中就收起，挪一下就收不合适） */
function rove(e: KeyboardEvent<HTMLElement>): void {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (step === 0) return;
  const xs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
  const i = xs.indexOf(document.activeElement as HTMLButtonElement);
  const next = xs[Math.max(0, Math.min(xs.length - 1, (i < 0 ? 0 : i) + step))];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/** 一组单选（日、时、分、选项） */
function Radios({ id, label, className, children, boxRef, onScroll, onUser, first }: {
  id?: string;
  label: string;
  className: string | undefined;
  children: ReactNode;
  boxRef?: Ref<HTMLDivElement>;
  onScroll?(): void;
  /** 手碰到这一条（按下、滚轮）：日期滑条用来停掉“等 ‹ › 滚到位” */
  onUser?(): void;
  /** 日期滑条最左看得见的那天（测试按它找看得见的 7 天） */
  first?: string;
}) {
  return (
    // 组本身不进 Tab 顺序（tabIndex -1）：Tab 停在组里能 Tab 到的那一格，方向键冒上来在这里接
    <div ref={boxRef} id={id} className={className} role="radiogroup" aria-label={label} tabIndex={-1} onKeyDown={rove} onScroll={onScroll} onPointerDown={onUser} onWheel={onUser} onTouchStart={onUser} data-first={first}>
      {children}
    </div>
  );
}

/** 一个可点的小块：按钮是 44 的透明点按区，里面的 span 才是看得见的 28 小块 */
function Cell(p: {
  on: boolean;
  /** 组里能 Tab 到的那一格 */
  tab: boolean;
  today?: boolean | undefined;
  disabled?: boolean | undefined;
  label?: string | undefined;
  onClick(): void;
  children: ReactNode;
  className?: string | undefined;
  testId?: string | undefined;
  /** 这一格的值（'YYYY-MM-DD'、'h15'、'm30'、月份 'ym2027-02'、选项的值）：e2e 按它点（tests/e2e/pick-helpers.ts），不靠随语言变的读屏名 */
  v?: string | undefined;
}) {
  return (
    <button
      type="button"
      role="radio"
      className={p.className ? `${s.c} ${p.className}` : s.c}
      data-on={p.on || undefined}
      data-today={p.today || undefined}
      data-v={p.v}
      aria-checked={p.on}
      aria-label={p.label}
      tabIndex={p.tab ? 0 : -1}
      disabled={p.disabled}
      onClick={p.onClick}
      data-testid={p.testId}
    >
      {p.children}
    </button>
  );
}

/** 时、分那一条：横排、左右滑；打开时把选中的那块滚到中间（点了别的不跳回） */
function Strip({ label, values, on, name, prefix, onPick }: { label: string; values: readonly string[]; on: string; name(v: string): string; prefix: string; onPick(v: string): void }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const cur = el?.querySelector<HTMLElement>('[data-on]');
    if (el && cur) el.scrollLeft = cur.offsetLeft - el.clientWidth / 2 + cur.offsetWidth / 2;
  }, []);
  const tab = tabIndexOf(values.map((v) => ({ on: v === on })));
  return (
    <div className={s.srow}>
      <span className={s.lab} aria-hidden="true">
        {label}
      </span>
      <Radios boxRef={box} className={s.strip} label={label}>
        {values.map((v, i) => (
          <Cell key={v} v={`${prefix}${v}`} on={v === on} tab={i === tab} label={name(v)} onClick={() => onPick(v)}>
            <span className={s.face}>{v}</span>
          </Cell>
        ))}
      </Radios>
    </div>
  );
}

/** 月份列表（点周标题弹出）：外观照下拉单选的小胶囊（.opts .opt，多了就上下滚），每年前面一行小字年份；
 *  一组 radiogroup，方向键挪、空格 / 回车选；是层栈里的非模态层，Esc 只收起它，收起时焦点还给标题 */
function MonthList(p: { id: string; months: readonly string[]; on: string; today: string; onPick(ym: string): void; onEsc(): void; back(): (HTMLElement | null)[] }) {
  const t = usePickT();
  const box = useRef<HTMLDivElement>(null);
  useLayer(true, { name: 'pick-months', el: () => box.current, onEsc: p.onEsc, back: p.back });
  // 打开时把正在看的那一年的年份小字滚到顶（滚到正中会把上一年的年份行切一半）
  const [openYear] = useState(() => p.on.slice(0, 4));
  useLayoutEffect(() => {
    const el = box.current;
    const yr = el?.querySelector<HTMLElement>(`[data-y="${openYear}"]`);
    if (el && yr) el.scrollTop = yr.offsetTop;
  }, [openYear]);
  const tab = tabIndexOf(p.months.map((ym) => ({ on: ym === p.on })));
  return (
    <Radios id={p.id} boxRef={box} className={`${s.opts} ${s.many}`} label={t('pick.months', {})}>
      {p.months.map((ym, i) => {
        const y = Number(ym.slice(0, 4));
        const m = Number(ym.slice(5, 7));
        return (
          <Fragment key={ym}>
            {i === 0 || m === 1 ? (
              <span className={`${s.lab} ${s.yr}`} data-y={y} aria-hidden="true">
                {t('pick.y', { y })}
              </span>
            ) : null}
            <Cell v={`ym${ym}`} className={s.opt} on={ym === p.on} today={ym === p.today} tab={i === tab} label={t('pick.ym', { y, m })} onClick={() => p.onPick(ym)}>
              <span className={s.face}>{t('pick.m', { m })}</span>
            </Cell>
          </Fragment>
        );
      })}
    </Radios>
  );
}

export interface DateTimePickProps {
  mode: PickMode;
  /** 只选时刻时写在头部中间；也是这一块的读屏名称 */
  label: string;
  /** 打开时的值（没值的日期用今天、时刻用 9:00） */
  date?: string | null | undefined;
  time?: string | null | undefined;
  /** 能选的日期范围（含当天；范围外灰掉、周箭头到边禁用，草稿日期在范围外时“确定”变灰） */
  min?: string | undefined;
  max?: string | undefined;
  onDone(v: PickValue): void;
  /** 能清空的格子才给：左上角灰字“清空” */
  onClear?: (() => void) | undefined;
  hint?: ((v: PickValue) => PickHint | null) | undefined;
  testId?: string | undefined;
}

/** 选择器本体（头部 + 周条 + 时、分两条 + 提示行） */
export function DateTimePick(p: DateTimePickProps) {
  const t = usePickT();
  const locale = useUi((u) => u.locale);
  const today = usePickToday();
  const weekStart = usePickWeekStart();
  const [draft, setDraft] = useState<PickValue>(() => draftOf(p.date, p.time, today));
  const [first, setFirst] = useState(() => weekOf(draft.date, weekStart));
  const hasDate = p.mode !== 'time';
  const hasTime = p.mode !== 'date';
  const hint = p.hint?.(draft) ?? null;
  // 草稿日期在 min～max 外（原来的值已经不在范围里）“确定”变灰，要先点一个能选的日子
  const bad = hint?.bad === true || (hasDate && outOfRange(draft.date, p.min, p.max));
  const [hh = '', mm = ''] = draft.time.split(':');
  // 标题是按钮，点了周条那一行换成月份列表，点某月跳到那个月第一周
  const [months, setMonths] = useState(false);
  // 日期一行是和时、分一样的横排滑条，一屏 7 天。first = 滑条最左边看得见的那天：标题写它起的 7 天，‹ › 挪 7 天、跳月都是改 first 再滚过去；手滑时把滚到最左的那天写回 first
  const [span] = useState(() => monthSpan(first, today, draft.date, p.min, p.max));
  const range = useMemo(() => dayRange(span, weekStart), [span, weekStart]);
  const fi = Math.max(0, range.indexOf(first));
  const last = Math.max(0, range.length - 7);
  const wa = weekArrows(first, p.min, p.max);
  const arrows = { prev: wa.prev && fi > 0, next: wa.next && fi < last };
  const title = weekSpan(first);   // 同一个月写“年 + 月”；跨两个月写“月–月”；跨年那一周两头都带年份
  const wd = t('pick.wd', {});
  const strip = useRef<HTMLDivElement>(null);
  const byHand = useRef(false);
  const smooth = useRef(false);
  const raf = useRef<() => void>(() => undefined);
  // ‹ › 平滑滚动途中的滚动事件不算手滑（不然连点 › 时中途的位置会被写回 first、下一次从半路算）；滚到了或手一碰就不再等
  const aim = useRef<number | null>(null);
  const step = (n: number): void => {
    smooth.current = true;
    setFirst(range[Math.min(last, Math.max(0, fi + 7 * n))] ?? first);
  };
  const onScroll = (): void => {
    raf.current();
    raf.current = nextFrame(() => {
      const el = strip.current;
      if (el && aim.current !== null) {
        if (Math.abs(el.scrollLeft - aim.current) > 1) return;
        aim.current = null;
      }
      const w = el ? el.clientWidth / 7 : 0;
      const d = el && w > 0 ? range[Math.min(last, Math.round(el.scrollLeft / w))] : undefined;
      if (d === undefined || d === first) return;
      byHand.current = true;
      setFirst(d);
    });
  };
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  useEffect(() => () => raf.current(), []);
  // first 不是手滑改的（打开、‹ ›、跳月、月份列表收起后滑条重新出来）就把那天滚到最左；‹ › 平滑滚，别的直接到位
  useLayoutEffect(() => {
    const el = strip.current;
    const c = el?.children[fi] as HTMLElement | undefined;
    if (byHand.current) byHand.current = false;
    else if (el && c) {
      const left = c.offsetLeft - (el.firstElementChild as HTMLElement).offsetLeft;
      aim.current = smooth.current && Math.abs(el.scrollLeft - left) > 1 ? left : null;
      // 兜底：平滑滚动被打断、没滚到位，过一会儿不再等，按实际位置把 first 对回来
      if (aim.current !== null) {
        window.setTimeout(() => {
          aim.current = null;
          onScrollRef.current();
        }, 700);
      }
      if (typeof el.scrollTo === 'function') el.scrollTo({ left, behavior: smooth.current ? 'smooth' : 'auto' });
      else el.scrollLeft = left;
    }
    smooth.current = false;
  }, [fi, months]);
  const days = useMemo(
    () => range.map((d) => ({ d, on: d === draft.date, disabled: outOfRange(d, p.min, p.max) })),
    [range, draft.date, p.min, p.max],
  );
  // 能 Tab 到的那一格照旧按看得见的 7 天算：草稿那天在这 7 天里就是它，不在就是这 7 天里第一个能选的
  const wt = tabIndexOf(days.slice(fi, fi + 7));
  const dayTab = wt >= 0 ? fi + wt : tabIndexOf(days);
  const titleBtn = useRef<HTMLButtonElement>(null);
  const listId = `${useId()}-months`;
  const toggleMonths = (): void => {
    pickLog(`pick months ${months ? 'close' : 'open'}`);
    setMonths(!months);
  };
  const jump = (ym: string): void => {
    pickLog(`pick month jump d=${monthDiff(monthOfWeek(first), ym)}`);
    setFirst(monthJump(ym, weekStart, p.min));
    setMonths(false);
  };

  const mid = hasDate ? (
    <>
      <button type="button" className={s.arr} aria-label={t('pick.prevWeek', {})} disabled={!arrows.prev} onClick={() => step(-1)} data-testid="pick-prev">
        {ARL}
      </button>
      <button
        ref={titleBtn}
        type="button"
        className={`${s.title} ${s.tbtn}`}
        aria-expanded={months}
        aria-controls={months ? listId : undefined}
        onClick={toggleMonths}
        data-testid="pick-title"
      >
        {title.kind === 'same' ? t('pick.ym', { y: title.y1, m: title.m1 }) : title.kind === 'year' ? t('pick.yy', { ya: title.y1, a: title.m1, yb: title.y2, b: title.m2 }) : t('pick.mm', { a: title.m1, b: title.m2 })}
      </button>
      <button type="button" className={s.arr} aria-label={t('pick.nextWeek', {})} disabled={!arrows.next} onClick={() => step(1)} data-testid="pick-next">
        {ARR}
      </button>
    </>
  ) : (
    <span className={s.title}>{p.label}</span>
  );

  return (
    <div className={s.pk} data-testid={p.testId}>
      <div className={s.hd}>
        {p.onClear ? (
          <button type="button" className={s.clr} onClick={p.onClear} data-testid="pick-clear">
            {t('pick.clear', {})}
          </button>
        ) : (
          <span />
        )}
        <div className={s.mid}>{mid}</div>
        <button type="button" className={s.ok} disabled={bad} onClick={() => p.onDone(draft)} data-testid="pick-ok">
          <span className={s.okFace}>{t('pick.ok', {})}</span>
        </button>
      </div>
      {hasDate && months ? (
        <MonthList
          id={listId}
          months={span}
          on={monthOfWeek(first)}
          today={today.slice(0, 7)}
          onPick={jump}
          onEsc={() => setMonths(false)}
          back={() => [titleBtn.current]}
        />
      ) : hasDate ? (
        <Radios boxRef={strip} className={s.week} label={p.label} onScroll={onScroll} onUser={() => (aim.current = null)} first={first}>
          {days.map(({ d, on, disabled }, i) => (
            <Cell
              key={d}
              v={d}
              className={s.day}
              on={on}
              tab={i === dayTab}
              today={d === today}
              disabled={disabled}
              label={d === today ? `${fmtDay(d, locale, 'monthDayWeek')} ${t('pick.today', {})}` : fmtDay(d, locale, 'monthDayWeek')}
              onClick={() => setDraft((v) => ({ ...v, date: d }))}
            >
              <i aria-hidden="true">{wd[weekdayOf(d)]}</i>
              <span className={s.face}>{Number(d.slice(8))}</span>
            </Cell>
          ))}
        </Radios>
      ) : null}
      {hasTime ? (
        <>
          {hasDate ? <div className={s.hair} /> : null}
          <Strip label={t('pick.hour', {})} values={HOURS} on={hh} prefix="h" name={(h) => t('pick.hourName', { h })} onPick={(h) => setDraft((x) => ({ ...x, time: withHour(x.time, h) }))} />
          <Strip label={t('pick.minute', {})} values={minutesOf(mm)} on={mm} prefix="m" name={(m) => t('pick.minuteName', { m })} onPick={(m) => setDraft((x) => ({ ...x, time: withMinute(x.time, m) }))} />
        </>
      ) : null}
      <p className={s.hint} data-bad={hint?.bad || undefined} aria-live="polite" data-testid="pick-hint">
        {hint?.text ?? ''}
      </p>
    </div>
  );
}

export interface OptionPickProps {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onPick(v: string): void;
  testId?: string | undefined;
}

/** 下拉单选那一块：头部写名字（没有“清空”“确定”），选项是折行的小胶囊，点一下就选（收不收起由用的地方定） */
export function OptionPick({ label, value, options, onPick, testId }: OptionPickProps) {
  const box = useRef<HTMLDivElement>(null);
  const many = options.length > 12;
  useLayoutEffect(() => {
    const el = box.current;
    const on = el?.querySelector<HTMLElement>('[data-on]');
    if (many && el && on) el.scrollTop = on.offsetTop - el.clientHeight / 2 + on.offsetHeight / 2;
  }, [many]);
  const tab = tabIndexOf(options.map((o) => ({ on: o.value === value })));
  return (
    <div className={s.pk} data-testid={testId}>
      <div className={s.hd}>
        <span />
        <div className={s.mid}>
          <span className={s.title}>{label}</span>
        </div>
        <span />
      </div>
      <Radios boxRef={box} className={many ? `${s.opts} ${s.many}` : s.opts} label={label}>
        {options.map((o, i) => (
          <Cell key={o.value} v={o.value} className={s.opt} on={o.value === value} tab={i === tab} onClick={() => onPick(o.value)} testId={testId ? `${testId}-${o.value}` : undefined}>
            <span className={s.face}>{o.label}</span>
          </Cell>
        ))}
      </Radios>
    </div>
  );
}

/** 编辑页里的值按钮：看得见 32 高的浅底块，点按区 44；开着时描一圈细边，没值时字淡一档 */
export function PickButton(p: {
  open: boolean;
  empty?: boolean;
  label: string;
  controls: string;
  disabled?: boolean | undefined;
  onClick(e: MouseEvent<HTMLButtonElement>): void;
  testId?: string | undefined;
  /** 现在的值（'YYYY-MM-DD'、'HH:MM'、选项的值；没值为空串）：e2e、运行日志按它认，不靠随语言变的显示字 */
  value: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={s.fb}
      data-value={p.value}
      data-on={p.open || undefined}
      data-empty={p.empty || undefined}
      aria-expanded={p.open}
      aria-controls={p.open ? p.controls : undefined}
      aria-label={p.label}
      disabled={p.disabled}
      onClick={p.onClick}
      data-testid={p.testId}
    >
      <span className={s.fbFace}>{p.children}</span>
    </button>
  );
}

/** 值按钮旁边的灰字小按钮（待办截止日、截止时刻后面的“清掉”；是灰字，不是胶囊） */
export function PickTextButton(p: { onClick(): void; disabled?: boolean | undefined; testId?: string | undefined; children: ReactNode }) {
  return (
    <button type="button" className={s.txt} onClick={p.onClick} disabled={p.disabled} data-testid={p.testId}>
      {p.children}
    </button>
  );
}

/** 就地展开的那一格：在 PickArea 里就画进行下面的展开格（整行宽），不在就画在自己后面；挂着时是层栈里的非模态层（Esc 只收它） */
function Panel({ id, label, children, onEsc, back }: { id: string; label: string; children: ReactNode; onEsc(): void; back(): (HTMLElement | null)[] }) {
  const f = useFieldSlot();
  const box = useRef<HTMLDivElement>(null);
  useLayer(true, { name: 'pick', el: () => box.current, onEsc, back });
  const el = (
    <div ref={box} id={id} className={s.panel} role="group" aria-label={label}>
      {children}
    </div>
  );
  return f?.slot ? createPortal(el, f.slot) : el;
}

export interface DateTimeFieldProps extends Omit<DateTimePickProps, 'label' | 'onDone' | 'testId'> {
  /** 读屏、头部用的名字；不给用所在字段行的行名 */
  label?: string | undefined;
  /** 日期 + 时刻时，时刻那个按钮的读屏名字（如“开始时刻”） */
  timeLabel?: string | undefined;
  disabled?: boolean | undefined;
  onDone(v: PickValue): void;
  /** 两个按钮的 data-testid */
  testIds?: { date?: string | undefined; time?: string | undefined; panel?: string | undefined } | undefined;
}

/** 编辑页的日期 / 时刻格子：值按钮（日期 + 时刻是两个按钮，点哪个都打开同一个选择器）+ 就地展开 */
export function DateTimeField(p: DateTimeFieldProps) {
  const t = usePickT();
  const locale = useUi((u) => u.locale);
  const slot = useFieldSlot();
  const pk = usePickPanel(`${p.date ?? ''}|${p.time ?? ''}`);
  const label = p.label ?? slot?.label ?? '';
  const panelId = `${pk.id}-pk`;
  const dateText = p.date ? fmtDay(p.date, locale, 'monthDayWeek') : t('pick.date', {});
  const timeText = p.time || t('pick.time', {});
  return (
    <>
      {p.mode !== 'time' ? (
        <PickButton open={pk.open} empty={!p.date} value={p.date ?? ''} label={`${label} ${dateText}`} controls={panelId} disabled={p.disabled} onClick={pk.toggle} testId={p.testIds?.date}>
          {dateText}
        </PickButton>
      ) : null}
      {p.mode !== 'date' ? (
        <PickButton
          open={pk.open}
          empty={!p.time}
          value={p.time ?? ''}
          label={`${p.mode === 'datetime' ? (p.timeLabel ?? label) : label} ${timeText}`}
          controls={panelId}
          disabled={p.disabled}
          onClick={pk.toggle}
          testId={p.testIds?.time}
        >
          {timeText}
        </PickButton>
      ) : null}
      {pk.open && !p.disabled ? (
        <Panel id={panelId} label={label} onEsc={pk.done} back={pk.back}>
          <DateTimePick
            mode={p.mode}
            label={label}
            date={p.date}
            time={p.time}
            min={p.min}
            max={p.max}
            hint={p.hint}
            testId={p.testIds?.panel}
            onClear={
              p.onClear
                ? () => {
                    p.onClear?.();
                    pk.done();
                  }
                : undefined
            }
            onDone={(v) => {
              p.onDone(v);
              pk.done();
            }}
          />
        </Panel>
      ) : null}
    </>
  );
}

export interface SelectProps {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange(v: string): void;
  disabled?: boolean | undefined;
  /** 头部、读屏用的名字；不给用所在字段行的行名 */
  label?: string | undefined;
  'data-testid'?: string | undefined;
}

/** 下拉（原 kit Form.tsx 的原生 select）：值按钮 + 就地展开的小胶囊，点一下选中就收起 */
export function Select({ value, options, onChange, disabled, label: own, 'data-testid': testId }: SelectProps) {
  const slot = useFieldSlot();
  const pk = usePickPanel(value);
  const label = own ?? slot?.label ?? '';
  const cur = options.find((o) => o.value === value)?.label ?? value;
  const panelId = `${pk.id}-pk`;
  return (
    <>
      <PickButton open={pk.open} value={value} label={`${label} ${cur}`} controls={panelId} disabled={disabled} onClick={pk.toggle} testId={testId}>
        {cur}
      </PickButton>
      {pk.open && !disabled ? (
        <Panel id={panelId} label={label} onEsc={pk.done} back={pk.back}>
          <OptionPick
            label={label}
            value={value}
            options={options}
            testId={testId ? `${testId}-opts` : undefined}
            onPick={(v) => {
              pk.done();
              if (v !== value) onChange(v);
            }}
          />
        </Panel>
      ) : null}
    </>
  );
}
