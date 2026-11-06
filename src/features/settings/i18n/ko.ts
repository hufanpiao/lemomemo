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
  'settings.lang.note': '알림과 메일도 이 언어로 보내 드려요.', // SETTINGS-merge-cards M1 缩短稿，R-106 审校 9 分通过（11-05，B2-文案审校-语言说明）
  'settings.lang.syncFailed': '이 기기에서는 바꿨지만 계정에 동기화하지 못했어요. 인터넷에 연결한 뒤 언어를 다시 선택해 주세요', // R-106 B1 第一遍已审（10-31），按审校意见 K-15 改过：“한 번 더 바꿔”容易读成换成别的语言
  'settings.card.main': '기본 설정', // SETTINGS-merge-cards；R-106 韩文审校 C-1（11-06）：“기본”单说是“基本 / 默认”，改“기본 설정”
  'settings.card.more': '기타', // SETTINGS-merge-cards；R-106 韩文审校 C-2（11-06）：卡片标题不是展开按钮，“더 보기”像按钮，改“기타”
  'settings.account.devicesN': '기기 {n}대', // SETTINGS-merge-cards 新文案，待 R-106 审（11-05）
  'settings.account.devicesList': '기기 {n}대: {names}', // SETTINGS-merge-cards 新文案，待 R-106 审（11-05）；首页账号一行的值，放在邮箱下面一行，太长时换行、不省略（stacked）
  'settings.account.nameSep': ', ', // TODO(ko) SETTINGS-merge-cards：设备名之间的分隔（只是标点，随新文案一起送 R-106 看）
  'settings.account.devicesFailed': '기기 목록을 불러오지 못했어요', // SETTINGS-merge-cards 新文案，待 R-106 审（11-05）
  'settings.data.busyShort': '내보내는 중…', // SETTINGS-merge-cards：首页数据一行导出中只写这一句（负责人 11-05 ②），待 R-106 审
  'settings.data.pausedShort': '내보내기가 중단됐어요', // SETTINGS-merge-cards 新文案，待 R-106 审（11-05）
  'settings.sub.failed': '이 화면을 불러오지 못했어요', // SETTINGS-merge-cards 新文案，待 R-106 审（11-05）

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
  'settings.devices.removeThis': '로그아웃', // R-106 B1 第一遍已审（10-30）；按钮只写 로그아웃，读屏标签见下面两条
  // 读屏标签（KO-K43-a11y，B1 韩文审校 K-43 建议原文）：韩语“对象 + 动作”语序，不用中文全角括号；包含看得见的 로그아웃 / 제거。R-106 K-43 复核已审（11-04，removeLabel 按复核去掉“기기”）
  'settings.devices.removeThisLabel': '{name}에서 로그아웃',
  'settings.devices.removeLabel': '{name} 제거',
  'settings.devices.residual': '제거해도 그 기기는 최대 10분 동안 내 데이터를 읽고 쓸 수 있고, 그 뒤에 로그인 화면으로 돌아가요.', // R-106 B1 第一遍已审（10-30）
  'settings.devices.orphans': '기기 기록이 없는 로그인이 {n}건 더 있어요 (마지막 로그인 {date})', // R-106 B1 第一遍已审（10-31），按审校意见 K-14 改过：和 lastSeen 的“최근 사용”区分
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
  'settings.account.email': '현재 로그인한 이메일: ', // R-106 B1 第一遍已审（10-31）；R-275 读屏标签，末尾空格保留
  'settings.account.export': '모든 데이터 내보내기', // R-106 B1 第一遍已审（10-30）
  'settings.account.delete': '회원 탈퇴', // R-106 B1 第一遍已审（10-30）；注销账号，회원 탈퇴 负责人 10-30 已定
  'settings.account.signOut': '로그아웃', // R-106 B1 第一遍已审（10-30）
  'settings.account.rateLimited': '내보내기와 회원 탈퇴는 합쳐서 하루 3번까지 할 수 있어요. 오늘 횟수를 다 썼으니 내일 다시 시도해 주세요', // R-106 B1 第一遍已审（10-31），按审校意见改过

  'settings.data.title': '데이터', // R-106 B1 第一遍已审（10-31）
  'settings.export.hint': '백업 파일 하나로 저장해요', // R-106 B1 第一遍已审（10-31）
  'settings.export.offline': '인터넷에 연결해야 내보낼 수 있어요', // R-106 B1 第一遍已审（10-31）
  'settings.export.busy': '내보내는 중… 데이터가 많으면 시간이 조금 걸려요', // R-106 B1 第一遍已审（10-31），按审校意见改过
  'settings.export.done': '내보냈어요. 이메일로 알림을 보내 드렸어요', // R-106 B1 第一遍已审（10-31），按审校意见改过
  'settings.export.notSaved': '내보냈지만 파일이 아직 저장되지 않았어요', // R-106 B1 第一遍已审（10-31）
  'settings.export.vaultOmitted': '잠금을 풀지 않아서 비밀 메모는 내보내지 않았어요', // R-106 B1 第一遍已审（10-31），按审校意见改过
  'settings.export.saveAgain': '다시 저장', // R-106 B1 第一遍已审（10-31）
  'settings.export.progress': '내보내는 중… {mb} MB 받았어요', // R-106 B1 第一遍已审（10-31），按审校意见 K-32 改过；10-31 导出分片新加（0.47 续 ④ 第 4 点）
  'settings.export.paused': '내보내기가 중단됐어요. 1시간 안에 이 기기에서 “계속”을 누르면 이어서 내보낼 수 있어요. 이때는 횟수가 따로 계산되지 않아요', // R-106 B1 第一遍已审（10-31），按审校意见 K-33 改过；10-31 导出分片新加（0.47 续 ④ 第 4 点）
  'settings.export.resume': '계속', // R-106 B1 第一遍已审（10-31）；10-31 导出分片新加（0.47 续 ④ 第 4 点）
  'settings.export.expired': '이번 내보내기는 만료됐어요. 다시 내보내 주세요. 다시 내보내면 횟수가 1번 계산돼요', // R-106 B1 第一遍已审（10-31），按审校意见 K-35 改过；10-31 导出分片新加（0.47 续 ④ 第 4 点）
  'settings.export.tooLarge': '데이터 양이 한도를 넘어서 내보낼 수 없어요. 레모 운영자에게 문의해 주세요', // R-106 B1 第一遍已审（10-31），按审校意见 K-36 改过；10-31 导出分片新加（0.47 续 ④ 第 4 点）
  'settings.export.tooLargeStart': '데이터 양이 1회 내보내기 한도를 넘어서 지금은 내보낼 수 없어요. 레모 운영자에게 문의해 주세요', // R-106 B1 第一遍已审（10-31），按审校意见 K-41 改过；10-31 start 大小预检新加（0.47 续 ①“超大账号”、④ 第 4 点）
  'settings.export.partsUsedUp': '오늘 내보낼 수 있는 횟수를 다 썼어요. 내일 다시 시도해 주세요', // R-106 B1 第一遍已审（10-31）；10-31 导出分片新加（0.47 续 ④ 第 4 点）
  'settings.export.quota': '내보내기와 회원 탈퇴는 합쳐서 하루 3번까지 할 수 있어요. “모든 데이터 내보내기”를 누를 때마다 1번씩 계산돼요.', // 11-06 句末补句号（设计评审 L-3，只改标点，待 R-106 看）；R-106 B1 第一遍已审（10-31），按审校意见 K-38 改过；10-31 导出分片新加（0.47 续 ④ 第 4 点）
  'settings.export.wifi': '데이터가 많으면 파일이 수십 MB가 될 수 있어요. Wi-Fi에 연결하는 걸 추천해요.', // 11-06 句末补句号（设计评审 L-3）；R-106 B1 第一遍已审（10-31）；K-39 可不改，按主持人定不改；10-31 导出分片新加（0.47 续 ④ 第 4 点）

  'settings.delete.back': '계정', // 合卡以后注销页退回账号二级页（SETTINGS-merge-cards），照 settings.account.title（R-106 B1 第一遍已审）
  'settings.cal.title': '캘린더', // R-106 B2 第一遍已审（11-04）（B2K-05，和 calendar 的 cal.set.title、cal.h1 同名）
  'settings.remind.title': '알림', // REVIEW(ko)：照 reminders 的 remind.set.title
  'settings.remind.upcoming': '앞으로 7일 알림', // REVIEW(ko)：照 reminders 的 remind.set.upcoming
  'settings.remind.showTitle': '알림에 표시할 내용', // REVIEW(ko)：照 reminders 的 remind.set.showTitle（R-347）
  'settings.remind.dnd': '방해 금지', // REVIEW(ko)：照 reminders 的 remind.set.dnd（R-347）
  'settings.delete.body.what': '탈퇴하면 레모에 기록한 모든 내용과 사진, 첨부파일, 설정, 그리고 서버에 있는 백업까지 모두 삭제돼요.', // R-106 B1 第一遍已审（10-31），按审校意见改过
  'settings.delete.body.cooling': '신청하면 7일간의 탈퇴 대기 기간이 시작돼요. 그동안 계정은 사용 중지되고, 모든 기기에서 로그아웃돼요. {date} 전에 이메일 인증 코드로 로그인하면 계정을 복구할 수 있어요.', // R-106 B1 第一遍已审（10-31），按审校意见 K-09 改过：“7일간의”修饰名词；10-30 设置页导出、注销批新写
  'settings.delete.body.final': '7일이 지나면 완전히 삭제되어 복구할 수 없어요.', // R-106 B1 第一遍已审（10-31），按审校意见改过
  'settings.delete.body.mail': '회원 탈퇴 안내는 이메일로만 보내 드려요. 스팸함도 확인해 주세요.', // R-106 B1 第一遍已审（10-31）
  'settings.delete.unsent': '아직 동기화되지 않은 변경 사항이 {n}개 있어요. 탈퇴하면 사라져요', // R-106 B1 第一遍已审（10-31），按审校意见改过
  'settings.delete.unsentUnknown': '아직 동기화되지 않은 변경 사항이 있을 수 있어요. 탈퇴하면 사라져요', // R-106 B1 第一遍已审（10-31），按审校意见改过
  'settings.delete.label': '확인을 위해 “{word}”라고 입력해 주세요', // R-106 B1 第一遍已审（10-31），按审校意见改过
  'settings.delete.word': '탈퇴', // R-106 B1 第一遍已审（10-31）；服务器只认“注销”“탈퇴”（R-188），改这个词要先改 account 函数
  'settings.delete.submit': '회원 탈퇴', // R-106 B1 第一遍已审（10-31）；同 settings.account.delete
  'settings.delete.busy': '탈퇴 처리 중… 이 기기의 데이터를 지우고 있어요', // R-106 B1 第一遍已审（10-31）
  'settings.delete.confirmRequired': '“{word}”라고 정확히 입력해 주세요', // R-106 B1 第一遍已审（10-31），按审校意见改过
  'settings.delete.admin': '관리자 계정은 콘솔에서 처리해 주세요', // R-106 B1 第一遍已审（10-31）
  'settings.busy': '잠시만요…', // R-106 B1 第一遍已审（10-30）；照 onboarding consent.busy
  'settings.signingOut': '로그아웃하는 중… 이 기기의 데이터를 지우고 있어요. 인터넷이 느리면 10초 넘게 걸릴 수도 있어요.', // R-106 B1 第一遍已审（10-30）
  'settings.cancel': '취소', // R-106 B1 第一遍已审（10-30）；照 shared common.cancel
  'settings.err.offline': '지금 인터넷에 연결되어 있지 않아요. 연결한 뒤 다시 시도해 주세요', // R-106 B1 第一遍已审（10-30）；前半照 shared error.offline
  'settings.err.unreachable': '지금 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요', // REVIEW(ko)：新句，前半照 shared error.offline 的语气，后半照 settings.err.tryLater
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

  'settings.recentExport.title': '최근 내보내기', // R-106 B1 第一遍已审（10-31）
  'settings.recentExport.none': '최근 90일 동안 내보낸 적이 없어요', // R-106 B1 第一遍已审（10-31）
  'settings.recentExport.mailFailed': '“알림 메일 발송 실패”로 표시된 내보내기는 알림 메일이 가지 않았어요. 본인이 내보낸 게 아니라면 위의 “다른 모든 기기에서 로그아웃”을 바로 눌러 주세요.', // R-106 B1 第一遍已审（10-31），按审校意见改过；10-30 改成列表后改写（本批自己的行）；按钮名照 settings.devices.signOutOthers
  'settings.recentExport.mailMark': '알림 메일 발송 실패', // R-106 B1 第一遍已审（10-31），按审校意见改过
  'settings.recentExport.removedDevice': '제거된 기기', // R-106 B1 第一遍已审（10-31）；移除照 settings.devices.remove 用 제거
  'settings.recentExport.unknownDevice': '알 수 없는 기기', // R-106 B1 第一遍已审（10-31）
  'settings.recentExport.showAll': '모두 보기 ({n}건)', // R-106 B1 第一遍已审（10-31），按审校意见改过
  'settings.recentExport.incomplete': '완료되지 않음', // R-106 B1 第一遍已审（10-31）；10-31 导出分片新加（0.47 续 ④ 第 4 点）
  // 设置 › 电脑 › 快速记录热键（R-297）
  'settings.desktop.title': '컴퓨터', // REVIEW(ko)
  'settings.hotkey.title': '빠른 기록 단축키', // REVIEW(ko)
  'settings.hotkey.space': '스페이스', // REVIEW(ko)
  'settings.hotkey.change': '변경', // REVIEW(ko)
  'settings.hotkey.reset': '기본값으로', // REVIEW(ko)
  'settings.hotkey.press': '새 단축키를 눌러 주세요… (Esc로 취소)', // REVIEW(ko)
  'settings.hotkey.note': '어떤 프로그램에서든 이 단축키를 누르면 빠른 기록 창이 열려요. 이 조합은 시스템 전체에서 레모가 쓰게 되어 다른 프로그램에서는 원래 기능이 동작하지 않으니, 자주 쓰는 조합은 피해 주세요. Ctrl이나 Alt 하나만 쓰는 조합은 안 되고 Shift, Win 또는 다른 보조 키를 함께 써야 해요.', // REVIEW(ko)；明早清单第 78 条：Ctrl+Shift+C 这类不拦，只提示会占用
  'settings.hotkey.unregistered': '단축키가 이미 사용 중이에요. 다른 프로그램이 이 조합을 쓰고 있으니 다른 조합으로 바꿔 주세요.', // REVIEW(ko)
  'settings.hotkey.err.inUse': '단축키가 이미 사용 중이에요. 다른 프로그램이 이 조합을 쓰고 있어요. 원래 단축키는 그대로 쓸 수 있어요.', // REVIEW(ko)
  'settings.hotkey.err.invalid': '이 조합은 쓸 수 없어요. 다른 조합으로 바꿔 주세요.', // REVIEW(ko)
  'settings.hotkey.err.combo': '보조 키를 누른 채로 문자, 숫자, F1~F12 또는 스페이스를 눌러 주세요. Ctrl이나 Alt 하나만으로는 안 되고 Shift, Win 또는 다른 보조 키를 함께 눌러야 해요(예: Ctrl + Shift + 스페이스). Win 하나만은 괜찮아요.', // REVIEW(ko)
  'settings.hotkey.err.saveFailed': '새 단축키는 지금 바로 쓸 수 있지만 저장하지 못했어요. 레모를 다시 열면 원래 단축키로 돌아가요.', // REVIEW(ko)
  'settings.hotkey.err.failed': '바꾸지 못했어요. 잠시 후 다시 시도해 주세요.', // REVIEW(ko)
  // 설정 › 정보：음력·절기 데이터 출처（R-299、R-306、R-309）
  'settings.about.title': '정보', // REVIEW(ko)；设置 › 关于（R-306 注明农历出处）
  'settings.about.version': '버전', // 设置 › 关于“버전 4.0.0”（设计评审 M-1，11-06），待 R-106 审
  'settings.about.lunarCredit': '음력 및 절기 데이터: 홍콩 천문대', // REVIEW(ko)
  // 설정 › 스킨（TILT-b2：기울기 하이라이트）
  'settings.skin.title': '스킨', // R-106 已审（11-05，B2-韩文审校-TILT与主导航 K-1，维持）
  'settings.skin.tilt': '기울기 하이라이트', // R-106 已审（11-05，B2-韩文审校-TILT与主导航 K-2）
  'settings.skin.tiltNote': '휴대폰을 기울이면 하단 메뉴의 하이라이트가 따라 움직여요. 켜면 “동작 및 방향” 접근을 허용할지 물어봐요. iPhone처럼 허용을 기억하지 않는 휴대폰에서는 레모를 열 때마다 하단 메뉴를 처음 누르면 다시 물어봐요.', // R-106 已审（11-05，B2-韩文审校-TILT提示 T-1、T-2）
  'settings.skin.tiltDenied': '“동작 및 방향” 접근이 허용되지 않아 기울기 하이라이트를 켜지 못했어요. 레모를 완전히 닫았다가 다시 연 뒤 이 스위치를 켜면 한 번 더 물어봐요.', // R-106 已审（11-05，B2-韩文审校-TILT提示 T-3）
} as const satisfies Record<keyof typeof zh, string>;
