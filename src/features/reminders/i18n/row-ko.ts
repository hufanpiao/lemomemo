// 功能 reminders 的词典·韩文，首屏那几句（见 row-zh.ts）
import type { remindRowZh } from './row-zh.ts';

export const remindRowKo = {
  'remind.missed.row': '놓친 알림 {n}개', // REVIEW(ko)
  'remind.missed.open': '보기 ›', // REVIEW(ko)
  'remind.unsynced': '동기화 안 됨. 알림이 안 울릴 수 있어요', // REVIEW(ko)
  'remind.unsynced.mark': '동기화 안 됨', // REVIEW(ko)
  'remind.unsynced.retry': '다시 시도', // REVIEW(ko)
} as const satisfies Record<keyof typeof remindRowZh, string>;
