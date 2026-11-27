// 今日运势卡的底部弹层：详情、填生日
// 唯一参考：方案页 方案-八字-B.html 的 renderSheet() 和点击处理；参考里没有的一律不加
// • 外壳：kit Dialog（edge 贴底边整宽；进出场用 Dialog 的 sheet 从下往上弹出、原路滑回，backdrop="mist" 后面整页液态模糊；
//   锁焦点、Esc、inert、滚动锁、还焦点都在 Dialog 和层栈里，点遮罩关）。
//   标题和按钮同一行，所以不传 title，Setup、Detail 各自放 DialogTitle。关上时焦点先还打开它的元素，那个元素没了（清除生日以后卡片换成“填生日”）就还给 anchor
// • 详情：标题“本色 · 11月21日”+ ×；本色的一句白话；大星星；一句白话；工作、感情、财运、健康四项星星和短句；幸运色和数字；“改生日”；最下面小字“今天是你的××日 · 仅供娱乐…”
// • 填生日：头部“取消 / 你的生日 / 黄色确定”；年份是自己画的数字小键盘（不用系统日期框），打两位就够（92 → 1992），
//   打完键盘收起，出月、日、时三条横条（28 高小块、44 点按区，选中是深色块，放不下的日子变灰）；下面一行结果“1992年6月12日 · 不知道几点 / 你的本色：田园”；
//   填过的多一个“清除生日”；底部小字“生日会同步到你的账号，可随时清除 · 仅供娱乐”。没填过打开时键盘先弹出，填过的先收着、点年份再弹
// • 点年份重新打时显示清空、选的年份也一起清空（不会“显示空着、确定后存了旧年份”）；打满四位但不在 1901～今年，键盘提示那一行换成范围提示；
//   今天以后的月、日置灰，确定只认不晚于今天的日子
// • 写不进本机（切换账号中、本机库打不开）时弹层不关、选的保留（write.* 的调用方义务）；运行日志只记 fortune set / clear
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { daysIn, parseDate, type DateStr } from '../../../../shared/core/date.ts';
import { Dialog, DialogTitle } from '../../../kit/components/Dialog.tsx';
import {
  BIRTH_HOURS,
  BIRTH_MIN_YEAR,
  afterToday,
  fortuneWords,
  typedYear,
  type BirthValue,
  type FortuneLib,
  type Lang,
  type useFortuneBirth,
} from '../hooks/useFortuneBirth.ts';
import { useFortuneT, type FortuneT } from '../hooks/useFortuneT.ts';
import styles from './Fortune.module.css';

export type SheetKind = 'detail' | 'setup';

const STAR = 'M10 1.6l2.47 5.2 5.7.68-4.2 3.9 1.1 5.63L10 14.2l-5.07 2.8 1.1-5.63-4.2-3.9 5.7-.68z';

/** 五颗星，亮 n 颗；label 给了才对读屏有名字（卡片里整个按钮已有名字，不给） */
export function Stars({ n, label }: { n: number; label?: string }) {
  return (
    <span className={styles.stars} role={label === undefined ? undefined : 'img'} aria-label={label} aria-hidden={label === undefined ? true : undefined}>
      {[1, 2, 3, 4, 5].map((i) => (
        <svg key={i} viewBox="0 0 20 20" aria-hidden="true" className={i <= n ? styles.on : styles.off}>
          <path d={STAR} />
        </svg>
      ))}
    </span>
  );
}

const lumpOf = (i: number): string => styles[`k${i}`] ?? '';
const hourText = (t: FortuneT, h: number | null): string => (h === null ? t('fortune.hourUnknown', {}) : t('fortune.hour', { a: h, b: (h + 2) % 24 }));

type FB = ReturnType<typeof useFortuneBirth>;

/** 填写中的生日：年、月、日没选时是 null */
interface Draft {
  readonly y: number | null;
  readonly m: number | null;
  readonly d: number | null;
  readonly h: number | null;
}

function Cell({ on, label, aria, disabled, onPick, testId }: { on: boolean; label: ReactNode; aria?: string; disabled?: boolean; onPick: () => void; testId: string }) {
  return (
    <button type="button" className={styles.c} aria-pressed={on} aria-label={aria} disabled={disabled} onClick={onPick} data-testid={testId}>
      <span>{label}</span>
    </button>
  );
}

function Strip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.srow}>
      <span className={styles.lab}>{label}</span>
      <div className={styles.strip}>{children}</div>
    </div>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clr', '0', 'del'] as const;

function Setup({ fb, today, L, lib, onClose }: { fb: FB; today: DateStr; L: Lang; lib: FortuneLib | null; onClose: () => void }) {
  const t = useFortuneT();
  const now = parseDate(today);
  const filled = fb.birth !== null;
  const [draft, setDraft] = useState<Draft>(() => fb.birth ?? { y: null, m: null, d: null, h: null });
  const [kp, setKp] = useState(!filled);
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { y, m, d, h } = draft;
  const md = y !== null && m !== null ? daysIn(y, m) : 31;
  const monthOff = (v: number): boolean => y === now.y && v > now.m;
  const dayOff = (v: number): boolean => v > md || (y !== null && m !== null && afterToday(y, m, v, today));
  const ok = y !== null && m !== null && d !== null && d <= md && !afterToday(y, m, d, today);
  /** 打满四位、年份没定下来：不在 1901～今年 */
  const bad = kp && typed?.length === 4 && y === null;
  const pick = (p: Partial<Draft>): void => setDraft((x) => ({ ...x, ...p }));

  // 每次选了以后把横条里选中的那一块滚到中间（同参考 renderSheet 末尾）
  useLayoutEffect(() => {
    for (const st of box.current?.querySelectorAll<HTMLElement>(`.${styles.strip}`) ?? []) {
      const on = st.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (on) st.scrollLeft = on.offsetLeft - st.clientWidth / 2 + on.clientWidth / 2;
    }
  }, [draft, kp]);

  const key = (k: (typeof KEYS)[number]): void => {
    let ty = typed ?? '';
    if (k === 'del') ty = ty.slice(0, -1);
    else if (k === 'clr') ty = '';
    else if (ty.length < 4) ty += k;
    const r = typedYear(ty, now.y);
    setTyped(r.typed);
    if (r.year !== null) {
      pick({ y: r.year });
      setKp(false);
    }
  };
  const save = async (): Promise<void> => {
    if (!ok || busy || y === null || m === null || d === null) return;
    setBusy(true);
    const done = await fb.set({ y, m, d, h } satisfies BirthValue);
    setBusy(false);
    if (done) onClose();
  };
  const clear = async (): Promise<void> => {
    setBusy(true);
    const done = await fb.clear();
    setBusy(false);
    if (done) onClose();
  };

  const ty = typed ?? (y !== null ? String(y) : '');
  const dayStem = ok && lib && y !== null && m !== null && d !== null ? lib.baziOf({ y, m, d, h })?.at(2)?.[0] : undefined;
  const me = dayStem === undefined ? undefined : lib?.FORTUNE_ME.at(dayStem)?.at(L);
  return (
    <div className={styles.pk} ref={box} data-testid="fortune-setup">
      <div className={styles.hd}>
        <button type="button" className={styles.clr} onClick={onClose} data-testid="fortune-cancel">
          {t('fortune.cancel', {})}
        </button>
        <DialogTitle className={styles.mid}>{t('fortune.title', {})}</DialogTitle>
        <button type="button" className={styles.ok} disabled={!ok || busy} onClick={() => void save()} data-testid="fortune-ok">
          <span className={styles.okPill}>{t('fortune.ok', {})}</span>
        </button>
      </div>
      <div className={styles.srow}>
        <span className={styles.lab}>{t('fortune.y', {})}</span>
        <div className={styles.yRow}>
          <button
            type="button"
            className={`${styles.yIn} ${kp ? styles.cur : ''}`}
            aria-label={t('fortune.yearInput', {})}
            onClick={() => {
              setKp(true);
              setTyped('');
              pick({ y: null });
            }}
            data-testid="fortune-year"
          >
            {[0, 1, 2, 3].map((i) => (
              <i key={i} className={`${ty.charAt(i) ? '' : styles.ph} ${i === ty.length ? styles.next : ''}`}>
                {ty.charAt(i) || '·'}
              </i>
            ))}
          </button>
          {kp ? (
            <span className={styles.yTip} role={bad ? 'alert' : undefined} data-testid="fortune-ytip">
              {bad ? t('fortune.yearBad', { min: BIRTH_MIN_YEAR, max: now.y }) : t('fortune.kpTip', {})}
            </span>
          ) : null}
        </div>
      </div>
      {kp ? (
        <div className={styles.kp} data-testid="fortune-keypad">
          {KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={k.length > 1 ? styles.fn : undefined}
              aria-label={k === 'del' ? t('fortune.kpDel', {}) : undefined}
              // 手指一按下就算：前一个键没松手就按下一个、按下后手指挪了几 px，click 都不来，打字会卡。preventDefault 不抢焦点；
              // 键盘的 Enter / 空格走 click（detail 为 0），手点的 click（detail ≥ 1）已经在按下时算过，不再算一次
              onPointerDown={(e) => {
                e.preventDefault();
                key(k);
              }}
              onClick={(e) => {
                if (e.detail === 0) key(k);
              }}
              data-testid={`fortune-key-${k}`}
            >
              {k === 'clr' ? t('fortune.kpClear', {}) : k === 'del' ? '⌫' : k}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className={styles.hair} />
          <Strip label={t('fortune.m', {})}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((v) => (
              <Cell key={v} on={m === v} label={v} disabled={monthOff(v)} onPick={() => pick({ m: v })} testId={`fortune-m-${v}`} />
            ))}
          </Strip>
          <Strip label={t('fortune.d', {})}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((v) => (
              <Cell key={v} on={d === v} label={v} disabled={dayOff(v)} onPick={() => pick({ d: v })} testId={`fortune-d-${v}`} />
            ))}
          </Strip>
          <div className={styles.hair} />
          <Strip label={t('fortune.h', {})}>
            {BIRTH_HOURS.map((v) => (
              <Cell key={v ?? 'n'} on={h === v} label={hourText(t, v)} onPick={() => pick({ h: v })} testId={`fortune-h-${v ?? 'n'}`} />
            ))}
          </Strip>
        </>
      )}
      <div className={styles.res} aria-live="polite" data-testid="fortune-res">
        {ok ? (
          <>
            {t('fortune.resWhen', { y, m, d, h: h === null ? t('fortune.resHourUnknown', {}) : hourText(t, h) })}
            {me === undefined ? null : (
              <>
                <br />
                {t('fortune.resMe', {})}
                <b>{me}</b>
              </>
            )}
          </>
        ) : (
          t('fortune.pick', {})
        )}
      </div>
      {filled ? (
        <button type="button" className={styles.ghost} disabled={busy} onClick={() => void clear()} data-testid="fortune-clear">
          {t('fortune.clear', {})}
        </button>
      ) : null}
      <p className={styles.note}>{t('fortune.store', {})}</p>
    </div>
  );
}

function Detail({ birth, date, L, lib, onClose, onEdit }: { birth: BirthValue; date: DateStr; L: Lang; lib: FortuneLib; onClose: () => void; onEdit: () => void }) {
  const t = useFortuneT();
  const f = lib.fortuneOf(birth, date);
  if (f === null) return null;
  const { me, desc, tip, color } = fortuneWords(lib, f, L);
  const { m, d } = parseDate(date);
  return (
    <div data-testid="fortune-detail">
      <div className={styles.dHead}>
        <DialogTitle>{t('fortune.detailTitle', { me, m, d })}</DialogTitle>
        <button type="button" className={styles.x} aria-label={t('fortune.close', {})} onClick={onClose} data-testid="fortune-close">
          ×
        </button>
      </div>
      <p className={styles.dMe}>{t('fortune.meLine', { me, desc })}</p>
      <div className={styles.dTop}>
        <Stars n={f.stars} label={t('fortune.stars', { n: f.stars })} />
      </div>
      <p className={styles.dTip}>{tip}</p>
      {lib.FORTUNE_CATS.map((c, i) => {
        const cs = f.cats.at(i);
        const name = c.name.at(L) ?? '';
        return (
          <div key={name} className={styles.cat}>
            <b>{name}</b>
            <Stars n={cs?.stars ?? 3} label={t('fortune.catStars', { cat: name, n: cs?.stars ?? 3 })} />
            <span className={styles.cl}>{c.lines.at(cs?.line ?? 0)?.at(L)}</span>
          </div>
        );
      })}
      <div className={styles.luck}>
        <div>
          <span className={`${styles.big} ${lumpOf(f.color)}`} />
          <span>
            <small>{t('fortune.luckColor', {})}</small>
            {color}
          </span>
        </div>
        <div>
          <span className={styles.num}>{f.num}</span>
          <span>
            <small>{t('fortune.luckNum', {})}</small>
          </span>
        </div>
      </div>
      <button type="button" className={styles.ghost} onClick={onEdit} data-testid="fortune-edit">
        {t('fortune.edit', {})}
      </button>
      <p className={styles.foot}>{t('fortune.dayLine', { name: lib.FORTUNE_DAY_NAMES.at(f.day)?.at(L) ?? '' })}</p>
    </div>
  );
}

/** 弹层：kind 为 null 时关着。详情要等算法下载好（lib）；填生日不用等，结果行的“你的本色”下载好了才出。anchor：打开它的元素没了时把焦点还给谁 */
export function FortuneSheet({
  kind,
  onKind,
  date,
  today,
  L,
  fb,
  lib,
  anchor,
}: {
  kind: SheetKind | null;
  onKind: (k: SheetKind | null) => void;
  date: DateStr;
  today: DateStr;
  L: Lang;
  fb: FB;
  lib: FortuneLib | null;
  anchor: () => HTMLElement | null;
}) {
  const open = kind !== null && (kind === 'setup' || (lib !== null && fb.birth !== null));
  const close = (): void => onKind(null);
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : close())} edge backdrop="mist" lang={L === 1 ? 'ko' : 'zh-CN'} returnFocus={anchor}>
      <div className={styles.grip} aria-hidden="true" />
      {kind === 'setup' ? (
        <Setup fb={fb} today={today} L={L} lib={lib} onClose={close} />
      ) : kind === 'detail' && lib !== null && fb.birth !== null ? (
        <Detail birth={fb.birth} date={date} L={L} lib={lib} onClose={close} onEdit={() => onKind('setup')} />
      ) : null}
    </Dialog>
  );
}
