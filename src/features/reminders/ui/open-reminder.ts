// App 里打开整页提醒（R-372 代码审 M1，负责人选 ①“其他页左滑回今天”）：横幅、错过的提醒都走这里。
// 网页版在 /app/ 里交给路由的 goHref，压一条带本次编号的历史，关掉整页提醒时退一步回原页；
// 不走网页桥的 openReminder（它直接改 location.hash，压的历史不带编号，关掉时只能原地换成今天，今天下面就留着打开前那一页，
// 在今天左滑又回到那一页）。platform 不许引用 app（架构边界），所以判断放在提醒这个懒加载模块里，不进首屏。
// exe 照旧交给 exe 的桥（先拉主窗口到前台）；它在主窗口里换 hash 也走 goHref（main.tsx 装桥时注入）
import { goHref } from '../../../app/router.ts';
import { openReminder as bridgeOpen, reminderHash, type ReminderKind } from '../../../platform/native-bridge.ts';
import { isTauri } from '../../../platform/env.ts';

export function openReminder(kind: ReminderKind, id: string, dueAt: number): Promise<void> {
  const p = window.location.pathname;
  if (!isTauri() && (p === '/app/' || p === '/app/index.html')) return goHref(reminderHash(kind, id, dueAt));
  return bridgeOpen(kind, id, dueAt);
}
