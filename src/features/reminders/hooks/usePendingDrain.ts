// 什么时候把通知上按的“推迟 / 完成”转进 outbox（data/remind-pending.ts；架构 0.29 续第 102 条③“页面启动后由正常的 data 层把它变成 outbox 里的一项”）
// 挂在提醒引擎上（useReminders.ts 的 useRemindEngine，RemindHost 一份；冷启动就是整页提醒时 App 立刻挂）。要按这一行现在的提醒核对 due_at，
// 所以等本机行灌好（known 不空）才转，不然什么都找不到、会把按键当 gone 丢掉。转的时机：
// • 行灌好以后、行每次变了（App 启动；同一行的第二个按键 core 留到下一轮，转完第一个行一变就接着转）
// • 回到前台（visibilitychange → visible：SW 聚焦已经开着的窗口）
// • 打开整页提醒（hashchange 到 #/remind/…：SW 对已经开着、正在前台的窗口只改 hash）
// 同时只跑一份，跑的时候又触发了，跑完再跑一次。出错只记运行日志（错误类型），按键留着下次再转
import { useEffect, useRef } from 'react';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { drainNotifyActions, type FindReminder } from '../data/remind-pending.ts';
import type { Reminder } from '../data/reminder-model.ts';

export function usePendingDrain(list: readonly Reminder[], known: ReadonlySet<string>, tz: string): void {
  const latest = useRef({ list, known, tz });
  latest.current = { list, known, tz };
  const run = useRef<(() => void) | null>(null);
  if (!run.current) {
    let busy = false;
    let again = false;
    const find: FindReminder = (kind, id) => {
      const { list: l, known: k } = latest.current;
      const r = l.find((x) => x.kind === kind && x.id === id);
      if (r) return r;
      return kind === 'anniv' && !k.has(`anniv:${id}`) ? 'later' : undefined;
    };
    const go = async (): Promise<void> => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const n = await drainNotifyActions(find, clock.now(), latest.current.tz);
        if (n > 0) rlog(`pending drained n=${n}`);
      } catch (e) {
        rlog(`pending drain failed ${(e as Error | null)?.name ?? 'Error'}`);
      } finally {
        busy = false;
        if (again) {
          again = false;
          void go();
        }
      }
    };
    run.current = () => void go();
  }
  const ready = known.size > 0;
  useEffect(() => {
    if (ready) run.current?.();
  }, [ready, list]);
  useEffect(() => {
    if (!ready) return;
    const onVis = (): void => {
      if (document.visibilityState === 'visible') run.current?.();
    };
    const onHash = (): void => {
      if (window.location.hash.startsWith('#/remind/')) run.current?.();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('hashchange', onHash);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('hashchange', onHash);
    };
  }, [ready]);
}
