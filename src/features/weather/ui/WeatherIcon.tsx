// 天气的线条图标：天空 9 种、提示 13 种、定位针。和 App 现有线条图标同一套画法（kit TrashLink 等：viewBox 24、currentColor、
// 线宽 1.7、圆头圆角、不填色）；读屏不念（旁边有字）
// 提示图标的形状和颜色照 本机资料/01-设计方案/2026-11-26_今天页天气/13种提示预览.png（颜色在 WeatherIcon.module.css）
import type { WxSky, WxTipKind } from '../../../../shared/logic/weather/tips.ts';
import styles from './WeatherIcon.module.css';

const CLOUD = 'M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 11.1 3.5 3.5 0 0 0 7 18z';
const CLOUD_UP = 'M7 15h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 8.1 3.5 3.5 0 0 0 7 15z';
const CLOUD_SMALL = 'M9.5 19.5h8a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.4 1.1A3 3 0 0 0 9.5 19.5z';
const SUN = 'M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4';
const MOON = 'M19.5 14.5A7.5 7.5 0 1 1 9.5 4.5a6 6 0 0 0 10 10z';
const THERMO = 'M8 13.6V5a2 2 0 1 1 4 0v8.6a4 4 0 1 1-4 0z';

const SKY: Record<WxSky, string> = {
  clear: SUN,
  clearNight: MOON,
  // 太阳在左上、云在右下（样图 4-胶囊 的图标）
  partly: `${CLOUD_SMALL}M8.2 11.2A3.2 3.2 0 1 1 12.9 7.4M8 2.5v1.5M2.5 8H4M4.1 4.1l1 1M11.9 4.1l-1 1`,
  partlyNight: `${CLOUD_SMALL}M12.4 8.2A4 4 0 0 1 6.8 3.2a4.5 4.5 0 1 0 1.4 8.6`,
  cloudy: CLOUD,
  fog: 'M5 8h14M3 12h18M5 16h14M8 20h8',
  rain: `${CLOUD_UP}M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5`,
  snow: `${CLOUD_UP}M9 18.5h.01M13 18.5h.01M17 18.5h.01M11 21.5h.01M15 21.5h.01`,
  storm: `${CLOUD_UP}M13 15.5l-2.5 3.5h3L11 22.5`,
};

const TIP: Record<WxTipKind, string> = {
  // 云下一道闪电（13种提示预览.png 第 1 条）
  storm: `${CLOUD_UP}M13 15.5l-2.5 3.5h3L11 22.5`,
  // 伞（样图 4-胶囊 的“15 点后有雨”前面那一把）
  rain: 'M12 3.5a8.5 8.5 0 0 0-8.5 8.5h17A8.5 8.5 0 0 0 12 3.5zM12 12v6.5a2 2 0 0 1-4 0',
  snow: 'M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9',
  // 冰面：上一道波浪、下一道直线
  ice: 'M3.5 13c1.4-1.3 2.8-1.3 4.2 0s2.8 1.3 4.3 0 2.8-1.3 4.3 0 2.8 1.3 4.2 0M3.5 17.5h17',
  wind: 'M3 8h10.5a2.5 2.5 0 1 0-2.5-2.5M3 12h15.5a2.5 2.5 0 1 1-2.5 2.5M3 16h7',
  fog: 'M4.5 8h15M4.5 12h15M4.5 16h15',
  air: 'M5 9c2.5-1 4.5-1.5 7-1.5s4.5.5 7 1.5v4c0 3.5-3.5 5.5-7 5.5S5 16.5 5 13V9zM5 10.5H3.5v1.5A3 3 0 0 0 5.6 15M19 10.5h1.5v1.5a3 3 0 0 1-2.1 3M9 11.5h6M9.5 14.5h5',
  drop: `${THERMO}M18 5v9M15.5 11.5L18 14l2.5-2.5`,
  cold: `${THERMO}M10 17.5V16`,
  hot: `${THERMO}M10 17.5V7M16 6h2.5M16 9.5h3.5M16 13h2.5`,
  // 大衣：两片前襟、V 领
  swing: 'M8.5 3.5L5 6.5v14h5.5V9.5M15.5 3.5L19 6.5v14h-5.5V9.5M8.5 3.5L12 9.5l3.5-6M10.5 9.5h3',
  sun: SUN,
  mild: 'M4.5 12.5l5 5 10-10',
};

const PIN = 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11zM12 7.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6z';

function Glyph({ d, size, className, kind }: { d: string; size: number; className?: string | undefined; kind?: WxTipKind }) {
  return (
    <svg className={className} data-kind={kind} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const SkyIcon = ({ sky, size = 18, className }: { sky: WxSky; size?: number; className?: string | undefined }) => <Glyph d={SKY[sky]} size={size} className={className} />;
export const TipIcon = ({ kind, size = 18, className }: { kind: WxTipKind; size?: number; className?: string | undefined }) => <Glyph d={TIP[kind]} size={size} kind={kind} className={className ? `${styles.tip} ${className}` : styles.tip} />;
export const PinIcon = ({ size = 18, className }: { size?: number; className?: string | undefined }) => <Glyph d={PIN} size={size} className={className} />;
