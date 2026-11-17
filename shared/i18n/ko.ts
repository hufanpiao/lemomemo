// 公共词典·韩文：已过 R-106 B1 第一遍审校（10-31，逐行标“R-106 B1 第一遍已审”）；以后新加的行先标 REVIEW(ko)，审过再换标记
// satisfies Record<MsgKey, string>：少一个键、多一个键都编译不过（架构 2.4）
import type { SharedMsgKey } from './i18n.ts';
// App 名、退出屏、出错屏、升级整屏提示的词条在 boot-ko.ts（同 zh.ts 的 boot-zh.ts），这里展开
import { bootKo } from './boot-ko.ts';

export const ko = {
  ...bootKo,
  'app.settings': '설정', // 同 settings.title（R-106 B1 第一遍已审）；B0 占位页上的设置入口（PLACEHOLDER-settings-link，B2 换真页面时去掉）
  'nav.label': '메인 메뉴', // R-106 已审（11-05，B2-韩文审校-TILT与主导航 N-1）：不分宽窄（D5 侧栏不在底部）；不用“주 메뉴”，免得和日历的“주”（周视图）混听
  'nav.today': '오늘', // R-106 B2 FA-7 底栏已审（11-05）
  'nav.calendar': '캘린더', // R-106 B2 FA-7 底栏已审（11-05）
  'nav.todos': '할 일', // R-106 B2 FA-7 底栏已审（11-05）
  'nav.notes': '메모', // R-106 B2 FA-7 底栏已审（11-05）
  'nav.newEvent': '새 일정', // R-106 B2 FA-7 底栏已审（11-05）
  'nav.newTodo': '새 할 일', // R-106 B2 FA-7 底栏已审（11-05）
  'nav.add': '입력해서 기록하기', // REVIEW(ko) B3 M4 初稿
  'nav.plusPreparing': '준비 중', // REVIEW(ko) B3 Q4 初稿
  'nav.plusClose': '닫기', // REVIEW(ko) B3 初稿
  'notes.soon': '메모는 준비 중이에요', // R-106 B2 FA-7 底栏已审（11-05）（F-8：占位页标题是“레모”，写明是哪个功能）
  'common.ok': '확인', // R-106 B1 第一遍已审（10-31）
  'common.cancel': '취소', // R-106 B1 第一遍已审（10-31）
  'common.retry': '다시 시도', // R-106 B1 第一遍已审（10-31）
  'common.close': '닫기', // R-106 B1 第一遍已审（10-31）
  'error.unknown': '문제가 생겼어요. 잠시 후 다시 시도해 주세요', // R-106 B1 第一遍已审（10-31）
  'error.offline': '지금 인터넷에 연결되어 있지 않아요', // R-106 B1 第一遍已审（10-31）
  'feature.off': '이 기능은 아직 사용할 수 없어요', // R-106 B1 第一遍已审（10-29）
  'update.required': '동기화를 계속하려면 업데이트가 필요해요 · 기록한 내용은 이 기기에 그대로 있어요', // R-106 B1 第一遍已审（10-31）
  'update.available': '레모 새 버전이 있어요', // R-106 B1 第一遍已审（10-31）
  'update.reopen': '다시 열기', // R-106 B1 第一遍已审（10-31）
  'update.update': '업데이트', // R-106 B1 第一遍已审（10-30）；426 横幅的按钮（0.27 第 1 点“更新”）
  'update.queued': '변경 사항 {n}개는 업데이트한 뒤에 동기화돼요 · 내용은 이 기기에 그대로 있어요', // R-106 B1 第一遍已审（10-30），按审校意见改过；426 时排队的条数（0.27 第 1 点）
  'update.newVersion': '새 버전이 있어요', // R-106 B1 第一遍已审（10-30）；SW 有新版本的横幅（8.1“有新版本 · 重新打开”），按钮沿用 update.reopen
  'remind.push.event': '{time} {title}', // R-106 B1 第一遍已审（10-31）
  'remind.push.allDayToday': '오늘 · {title}', // REVIEW(ko)
  'remind.push.allDayTomorrow': '내일 · {title}', // REVIEW(ko)
  'remind.push.hiddenAllDayToday': '오늘 일정 1개', // R-106 B2 第一遍已审（11-04）（B2K-01 锁屏短式）
  'remind.push.hiddenAllDayTomorrow': '내일 일정 1개', // R-106 B2 第一遍已审（11-04）（B2K-01 锁屏短式）
  'remind.push.hiddenAllDay': '일정 1개', // R-106 B2 第一遍已审（11-04）（B2K-01 锁屏短式）
  'remind.push.todoDue': '{time} 마감', // REVIEW(ko)
  'remind.push.hidden': '{time} 일정 1개', // R-106 B2 第一遍已审（11-04）（B2K-01 锁屏短式）
  'remind.push.hiddenTodo': '{time} 할 일 1개', // R-106 B2 第一遍已审（11-04）（B2K-01 锁屏短式）
  'remind.push.hiddenAnniv': '{time} 기념일 1개', // R-106 B2 第一遍已审（11-04）（B2K-01 锁屏短式）
  'remind.push.action.snooze': '미루기', // REVIEW(ko)
  'remind.push.action.done': '완료', // REVIEW(ko)
  'remind.push.action.ack': '확인', // REVIEW(ko)
  'remind.push.fromClaude': 'Claude에서 · {text}', // REVIEW(ko)
  'push.resolved': '다른 기기에서 처리했어요', // REVIEW(ko)
  'push.test': '테스트 알림이에요. 푸시가 잘 연결됐어요', // REVIEW(ko)
  'fmt.monthDay': '{m}월 {d}일', // R-106 B1 第一遍已审（10-31）
  'fmt.monthDayWeek': '{m}월 {d}일 ({w})', // R-106 B1 第一遍已审（10-31）
  'fmt.wd.0': '일', // R-106 B1 第一遍已审（10-31）
  'fmt.wd.1': '월', // R-106 B1 第一遍已审（10-31）
  'fmt.wd.2': '화', // R-106 B1 第一遍已审（10-31）
  'fmt.wd.3': '수', // R-106 B1 第一遍已审（10-31）
  'fmt.wd.4': '목', // R-106 B1 第一遍已审（10-31）
  'fmt.wd.5': '금', // R-106 B1 第一遍已审（10-31）
  'fmt.wd.6': '토', // R-106 B1 第一遍已审（10-31）
  'fmt.dur.d': '{n}일', // REVIEW(ko) R-444
  'fmt.dur.h': '{n}시간', // 同视觉稿 kDur（原 today dur.h）
  'fmt.dur.m': '{n}분', // 同视觉稿 kDur（原 today dur.m）
  'fmt.dur.mTail': '{n}분', // 同视觉稿 kDur（原 today dur.hm 的后半）
  'update.syncPaused': '동기화를 잠시 멈췄어요. 조금 뒤에 다시 열어 주세요', // R-106 B1 第一遍已审（10-31），按审校意见 K-08 改过：一句里两个“잠시”；同 zh：探测说账号正常但 5 分钟内已重新载入过，同步暂停（10-30）
  'span.allDay': '종일', // 原 cal.allDay、list.allDay 合并（REVIEW(ko)）
  'span.ongoing': '계속', // REVIEW(ko) R-444（原 cal.day.ongoing、list.ongoing 合并）
  'span.until': '{t}까지', // REVIEW(ko) R-444（原 cal.day.until、list.until 合并）
  'span.untilDate': '{m}월 {d}일 {t}까지', // REVIEW(ko) R-444
  'span.dayOf': '{i}/{n}일째', // REVIEW(ko) R-444
  // 时区的通俗说法（tz.*）11-05 挪到 shared/i18n/tz-zh.ts、tz-ko.ts：只有登录页的恢复页和邮件用，不进主 App 首屏的公共词典
} as const satisfies Record<SharedMsgKey, string>;
