// 功能 reminders 的词典·韩文：新建失败的两个按钮（见 failed-create-zh.ts）
import type { failedCreateZh } from './failed-create-zh.ts';

export const failedCreateKo = {
  'remind.unsynced.copy': '새 항목으로 저장', // REVIEW(ko)
  'remind.unsynced.drop': '버리기', // REVIEW(ko)
  'remind.unsynced.failedDeps': '다른 항목이 이 항목을 쓰고 있어 새로 저장할 수 없어요. 버리기만 할 수 있어요', // REVIEW(ko)
  'remind.unsynced.failedOther': '처리하지 못했어요. 잠시 후 다시 시도해 주세요', // REVIEW(ko)
} as const satisfies Record<keyof typeof failedCreateZh, string>;
