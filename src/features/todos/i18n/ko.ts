// 功能 todos 的词典·韩文（架构 2.4）：待办编辑页（B2 FA-2 第一段）。全部是自译初稿，等 R-106 审校，逐行标 REVIEW(ko)
// satisfies Record<keyof typeof zh, string>：少一个键、多一个键都编译不过
import type { zh } from './zh.ts';

export const ko = {
  'todo.edit.kind': '할 일', // REVIEW(ko)
  'todo.edit.newKind': '새 할 일', // REVIEW(ko)
  'todo.edit.back': '뒤로', // REVIEW(ko)
  'todo.edit.titleLabel': '제목', // REVIEW(ko)
  'todo.edit.titlePh': '무엇을 할까요', // REVIEW(ko)
  'todo.edit.done': '완료 (체크한 뒤에도 계속 고칠 수 있어요)', // REVIEW(ko)
  'todo.edit.doneShort': '완료', // REVIEW(ko) FA-2 只读编辑页：不写“체크한 뒤에도 계속 고칠 수 있어요”
  'todo.edit.important': '중요', // REVIEW(ko)
  'todo.edit.due': '마감', // REVIEW(ko)
  'todo.edit.dueTime': '마감 시각', // REVIEW(ko)
  'todo.edit.clear': '지우기', // REVIEW(ko)
  'todo.edit.remindBefore': '미리 알림', // REVIEW(ko)
  'todo.edit.before.none': '알리지 않음', // REVIEW(ko)
  'todo.edit.before.0': '마감 시각에', // REVIEW(ko)
  'todo.edit.before.10': '10분 전', // REVIEW(ko)
  'todo.edit.before.30': '30분 전', // REVIEW(ko)
  'todo.edit.before.60': '1시간 전', // REVIEW(ko)
  'todo.edit.before.120': '2시간 전', // REVIEW(ko)
  'todo.edit.before.1440': '1일 전', // REVIEW(ko)
  'todo.edit.remind': '알림', // REVIEW(ko)
  'todo.edit.days.none': '알리지 않음', // REVIEW(ko)
  'todo.edit.days.0': '당일', // REVIEW(ko)
  'todo.edit.days.1': '전날', // REVIEW(ko)
  'todo.edit.remindTime': '알림 시각', // REVIEW(ko)
  'todo.edit.needDue': '알림을 정하면 마감일이 오늘로 정해져요', // REVIEW(ko) R-375
  'todo.edit.remindPast': '이 알림 시각은 이미 지나서 알려 드리지 않아요', // REVIEW(ko) R-375
  'todo.edit.project': '프로젝트', // REVIEW(ko)
  'todo.edit.note': '메모', // REVIEW(ko)
  'todo.edit.projectPh': '예: 회사, 집', // REVIEW(ko) G11 占位
  'todo.edit.notePh': '덧붙일 내용 (선택)', // REVIEW(ko) G11 占位
  'todo.edit.raw': '원래 한 말', // REVIEW(ko)
  'todo.edit.st.empty': '제목을 써야 저장돼요', // REVIEW(ko)
  'todo.edit.st.rejected': '형식이 맞지 않아 저장하지 못했어요 (제목이 너무 길거나 날짜가 맞지 않아요)', // REVIEW(ko)
} as const satisfies Record<keyof typeof zh, string>;
