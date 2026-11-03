// 功能 today 的词典·韩文（架构 2.4）：键和中文一一对应；“现在”卡照皮肤视觉稿 KT.ko，其余逐行待 AI 韩文审校（R-106）
import type { zh } from './zh.ts';

export const ko: Readonly<Record<keyof typeof zh, string>> = {
  'today.title': '오늘', // REVIEW(ko)
  'today.date': '{date}', // REVIEW(ko)
  'now.live': '진행 중', // 视觉稿 KT.ko
  'now.live2': '진행 중 {n}개', // 视觉稿 KT.ko
  'now.idle': '다음 일정', // 视觉稿 KT.ko
  'now.now': '지금 {t}', // 视觉稿 KT.ko
  'now.left': '{d} 남음', // 视觉稿 KT.ko
  'now.in': '{d} 후', // 视觉稿 KT.ko
  'now.also': '동시에: {title} · {end}까지 · {d} 남음', // 视觉稿 KT.ko
  'now.alsoMore': '동시에 {n}개 더', // REVIEW(ko)
  'now.hint': '다음 {t} {title} · {d} 후', // 视觉稿 KT.ko
  'now.done': '오늘 일정이 모두 끝났어요', // REVIEW(ko)
  'now.doneNext': '내일 {t} {title}', // REVIEW(ko)
  'now.empty': '오늘은 일정이 없어요', // REVIEW(ko)
  'dur.hm': '{h}시간 {m}분', // 视觉稿 kDur
  'dur.h': '{h}시간', // 视觉稿 kDur
  'dur.m': '{m}분', // 视觉稿 kDur
  'late.title': '놓친 일', // REVIEW(ko)
  'late.days': '{n}일 지남', // REVIEW(ko)
  'late.passed': '{t} 지남', // REVIEW(ko)
  'list.title': '오늘 할 일', // REVIEW(ko)
  'list.empty': '오늘은 예정된 일이 없어요', // REVIEW(ko)
  'list.allDay': '종일', // REVIEW(ko)
  'list.due': '{t} 마감', // REVIEW(ko)
  'list.dueDay': '오늘 마감', // REVIEW(ko)
  'list.origin': '({zone} {t})', // REVIEW(ko)
  'list.done': '완료', // REVIEW(ko)
  'list.undoDone': '완료 취소', // REVIEW(ko)
  'list.delete': '삭제', // REVIEW(ko)
  'toast.deleted': '삭제했어요', // REVIEW(ko)
  'toast.undo': '실행 취소', // REVIEW(ko)
  'err.save': '저장하지 못했어요. 잠시 후 다시 시도해 주세요', // REVIEW(ko)
  'err.readonly': '새 버전으로 업데이트해야 수정할 수 있어요', // REVIEW(ko)
  'trash.title': '최근 삭제', // REVIEW(ko)
  'trash.back': '뒤로', // REVIEW(ko)
  'trash.note': '삭제한 일정과 할 일은 30일 동안 보관된 뒤 자동으로 정리돼요', // REVIEW(ko)
  'trash.empty': '최근 삭제한 항목이 없어요', // REVIEW(ko)
  'trash.left': '{n}일 후 정리', // REVIEW(ko)
  'trash.restore': '복원', // REVIEW(ko)
  'trash.restored': '복원했어요', // REVIEW(ko)
  'trash.kind.events': '일정', // REVIEW(ko)
  'trash.kind.todos': '할 일', // REVIEW(ko)
};
