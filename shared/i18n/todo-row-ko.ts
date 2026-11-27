// 待办行的词条·韩文（见 todo-row-zh.ts 文件头；原来今天页、待办页两份词典里的同几句，审校标记照搬）
// satisfies Record<TodoRowMsgKey, string>：少一个键、多一个键都编译不过
import type { TodoRowMsgKey } from './todo-row-zh.ts';

export const todoRowKo = {
  'row.done': '완료', // REVIEW(ko)
  'row.undoDone': '완료 취소', // REVIEW(ko)
  'row.prio': '우선순위: {p}, 누르면 {next}(으)로 바뀜', // REVIEW(ko)
  'row.prio.high': '높음', // REVIEW(ko)
  'row.prio.mid': '보통', // REVIEW(ko)
  'row.prio.low': '낮음', // REVIEW(ko)
  'row.stage.1': '시작', // REVIEW(ko)
  'row.stage.2': '절반 넘음', // REVIEW(ko)
  'row.later': '미루기', // REVIEW(ko)
  'row.later.label': '내일로 미루기: {title}', // REVIEW(ko)
  'row.later.toast': '내일로 미뤘어요', // REVIEW(ko)
  'row.doneToast': '완료했어요', // REVIEW(ko)
  'row.deleted': '삭제했어요', // REVIEW(ko)
  'row.undo': '되돌리기', // REVIEW(ko) 负责人 11-20 定“撤销”统一 되돌리기
  'row.err.save': '저장하지 못했어요. 잠시 후 다시 시도해 주세요', // REVIEW(ko)
  'row.err.readonly': '새 버전으로 업데이트해야 수정할 수 있어요', // REVIEW(ko)
} satisfies Record<TodoRowMsgKey, string>;
