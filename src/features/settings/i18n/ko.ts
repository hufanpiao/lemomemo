// 功能 settings 的词典·韩文（架构 2.4）
// TODO(ko)：K9 先放中文占位，等 K17 统一翻译和审校（R-106）；没翻的每一行都标了 TODO(ko)，翻好一行删一行的标记
// 语言名“中文”“한국어”两种界面一样，不用翻
// satisfies Record<keyof typeof zh, string>：少一个键、多一个键都编译不过
import type { zh } from './zh.ts';

export const ko = {
  'settings.title': '设置', // TODO(ko)
  'settings.back': '今天', // TODO(ko)

  'settings.lang.title': '界面语言', // TODO(ko)
  'settings.lang.zh': '中文',
  'settings.lang.ko': '한국어',
  'settings.lang.note': '换语言后整个柠檬记立刻跟着变，提醒和邮件也会改用这种语言。', // TODO(ko)
  'settings.lang.syncFailed': '已在这台设备上换好；同步到账号没成功，联网后再换一次即可', // TODO(ko)

  'settings.devices.title': '已登录设备', // TODO(ko)
  'settings.devices.loading': '正在读取设备…', // TODO(ko)
  'settings.devices.loadFailed': '设备列表读不出来，请检查网络后重试', // TODO(ko)
  'settings.devices.empty': '还没有设备记录', // TODO(ko)
  'settings.devices.retry': '重试', // TODO(ko)
  'settings.devices.thisDevice': '本机', // TODO(ko)
  'settings.devices.signedOut': '已退出', // TODO(ko)
  'settings.devices.lastSeen': '最近使用 {date}', // TODO(ko)
  'settings.devices.neverSeen': '还没有使用记录', // TODO(ko)
  'settings.devices.stale': '很久没用，{date} 后自动移除', // TODO(ko)
  'settings.devices.remove': '移除', // TODO(ko)
  'settings.devices.removeThis': '退出这台设备', // TODO(ko)
  'settings.devices.residual': '移除后，那台设备最多还能在 10 分钟内读写你的数据，之后会退回登录页。', // TODO(ko)
  'settings.devices.orphans': '另有 {n} 个登录没有设备记录（最近一次 {date}）', // TODO(ko)
  'settings.devices.signOutOthers': '退出其他所有设备', // TODO(ko)
  'settings.devices.signOutOthersDone': '其他设备已退出，最迟 10 分钟内回到登录页', // TODO(ko)
  'settings.devices.removed': '已移除“{name}”', // TODO(ko)
  'settings.devices.notFound': '这台设备已经不在列表里了', // TODO(ko)
  'settings.devices.isCurrent': '这是本机。要退出这台设备，请用下面的“退出登录”', // TODO(ko)

  'settings.platform.ios': 'iPhone', // TODO(ko)
  'settings.platform.windows': 'Windows 电脑', // TODO(ko)
  'settings.platform.tauri': '电脑版', // TODO(ko)
  'settings.platform.web': '网页', // TODO(ko)
  'settings.platform.unknown': '未知设备', // TODO(ko)

  'settings.confirm.remove.title': '移除“{name}”？', // TODO(ko)
  'settings.confirm.remove.body': '那台设备会退回登录页，没上传的改动会丢失。最迟 10 分钟内生效。', // TODO(ko)
  'settings.confirm.remove.ok': '移除', // TODO(ko)
  'settings.confirm.removeThis.title': '退出这台设备？', // TODO(ko)
  'settings.confirm.removeThis.body': '移除本机就是退出登录：这台设备上的缓存会清空，还没上传的改动会丢失。', // TODO(ko)
  'settings.confirm.removeThis.ok': '退出登录', // TODO(ko)
  'settings.confirm.others.title': '退出其他所有设备？', // TODO(ko)
  'settings.confirm.others.body': '除了这台，别的设备都会退回登录页，最迟 10 分钟内生效。', // TODO(ko)
  'settings.confirm.others.ok': '全部退出', // TODO(ko)
  'settings.confirm.signOut.title': '还有 {n} 条改动或草稿没上传', // TODO(ko)
  'settings.confirm.signOut.body': '现在退出，这些改动和草稿会丢失。联网等它们上传完再退出更稳妥。', // TODO(ko)
  'settings.confirm.signOut.unknownTitle': '可能有改动还没上传', // TODO(ko)
  'settings.confirm.signOut.ok': '仍然退出', // TODO(ko)

  'settings.account.title': '账号', // TODO(ko)
  'settings.account.export': '导出全部数据', // TODO(ko)
  'settings.account.delete': '注销账号', // TODO(ko)
  'settings.account.signOut': '退出登录', // TODO(ko)
  'settings.soon': '即将开放', // TODO(ko)

  'settings.busy': '请稍候…', // TODO(ko)
  'settings.signingOut': '正在退出…正在清空这台设备上的数据，网络不好时最多要十几秒。', // TODO(ko)
  'settings.cancel': '取消', // TODO(ko)
  'settings.err.offline': '现在没有网络，请联网后再试', // TODO(ko)
  'settings.err.tryLater': '服务器忙，稍后再试', // TODO(ko)
  'settings.err.unknown': '出了点问题，请稍后再试', // TODO(ko)
  'settings.err.accountDisabled': '这个账号已停用。申请注销后 7 天内重新登录可以恢复。', // TODO(ko)

  'settings.revoked.title': '需要重新登录', // TODO(ko)
  'settings.revoked.body': '这台设备已在别的设备上被移除，请重新登录；还没上传的改动已丢弃。', // TODO(ko)
  'settings.revoked.go': '去登录', // TODO(ko)
  'settings.signedOut.title': '已退出登录', // TODO(ko)
  'settings.signedOut.body': '这个账号已在别的窗口退出，请重新登录。', // TODO(ko)
  'settings.offlineOut.title': '已在这台设备上退出', // TODO(ko)
  'settings.offlineOut.body': '服务器上的这次登录暂时没能吊销，本机已清空。之后可以在别的设备上用“退出其他所有设备”清掉它。', // TODO(ko)
} as const satisfies Record<keyof typeof zh, string>;
