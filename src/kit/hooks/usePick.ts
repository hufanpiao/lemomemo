// kit 选择器（kit/components/Pick）要碰 core、platform 的几样放这里（kit 的组件不准直接引 core）：
// • usePickT：选择器词典（shared/i18n/pick-zh.ts、pick-ko.ts，不进首屏）的 t，写法同 useDeskT，语言变了跟着重画
// • usePickToday：今天（当前时区）；选择器打开时取一次，用来标“今天”的深黄数字、给没值的格子当起点
// • pickLog：运行日志（点周标题开关月份列表、跳月各一行）
// • usePickWeekStart：一周从哪天起，跟日历设置 cal.week_start 走（没设时 resolveWeekStart 给默认）。
//   键名同 features/calendar/data/cal-settings.ts 的 KEY_WEEK_START（kit 不准引 features，这里写字面量）
import { useState } from 'react';
import { todayOf } from '../../../shared/core/date.ts';
import { pickKo } from '../../../shared/i18n/pick-ko.ts';
import { pickZh } from '../../../shared/i18n/pick-zh.ts';
import { resolveWeekStart, type WeekStart } from '../../../shared/logic/calendar/cal-nav.ts';
import { currentTz } from '../../core/current-tz.ts';
import { settingValue, type SettingRow } from '../../core/setting-read.ts';
import { clock } from '../../platform/clock.ts';
import { rlog } from '../../platform/run-log-api.ts';
import { useCollection } from './useCollection.ts';
import { makeUseT } from './useT.ts';

/** 选择器的运行日志（kit 组件不准直接引 platform，从这里转一手；只记动作和跳了几个月，不记日子） */
export const pickLog = (line: string): void => rlog(line);

export const usePickT =makeUseT({ zh: pickZh, ko: pickKo });

export function usePickToday(): string {
  const [today] = useState(() => todayOf(clock.now(), currentTz()));
  return today;
}

export function usePickWeekStart(): WeekStart {
  const rows = useCollection<SettingRow>('settings');
  return resolveWeekStart(settingValue(rows, 'cal.week_start'));
}
