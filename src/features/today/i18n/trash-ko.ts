// 功能 today 的词典·韩文：“最近删除”页；键和 trash-zh.ts 一一对应（从 ko.ts 原样挪过来，行尾审校标记照旧，R-106）
// satisfies Record<keyof typeof trashZh, string>：少一个键、多一个键都编译不过
import type { trashZh } from './trash-zh.ts';

export const trashKo = {
  'trash.title': '최근 삭제', // REVIEW(ko)
  'trash.back': '뒤로', // REVIEW(ko)
  'trash.note': '삭제한 일정, 할 일, 메모는 30일 동안 보관된 뒤 자동으로 정리돼요', // REVIEW(ko)
  'trash.empty': '최근 삭제한 항목이 없어요', // REVIEW(ko)
  'trash.left': '{n}일 후 정리', // REVIEW(ko)
  'trash.restore': '복원', // REVIEW(ko)
  'trash.restored': '복원했어요', // REVIEW(ko)
  'trash.kind.events': '일정', // REVIEW(ko)
  'trash.kind.todos': '할 일', // REVIEW(ko)
  'trash.kind.notes': '메모', // REVIEW(ko)
} as const satisfies Record<keyof typeof trashZh, string>;
