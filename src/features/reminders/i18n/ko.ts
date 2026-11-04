// 功能 reminders 的词典·韩文（B2 FA-4）。自译初稿逐行标 REVIEW(ko)；R-106 B2 韩文审校第一遍（docs/03-评审/B2/B2-韩文审校-第一遍.md）改过的行
// 换成“R-106 B2 第一遍已审（11-04）”并注明条目编号；改了但还要韩语母语者确认的仍标 REVIEW(ko)
// 语气统一用해요체（和其他功能一致）
// satisfies Record<keyof typeof remindZh, string>：少一个键、多一个键都编译不过；占位符一致由 __tests__/remind-i18n.test.ts 查
import type { remindZh } from './zh.ts';

export const remindKo = {
  'remind.a11y.region': '알림', // REVIEW(ko)
  'remind.banner.event': '일정 · {when}', // REVIEW(ko)
  'remind.banner.todo': '할 일 알림 · {when}', // REVIEW(ko)
  'remind.banner.detail': '자세히 ›', // REVIEW(ko)
  'remind.banner.collapse': '접어 두기', // REVIEW(ko)
  'remind.banner.more': '{n}개 더 있어요', // REVIEW(ko)
  'remind.when.startIn': '{n}분 후 시작', // REVIEW(ko)
  'remind.when.startAt': '{time} 시작', // REVIEW(ko)
  'remind.when.started': '시작됨', // REVIEW(ko)
  'remind.when.dueToday': '오늘 마감', // REVIEW(ko)
  'remind.when.dueAt': '오늘 {time} 마감', // REVIEW(ko)
  'remind.when.dueOn': '{m}월 {d}일 마감', // REVIEW(ko)
  'remind.when.overdue': '마감 지남', // REVIEW(ko)
  'remind.when.noDue': '마감일 없음', // REVIEW(ko)
  'remind.act.ack': '확인', // REVIEW(ko)
  'remind.act.snooze10': '10분 후', // REVIEW(ko)
  'remind.act.atStart': '시작할 때 알림', // R-106 B2 第一遍已审（11-04）（B2K-S04）
  'remind.act.hour1': '1시간 후', // REVIEW(ko)
  'remind.act.tomorrow': '내일 다시 알림', // R-106 B2 第一遍已审（11-04）（B2K-S05）
  'remind.act.genTodo': '할 일 만들기', // REVIEW(ko)
  'remind.snoozed': '{time}에 다시 알려 드릴게요', // REVIEW(ko)
  'remind.saveFailed': '저장하지 못했어요. 잠시 후 다시 시도해 주세요', // R-106 B2 第一遍已审（11-04）（B2K-S08）
  'remind.readonly': '새 버전으로 업데이트해야 고칠 수 있어요', // R-106 B2 第一遍已审（11-04）（B2K-S09）
  'remind.missed.row': '놓친 알림 {n}개', // REVIEW(ko)
  'remind.missed.open': '보기 ›', // REVIEW(ko)
  'remind.missed.titleN': '놓친 알림 {n}', // REVIEW(ko)
  'remind.missed.note': '처리하지 못한 알림이 여기 모여 있어요', // REVIEW(ko)
  'remind.missed.allAck': '모두 확인', // REVIEW(ko)
  'remind.missed.head': '{day} {time} ·', // REVIEW(ko)
  'remind.missed.started': '(이미 시작됨)', // R-106 B2 第一遍已审（11-04）（B2K-S06）
  'remind.missed.empty': '놓친 알림이 없어요', // REVIEW(ko)
  'remind.kindName.event': '일정', // REVIEW(ko)
  'remind.kindName.todo': '할 일', // REVIEW(ko)
  'remind.kindAlert.todo': '할 일 알림', // REVIEW(ko)
  'remind.day.today': '오늘', // REVIEW(ko)
  'remind.day.yesterday': '어제', // REVIEW(ko)
  'remind.day.tomorrow': '내일', // REVIEW(ko)
  'remind.day.date': '{m}월 {d}일', // REVIEW(ko)
  'remind.wd.0': '일요일', // REVIEW(ko)
  'remind.wd.1': '월요일', // REVIEW(ko)
  'remind.wd.2': '화요일', // REVIEW(ko)
  'remind.wd.3': '수요일', // REVIEW(ko)
  'remind.wd.4': '목요일', // REVIEW(ko)
  'remind.wd.5': '금요일', // REVIEW(ko)
  'remind.wd.6': '토요일', // REVIEW(ko)
  'remind.full.back': '뒤로', // REVIEW(ko)
  'remind.full.pos': '{n}개 중 {i}번째', // REVIEW(ko)
  'remind.full.head.event': '일정 · {when}', // REVIEW(ko)
  'remind.full.head.todo': '할 일 알림 · {when}', // REVIEW(ko)
  'remind.full.until': '{time}까지', // REVIEW(ko)
  'remind.full.loc': '장소 / 링크', // REVIEW(ko)
  'remind.full.note': '메모', // REVIEW(ko)
  'remind.full.next': '다음: {title}', // REVIEW(ko)
  'remind.full.handled': '다른 기기에서 처리했어요', // REVIEW(ko)
  'remind.full.handledNote': '이미 처리한 알림이에요. 이 화면은 닫아도 돼요.', // R-106 B2 第一遍已审（11-04）（B2K-S02）
  'remind.full.gone': '이 알림을 찾을 수 없어요', // REVIEW(ko)
  'remind.full.goneNote': '삭제됐거나 아직 이 기기에 동기화되지 않았을 수 있어요.', // REVIEW(ko)
  'remind.full.home': '오늘로 돌아가기', // REVIEW(ko)
  'remind.full.doneA11y': '이 할 일 완료', // REVIEW(ko)
  'remind.set.title': '알림', // REVIEW(ko)
  'remind.set.summary.on': '알림 켜짐', // REVIEW(ko)
  'remind.set.summary.off': '알림 꺼짐, 알림이 안 울려요', // REVIEW(ko)：照线框 s13 补后半句（设计复审 M2）
  'remind.set.summary.desk': 'Windows 알림', // REVIEW(ko)
  'remind.set.notify': '알림 허용', // REVIEW(ko)
  'remind.set.notify.on': '켜짐', // REVIEW(ko)
  'remind.set.notify.off': '꺼짐', // REVIEW(ko)：和首页同一个说法（设计复审 M2）
  'remind.set.notify.enable': '알림 켜기', // REVIEW(ko)
  'remind.set.notify.denied': '알림이 꺼져 있어서 제때 알려 드릴 수 없어요. 시스템 설정에서 레모 알림을 허용해 주세요.', // R-106 B2 第一遍已审（11-04）（B2K-S03）
  'remind.set.notify.tauri': 'PC 앱은 Windows 알림을 써요', // R-106 B2 第一遍已审（11-04）（B2K-02）
  'remind.set.notify.unsupported': '이 브라우저는 알림을 받을 수 없어요', // REVIEW(ko)
  'remind.set.showTitle': '알림에 표시할 내용', // REVIEW(ko)
  'remind.set.showTitle.on': '제목과 이름 그대로', // REVIEW(ko)
  'remind.set.showTitle.off': '잠금 화면에는 “일정 1개”만', // REVIEW(ko)
  'remind.set.showTitle.note': '잠금 화면 표시를 고르면 “15:00 일정 1개”, “할 일 1개”처럼만 보여 주고, 제목과 마감 시각은 쓰지 않아요.', // REVIEW(ko)：只留一层引号（设计复审 L3）
  'remind.set.dnd': '방해 금지', // REVIEW(ko)
  'remind.set.dnd.from': '시작', // REVIEW(ko)
  'remind.set.dnd.to': '종료', // REVIEW(ko)
  'remind.set.dnd.note': '방해 금지 시간에 걸린 알림은 끝난 뒤에 울려요.', // REVIEW(ko)
  'remind.set.dnd.range': '{start} – {end}', // REVIEW(ko)：R-347
  'remind.set.dnd.off': '꺼짐', // REVIEW(ko)：R-347，和 remind.set.notify.off 同一个说法
  'remind.set.dnd.same': '시작과 종료를 같은 시각으로 정할 수 없어요', // R-106 B2 第一遍已审（11-04）（B2K-S15）
  'remind.set.upcoming': '앞으로 7일 알림', // REVIEW(ko)
  'remind.set.upcoming.note': '앞으로 일주일 동안 울릴 알림을 볼 수 있어요. 하나를 누르면 고칠 수 있어요.', // REVIEW(ko)
  'remind.set.test': '알림이 오는지 확인', // REVIEW(ko)
  'remind.set.test.btn': '한 번 보내 보기', // REVIEW(ko)
  'remind.set.test.sending': '보내는 중…', // REVIEW(ko)
  'remind.set.test.sent': '보냈어요. 이 기기에 왔는지 확인해 보세요', // REVIEW(ko)
  'remind.set.test.noDevice': '알림을 받을 수 있는 기기가 없어요. 먼저 알림을 켜 주세요', // R-106 B2 第一遍已审（11-04）（B2K-S10）
  'remind.set.test.resubscribe': '알림 연결이 끊겼어요. 알림을 다시 켜 주세요', // R-106 B2 第一遍已审（11-04）（B2K-S10）
  'remind.set.test.rate': '테스트는 1시간에 5번까지 할 수 있어요. 잠시 후 다시 시도해 주세요', // R-106 B2 第一遍已审（11-04）（B2K-S07）
  'remind.set.test.offline': '인터넷에 연결한 뒤 다시 시도해 주세요', // R-106 B2 第一遍已审（11-04）（B2K-S08）
  'remind.set.test.failed': '보내지 못했어요. 잠시 후 다시 시도해 주세요', // R-106 B2 第一遍已审（11-04）（B2K-S08）
  'remind.set.test.help': '안 왔나요? 시스템 설정에서 레모 알림이 켜져 있는지, 집중 모드가 켜져 있지 않은지 확인해 보세요.', // REVIEW(ko)
  'remind.set.localTest.title': '레모 테스트 알림', // REVIEW(ko)
  'remind.set.localTest.body': '이 알림이 보이면 이 컴퓨터에서 알림을 띄울 수 있어요.', // REVIEW(ko)
  'remind.set.test.localShown': '띄웠어요. 화면 오른쪽 아래를 확인해 보세요', // REVIEW(ko)
  'remind.set.test.localDenied': 'Windows 알림이 꺼져 있어요. 설정 › 시스템 › 알림에서 레모를 켜 주세요', // REVIEW(ko)
  'remind.set.test.localFailed': '띄우지 못했어요. 잠시 후 다시 시도해 주세요', // R-106 B2 第一遍已审（11-04）（B2K-S08）
  'remind.set.inUse.self': '이 기기의 예전 로그인 기록이 아직 이 기기의 알림을 받고 있어요. 이 기록을 제거해야 지금 로그인한 상태로 알림이 와요.', // REVIEW(ko)：B2K-S12 已按审校改，待韩语母语者确认
  'remind.set.inUse.other': '다른 기기 기록 “{label}” (최근 사용 {date})이 이 기기의 알림을 받고 있어요. 예전에 인터넷이 끊긴 상태에서 로그아웃해서 남은 기록일 가능성이 커요.', // REVIEW(ko)：B2K-S13 已按审校改，待韩语母语者确认
  'remind.set.inUse.remove': '제거', // R-106 B2 第一遍已审（11-04）（B2K-04）
  'remind.set.inUse.removing': '제거하는 중…', // R-106 B2 第一遍已审（11-04）（B2K-04）
  'remind.set.inUse.removed': '제거했어요. 이제 이 기기로 알림이 와요', // R-106 B2 第一遍已审（11-04）（B2K-04）
  'remind.set.inUse.reclaimFailed': '제거했지만 알림이 아직 연결되지 않았어요. “다시 연결”을 눌러 주세요', // R-106 B2 第一遍已审（11-04）（B2K-04）
  'remind.set.inUse.reconnect': '다시 연결', // REVIEW(ko)
  'remind.set.inUse.reconnecting': '연결하는 중…', // REVIEW(ko)
  'remind.set.inUse.confirmTitle': '이 기기 기록을 제거할까요?', // R-106 B2 第一遍已审（11-04）（B2K-04）
  'remind.set.inUse.confirmBody': '“{label}” (최근 사용 {date}) 기록을 제거해요. 제거하면 그 기기는 로그아웃되고, 더 이상 알림을 받지 않아요.', // R-106 B2 第一遍已审（11-04）（B2K-04）
  'remind.set.inUse.confirmBodySelf': '이 기기의 예전 로그인 기록 (최근 사용 {date})을 제거해요. 제거하면 예전 로그인은 로그아웃되고, 더 이상 알림을 받지 않아요.', // R-106 B2 第一遍已审（11-04）（B2K-04）
  'remind.set.inUse.confirmOk': '제거', // R-106 B2 第一遍已审（11-04）（B2K-04）
  'remind.set.inUse.cancel': '취소', // REVIEW(ko)
  'remind.set.inUse.failed': '제거하지 못했어요. 잠시 후 다시 시도해 주세요', // R-106 B2 第一遍已审（11-04）（B2K-04）
  'remind.set.inUse.offline': '인터넷에 연결한 뒤 다시 시도해 주세요', // R-106 B2 第一遍已审（11-04）（B2K-S08）
  'remind.set.inUse.noLabel': '이름 없는 기기', // REVIEW(ko)
  'remind.set.inUse.noDate': '알 수 없음', // REVIEW(ko)
  'remind.set.resubscribe': '알림을 다시 켜야 해요. 여기를 눌러 주세요', // R-106 B2 第一遍已审（11-04）（B2K-S10）
  'remind.set.notSupported': '이 브라우저에서는 아직 레모 알림을 받을 수 없어요', // R-106 B2 第一遍已审（11-04）（B2K-S14）
  'remind.set.saveFailed': '저장하지 못했어요. 잠시 후 다시 시도해 주세요', // R-106 B2 第一遍已审（11-04）（B2K-S08）
  'remind.up.empty': '앞으로 7일 동안 알림이 없어요', // REVIEW(ko)
  'remind.up.date': '{date} {wd}', // REVIEW(ko)
  'remind.up.dayRel': '{label} · {full}', // REVIEW(ko)
  'remind.up.count': '{n}개', // REVIEW(ko)
  'remind.up.summary': '지금 {time} 이후 · 모두 {n}개', // REVIEW(ko)
  'remind.up.noneOn': '{days} 알림 없음', // REVIEW(ko)
  'remind.up.sep': ', ', // REVIEW(ko)
  'remind.up.rangeMonth': '{m}월 {d1}~{d2}일', // REVIEW(ko)：连着的几天合并写（设计复审 M1）
  'remind.up.range': '{from}~{to}', // REVIEW(ko)
  'remind.up.evSub': '{time} 시작 · {mode}', // REVIEW(ko)
  'remind.up.evSubDay': '{day} {time} 시작 · {mode}', // REVIEW(ko)
  'remind.up.tdSub': '할 일 · {mode}', // REVIEW(ko)
  'remind.mode.snoozed': '나중에 다시 알림', // REVIEW(ko)
  'remind.mode.onTime': '시작할 때 알림', // R-106 B2 第一遍已审（11-04）（B2K-03）
  'remind.mode.beforeMin': '{n}분 전', // REVIEW(ko)
  'remind.mode.beforeHour': '{n}시간 전', // REVIEW(ko)
  'remind.mode.beforeDay': '{n}일 전', // REVIEW(ko)
  'remind.mode.dueOnTime': '마감 시각에 알림', // REVIEW(ko)
  'remind.mode.dueBeforeMin': '마감 {n}분 전', // REVIEW(ko)
  'remind.mode.dueBeforeHour': '마감 {n}시간 전', // REVIEW(ko)
  'remind.mode.dueBeforeDay': '마감 {n}일 전', // REVIEW(ko)
  'remind.mode.sameDay': '당일 {time}', // REVIEW(ko)
  'remind.mode.dayBefore': '전날 {time}', // REVIEW(ko)
  'remind.unsynced': '동기화 안 됨. 알림이 안 울릴 수 있어요', // REVIEW(ko)
  'remind.unsynced.mark': '동기화 안 됨', // REVIEW(ko)
  'remind.clock.wrongNote': '이 기기 시간이 서버와 약 {min}분 차이 나요. 알림은 서버 시간 기준으로 울려요.', // REVIEW(ko)
} as const satisfies Record<keyof typeof remindZh, string>;
