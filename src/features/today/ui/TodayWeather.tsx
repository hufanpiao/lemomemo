// 今天页手机版的天气胶囊挂点（weather 功能的 WeatherChip，负责人 11-26 方向4）：只转一手，不加逻辑。
// 为什么多这一层：TodayPage 直接 import weather/index.ts 时，那一包（连着设置页两块的依赖名单）进了首屏，
// e2e b2-first-screen-budget 量到 150.4 KB 超 150 KB；经 today/index.ts 的这一个懒加载，weather 那一包首屏画完以后才下载
import { WeatherChip } from '../../weather/index.ts';

export default function TodayWeather({ slot }: { slot: 'head' | 'below' }) {
  return <WeatherChip slot={slot} />;
}
