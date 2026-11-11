// 编辑页共用词条·韩文（见 edit-zh.ts 文件头；从三个功能词典合并过来，审校标注照旧）
// satisfies Record<EditMsgKey, string>：少一个键、多一个键都编译不过
import type { EditMsgKey } from './edit-zh.ts';

export const editKo = {
  'edit.st.idle': '고치면 자동으로 저장돼요', // REVIEW(ko)
  'edit.st.saving': '저장 중…', // REVIEW(ko)
  'edit.st.saved': '자동 저장됨', // REVIEW(ko)
  'edit.st.failed': '저장하지 못했어요. 내용은 그대로 있으니 잠시 후 다시 고쳐 주세요', // REVIEW(ko)
  'edit.st.unavailable': '지금 이 기기에 저장할 수 없어요. 내용은 그대로 있으니 잠시 후 다시 고쳐 주세요', // REVIEW(ko)
  'edit.st.readonly': '새 버전에서만 고칠 수 있어요', // REVIEW(ko)
  'edit.st.missing': '이 항목을 찾을 수 없어요. 다른 기기에서 삭제했을 수 있어요', // REVIEW(ko)
  'edit.update': '업데이트', // REVIEW(ko)
  'edit.delete': '삭제', // REVIEW(ko)
  'edit.deleted': '삭제했어요. 30일 안에는 ‘최근 삭제’에서 되살릴 수 있어요.', // REVIEW(ko)
  'edit.undo': '되돌리기', // REVIEW(ko)
} as const satisfies Record<EditMsgKey, string>;
