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
  // 永久删除、全部清空（B4 S9，TC-B4-17；确认文案照架构 0.29 续第 121 条⑧）
  'trash.purge': '영구 삭제', // REVIEW(ko)
  'trash.clear': '모두 비우기', // REVIEW(ko)
  'trash.cancel': '취소', // REVIEW(ko)
  'trash.purge.title': '이 항목을 영구 삭제할까요?', // REVIEW(ko)
  'trash.purge.body': '영구 삭제하면 복원할 수 없어요', // REVIEW(ko)
  'trash.clear.title': '모두 비우기', // REVIEW(ko)
  'trash.clear.body': '최근 삭제에 있는 {n}개 항목을 비울까요? 비우면 복원할 수 없어요', // REVIEW(ko)
  'trash.clear.skip': ' 삭제가 아직 동기화되지 않은 {n}개 항목은 이번에 비우지 않아요', // REVIEW(ko)
  'trash.clear.ro': ' 새 버전이 필요한 {n}개 항목은 삭제할 수 없어서 남겨 둬요', // REVIEW(ko)
  'trash.ro.tail': ' 새 버전이 필요한 {n}개 항목은 삭제할 수 없어서 목록에 남겨 두었어요', // REVIEW(ko)
  'trash.ro.kept': '이 {n}개 항목은 새 버전이 필요해서 삭제할 수 없어요. 목록에 남겨 두었어요', // REVIEW(ko)
  'trash.offline': '영구 삭제와 모두 비우기는 인터넷 연결이 필요해요', // REVIEW(ko)
  'trash.purged': '영구 삭제했어요', // REVIEW(ko)
  'trash.cleared': '모두 비웠어요', // REVIEW(ko)
  'trash.syncing': '삭제했어요. 동기화 중이에요', // REVIEW(ko)
  'trash.err.notSynced': '이 항목의 삭제가 아직 동기화되지 않았어요. 연결된 상태에서 잠시 후 다시 시도해 주세요', // REVIEW(ko)
  'trash.err.partial': '일부 항목의 삭제가 아직 동기화되지 않았어요. 연결된 상태에서 잠시 후 다시 시도해 주세요', // REVIEW(ko)
  'trash.err.offline': '서버에 연결할 수 없어요. 연결된 뒤 다시 시도해 주세요', // REVIEW(ko)
  'trash.err.failed': '삭제하지 못했어요. 잠시 후 다시 시도해 주세요', // REVIEW(ko)
} as const satisfies Record<keyof typeof trashZh, string>;
