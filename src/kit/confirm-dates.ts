// “过去的月日先问”两个选项的日子写法：打字条、录音的确认行（plus 的 ui/ConfirmRow.tsx）和 AI 助手确认卡片（ai-chat 的 ui/DraftCards.tsx）共用一份，
// 两边给的选项一样：只说月日的“补记今年（10/30） · 明年（2027/10/30）”，只说几号的“补记本月（11/1） · 下个月（12/1）”（跨年才带年份）。
// 文案各自的 i18n 出，这里只算日子；纯 TS
import type { Confirm, DateBasis } from '../../shared/logic/parse/past-date.ts';

export interface ConfirmDates {
  /** 只说了几号（d）：按月问，否则按年问 */
  byMonth: boolean;
  /** 问句里那一天（past 的月、日） */
  m: number;
  d: number;
  /** 两颗按钮括号里的日子 */
  past: string;
  next: string;
}

const parts = (s: string): { y: number; m: number; d: number } => ({ y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) });
const md = (s: string): string => `${parts(s).m}/${parts(s).d}`;

export function confirmDates(item: { confirm: Confirm | null; date_basis: DateBasis | null }): ConfirmDates | null {
  const c = item.confirm;
  if (!c) return null;
  const byMonth = item.date_basis === 'd';
  const p = parts(c.past);
  const n = parts(c.next);
  return { byMonth, m: p.m, d: p.d, past: md(c.past), next: byMonth && n.y === p.y ? md(c.next) : `${n.y}/${md(c.next)}` };
}
