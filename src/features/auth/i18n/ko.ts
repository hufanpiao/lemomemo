// 功能 auth 的词典·韩文（架构 2.4）
// K4 先放中文占位；10-30 补成韩文初稿，已过 R-106 B1 第一遍审校（10-30，标“R-106 B1 第一遍已审”）；
// 以后新加、还是中文占位的行仍标 TODO(ko)（测试要求没有谚文的行必须带 TODO(ko)）
// satisfies Record<keyof typeof zh, string>：少一个键、多一个键都编译不过
import type { zh } from './zh.ts';

export const ko = {
  'auth.title': '레모에 로그인', // R-106 B1 第一遍已审（10-30）
  'auth.lead': '비밀번호는 필요 없어요. 로그인할 때마다 이메일로 6자리 인증 코드를 보내 드려요.', // R-106 B1 第一遍已审（10-30）
  'auth.session.signedIn': '이미 로그인되어 있어요. 다른 계정으로 바꾸려면 먼저 로그아웃해 주세요', // R-106 B1 第一遍已审（10-29）
  'auth.session.signedInAs': '{email} 계정으로 로그인되어 있어요. 다른 계정으로 바꾸려면 먼저 로그아웃해 주세요', // R-106 B1 第一遍已审（10-29）；“{email} 계정으로”避开 (으)로 随邮箱末字变化的问题
  'auth.session.switch': '로그아웃하고 계정 바꾸기', // R-106 B1 第一遍已审（10-29）
  'auth.session.backToApp': '앱으로 돌아가기', // R-106 B1 第一遍已审（10-29）
  'auth.session.changed': '다른 창에서 계정이 바뀌어 위 내용을 업데이트했어요. 확인한 뒤 “로그아웃하고 계정 바꾸기”를 다시 눌러 주세요.', // R-106 B1 第一遍已审（10-29）；按钮名照 auth.session.switch，引号照官网 site/ko 用 “ ”
  'auth.session.serverPending': '이 기기에서 로그아웃하고 이 기기의 데이터를 모두 지웠어요. 서버에 남은 이번 로그인은 아직 끊지 못했어요. 나중에 다른 기기에서 “다른 모든 기기에서 로그아웃”으로 정리할 수 있어요.', // R-106 B1 第一遍已审（10-30）；引号里的按钮名和 settings.devices.signOutOthers 一致
  'auth.exit.removed': '다른 기기에서 이 기기를 제거했어요. 다시 로그인해 주세요. 아직 동기화되지 않은 변경 사항은 삭제됐어요.', // R-106 B1 第一遍已审（10-29）；中文照架构 0.29 续第 98 条
  'auth.exit.disabled': '계정이 사용 중지되어 이 기기에 있던 데이터를 삭제했어요. 궁금한 점은 레모 운영자에게 문의해 주세요.', // R-106 B1 第一遍已审（10-30）；10-30 按 R-106 第一遍结论把“负责人”改成 운영자（照官网 site/ko），负责人待确认
  'auth.exit.pendingDeletion': '계정이 탈퇴 대기 중이라 이 기기에 있던 데이터를 삭제했어요. 대기 기간 중에 이메일 인증 코드로 로그인하면 계정을 복구할 수 있어요.', // TODO(ko): 韩文已审（R-106 B1，10-29），但中文本身是占位，等 R-192 ④ 定稿后再对一遍
  'auth.email.label': '이메일', // R-106 B1 第一遍已审（10-30）
  'auth.email.invalid': '이메일 형식이 올바르지 않아요. 다시 확인해 주세요', // R-106 B1 第一遍已审（10-30）
  'auth.email.send': '인증 코드 받기', // R-106 B1 第一遍已审（10-30）；按钮；中文 4 字→韩文 8 字
  'auth.captcha.label': '보안 확인', // R-106 B1 第一遍已审（10-30）；“人机验证”（Turnstile）
  'auth.captcha.wait': '보안 확인이 끝날 때까지 잠시 기다려 주세요', // R-106 B1 第一遍已审（10-30）
  'auth.captcha.loadFailed': '보안 확인을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 페이지를 새로고침해 주세요', // R-106 B1 第一遍已审（10-30）
  'auth.code.title': '이메일로 받은 6자리 인증 코드를 입력해 주세요', // R-106 B1 第一遍已审（10-30）
  'auth.code.sentTo': '{email} 주소로 인증 코드를 보냈어요. 10분 동안 유효해요', // R-106 B1 第一遍已审（10-30）；“{email} 주소로”避开 (으)로 随邮箱末字变化
  'auth.code.label': '이메일로 받은 6자리 인증 코드', // R-106 B1 第一遍已审（10-30）
  'auth.code.resend': '다시 보내기', // R-106 B1 第一遍已审（10-30）
  'auth.code.resendIn': '{s}초 후 다시 보내기', // R-106 B1 第一遍已审（10-30）；显示在按钮上，按按钮口吻缩短
  'auth.code.changeEmail': '이메일 바꾸기', // R-106 B1 第一遍已审（10-30）
  'auth.invite.notRegistered': '아직 가입하지 않은 이메일이에요. 가입하려면 초대 코드가 필요해요', // R-106 B1 第一遍已审（10-30）
  'auth.invite.label': '초대 코드', // R-106 B1 第一遍已审（10-30）
  'auth.invite.format': '초대 코드는 영문과 숫자 12자리예요', // R-106 B1 第一遍已审（10-30）
  'auth.invite.noCode': '초대 코드가 없나요? 레모 운영자에게 요청해 주세요', // R-106 B1 第一遍已审（10-30）；负责人照官网 site/ko 用 운영자，负责人待确认
  'auth.invite.next': '다음', // R-106 B1 第一遍已审（10-30）
  'auth.invite.sent': '초대 코드가 유효하면 이 이메일로 6자리 인증 코드를 보내 드려요', // R-106 B1 第一遍已审（10-30）
  'auth.invite.noMail': '몇 분이 지나도 메일이 오지 않으면 잠시 후 다시 시도하거나 운영자에게 문의해 주세요.', // R-106 B1 第一遍已审（10-30）；운영자 待负责人确认
  'auth.busy': '잠시만요…', // R-106 B1 第一遍已审（10-30）；照 onboarding consent.busy
  'auth.done': '로그인했어요. 레모를 열고 있어요…', // R-106 B1 第一遍已审（10-30）
  'auth.err.codeWrong.title': '인증 코드가 맞지 않아요', // R-106 B1 第一遍已审（10-30）
  'auth.err.codeWrong.body': '메일에 있는 6자리 숫자를 확인하고 다시 입력해 주세요.', // R-106 B1 第一遍已审（10-30）
  'auth.err.codeExpired.title': '인증 코드가 만료됐어요', // R-106 B1 第一遍已审（10-30）
  'auth.err.codeExpired.body': '인증 코드는 10분 동안 유효해요.', // R-106 B1 第一遍已审（10-30）；和邮件模板“10분 동안 유효해요”一致
  'auth.err.rateLimited.title': '너무 자주 요청했어요', // R-106 B1 第一遍已审（10-30）
  'auth.err.rateLimited.body': '60초 후에 다시 보내 주세요. 카운트다운이 끝나면 버튼을 다시 누를 수 있어요.', // R-106 B1 第一遍已审（10-30）
  'auth.err.sendQuota.title': '지금 인증 코드 요청이 너무 많아요', // R-106 B1 第一遍已审（10-30）
  'auth.err.sendQuota.body': '잠시 후 다시 시도해 주세요. 계속 안 되면 운영자에게 문의해 주세요.', // R-106 B1 第一遍已审（10-30）；운영자 待负责人确认
  'auth.err.registeredLogin.title': '가입이 완료됐어요', // R-106 B1 第一遍已审（10-30）
  'auth.err.registeredLogin.body': '이메일 인증 코드로 로그인해 주세요.', // R-106 B1 第一遍已审（10-30）
  'auth.err.inviteInvalid.title': '이 초대 코드는 사용할 수 없어요', // R-106 B1 第一遍已审（10-30）
  'auth.err.inviteInvalid.body': '잘못 입력했거나 이미 사용된 코드일 수 있어요. 레모 운영자에게 새 코드를 요청해 주세요.', // R-106 B1 第一遍已审（10-30）；운영자 待负责人确认
  'auth.err.emailExists.title': '이미 가입한 이메일이에요', // R-106 B1 第一遍已审（10-30）
  'auth.err.emailExists.body': '이메일 인증 코드로 바로 로그인해 주세요.', // R-106 B1 第一遍已审（10-30）
  'auth.err.tryLater.title': '지금 서비스에 연결할 수 없어요', // R-106 B1 第一遍已审（10-30）
  'auth.err.tryLater.body': '잠시 후 다시 시도해 주세요.', // R-106 B1 第一遍已审（10-30）
  'auth.err.tooManyTries.title': '인증 코드를 더 이상 쓸 수 없어요', // R-106 B1 第一遍已审（10-30）
  'auth.err.tooManyTries.body': '잘못 입력한 횟수가 너무 많아요. 이메일 입력부터 다시 시작해 주세요.', // R-106 B1 第一遍已审（10-30）
  'auth.err.verifyLimited.title': '너무 자주 시도했어요', // R-106 B1 第一遍已审（10-30）
  'auth.err.verifyLimited.body': '조금 뒤에 다시 시도해 주세요. 계속 안 되면 운영자에게 문의해 주세요.', // R-106 B1 第一遍已审（10-30）；운영자 待负责人确认
  'auth.err.captcha.title': '보안 확인을 통과하지 못했어요', // R-106 B1 第一遍已审（10-30）
  'auth.err.captcha.body': '보안 확인이 다시 완료되면 한 번 더 시도해 주세요.', // R-106 B1 第一遍已审（10-30）
  'auth.err.offline.title': '지금 인터넷에 연결되어 있지 않아요', // R-106 B1 第一遍已审（10-30）；照 shared error.offline
  'auth.err.offline.body': '인터넷에 연결한 뒤 다시 시도해 주세요.', // R-106 B1 第一遍已审（10-30）
  'auth.err.unknown.title': '문제가 생겼어요', // R-106 B1 第一遍已审（10-30）
  'auth.err.unknown.body': '잠시 후 다시 시도해 주세요.', // R-106 B1 第一遍已审（10-30）
  'auth.err.retry': '다시 입력하기', // R-106 B1 第一遍已审（10-30）
  'auth.err.resend': '다시 보내기', // R-106 B1 第一遍已审（10-30）
  'auth.ios.title': '먼저 홈 화면에 추가해 주세요', // R-106 B1 第一遍已审（10-30）
  'auth.ios.openInSafari': '이 페이지를 Safari에서 연 뒤 홈 화면에 추가해 주세요.', // R-106 B1 第一遍已审（10-30）
  'auth.ios.why': '홈 화면에 추가해야 휴대폰에서 제때 알림을 받을 수 있어요.', // R-106 B1 第一遍已审（10-30）
  'auth.ios.step1': 'Safari에서 “공유” 버튼을 눌러 주세요 (“⋯” 메뉴 안에 있을 수도 있어요)', // R-106 B1 第一遍已审（10-30）
  'auth.ios.step2': '열린 메뉴에서 “홈 화면에 추가”를 찾아 눌러 주세요', // R-106 B1 第一遍已审（10-30）
  'auth.ios.step3': '홈 화면으로 돌아가 “Lemo” 아이콘을 눌러 연 뒤 로그인해 주세요', // R-106 B1 第一遍已审（10-30）；主屏幕上显示 Lemo（官网 site/ko 同），不改成 레모
  'auth.ios.noShare': '공유 버튼이 보이지 않으면 먼저 메뉴에서 “Safari에서 열기”를 눌러 주세요.', // R-106 B1 第一遍已审（10-30）
  'auth.ios.note': '이 페이지에서는 로그인할 수 없어요. 홈 화면의 아이콘으로 연 뒤 로그인해 주세요. 그러면 다음부터는 다시 로그인하지 않아도 돼요.', // R-106 B1 第一遍已审（10-30）
  'auth.restore.ask': '계정이 탈퇴 대기 중이에요. {when}에 완전히 삭제돼요. 계정을 복구할까요?', // R-106 B1 第一遍已审（10-30）
  'auth.restore.when': '{y}년 {m}월 {d}일 {hh}:{mm} ({zone})', // R-106 B1 第一遍已审（10-30）；；同申请注销邮件 fmtWhen 的韩文写法
  'auth.restore.askNoDate': '계정이 탈퇴 대기 중이에요. 대기 기간이 끝나면 완전히 삭제돼요. 계정을 복구할까요?', // R-106 B1 第一遍已审（10-30）
  'auth.restore.restore': '계정 복구', // R-106 B1 第一遍已审（10-30）；；和申请注销邮件（account-mail.ts）里的“계정 복구”一致
  'auth.restore.keep': '복구하지 않고 로그아웃', // R-106 B1 第一遍已审（10-30），按审校意见改过
  'auth.restore.reauth': '본인 확인을 위해 계정을 복구하려면 인증 코드를 한 번 더 받아야 해요. 다시 로그인한 뒤 “계정 복구”를 눌러 주세요.', // R-106 B1 第一遍已审（10-30），按审校意见改过
  'auth.restore.err.tooLate': '이미 삭제가 시작되어 복구할 수 없어요.', // R-106 B1 第一遍已审（10-30）
  'auth.restore.err.rateLimited': '오늘은 복구를 더 시도할 수 없어요. 내일 다시 시도해 주세요.', // R-106 B1 第一遍已审（10-30），按审校意见改过
  'auth.restore.err.tryLater': '서버가 바빠요. 잠시 후 다시 시도해 주세요.', // R-106 B1 第一遍已审（10-30）
  'auth.restore.err.offline': '지금 인터넷에 연결되어 있지 않아요. 연결한 뒤 다시 시도해 주세요.', // R-106 B1 第一遍已审（10-30），按审校意见改过
  'auth.restore.err.unknown': '문제가 생겼어요. 잠시 후 다시 시도해 주세요.', // R-106 B1 第一遍已审（10-30）
  'auth.gate.unsure': '지금은 계정 상태를 확인할 수 없어요. 다시 시도하거나 일단 레모에 들어갈 수 있어요.', // R-106 B1 第一遍已审（10-30），按审校意见改过
  'auth.gate.retry': '다시 시도', // R-106 B1 第一遍已审（10-30）
  'auth.gate.enterAnyway': '그래도 들어가기', // R-106 B1 第一遍已审（10-30）
  'auth.gate.backToLogin': '로그인 화면으로 돌아가기', // R-106 B1 第一遍已审（10-30），按审校意见改过
  'auth.exit.disabledUnsure': '지금은 계정을 사용할 수 없어서 이 기기에 있던 데이터를 삭제했어요. 회원 탈퇴를 신청했다면 탈퇴 대기 기간 중에 이메일 인증 코드로 로그인해서 계정을 복구할 수 있어요. 그렇지 않다면 레모 운영자에게 문의해 주세요.', // R-106 B1 第一遍已审（10-30），按审校意见改过
} as const satisfies Record<keyof typeof zh, string>;
