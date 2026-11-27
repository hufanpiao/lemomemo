// 电脑版布局的词条·韩文（B6，见 desk-zh.ts 文件头）
// satisfies Record<DeskMsgKey, string>：少一个键、多一个键都编译不过
import type { DeskMsgKey } from './desk-zh.ts';

export const deskKo = {
  'desk.handle': '“{name}” 옮기기', // REVIEW(ko) B6 电脑版新加
  'desk.handleHint': '스페이스로 들고, 방향키로 옮기고, 스페이스로 놓기, Esc로 취소', // REVIEW(ko) B6 电脑版新加
  'desk.collapse': '“{name}” 접기', // REVIEW(ko) B6 电脑版新加
  'desk.resize': '{n}열과 {m}열의 너비', // REVIEW(ko) B6 电脑版新加
  'desk.more': '레이아웃', // REVIEW(ko) B6 电脑版新加
  'desk.lock': '레이아웃 잠그기', // REVIEW(ko) B6 电脑版新加
  'desk.collapsed': '접어 둔 블록', // REVIEW(ko) B6 电脑版新加
  'desk.collapsedNone': '접어 둔 블록이 없어요', // REVIEW(ko) B6 电脑版新加
  'desk.restore': '“{name}” 다시 놓기', // REVIEW(ko) B6 电脑版新加
  'desk.reset': '기본 레이아웃으로', // REVIEW(ko) B6 电脑版新加
  'desk.saved': '레이아웃을 저장했어요', // REVIEW(ko) B6 电脑版新加
  'desk.undo': '되돌리기', // REVIEW(ko) B6 电脑版新加
  'desk.picked': '“{name}”을(를) 들었어요, {c}열 {n}번째', // REVIEW(ko) B6 电脑版新加
  'desk.at': '“{name}”, {c}열 {n}번째', // REVIEW(ko) B6 电脑版新加
  'desk.dropped': '“{name}”을(를) 놓았어요, {c}열 {n}번째', // REVIEW(ko) B6 电脑版新加
  'desk.cancelled': '취소했어요, “{name}”은(는) {c}열 {n}번째로 돌아갔어요', // REVIEW(ko) B6 电脑版新加
  'desk.toLeft': '서랍을 왼쪽으로', // REVIEW(ko) B6 电脑版新加
  'desk.toRight': '서랍을 오른쪽으로', // REVIEW(ko) B6 电脑版新加
} satisfies Record<DeskMsgKey, string>;
