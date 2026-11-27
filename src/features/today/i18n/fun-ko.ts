// 功能 today 的词典·韩文：今天页没日程时的组合区；键和 fun-zh.ts 一一对应（待审校）
import type { todayFunZh } from './fun-zh.ts';

export const todayFunKo: Record<keyof typeof todayFunZh, string> = {
  'fun.quickQ': '오늘 비어 있는데, 이것부터 해 볼까요?',
  'fun.quickMeta': '날짜 없음 · {n}일 전에 적음',
  'fun.quickMetaToday': '날짜 없음 · 오늘 적음',
  'fun.quickGo': '오늘로',
  'fun.quickGoLabel': '오늘로 옮기기: {title}',
  'fun.week': '이번 주 완료',
  'fun.weekUnit': '개',
  'fun.weekUp': '지난주보다 +{n}',
  'fun.weekDown': '지난주보다 −{n}',
  'fun.weekSame': '지난주와 같아요',
  'fun.wd': '일월화수목금토',
  'fun.weekLabel': '이번 주 {n}개 완료, {vs}. 요일별: {days}',
  'fun.weekDay': '{w} {n}개',
} as const;
