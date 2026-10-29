// 功能 auth 的词典·韩文（架构 2.4）
// TODO(ko)：K4 先放中文占位，等韩文翻译和审校（R-106）；每一行都标了 TODO，翻好一行删一行的标记
// satisfies Record<keyof typeof zh, string>：少一个键、多一个键都编译不过
import type { zh } from './zh.ts';

export const ko = {
  'auth.title': '登录柠檬记', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.lead': '不用密码。每次登录发一个 6 位验证码到邮箱。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.session.signedIn': '이미 로그인되어 있어요. 다른 계정으로 바꾸려면 먼저 로그아웃해 주세요', // R-106 B1 第一遍已审（10-29）
  'auth.session.signedInAs': '{email} 계정으로 로그인되어 있어요. 다른 계정으로 바꾸려면 먼저 로그아웃해 주세요', // R-106 B1 第一遍已审（10-29）；“{email} 계정으로”避开 (으)로 随邮箱末字变化的问题
  'auth.session.switch': '로그아웃하고 계정 바꾸기', // R-106 B1 第一遍已审（10-29）
  'auth.session.backToApp': '앱으로 돌아가기', // R-106 B1 第一遍已审（10-29）
  'auth.session.changed': '다른 창에서 계정이 바뀌어 위 내용을 업데이트했어요. 확인한 뒤 “로그아웃하고 계정 바꾸기”를 다시 눌러 주세요.', // R-106 B1 第一遍已审（10-29）；按钮名照 auth.session.switch，引号照官网 site/ko 用 “ ”
  'auth.session.serverPending': '이 기기에서 로그아웃하고 이 기기의 데이터를 모두 지웠어요. 서버에 남은 이번 로그인은 아직 끊지 못했어요. 나중에 다른 기기에서 “다른 모든 기기에서 로그아웃”으로 정리할 수 있어요.', // TODO(ko): 引号里的按钮名要和设置页 settings.devices.signOutOthers 的韩文定稿一致（那边还是中文占位）
  'auth.exit.removed': '다른 기기에서 이 기기를 제거했어요. 다시 로그인해 주세요. 아직 동기화되지 않은 변경 사항은 삭제됐어요.', // R-106 B1 第一遍已审（10-29）；中文照架构 0.29 续第 98 条
  'auth.exit.disabled': '계정이 사용 중지되어 이 기기에 있던 데이터를 삭제했어요. 궁금한 점은 레모 담당자에게 문의해 주세요.', // R-106 B1 第一遍已审（10-29）；App 名照 shared app.name 写 레모
  'auth.exit.pendingDeletion': '계정이 탈퇴 대기 중이라 이 기기에 있던 데이터를 삭제했어요. 대기 기간 중에 이메일 인증 코드로 로그인하면 계정을 복구할 수 있어요.', // TODO(ko): 韩文已审（R-106 B1，10-29），但中文本身是占位，等 R-192 ④ 定稿后再对一遍
  'auth.email.label': '邮箱', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.email.invalid': '邮箱格式不对，请再看一下', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.email.send': '发验证码', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.captcha.label': '人机验证', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.captcha.wait': '请先等人机验证完成', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.captcha.loadFailed': '人机验证加载不出来，请检查网络后刷新页面', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.code.title': '输入邮箱里的 6 位验证码', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.code.sentTo': '验证码已发到 {email}，10 分钟内有效', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.code.label': '邮箱里的 6 位验证码', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.code.resend': '重新发送', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.code.resendIn': '{s} 秒后可以重新发送', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.code.changeEmail': '换一个邮箱', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.invite.notRegistered': '这个邮箱还没注册，需要邀请码', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.invite.label': '邀请码', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.invite.format': '邀请码是 12 位字母和数字', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.invite.noCode': '没有邀请码？请向柠檬记的负责人要一个', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.invite.next': '下一步', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.invite.sent': '邀请码有效的话，6 位验证码会发到这个邮箱', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.invite.noMail': '几分钟内没收到，请稍后再试或联系负责人。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.busy': '请稍候…', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.done': '登录好了，正在打开柠檬记…', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.codeWrong.title': '验证码不对', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.codeWrong.body': '请对照邮件里的 6 位数字再输一次。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.codeExpired.title': '验证码过期了', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.codeExpired.body': '验证码 10 分钟内有效。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.rateLimited.title': '发得太频繁了', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.rateLimited.body': '请 60 秒后再发。倒计时结束后按钮会自动变回可用。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.sendQuota.title': '现在发码的人太多', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.sendQuota.body': '请稍后再试；一直不行请联系负责人。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.registeredLogin.title': '注册成功', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.registeredLogin.body': '请用邮箱验证码登录。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.inviteInvalid.title': '这个邀请码用不了', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.inviteInvalid.body': '可能输错了，或者已经被用过。请向柠檬记的负责人再要一个。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.emailExists.title': '这个邮箱已经注册过了', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.emailExists.body': '请直接用邮箱验证码登录。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.tryLater.title': '服务暂时不通', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.tryLater.body': '请稍后再试。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.tooManyTries.title': '验证码已失效', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.tooManyTries.body': '试错次数太多，请从填邮箱重新开始。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.verifyLimited.title': '试得太频繁了', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.verifyLimited.body': '请过一会儿再试；一直不行请联系负责人。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.captcha.title': '人机验证没通过', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.captcha.body': '请等人机验证重新完成后再试一次。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.offline.title': '现在没有网络', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.offline.body': '连上网络后再试一次。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.unknown.title': '出了点问题', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.unknown.body': '请稍后再试。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.retry': '重新输入', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.err.resend': '重新发送', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.ios.title': '先把它放到主屏幕', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.ios.openInSafari': '请在 Safari 里打开本页再添加到主屏幕。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.ios.why': '放到主屏幕以后，到点的提醒才能在手机上响。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.ios.step1': '点 Safari 的“分享”（可能在“⋯”里）', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.ios.step2': '在弹出的菜单里找到“添加到主屏幕”', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.ios.step3': '回到主屏幕，点“Lemo”的图标打开，再登录', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.ios.noShare': '看不到分享按钮时，先点“在 Safari 中打开”。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.ios.note': '这个页面不能登录。请从主屏幕上的图标打开，再登录，这样只用登一次。', // TODO(ko): 待韩文翻译，先放中文占位
} as const satisfies Record<keyof typeof zh, string>;
