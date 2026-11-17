// 功能 today 的词典·韩文（架构 2.4）：键和中文一一对应；“现在”卡照皮肤视觉稿 KT.ko，其余逐行待 AI 韩文审校（R-106）
import type { zh } from './zh.ts';

export const ko: Readonly<Record<keyof typeof zh, string>> = {
  'today.title': '오늘', // REVIEW(ko)
  'today.date': '{date}', // REVIEW(ko)
  'now.live': '진행 중', // 视觉稿 KT.ko
  'now.live2': '진행 중 {n}개', // 视觉稿 KT.ko
  'now.idle': '다음 일정', // 视觉稿 KT.ko
  'now.empty': '오늘 일정 없음', // REVIEW(ko)
  'now.done': '오늘 일정 끝', // REVIEW(ko)
  'now.allDay': '종일 · {title}', // REVIEW(ko)
  'now.allDayN': '종일 {n}개', // REVIEW(ko)
  'now.now': '지금 {t}', // 视觉稿 KT.ko
  'now.left': '{d} 남음', // 视觉稿 KT.ko
  'now.in': '{d} 후', // 视觉稿 KT.ko
  'now.also': '동시에: {title} · {end}까지 · {d} 남음', // 视觉稿 KT.ko
  'now.alsoMore': '동시에 {n}개 더', // REVIEW(ko)
  'now.hint': '다음 {t} {title} · {d} 후', // 视觉稿 KT.ko
  'now.doneNext': '내일 {t} {title}', // REVIEW(ko)
  'late.title': '놓친 일', // REVIEW(ko)
  'late.days': '{n}일 지남', // REVIEW(ko)
  'late.passed': '{t} 지남', // REVIEW(ko)
  'list.title': '오늘 일정', // R-337（11-04 负责人定；R-106 B2 审校第三节 ①）
  'list.empty': '오늘은 예정된 일이 없어요', // REVIEW(ko)
  'list.due': '{t} 마감', // REVIEW(ko)
  'list.dueDay': '오늘 마감', // REVIEW(ko)
  'prio': '우선순위: {p}, 누르면 {next}(으)로 바뀜', // REVIEW(ko)
  'prio.high': '높음', // REVIEW(ko)
  'prio.mid': '보통', // REVIEW(ko)
  'prio.low': '낮음', // REVIEW(ko)
  'list.origin': '({zone} {t})', // REVIEW(ko)
  'list.done': '완료', // REVIEW(ko)
  'list.undoDone': '완료 취소', // REVIEW(ko)
  'list.delete': '삭제', // REVIEW(ko)
  'list.past': '지난 일 {n}건: {items}', // REVIEW(ko) B6 线框 s1“已过去”
  'toast.deleted': '삭제했어요', // REVIEW(ko)
  'toast.undo': '실행 취소', // REVIEW(ko)
  'toast.done': '완료했어요', // REVIEW(ko) 11-17 同待办页 list.doneToast
  'stage.1': '시작', // REVIEW(ko) 11-17 同待办页 items.stage.1
  'stage.2': '절반 넘음', // REVIEW(ko) 11-17 同待办页 items.stage.2
  'err.save': '저장하지 못했어요. 잠시 후 다시 시도해 주세요', // REVIEW(ko)
  'err.readonly': '새 버전으로 업데이트해야 수정할 수 있어요', // REVIEW(ko)
  'today.micDenied': '마이크가 꺼져 있어서 음성 기록을 쓸 수 없어요. iPhone “설정”에서 이 앱의 마이크를 켜 주세요.', // REVIEW(ko)
  'today.micDeniedWeb': '마이크가 꺼져 있어서 음성 기록을 쓸 수 없어요. 브라우저 설정에서 이 사이트의 마이크를 켜 주세요.', // REVIEW(ko) R-367 iPhone 아닌 기기
  'today.anniv.today': '오늘', // REVIEW(ko) B5
  'today.anniv.tomorrow': '내일', // REVIEW(ko) B5
  'today.anniv.in': '{n}일 후', // REVIEW(ko) B5
  'today.anniv.bday': '생일', // REVIEW(ko) B6 线框 s1 ANNLINE
};
