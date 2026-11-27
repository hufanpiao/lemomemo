// 设置首页“天气”一行右边的值：自动定位 / 城市名（内置常用城市跟着界面语言）/ 不看天气（二级页正文在 WeatherSettings.tsx）
import { useCityName, useWeatherT, useWeatherView, weatherState } from '../hooks/useWeather.ts';

export default function WeatherSettingValue() {
  const t = useWeatherT();
  const name = useCityName();
  useWeatherView();
  const p = weatherState.place();
  return <>{p.mode === 'city' ? name(p) : p.mode === 'off' ? t('weather.set.value.off', {}) : t('weather.set.value.auto', {})}</>;
}
