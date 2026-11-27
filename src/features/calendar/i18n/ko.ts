// 功能 calendar 的词典·韩文：日程编辑页。全部是自译初稿，等母语者校对，逐行标 REVIEW(ko)
// satisfies Record<keyof typeof zh, string>：少一个键、多一个键都编译不过
import type { zh } from './zh.ts';

export const ko = {
  'event.edit.kind': '일정', // REVIEW(ko)
  'event.edit.newKind': '새 일정', // REVIEW(ko)
  'event.edit.back': '뒤로', // REVIEW(ko)
  'event.edit.titleLabel': '제목', // REVIEW(ko)
  'event.edit.titlePh': '예: 금요일에 지민이랑 저녁', // REVIEW(ko)
  'event.edit.startTime': '시작 시간', // REVIEW(ko)
  'event.edit.endTime': '종료 시간', // REVIEW(ko)
  'event.edit.allDay': '종일', // 不用“하루 종일”：375 宽日期框放不下
  'event.edit.start': '시작', // REVIEW(ko)
  'event.edit.end': '종료', // REVIEW(ko)
  'event.edit.endRange': '종료는 {from}~{to} 사이에서 고를 수 있어요', // REVIEW(ko) 选择器
  'event.edit.endNextDay': '시작보다 빨라서 다음 날로 계산해요', // REVIEW(ko) 选择器
  'event.edit.endTooLong': '최대 {n}일까지예요. 종료를 조금 앞당겨 주세요', // REVIEW(ko) 选择器
  'event.edit.tz': '시간대', // REVIEW(ko)
  'event.edit.tzLocal': '이 시간대 기준이에요. 지금 계신 곳에서는 {date} {time}이에요', // REVIEW(ko)
  'event.edit.remind': '알림', // REVIEW(ko)
  'event.edit.min.none': '알리지 않음', // REVIEW(ko)
  'event.edit.min.0': '시작할 때', // REVIEW(ko)
  'event.edit.min.15': '15분 전', // REVIEW(ko)
  'event.edit.min.30': '30분 전', // REVIEW(ko)
  'event.edit.min.60': '1시간 전', // REVIEW(ko)
  'event.edit.min.1440': '1일 전', // REVIEW(ko)
  'event.edit.days.none': '알리지 않음', // REVIEW(ko)
  'event.edit.days.0': '당일', // REVIEW(ko)
  'event.edit.days.1': '전날', // REVIEW(ko)
  'event.edit.location': '장소 / 링크', // REVIEW(ko)
  'event.edit.project': '프로젝트', // REVIEW(ko)
  'event.edit.note': '메모', // REVIEW(ko)
  'event.edit.locationPh': '어디서? 회의 링크를 붙여도 돼요', // REVIEW(ko) 占位
  'event.edit.projectPh': '회사, 집… 마음대로 나눠요', // REVIEW(ko) 占位
  'event.edit.notePh': '더 적고 싶으면 여기에', // REVIEW(ko) 占位
  'event.edit.raw': '원래 한 말', // REVIEW(ko)
  'event.edit.groupTime': '시간', // REVIEW(ko)
  'event.edit.groupDetail': '자세히', // REVIEW(ko)
  'event.edit.delete': '이 일정 삭제', // REVIEW(ko)
  'event.edit.st.empty': '제목을 써야 저장돼요', // REVIEW(ko)
  'event.edit.st.rejected': '형식이 맞지 않아 저장하지 못했어요 (제목이 너무 길거나 날짜·시간대가 맞지 않아요)', // REVIEW(ko)
} as const satisfies Record<keyof typeof zh, string>;
