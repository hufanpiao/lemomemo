// 功能 auth 的词典·韩文（架构 2.4）
// TODO(ko)：K4 先放中文占位，等韩文翻译和审校（R-106）；每一行都标了 TODO，翻好一行删一行的标记
// satisfies Record<keyof typeof zh, string>：少一个键、多一个键都编译不过
import type { zh } from './zh.ts';

export const ko = {
  'auth.title': '登录柠檬记', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.lead': '不用密码。每次登录发一个 6 位验证码到邮箱。', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.session.signedIn': '当前已登录，要换账号请先退出', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.session.switch': '退出并换账号', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.session.backToApp': '回到 App', // TODO(ko): 待韩文翻译，先放中文占位
  'auth.exit.removed': '이 기기는 다른 기기에서 제거되었어요. 다시 로그인해 주세요. 아직 업로드되지 않은 변경 사항은 삭제되었어요.', // TODO(ko): 초안, 韩文审校待审（R-106；中文照架构 0.29 续第 98 条）
  'auth.exit.disabled': '계정이 정지되어 이 기기의 데이터를 삭제했어요. 궁금한 점은 Lemo 담당자에게 문의해 주세요.', // TODO(ko): 초안, 韩文审校待审（R-106；App 名的韩文译法未定，先写 Lemo）
  'auth.exit.pendingDeletion': '계정이 탈퇴 대기 중이라 이 기기의 데이터를 삭제했어요. 대기 기간 안에 이메일 인증 코드로 로그인하면 계정을 복구할 수 있어요.', // TODO(ko): 초안, 韩文审校待审（R-106；中文也是占位，R-192 ④）
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
