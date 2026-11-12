// 提示条按结果选文案（B3 任务单 FA-2；架构 5.1 提示条几种结果；R-163、R-166、R-187、R-200）
// • 只返回词条键和参数（data 层不碰 t()），界面经 usePlusT 翻成文字
// • 主句：一条 → “已记下：标题”；多条 → “已记下 N 条”；AI 没成 → “已先记下：…”；额度用完 → 带恢复时刻（每天只出一次，
//   不该出时退成普通“已记下”）；离线 → “没网，已存在手机里：…”，带提醒的再加“未同步，提醒可能不响”
// • 附加句：重复 → R-163；“安排时间” → R-200；没有的日子 → R-166（续第 68 条）；
//   合并没存上、全部撤销有几条没撤成（FA-3 整块评审第 13 条：原来的几条留在提示条上，写明没成）
// 纯 TS：不准 import React（A1）
import type { TypeStatus } from './type-flow.ts';

export type NoticeKey =
  | 'plus.notice.saved'
  | 'plus.notice.savedN'
  | 'plus.notice.savedRule'
  | 'plus.notice.quota'
  | 'plus.notice.offline'
  | 'plus.notice.offlineRemind'
  | 'plus.notice.recur'
  | 'plus.notice.arrange'
  | 'plus.notice.badDay'
  | 'plus.notice.mergeFailed'
  | 'plus.notice.undoFailed'
  | 'plus.notice.annivKept';

export interface NoticeLine {
  key: NoticeKey;
  params: Readonly<Record<string, string | number>>;
}

export interface NoticeInput {
  status: TypeStatus;
  titles: readonly string[];
  hints: { recur: boolean; arrange: boolean; bad_day: { month: number; day: number } | null };
  /** 带提醒（离线时加一句） */
  remind: boolean;
  /** 今天还没出过额度提示 */
  quotaNoticeDue: boolean;
  /** 恢复时刻“HH:MM”（current_tz） */
  resetClock: string;
  /** 合并那一条没存上（原来的几条没撤） */
  mergeFailed?: boolean;
  /** 撤销时没撤成的条数（纪念日不算） */
  undoFailed?: number;
  /** 有纪念日撤不掉（这里撤不了纪念日） */
  annivKept?: boolean;
}

function mainLine(n: NoticeInput): NoticeLine {
  const title = n.titles[0] ?? '';
  const many = n.titles.length > 1;
  const saved: NoticeLine = many ? { key: 'plus.notice.savedN', params: { n: n.titles.length } } : { key: 'plus.notice.saved', params: { title } };
  switch (n.status) {
    case 'saved':
      return saved;
    case 'saved_rule':
      return many ? saved : { key: 'plus.notice.savedRule', params: { title } };
    case 'quota_out':
      return n.quotaNoticeDue ? { key: 'plus.notice.quota', params: { time: n.resetClock } } : saved;
    case 'offline_saved':
      return many ? saved : { key: 'plus.notice.offline', params: { title } };
    default: {
      const never: never = n.status;
      return never;
    }
  }
}

/** 提示条的几行：第一行主句，后面是附加句 */
export function noticeLines(n: NoticeInput): NoticeLine[] {
  const out: NoticeLine[] = [mainLine(n)];
  if (n.undoFailed) out.push({ key: 'plus.notice.undoFailed', params: { n: n.undoFailed } });
  if (n.mergeFailed) out.push({ key: 'plus.notice.mergeFailed', params: {} });
  if (n.annivKept) out.push({ key: 'plus.notice.annivKept', params: {} });
  if (n.status === 'offline_saved' && n.remind) out.push({ key: 'plus.notice.offlineRemind', params: {} });
  if (n.hints.recur) out.push({ key: 'plus.notice.recur', params: {} });
  if (n.hints.arrange) out.push({ key: 'plus.notice.arrange', params: {} });
  if (n.hints.bad_day) out.push({ key: 'plus.notice.badDay', params: { month: n.hints.bad_day.month, day: n.hints.bad_day.day } });
  return out;
}
