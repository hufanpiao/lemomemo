// 公共词典·韩文：已过 R-106 B1 第一遍审校（10-31，逐行标“R-106 B1 第一遍已审”）；以后新加的行先标 REVIEW(ko)，审过再换标记
// satisfies Record<MsgKey, string>：少一个键、多一个键都编译不过（架构 2.4）
import type { SharedMsgKey } from './i18n.ts';

export const ko = {
  'app.name': '레모', // R-106 B1 第一遍已审（10-31）
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
  'update.tooNew.title': '이 기기의 데이터는 새 버전에서 저장됐어요. 앱을 업데이트해 주세요', // R-106 B1 第一遍已审（10-31），按审校意见 K-07 改过：去掉叠用的“더 최신”，整屏标题短一截
  'update.tooNew.body': '지금 쓰는 버전에서는 이 데이터를 열 수 없어요. 업데이트하면 이어서 쓸 수 있고, 기록한 내용은 이 기기에 그대로 있어요.', // R-106 B1 第一遍已审（10-29）
  'update.tooNew.update': '업데이트하기', // R-106 B1 第一遍已审（10-29）
  'update.tooNew.refresh': '새로고침', // R-106 B1 第一遍已审（10-29）
  'update.updating': '업데이트 중…', // R-106 B1 第一遍已审（10-29）
  'update.failed': '업데이트하지 못했어요 · 인터넷에 연결한 뒤 다시 시도해 주세요', // R-106 B1 第一遍已审（10-29）
  'update.stillOld': '이미 최신 버전이에요. 잠시 후 다시 시도해 주세요', // R-106 B1 第一遍已审（10-29）
  'update.update': '업데이트', // R-106 B1 第一遍已审（10-30）；426 横幅的按钮（0.27 第 1 点“更新”）
  'update.queued': '변경 사항 {n}개는 업데이트한 뒤에 동기화돼요 · 내용은 이 기기에 그대로 있어요', // R-106 B1 第一遍已审（10-30），按审校意见改过；426 时排队的条数（0.27 第 1 点）
  'update.newVersion': '새 버전이 있어요', // R-106 B1 第一遍已审（10-30）；SW 有新版本的横幅（8.1“有新版本 · 重新打开”），按钮沿用 update.reopen
  'update.blocked.title': '열려 있는 다른 레모 창이나 탭을 닫아 주세요', // R-106 B1 第一遍已审（10-30）；“창이나 탭”负责人 10-30 定（明早清单第 25 条）；升级本机库被别的标签页挡住的整屏提示（TC-B1-48）
  'update.blocked.body': '다른 창이나 탭에서 아직 이전 버전을 쓰고 있어요. 그 창이나 탭을 닫으면 이 화면이 자동으로 이어서 열려요. 기록한 내용은 이 기기에 그대로 있어요.', // R-106 B1 第一遍已审（10-31），按审校意见 K-06 改过（接手清单 COPY-1030-sync ③）：补宾语“그 창이나 탭을”、主语“이 화면이”；“창이나 탭”负责人 10-30 定（明早清单第 25 条）；同上
  'app.crashed.title': '앗, 멈췄어요', // R-106 B1 第一遍已审（10-30）；App 顶层出错的整屏兜底（K6-sugg3 ⑥）
  'app.crashed.refresh': '새로고침', // R-106 B1 第一遍已审（10-30）；和 update.tooNew.refresh 统一成 새로고침
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
  'update.syncPaused': '동기화를 잠시 멈췄어요. 조금 뒤에 다시 열어 주세요', // R-106 B1 第一遍已审（10-31），按审校意见 K-08 改过：一句里两个“잠시”；同 zh：探测说账号正常但 5 分钟内已重新载入过，同步暂停（10-30）
  'update.stalled': '새 버전이 아직 준비되지 않았어요 · 잠시 후 다시 시도해 주세요', // R-106 B1 第一遍已审（10-31）；同 zh：查到新版本但 30 秒内没接管（BANNER-sugg ⑤，10-30）
  'exit.incomplete.title': '로그아웃이 끝나지 않았어요', // REVIEW(ko)；同 zh：exe 里退出时本机会话没删掉（A-1）
  'exit.incomplete.body': '이 컴퓨터의 로그인 정보가 지워지지 않았어요. “다시 시도”를 눌러 한 번 더 지워 주세요. 지워지기 전에는 로그인된 화면으로 돌아가지 않아요.', // REVIEW(ko)
  'exit.incomplete.retry': '다시 시도', // REVIEW(ko)
  'exit.incomplete.busy': '지우는 중…', // REVIEW(ko)
  'exit.incomplete.failed': '아직 지우지 못했어요. 잠시 후 다시 시도하거나 레모를 다시 열어 주세요', // REVIEW(ko)
  'exit.unavailable.title': '이 컴퓨터의 로그인 정보를 읽지 못했어요', // REVIEW(ko)；同 zh：installDesktopSession 失败（代码审查建议 4）
  'exit.unavailable.body': '레모를 다시 열어 주세요. 그래도 안 되면 컴퓨터를 다시 시작한 뒤 시도해 주세요.', // REVIEW(ko)
  'exit.unavailable.reopen': '다시 열기', // REVIEW(ko)
  // 时区的通俗说法（tz.*）11-05 挪到 shared/i18n/tz-zh.ts、tz-ko.ts：只有登录页的恢复页和邮件用，不进主 App 首屏的公共词典
} as const satisfies Record<SharedMsgKey, string>;
