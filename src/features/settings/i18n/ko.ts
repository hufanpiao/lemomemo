// 功能 settings 的词典·韩文（架构 2.4）
// K9 先放中文占位；10-30 补成韩文初稿，已过 R-106 B1 第一遍审校（10-30，标“R-106 B1 第一遍已审”）；
// 值里没有谚文的行（iPhone、Windows PC）测试要求带 TODO(ko)，审过也保留这个标记
// 语言名“中文”“한국어”两种界面一样，不用翻
// 10-30 导出、注销批新加的行已过 R-106 B1 第一遍审校（10-30）；以后新加的行标 REVIEW(ko)；用词照 10-30 结论：注销 = 회원 탈퇴，负责人 = 운영자
// satisfies Record<keyof typeof zh, string>：少一个键、多一个键都编译不过
import type { zh } from './zh.ts';

export const ko = {
  'settings.title': '설정', // R-106 B1 第一遍已审（10-30）
  'settings.back': '오늘', // R-106 B1 第一遍已审（10-30）；返回“今天”页的链接

  'settings.lang.title': '앱 언어', // R-106 B1 第一遍已审（10-30）
  'settings.lang.zh': '中文',
  'settings.lang.ko': '한국어',
  'settings.lang.note': '언어를 바꾸면 레모 화면이 바로 바뀌고, 알림과 메일도 이 언어로 보내 드려요.', // R-106 B1 第一遍已审（10-30）
  'settings.lang.syncFailed': '이 기기에서는 바꿨지만 계정에 동기화하지 못했어요. 인터넷에 연결한 뒤 한 번 더 바꿔 주세요', // R-106 B1 第一遍已审（10-30）

  'settings.devices.title': '로그인한 기기', // R-106 B1 第一遍已审（10-30）
  'settings.devices.loading': '기기 목록을 불러오는 중…', // R-106 B1 第一遍已审（10-30）
  'settings.devices.loadFailed': '기기 목록을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요', // R-106 B1 第一遍已审（10-30）
  'settings.devices.empty': '아직 기기 기록이 없어요', // R-106 B1 第一遍已审（10-30）
  'settings.devices.retry': '다시 시도', // R-106 B1 第一遍已审（10-30）；照 shared common.retry
  'settings.devices.thisDevice': '이 기기', // R-106 B1 第一遍已审（10-30）；标签
  'settings.devices.signedOut': '로그아웃됨', // R-106 B1 第一遍已审（10-30）；标签
  'settings.devices.lastSeen': '최근 사용 {date}', // R-106 B1 第一遍已审（10-30）
  'settings.devices.neverSeen': '아직 사용 기록이 없어요', // R-106 B1 第一遍已审（10-30）
  'settings.devices.stale': '오래 쓰지 않아 {date} 이후 자동으로 제거돼요', // R-106 B1 第一遍已审（10-30）
  'settings.devices.remove': '제거', // R-106 B1 第一遍已审（10-30）；移除照 auth.exit.removed 用 제거
  'settings.devices.removeThis': '로그아웃', // R-106 B1 第一遍已审（10-30）；按钮只写 로그아웃，读屏标签另带“（设备名）”（DevicesSection.tsx）
  'settings.devices.residual': '제거해도 그 기기는 최대 10분 동안 내 데이터를 읽고 쓸 수 있고, 그 뒤에 로그인 화면으로 돌아가요.', // R-106 B1 第一遍已审（10-30）
  'settings.devices.orphans': '기기 기록이 없는 로그인이 {n}건 더 있어요 (최근 {date})', // R-106 B1 第一遍已审（10-30）
  'settings.devices.signOutOthers': '다른 모든 기기에서 로그아웃', // R-106 B1 第一遍已审（10-30）；按钮；中文 8 字→韩文 15 字；auth.session.serverPending、settings.offlineOut.body 引号里引用这一句
  'settings.devices.signOutOthersDone': '다른 모든 기기에서 로그아웃했어요. 그 기기들은 늦어도 10분 안에 로그인 화면으로 돌아가요', // R-106 B1 第一遍已审（10-30）
  'settings.devices.removed': '“{name}” 기기를 제거했어요', // R-106 B1 第一遍已审（10-30）；加“기기를”避开 을/를 随名字末字变化
  'settings.devices.notFound': '이미 목록에 없는 기기예요', // R-106 B1 第一遍已审（10-30）
  'settings.devices.isCurrent': '지금 쓰고 있는 기기예요. 이 기기에서 로그아웃하려면 아래의 “로그아웃”을 눌러 주세요', // R-106 B1 第一遍已审（10-30）；引号里照 settings.account.signOut

  'settings.platform.ios': 'iPhone', // TODO(ko): R-106 B1 第一遍已审（10-30），韩文界面也写 iPhone；值没有谚文，测试要求保留 TODO(ko)
  'settings.platform.windows': 'Windows PC', // TODO(ko): R-106 B1 第一遍已审（10-30）；值没有谚文，测试要求保留 TODO(ko)
  'settings.platform.tauri': 'PC 앱', // R-106 B1 第一遍已审（10-30）；“电脑版”统一叫“PC 앱”，负责人 10-30 定（明早清单第 25 条）
  'settings.platform.web': '웹', // R-106 B1 第一遍已审（10-30）
  'settings.platform.unknown': '알 수 없는 기기', // R-106 B1 第一遍已审（10-30）

  'settings.confirm.remove.title': '“{name}” 기기를 제거할까요?', // R-106 B1 第一遍已审（10-30）
  'settings.confirm.remove.body': '그 기기는 로그인 화면으로 돌아가고, 아직 동기화되지 않은 변경 사항은 사라져요. 늦어도 10분 안에 적용돼요.', // R-106 B1 第一遍已审（10-30）；“没上传的改动”照 auth.exit.removed 用 동기화되지 않은 변경 사항
  'settings.confirm.remove.ok': '제거', // R-106 B1 第一遍已审（10-30）
  'settings.confirm.removeThis.title': '이 기기에서 로그아웃할까요?', // R-106 B1 第一遍已审（10-30）
  'settings.confirm.removeThis.body': '이 기기를 제거하면 로그아웃돼요. 이 기기에 저장된 데이터는 지워지고, 아직 동기화되지 않은 변경 사항은 사라져요.', // R-106 B1 第一遍已审（10-30）
  'settings.confirm.removeThis.ok': '로그아웃', // R-106 B1 第一遍已审（10-30）
  'settings.confirm.others.title': '다른 모든 기기에서 로그아웃할까요?', // R-106 B1 第一遍已审（10-30）
  'settings.confirm.others.body': '이 기기를 제외한 다른 기기는 모두 로그인 화면으로 돌아가요. 늦어도 10분 안에 적용돼요.', // R-106 B1 第一遍已审（10-30）
  'settings.confirm.others.ok': '모두 로그아웃', // R-106 B1 第一遍已审（10-30）
  'settings.confirm.signOut.title': '아직 동기화되지 않은 변경 사항이나 초안이 {n}개 있어요', // R-106 B1 第一遍已审（10-30）
  'settings.confirm.signOut.body': '지금 로그아웃하면 이 변경 사항과 초안은 사라져요. 인터넷에 연결해서 동기화가 끝난 뒤 로그아웃하는 게 안전해요.', // R-106 B1 第一遍已审（10-30）
  'settings.confirm.signOut.unknownTitle': '아직 동기화되지 않은 변경 사항이 있을 수 있어요', // R-106 B1 第一遍已审（10-30）
  'settings.confirm.signOut.ok': '그래도 로그아웃', // R-106 B1 第一遍已审（10-30）

  'settings.account.title': '계정', // R-106 B1 第一遍已审（10-30）
  'settings.account.export': '모든 데이터 내보내기', // R-106 B1 第一遍已审（10-30）
  'settings.account.delete': '회원 탈퇴', // R-106 B1 第一遍已审（10-30）；注销账号，회원 탈퇴 待负责人确认
  'settings.account.signOut': '로그아웃', // R-106 B1 第一遍已审（10-30）
  'settings.account.rateLimited': '내보내기와 회원 탈퇴는 합쳐서 하루 3번까지 할 수 있어요. 오늘 횟수를 다 썼으니 내일 다시 시도해 주세요', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 设置页导出、注销批新写，待审校

  'settings.data.title': '데이터', // R-106 B1 第一遍已审（10-30）；10-30 设置页导出、注销批新写，待审校
  'settings.export.hint': '백업 파일 하나로 저장해요', // R-106 B1 第一遍已审（10-30）；10-30 设置页导出、注销批新写，待审校
  'settings.export.offline': '인터넷에 연결해야 내보낼 수 있어요', // R-106 B1 第一遍已审（10-30）；10-30 设置页导出、注销批新写，待审校
  'settings.export.busy': '내보내는 중… 데이터가 많으면 시간이 조금 걸려요', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 设置页导出、注销批新写，待审校
  'settings.export.done': '내보냈어요. 이메일로 알림을 보내 드렸어요', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 设置页导出、注销批新写，待审校
  'settings.export.notSaved': '내보냈지만 파일이 아직 저장되지 않았어요', // R-106 B1 第一遍已审（10-30）；10-30 设置页导出、注销批新写，待审校
  'settings.export.vaultOmitted': '잠금을 풀지 않아서 비밀 메모는 내보내지 않았어요', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 设置页导出、注销批新写，待审校
  'settings.export.saveAgain': '다시 저장', // R-106 B1 第一遍已审（10-30）；10-30 设置页导出、注销批新写，待审校

  'settings.delete.back': '설정', // R-106 B1 第一遍已审（10-30）；10-30 设置页导出、注销批新写，待审校；照 settings.title
  'settings.delete.body.what': '탈퇴하면 레모에 기록한 모든 내용과 사진, 첨부파일, 설정, 그리고 서버에 있는 백업까지 모두 삭제돼요.', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 设置页导出、注销批新写，待审校
  'settings.delete.body.cooling': '신청하면 7일 동안 탈퇴 대기 기간이 시작돼요. 그동안 계정은 사용 중지되고, 모든 기기에서 로그아웃돼요. {date} 전에 이메일 인증 코드로 로그인하면 계정을 복구할 수 있어요.', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 设置页导出、注销批新写，待审校
  'settings.delete.body.final': '7일이 지나면 완전히 삭제되어 복구할 수 없어요.', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 设置页导出、注销批新写，待审校
  'settings.delete.body.mail': '회원 탈퇴 안내는 이메일로만 보내 드려요. 스팸함도 확인해 주세요.', // R-106 B1 第一遍已审（10-30）；10-30 设置页导出、注销批新写，待审校
  'settings.delete.unsent': '아직 동기화되지 않은 변경 사항이 {n}개 있어요. 탈퇴하면 사라져요', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 设置页导出、注销批新写，待审校
  'settings.delete.unsentUnknown': '아직 동기화되지 않은 변경 사항이 있을 수 있어요. 탈퇴하면 사라져요', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 设置页导出、注销批新写，待审校
  'settings.delete.label': '확인을 위해 “{word}”라고 입력해 주세요', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 设置页导出、注销批新写，待审校
  'settings.delete.word': '탈퇴', // R-106 B1 第一遍已审（10-30）；10-30 设置页导出、注销批新写，待审校；服务器只认“注销”“탈퇴”（R-188），改这个词要先改 account 函数
  'settings.delete.submit': '회원 탈퇴', // R-106 B1 第一遍已审（10-30）；10-30 设置页导出、注销批新写，待审校；同 settings.account.delete
  'settings.delete.busy': '탈퇴 처리 중… 이 기기의 데이터를 지우고 있어요', // R-106 B1 第一遍已审（10-30）；10-30 设置页导出、注销批新写，待审校
  'settings.delete.confirmRequired': '“{word}”라고 정확히 입력해 주세요', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 设置页导出、注销批新写，待审校
  'settings.delete.admin': '관리자 계정은 콘솔에서 처리해 주세요', // R-106 B1 第一遍已审（10-30）；10-30 设置页导出、注销批新写，待审校
  'settings.busy': '잠시만요…', // R-106 B1 第一遍已审（10-30）；照 onboarding consent.busy
  'settings.signingOut': '로그아웃하는 중… 이 기기의 데이터를 지우고 있어요. 인터넷이 느리면 10초 넘게 걸릴 수도 있어요.', // R-106 B1 第一遍已审（10-30）
  'settings.cancel': '취소', // R-106 B1 第一遍已审（10-30）；照 shared common.cancel
  'settings.err.offline': '지금 인터넷에 연결되어 있지 않아요. 연결한 뒤 다시 시도해 주세요', // R-106 B1 第一遍已审（10-30）；前半照 shared error.offline
  'settings.err.tryLater': '서버가 바빠요. 잠시 후 다시 시도해 주세요', // R-106 B1 第一遍已审（10-30）；前半照 onboarding consent.err.tryLater
  'settings.err.unknown': '문제가 생겼어요. 잠시 후 다시 시도해 주세요', // R-106 B1 第一遍已审（10-30）；照 shared error.unknown
  'settings.err.accountDisabled': '이 계정은 사용 중지됐어요. 탈퇴를 신청한 뒤 7일 안에 다시 로그인하면 복구할 수 있어요.', // R-106 B1 第一遍已审（10-30）

  'settings.revoked.title': '다시 로그인해 주세요', // R-106 B1 第一遍已审（10-30）
  'settings.revoked.body': '다른 기기에서 이 기기를 제거했어요. 다시 로그인해 주세요. 아직 동기화되지 않은 변경 사항은 삭제됐어요.', // R-106 B1 第一遍已审（10-30）；中文和 auth.exit.removed 一字不差，照抄那条已审韩文
  'settings.revoked.go': '로그인하기', // R-106 B1 第一遍已审（10-30）
  'settings.signedOut.title': '로그아웃됐어요', // R-106 B1 第一遍已审（10-30）
  'settings.signedOut.body': '다른 창에서 이 계정을 로그아웃했어요. 다시 로그인해 주세요.', // R-106 B1 第一遍已审（10-30）
  'settings.offlineOut.title': '이 기기에서 로그아웃했어요', // R-106 B1 第一遍已审（10-30）
  'settings.offlineOut.body': '서버에 남은 이번 로그인은 아직 끊지 못했지만, 이 기기의 데이터는 모두 지웠어요. 나중에 다른 기기에서 “다른 모든 기기에서 로그아웃”으로 정리할 수 있어요.', // R-106 B1 第一遍已审（10-30）；措辞照 auth.session.serverPending（已审）

  'settings.recentExport.title': '최근 내보내기', // R-106 B1 第一遍已审（10-30）；10-30 最近的导出批新写，待审校
  'settings.recentExport.none': '최근 90일 동안 내보낸 적이 없어요', // R-106 B1 第一遍已审（10-30）；10-30 最近的导出批新写，待审校
  'settings.recentExport.mailFailed': '“알림 메일 발송 실패”로 표시된 내보내기는 알림 메일이 가지 않았어요. 본인이 내보낸 게 아니라면 위의 “다른 모든 기기에서 로그아웃”을 바로 눌러 주세요.', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 最近的导出批新写，待审校；10-30 改成列表后改写（本批自己的行）；按钮名照 settings.devices.signOutOthers
  'settings.recentExport.mailMark': '알림 메일 발송 실패', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 最近的导出批新写，待审校
  'settings.recentExport.removedDevice': '제거된 기기', // R-106 B1 第一遍已审（10-30）；10-30 最近的导出批新写，待审校；移除照 settings.devices.remove 用 제거
  'settings.recentExport.unknownDevice': '알 수 없는 기기', // R-106 B1 第一遍已审（10-30）；10-30 最近的导出批新写，待审校
  'settings.recentExport.showAll': '모두 보기 ({n}건)', // R-106 B1 第一遍已审（10-30），按审校意见改过；10-30 最近的导出批新写，待审校
} as const satisfies Record<keyof typeof zh, string>;
