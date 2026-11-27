// kit 选择器的词条·韩文（见 pick-zh.ts 文件头）
// satisfies Record<PickMsgKey, string>：少一个键、多一个键都编译不过
import type { PickMsgKey } from './pick-zh.ts';

export const pickKo = {
  'pick.clear': '지우기', // REVIEW(ko) 11-21 选择器新加
  'pick.ok': '확인', // REVIEW(ko) 11-21 选择器新加
  'pick.prevWeek': '이전 주', // REVIEW(ko) 11-21 选择器新加
  'pick.nextWeek': '다음 주', // REVIEW(ko) 11-21 选择器新加
  'pick.ym': '{y}년 {m}월', // REVIEW(ko) 11-21 选择器新加
  'pick.mm': '{a}월–{b}월', // REVIEW(ko) 11-21 选择器新加
  'pick.yy': '{ya}년 {a}월–{yb}년 {b}월', // REVIEW(ko) 11-22 评审第 14 条
  'pick.today': '오늘', // REVIEW(ko) 11-22 评审第 8 条
  'pick.wd': '일월화수목금토', // REVIEW(ko) 11-21 选择器新加
  'pick.hour': '시', // REVIEW(ko) 11-21 选择器新加
  'pick.minute': '분', // REVIEW(ko) 11-21 选择器新加
  'pick.hourName': '{h}시', // REVIEW(ko) 11-21 选择器新加
  'pick.minuteName': '{m}분', // REVIEW(ko) 11-21 选择器新加
  'pick.months': '월 선택', // REVIEW(ko) 11-23 跳月新加
  'pick.y': '{y}년', // REVIEW(ko) 11-23 跳月新加
  'pick.m': '{m}월', // REVIEW(ko) 11-23 跳月新加
  'pick.date': '날짜 선택', // REVIEW(ko) 11-21 选择器新加
  'pick.time': '시간 선택', // REVIEW(ko) 11-21 选择器新加
} as const satisfies Record<PickMsgKey, string>;
