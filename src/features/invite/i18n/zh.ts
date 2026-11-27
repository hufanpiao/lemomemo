// 功能 invite 的词典·中文：设置 › 邀请朋友（只有管理员看得到，R-83；架构 5.6 发码、第 6 节“invite-admin 的错误码”的“前端怎么处理”一列）
// 备注的说明照架构 5.6 和第 6 节：“只写编号或日期，例如 ‘3 号’ ‘10-29’，不要写名字”（服务器判断不了是不是名字，只查长度，靠界面写清楚）
export const zh = {
  'inv.note.title': '备注（可以不写）',
  'inv.note.placeholder': '例如 3 号、10-29',
  'inv.note.tip': '只写编号或日期，例如“3 号”“10-29”，不要写名字。最多 {max} 个字。',
  'inv.note.count': '{n} / {max}',
  'inv.create': '生成邀请码',
  'inv.creating': '正在生成…',
  // 刚生成的那一个
  'inv.fresh.title': '新的邀请码',
  'inv.copy': '复制',
  'inv.copied': '已复制',
  'inv.copyFailed': '没能自动复制，已经选中，请手动复制',
  'inv.fresh.tip': '7 天内有效（{when}前），只能用一次。这个码只显示这一次，离开这一页就看不到了，请现在复制发给朋友。',
  // 发过的
  'inv.list.title': '发过的、还没过期的',
  'inv.list.loading': '正在读…',
  'inv.list.failed': '列表没读出来，稍后再进来看看',
  'inv.list.empty': '还没有',
  'inv.list.noNote': '没写备注',
  'inv.list.used': '已用',
  'inv.list.unused': '还没用',
  'inv.list.expires': '{when}过期',
  // 作废（负责人 11-27“生产的邀请码可以查看跟废除”，只加作废）：还没用的才有；确认框问一次
  'inv.revoke': '作废',
  'inv.revoke.title': '作废“{name}”这个邀请码？',
  'inv.revoke.body': '作废以后这个码马上不能再用来注册，也不能撤回；需要的话再生成一个新的。',
  'inv.revoke.ok': '作废',
  'inv.revoke.cancel': '取消',
  'inv.revoke.done': '已作废，这个码不能再用来注册了',
  'inv.revoke.notFound': '这个码已经用掉、过期或作废了，列表已经刷新',
  'inv.revoke.failed': '没有作废成，稍后再试',
  // 出错（架构第 6 节“前端怎么处理”）
  'inv.err.not_admin': '只有管理员能发邀请码',
  'inv.err.note_too_long': '备注最多 {max} 个字',
  'inv.err.bad_request': '备注里有不能用的字符，换一种写法再试',
  'inv.err.rate_limited': '今天已经发了 20 个，明天再试',
  'inv.err.try_later': '服务器暂时不通，稍后再试',
  'inv.err.timeout': '等太久没有回应，稍后再试',
  'inv.err.offline': '没有网络，连上以后再试',
  'inv.err.signed_out': '登录过期了，重新登录以后再试',
  'inv.err.failed': '没有生成，稍后再试',
} as const;
