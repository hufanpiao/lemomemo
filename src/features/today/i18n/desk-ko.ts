// 功能 today 的词典·韩文：电脑版今天页的面板；键和 desk-zh.ts 一一对应（B6 新写，待审校，R-106）
// satisfies Record<keyof typeof deskZh, string>：少一个键、多一个键都编译不过
import type { deskZh } from './desk-zh.ts';

export const deskKo = {
  'desk.river': '오늘 일정', // REVIEW(ko) B6
  'desk.week': '이번 주', // REVIEW(ko) B6
  'desk.soon': '다가오는 날', // REVIEW(ko) B6
  'desk.notesN': '오늘 쓴 메모 {n}', // REVIEW(ko) B6
  'desk.keysTitle': '단축키', // REVIEW(ko) B6
  'desk.goCal': '캘린더', // REVIEW(ko) B6
  'desk.goAnniv': '기념일', // REVIEW(ko) B6
  'desk.goNotes': '메모', // REVIEW(ko) B6
  'desk.keys': 'J / K 위아래 · E 완료 · Enter 편집', // REVIEW(ko) B6
  'desk.tipExe': '어느 창에서든 Ctrl+Alt+Space를 누르면 입력창이 떠요. 한 줄 쓰고 Enter를 누르면 기록돼요.', // REVIEW(ko) B6
  'desk.tipWeb': 'Ctrl+N을 누르면 입력창이 떠요. 한 줄 쓰고 Enter를 누르면 기록돼요.', // REVIEW(ko) B6
  'desk.lunar': '음력 {d}', // REVIEW(ko) B6
  'desk.drawer': '상세', // REVIEW(ko) B6
  'desk.weekDay': '{w} {n}건', // REVIEW(ko) B6
  'desk.soonNone': '{n}일 안에 기념일이 없어요', // REVIEW(ko) B6
} as const satisfies Record<keyof typeof deskZh, string>;
