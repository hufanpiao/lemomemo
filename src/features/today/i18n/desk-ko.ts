// 功能 today 的词典·韩文：电脑版今天页的面板；键和 desk-zh.ts 一一对应（B6 新写，待审校，R-106）
// satisfies Record<keyof typeof deskZh, string>：少一个键、多一个键都编译不过
import type { deskZh } from './desk-zh.ts';

export const deskKo = {
  'desk.now': '지금', // REVIEW(ko) B6
  'desk.river': '오늘 일정', // REVIEW(ko) B6
  'desk.week': '이번 주', // REVIEW(ko) B6
  'desk.soon': '다가오는 날', // REVIEW(ko) B6
  'desk.notes': '오늘 쓴 메모', // REVIEW(ko) B6
  'desk.keys': 'J / K 위아래 · E 완료 · Enter 편집', // REVIEW(ko) B6
  'desk.weekDay': '{w} {n}건', // REVIEW(ko) B6
  'desk.soonNone': '30일 안에 기념일이 없어요', // REVIEW(ko) B6
} as const satisfies Record<keyof typeof deskZh, string>;
