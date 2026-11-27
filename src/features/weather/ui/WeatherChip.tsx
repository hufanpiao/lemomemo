// 今天页的天气胶囊（负责人 11-26 选“方向4 胶囊”，样图 本机资料/01-设计方案/2026-11-26_今天页天气/4-胶囊_*.png、5-没定位权限_*.png）
// • 有天气：一行写完“图标 3° 7°/-2° | 提示图标 15点有雨 ›”；后半句永远只有一条提示（shared/logic/weather/tips.ts 的 13 种按先后取第一条）；
//   整个胶囊（含 ›）点了开半屏逐时（WeatherSheet，按需下载）；取不到新的、显示旧的时在 › 前写取到的时刻
// • 没地方可看（没手动城市、也没定位过）：浅色小胶囊“设置城市看天气 ›”，点了去 设置 › 天气（那里点“用当前位置”才问定位）
// • 放哪：手机的有天气胶囊在日期下面、“现在”卡上面（slot below）；手机的“设置城市看天气”在日期那一行、头像左边（slot head，照 5-没定位权限_手机.png）；
//   宽屏都在页头右边（slot desk）。同一份状态，这几处各挂一个，只画归自己那一处的
// • 外形挂 kit 胶囊（Chip.module.css .chip，同纪念日一行），自己只管间距、颜色、宽屏小一号
import { lazy, Suspense, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { skyOf } from '../../../../shared/logic/weather/tips.ts';
import { navigate } from '../../../app/router.ts';
import chip from '../../../kit/components/Chip.module.css';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { eachFrame, Pressable } from '../../../motion/components.ts';
import { deg, hhmm, useTipText, useWeatherNow, useWeatherT, useWeatherView, weatherState } from '../hooks/useWeather.ts';
import { PinIcon, SkyIcon, TipIcon } from './WeatherIcon.tsx';
import styles from './Weather.module.css';

const WeatherSheet = lazy(() => import('./WeatherSheet.tsx'));

export type WeatherSlot = 'head' | 'below' | 'desk';

/** 等不到样式也照样画（样式表下失败时不至于一直不出） */
const STYLE_WAIT_MS = 3000;
/** 这一包的样式已经生效过（生效了就一直在，后面再挂的胶囊不用再等） */
let styleApplied = false;

/**
 * 胶囊这一包的样式真的生效了才画胶囊：WebKit 里分包的样式表下好了（Vite 等到 link 的 load 才交出这一包），
 * 但只要页面上还有别的样式表在下，就要等它们都到齐才一起生效（11-26 逐帧记录：别的样式表晚 400ms 到时，8 次里 7 次日期被没样式的
 * 15px 按钮挤成两行约 0.2～0.3 秒，有天气的胶囊 4 次以没样式的样子出现最长约 1 秒）。
 * 做法：先只放一个藏着的哨兵 span（Weather.module.css 的 .probe 带 --wx-ready: 1），每帧读它的计算样式，读到 1 才画胶囊（等不到 3 秒后照样画）；
 * 第一次在 useLayoutEffect 里读，样式早已生效（Chromium、第二次挂）时当帧就画，不晚一帧
 */
function useStyleApplied(): { ready: boolean; probe: ReactElement } {
  const ref = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(styleApplied);
  useLayoutEffect(() => {
    if (ready) return undefined;
    const t0 = performance.now();
    const check = (): void => {
      const el = ref.current;
      if (el && getComputedStyle(el).getPropertyValue('--wx-ready').trim() === '1') styleApplied = true;
      if (styleApplied || performance.now() - t0 > STYLE_WAIT_MS) setReady(true);
    };
    check();
    // 没生效就每帧再读（motion 的 eachFrame）；setReady(true) 后重画，这里的清理把循环停掉
    return eachFrame(check);
  }, [ready]);
  return { ready, probe: <span ref={ref} className={styles.probe} hidden /> };
}

/**
 * 手机页头那颗“设置城市看天气”放不下整句时只留定位图标（负责人 11-26 弹窗选“小屏只留定位图标”；375 宽中文只剩“设…”）。
 * 量法：这一行（TodayPage 的 .head）的宽减去日期、头像和间距，是留给这颗的；整句的宽在没收起时量（按钮宽 + 字被截掉的那段）存下，
 * 收起以后拿它比，宽了再放回（转屏）。日期、头像的宽不随这颗变，不会来回跳；日期字体晚到变宽也盯着（ResizeObserver 看整行和每个兄弟）
 */
function useNudgeCompact(on: boolean): [(el: HTMLSpanElement | null) => void, boolean] {
  const [label, setLabel] = useState<HTMLSpanElement | null>(null);
  const [compact, setCompact] = useState(false);
  const full = useRef(0);
  useLayoutEffect(() => {
    const btn = label?.parentElement;
    const row = btn?.parentElement;
    if (!on || !label || !btn || !row) return undefined;
    const others = [...row.children].filter((c): c is HTMLElement => c !== btn && c instanceof HTMLElement);
    const measure = (): void => {
      if (!label.hidden) full.current = btn.offsetWidth + label.scrollWidth - label.clientWidth;
      const shown = others.filter((c) => c.getClientRects().length > 0);
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const right = parseFloat(getComputedStyle(btn).marginRight) || 0;
      const free = row.clientWidth - shown.reduce((s, c) => s + c.offsetWidth, 0) - gap * shown.length - right;
      setCompact(full.current > free + 0.5);
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [row, ...others]) ro.observe(el);
    return () => ro.disconnect();
  }, [on, label]);
  return [setLabel, compact];
}

export default function WeatherChip({ slot }: { slot: WeatherSlot }) {
  const applied = useStyleApplied();
  const t = useWeatherT();
  const tipText = useTipText();
  const view = useWeatherView();
  const w = useWeatherNow(view);
  const [open, setOpen] = useState(false);
  const [labelRef, compact] = useNudgeCompact(slot === 'head' && view.kind === 'nudge');
  if (!applied.ready) return applied.probe;
  if (view.kind === 'nudge') {
    if (slot === 'below') return null;
    return (
      <Pressable
        type="button"
        className={`${chip.chip} ${styles.nudge}`}
        data-slot={slot}
        onClick={() => {
          weatherState.nudgeTapped();
          void navigate('settings', 'weather');
        }}
        data-testid="weather-nudge"
        data-compact={compact ? '' : undefined}
        aria-label={compact ? t('weather.nudge', {}) : undefined}
      >
        <PinIcon size={16} className={styles.pin} />
        <span ref={labelRef} className={styles.ell} hidden={compact}>
          {t('weather.nudge', {})}
        </span>
        <span className={styles.gt} aria-hidden="true" hidden={compact}>
          ›
        </span>
      </Pressable>
    );
  }
  if (view.kind !== 'show' || !w || slot === 'head') return null;
  const { cur } = view.pack;
  return (
    <>
      <Pressable
        type="button"
        className={`${chip.chip} ${styles.chip}`}
        data-slot={slot}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        data-testid="weather-chip"
        data-tip={w.tip.kind}
      >
        <SkyIcon sky={skyOf(cur.c, cur.d)} className={styles.sky} />
        <span className={styles.now}>{deg(cur.t)}°</span>
        <span className={styles.hiLo}>
          {deg(w.hi)}°/{deg(w.lo)}°
        </span>
        <span className={styles.bar} aria-hidden="true" />
        <TipIcon kind={w.tip.kind} className={styles.tipIcon} />
        <span className={styles.ell} data-testid="weather-tip">
          {tipText(w.tip)}
        </span>
        {view.stale ? (
          <span className={styles.stale} data-testid="weather-stale">
            {t('weather.chip.stale', { t: hhmm(view.at) })}
          </span>
        ) : null}
        <span className={styles.gt} aria-hidden="true">›</span>
      </Pressable>
      {open ? (
        <QuietBoundary name="weather-sheet">
          <Suspense fallback={null}>
            <WeatherSheet onClose={() => setOpen(false)} />
          </Suspense>
        </QuietBoundary>
      ) : null}
    </>
  );
}
