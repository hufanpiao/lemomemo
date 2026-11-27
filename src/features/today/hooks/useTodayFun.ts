// 今天页没日程时的组合区（ui/TodayFun.tsx）的数据和写入：只给按需下载的 TodayFun 用，不进首屏
// • 顺手做的那一件、这周做完几件：data/today-fun.ts 的纯函数（一周从周日起）
// • “放进今天”：截止日改成今天（core/todo-writes.ts 的 setTodoDue，和“推迟”同一个写法，提醒标记一起算）；
//   运行日志只记结果，不记待办标题
// • 词典 useFunT：../i18n/fun-zh.ts、fun-ko.ts，跟着这一包下载
import { useMemo } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useReadonlyIds } from '../../../kit/hooks/useReadonly.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { barHeight, quickTodo, weekDone } from '../data/today-fun.ts';
import { todayFunKo } from '../i18n/fun-ko.ts';
import { todayFunZh } from '../i18n/fun-zh.ts';

type Row = Readonly<{ id: string } & Record<string, unknown>>;

export { barHeight };
export const useFunT = makeUseT({ zh: todayFunZh, ko: todayFunKo });

export function useTodayFun(today: DateStr) {
  const rows = useCollection<Row>('todos');
  const ro = useReadonlyIds('todos');
  const tz = currentTz();
  const quick = useMemo(() => quickTodo(rows, today, tz, ro), [rows, today, tz, ro]);
  const week = useMemo(() => weekDone(rows, today, tz), [rows, today, tz]);
  /** 把顺手做的那一件放进今天（截止日 = 今天）；找不到这一行（刚被别处删了）按 failed */
  const toToday = async (id: string): Promise<ActionResult> => {
    const r = rows.find((x) => x.id === id);
    if (!r) {
      rlog('today-fun put ok=0 gone');
      return 'failed';
    }
    const o = await import('../../../core/todo-writes.ts');
    const now = clock.now();
    const res = actionResult(await o.setTodoDue(r, today, now, currentTz()));
    rlog(`today-fun put ${res}`);
    return res;
  };
  return { quick, week, toToday };
}
