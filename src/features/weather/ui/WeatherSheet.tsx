// 天气胶囊点开的半屏详情（负责人 11-26：点胶囊用半屏看逐时；“按右边的 › 可以看到详情”；未来 7 天；版式按 App 自己的风格）
// • 外壳就是 kit HalfSheet（同 AI 助手的半屏 ChatDrawer）：出现、关、圆角、把手、拖动、点后面、Esc 全照旧；顶栏“✕ 关闭 / 标题”照 ChatDrawer 的 .top
// • 里面只用现成的样式：分组名是 kit Form 的 .groupLabel.groupRow（同今天页“今天的安排”），卡片和行是 kit List 的 .list / .row（白卡、--r-lg、44 高、细分隔线），
//   行首时刻是 List 的 .lead（等宽小字）；胶囊那条提示对应的整点用 List 里“抽屉开着的那一行”同一道柠檬黄竖条标出
// • 从上到下：今天概况（地点、更新时刻、天气、现在气温、体感、最高最低、那条提示、紫外线、空气）→ 逐时（12 个整点）→ 未来 7 天（数据来源的署名负责人 11-26 定放设置里的署名页，不在这里）
import { weekdayOf } from '../../../../shared/core/date.ts';
import { weekdayName } from '../../../../shared/i18n/fmt.ts';
import { WX_RULES, skyOf, uvLevel } from '../../../../shared/logic/weather/tips.ts';
import form from '../../../kit/components/Form.module.css';
import { HalfSheet } from '../../../kit/components/HalfSheet.tsx';
import list from '../../../kit/components/List.module.css';
import refine from '../../../kit/components/Refine.module.css';
import { SheetTop } from '../../../kit/components/SheetTop.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { deg, hhmm, useCityName, useTipText, useWeatherNow, useWeatherT, useWeatherView } from '../hooks/useWeather.ts';
import { SkyIcon, TipIcon } from './WeatherIcon.tsx';
import styles from './WeatherSheet.module.css';

const GROUP_H = `${form.groupLabel} ${form.groupRow}`;

export default function WeatherSheet({ onClose }: { onClose(): void }) {
  const t = useWeatherT();
  const tipText = useTipText();
  const view = useWeatherView();
  const w = useWeatherNow(view);
  const locale = useUi((s) => s.locale);
  const cityName = useCityName();
  if (view.kind !== 'show' || !w) return null;
  const { cur } = view.pack;
  const place = view.place.mode === 'city' ? cityName(view.place) : t('weather.sheet.here', {});
  const air = view.pack.air;
  return (
    <HalfSheet label={t('weather.sheet.title', {})} onClose={onClose} log={rlog} tag="weather">
      {(close) => (
        <>
          <SheetTop title={t('weather.sheet.title', {})} left={{ kind: 'close', label: t('weather.sheet.close', {}), onClick: close, testId: 'weather-close' }} />
          <div className={styles.feed} data-testid="weather-sheet-body">
            <h4 className={GROUP_H}>
              <span>{place}</span>
              <span>{view.stale ? t('weather.sheet.stale', { t: hhmm(view.at) }) : t('weather.sheet.at', { t: hhmm(view.at) })}</span>
            </h4>
            <ul className={list.list}>
              <li className={`${list.row} ${styles.nowRow}`}>
                <SkyIcon sky={skyOf(cur.c, cur.d)} size={32} className={styles.bigSky} />
                <span className={styles.big}>{deg(cur.t)}°</span>
                <span className={styles.nowSub}>
                  <span>{t('weather.sheet.feels', { n: deg(cur.f) })}</span>
                  <span>{t('weather.sheet.hiLo', { hi: deg(w.hi), lo: deg(w.lo) })}</span>
                </span>
              </li>
              <li className={`${list.row} ${styles.tipRow}`} data-testid="weather-sheet-tip">
                <TipIcon kind={w.tip.kind} size={18} />
                <span>{tipText(w.tip)}</span>
              </li>
              <li className={`${list.row} ${styles.pairRow}`}>
                <span>{t('weather.sheet.uv', { lv: t(`weather.uv.${uvLevel(w.uv)}`, {}) })}</span>
                <span className={styles.num}>{Math.round(w.uv)}</span>
              </li>
              {w.air ? (
                <li className={`${list.row} ${styles.pairRow}`} data-testid="weather-sheet-air">
                  <span>{t('weather.sheet.air', { lv: t(`weather.air.${w.air.level}`, {}) })}</span>
                  <span className={styles.num}>
                    {[w.air.pm25 === null ? '' : `PM2.5 ${Math.round(w.air.pm25)}`, w.air.pm10 === null ? '' : `PM10 ${Math.round(w.air.pm10)}`].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ) : null}
            </ul>

            <h4 className={GROUP_H}>
              <span>{t('weather.sheet.hourly', {})}</span>
            </h4>
            <table className={`${list.list} ${styles.hours}`} data-air={air ? '' : undefined} data-testid="weather-hours">
              <thead>
                <tr>
                  <th scope="col">{t('weather.sheet.colTime', {})}</th>
                  <th scope="col">
                    <span className={refine.srOnly}>{t('weather.sheet.title', {})}</span>
                  </th>
                  <th scope="col">{t('weather.sheet.colTemp', {})}</th>
                  <th scope="col">{t('weather.sheet.colFeels', {})}</th>
                  <th scope="col">{t('weather.sheet.colRain', {})}</th>
                  <th scope="col">{t('weather.sheet.colUv', {})}</th>
                  {air ? <th scope="col">{t('weather.sheet.colAir', {})}</th> : null}
                </tr>
              </thead>
              <tbody>
                {w.hours.map((h) => (
                  <tr key={h.at} data-marked={w.marked.has(h.at) ? '' : undefined} data-testid={`weather-hour-${h.at.slice(11, 13)}`}>
                    <th scope="row" className={list.lead}>
                      {h.at.slice(11, 16)}
                    </th>
                    <td>
                      <SkyIcon sky={skyOf(h.c, h.d, h.p)} size={18} />
                    </td>
                    <td>{deg(h.t)}°</td>
                    <td>{deg(h.f)}°</td>
                    <td className={h.p >= WX_RULES.rainPct ? styles.blue : undefined}>{Math.round(h.p)}%</td>
                    <td>{Math.round(h.uv)}</td>
                    {air ? <td>{h.pm25 === null ? '' : Math.round(h.pm25)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>

            <h4 className={GROUP_H}>
              <span>{t('weather.sheet.week', {})}</span>
            </h4>
            <ul className={list.list} data-testid="weather-week">
              {w.week.map((d) => (
                <li key={d.date} className={`${list.row} ${styles.dayRow}`}>
                  <span className={list.lead}>{t('weather.sheet.wdOf', { d: weekdayName(weekdayOf(d.date), locale) })}</span>
                  <SkyIcon sky={skyOf(d.c, 1, d.p)} size={18} />
                  <span className={d.p >= WX_RULES.rainPct ? `${styles.wp} ${styles.blue}` : styles.wp}>{Math.round(d.p)}%</span>
                  <span className={styles.wt}>
                    {deg(d.hi)}° / {deg(d.lo)}°
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </HalfSheet>
  );
}
