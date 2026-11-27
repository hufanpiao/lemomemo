// 功能 weather：今天页天气胶囊（手机日期下面、宽屏页头右边）、逐时半屏、设置 › 天气（负责人 11-26）
// 对外唯一入口：只放懒加载。胶囊、半屏、设置页都在首屏画完以后才下载（今天页、宽屏页头外面包 kit 的 Later afterPaint），不进首屏预算
import { lazy } from 'react';

export const routes = [] as const;
/** 胶囊：slot 'head'（手机日期那一行，只出“设置城市看天气”）、'below'（手机日期下面，只出有天气的胶囊）、'desk'（宽屏页头右边，两种都出） */
export const WeatherChip = lazy(() => import('./ui/WeatherChip.tsx'));
/** 设置 › 天气 二级页正文 */
export const WeatherSettings = lazy(() => import('./ui/WeatherSettings.tsx'));
/** 设置首页“天气”一行右边的值 */
export const WeatherSettingValue = lazy(() => import('./ui/WeatherSettingValue.tsx'));
