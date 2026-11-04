// 节假日数据（B2 FA-3，架构 5.12 第 1、3 点）：按要显示的国家、年份拉 holidays/<国>/<年>.json，合成“日期 → 当天的节假日”
// • 文件经 platform/app-static.ts 的 fetchAppJsonStatus 拉，分三种（代码审查 M2、安全审查 FA3-4）：
//   – 拿到了（含 pending、days 为空）、或服务器明确没有（4xx）、或格式不对：记在模块缓存里，翻页回来不重拉
//   – 没拉到（断网又没缓存、5xx）：不记死；返回 offline = true，页面上方提示“联网后显示节假日”；
//     收到 online 事件、或下次进页面再拉（SW 对这个目录先联网、失败用缓存）
// • 合成交给前端 B 的 holidayMarks（只用 countries 里的国家，界面语言那国在前）
import { useEffect, useMemo, useState } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import {
  holidayFetchPaths,
  holidayMarks,
  parseHolidayFile,
  type HolidayCountry,
  type HolidayFile,
  type HolidayMark,
} from '../../../../shared/logic/calendar/holidays.ts';
import { fetchAppJsonStatus, type AppJson } from '../../../platform/app-static.ts';

/** 记住的结果：文件，或 null（确定没有 / 格式不对） */
type Known = HolidayFile | null;

/** 路径 → 确定的结果；还在拉的放 Promise。没拉到（failed）的不放，下次再拉 */
const cache = new Map<string, Known | Promise<Known | 'failed'>>();
/** 最近一次没拉到的路径（页面据此提示“联网后显示节假日”） */
const failed = new Set<string>();

interface Want {
  path: string;
  country: HolidayCountry;
  year: number;
}

/** 每个 (国家, 年份) 自己拼路径，不靠 holidayFetchPaths 返回顺序对齐下标（代码审查 L9） */
function wantsOf(countries: readonly HolidayCountry[], years: readonly number[]): Want[] {
  return countries.flatMap((country) => years.map((year) => ({ country, year, path: holidayFetchPaths([country], [year])[0] ?? '' }))).filter((w) => w.path !== '');
}

function load(w: Want, fetchJson: (path: string) => Promise<AppJson>): Promise<Known | 'failed'> {
  const hit = cache.get(w.path);
  if (hit instanceof Promise) return hit;
  if (hit !== undefined) return Promise.resolve(hit);
  const p = fetchJson(w.path)
    .catch((): AppJson => ({ kind: 'failed' }))
    .then((r): Known | 'failed' => {
      if (r.kind === 'failed') {
        cache.delete(w.path);
        failed.add(w.path);
        return 'failed';
      }
      const f = r.kind === 'ok' ? parseHolidayFile(r.json, w.country, w.year) : null;
      cache.set(w.path, f);
      failed.delete(w.path);
      return f;
    });
  cache.set(w.path, p);
  return p;
}

/** 测试用 */
export function resetHolidayCacheForTest(): void {
  cache.clear();
  failed.clear();
}

export interface HolidayState {
  readonly marks: ReadonlyMap<DateStr, readonly HolidayMark[]>;
  /** 要显示的文件里有没拉到的（离线）：页面提示“联网后显示节假日” */
  readonly offline: boolean;
}

export function useHolidays(
  countries: readonly HolidayCountry[],
  years: readonly number[],
  locale: UiLocale,
  fetchJson: (path: string) => Promise<AppJson> = fetchAppJsonStatus,
): HolidayState {
  const [ver, setVer] = useState(0);
  // countries、years 由调用方记住（内容不变时同一个数组），这里才不会每次重画都重算
  const wants = useMemo(() => wantsOf(countries, years), [countries, years]);

  useEffect(() => {
    let live = true;
    const run = (): void => {
      const missing = wants.filter((w) => {
        const v = cache.get(w.path);
        return v === undefined || v instanceof Promise;
      });
      if (missing.length === 0) return;
      void Promise.all(missing.map((w) => load(w, fetchJson))).then(() => {
        if (live) setVer((n) => n + 1);
      });
    };
    run();
    // 联网了：把没拉到的再拉一次
    window.addEventListener('online', run);
    return () => {
      live = false;
      window.removeEventListener('online', run);
    };
  }, [wants, fetchJson]);

  return useMemo(() => {
    const files: HolidayFile[] = [];
    let offline = false;
    for (const w of wants) {
      const v = cache.get(w.path);
      if (v && !(v instanceof Promise)) files.push(v);
      if (v === undefined && failed.has(w.path)) offline = true;
    }
    // ver 只用来在文件拉回来以后重算
    const marks = ver >= 0 ? holidayMarks(files, countries, locale) : new Map<DateStr, HolidayMark[]>();
    return { marks, offline };
  }, [wants, ver, countries, locale]);
}
