// 功能 today 的词典·韩文：电脑版今天页的面板；键和 desk-zh.ts 一一对应（待审校）
// satisfies Record<keyof typeof todayDeskZh, string>：少一个键、多一个键都编译不过
import type { todayDeskZh } from './desk-zh.ts';

export const todayDeskKo = {
  'desk.river': '오늘 일정', // REVIEW(ko)
  'desk.week': '이번 주', // REVIEW(ko)
  'desk.soon': '가까운 기념일', // REVIEW(ko) “最近的纪念日”
  'desk.notesN': '오늘 쓴 메모 {n}', // REVIEW(ko)
  'desk.keysTitle': '단축키', // REVIEW(ko)
  'desk.goCal': '캘린더', // REVIEW(ko)
  'desk.goAnniv': '기념일', // REVIEW(ko)
  'desk.goNotes': '메모', // REVIEW(ko)
  'desk.keys': 'J / K 위아래 · E 완료 · Enter 편집', // REVIEW(ko)
  'desk.tipExe': '어느 창에서든 Ctrl+Shift+Space(기본값, 설정에서 변경 가능)를 누르면 입력창이 떠요. 한 줄 쓰고 Enter를 누르면 기록돼요.', // REVIEW(ko)
  'desk.tipWeb': 'Ctrl+N을 누르면 입력창이 떠요. 한 줄 쓰고 Enter를 누르면 기록돼요.', // REVIEW(ko)
  'desk.lunar': '음력 {d}', // REVIEW(ko)
  'desk.drawer': '상세', // REVIEW(ko)
  'desk.weekDay': '{s}, {w} {n}건', // REVIEW(ko)；s 是格子里看得见的字（TodayDesk.tsx dayName）
  'desk.soonNone': '아직 기념일이 없어요', // REVIEW(ko) 一个纪念日都没有时
  'desk.weekN': '{n}개', // REVIEW(ko)
  'desk.wd': '일월화수목금토', // REVIEW(ko)
  'desk.today': '오늘', // REVIEW(ko)
  'desk.sched': '{d} 일정', // REVIEW(ko)
  'desk.todos': '{d} 할 일', // REVIEW(ko)
  'desk.schedNone': '이 날은 일정이 없어요', // REVIEW(ko)
  'desk.todosNone': '이 날은 할 일이 없어요', // REVIEW(ko)
  'desk.doneN': '완료 {n}', // REVIEW(ko) 同待办页 list.g.doneN
} as const satisfies Record<keyof typeof todayDeskZh, string>;
