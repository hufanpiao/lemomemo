// 设置 › 天气（负责人 11-26：定位“两种都要”——默认浏览器定位，设置里也能手动指定城市）
// • 第一张卡（单选）：用当前位置 / 已选的城市（有才出）/ 不看天气。点“用当前位置”这时才问定位；拒绝或没定到，卡下面说一句，请在下面手动选
// • 第二张卡：手动选城市——输入城市名，停手 0.4 秒去搜（经 /wx/v1/geo：内置常用城市在前，再接 Open-Meteo 地理编码），点结果就用它；
//   内置常用城市记 key，城市名跟着界面语言变（cities.ts），别的城市名是搜索时那种语言
// • 都只记在这台设备（platform/weather-store.ts），不同步到账号、不上服务器
// 地址 #/settings/weather；顶栏和返回由设置页画（SubView）。设置首页那一行的值是 WeatherSettingValue.tsx
import { useEffect, useId, useState } from 'react';
import type { WxPlace } from '../../../../shared/schema/weather.ts';
import { SettingsCard, SettingsChoiceCard, SettingsEntryRow, SettingsRow, settingsCardNoteClass } from '../../../kit/components/Settings/Settings.tsx';
import formStyles from '../../../kit/components/Form.module.css';
import refine from '../../../kit/components/Refine.module.css';
import { searchCity, useCityName, useWeatherT, useWeatherView, useWxLang, weatherState } from '../hooks/useWeather.ts';
import styles from './WeatherSettings.module.css';

type Here = 'idle' | 'busy' | 'denied' | 'failed';
type Found = { q: string; state: 'busy' | 'fail' | 'done'; places: readonly WxPlace[] };
/** 停手多久再搜 */
const SEARCH_IDLE_MS = 400;

export default function WeatherSettings() {
  const t = useWeatherT();
  const lang = useWxLang();
  const name = useCityName();
  // 订状态：改了看哪儿、取完天气时重画；看哪儿每次画都从本机那一份读（只有一份，不另存）
  useWeatherView();
  const place = weatherState.place();
  const [here, setHere] = useState<Here>('idle');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const inputId = useId();

  useEffect(() => {
    const qq = q.trim();
    if (!qq) {
      setFound(null);
      return undefined;
    }
    let live = true;
    const timer = setTimeout(() => {
      setFound({ q: qq, state: 'busy', places: [] });
      void searchCity(qq, lang).then((r) => {
        if (live) setFound({ q: qq, state: r.ok ? 'done' : 'fail', places: r.ok ? r.value : [] });
      });
    }, SEARCH_IDLE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, lang]);

  const askHere = async (): Promise<void> => {
    setHere('busy');
    const r = await weatherState.askHere();
    setHere(r.ok ? 'idle' : r.why === 'denied' ? 'denied' : 'failed');
  };
  const pick = async (p: WxPlace): Promise<void> => {
    await weatherState.setPlace({ mode: 'city', ...(p.key === undefined ? {} : { key: p.key }), name: p.name, lat: p.lat, lon: p.lon });
    setHere('idle');
    setQ('');
  };

  type Choice = 'auto' | 'city' | 'off';
  const options: { value: Choice; label: string; testId: string }[] = [
    { value: 'auto', label: t('weather.set.here', {}), testId: 'weather-set-auto' },
    ...(place.mode === 'city' ? [{ value: 'city' as const, label: name(place), testId: 'weather-set-city-on' }] : []),
    { value: 'off', label: t('weather.set.off', {}), testId: 'weather-set-off' },
  ];
  const note =
    here === 'busy'
      ? t('weather.set.locating', {})
      : here === 'denied'
        ? t('weather.set.denied', {})
        : here === 'failed'
          ? t('weather.set.failed', {})
          : place.mode === 'off'
            ? t('weather.set.offNote', {})
            : t('weather.set.hereNote', {});
  return (
    <div data-testid="weather-settings">
      <SettingsChoiceCard
        title={t('weather.set.where', {})}
        name="weather-place"
        options={options}
        value={place.mode}
        onPick={(v) => {
          if (v === 'auto') void askHere();
          else if (v === 'off') void weatherState.setPlace({ mode: 'off' });
        }}
        note={<span role={here === 'denied' || here === 'failed' ? 'alert' : undefined} data-testid="weather-set-note">{note}</span>}
      />
      <SettingsCard title={t('weather.set.city', {})} showTitle testId="weather-set-city">
        <SettingsRow>
          <label htmlFor={inputId} className={refine.srOnly}>
            {t('weather.set.search', {})}
          </label>
          <input
            id={inputId}
            type="search"
            className={`${formStyles.input} ${styles.search}`}
            value={q}
            placeholder={t('weather.set.search', {})}
            enterKeyHint="search"
            autoComplete="off"
            onChange={(e) => setQ(e.target.value)}
            data-testid="weather-set-search"
          />
        </SettingsRow>
        {found?.state === 'busy' ? <SettingsRow><span className={styles.dim}>{t('weather.set.searching', {})}</span></SettingsRow> : null}
        {found?.state === 'fail' ? <SettingsRow><span className={styles.dim} role="alert">{t('weather.set.searchFail', {})}</span></SettingsRow> : null}
        {found?.state === 'done' && found.places.length === 0 ? <SettingsRow><span className={styles.dim}>{t('weather.set.noResult', {})}</span></SettingsRow> : null}
        {found?.state === 'done'
          ? found.places.map((p) => (
              <SettingsEntryRow key={`${p.name}|${p.lat}|${p.lon}`} label={p.name} meta={p.sub || undefined} chev={false} onOpen={() => void pick(p)} testId="weather-set-result" />
            ))
          : null}
      </SettingsCard>
      <p className={settingsCardNoteClass}>{t('weather.set.searchHint', {})}</p>
    </div>
  );
}
