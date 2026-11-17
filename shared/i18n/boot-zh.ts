// 公共词典·中文的“启动兜底”一段（独立评审 11-17 第 2 条）：App 名、退出屏、出错屏、升级整屏提示要用的词条只写在这里，
// zh.ts 展开引用（不另抄一份）。shared/i18n/i18n.ts 静态带着它：按语言下载的整份公共词典两种都没下载到（发版后旧块 404、离线）时，
// 这几屏照样有字，永远不出键名。只放这几屏要的，别的词条不要往这里加（这一段跟着首屏下载）
export const bootZh = {
  'app.name': '柠檬记',
  'update.tooNew.title': '本机数据是新版本写的，请更新 App',
  'update.tooNew.body': '这台设备上的数据由更新版本的柠檬记写入，当前版本读不了。更新以后就能接着用，你的内容都还在本机。',
  'update.tooNew.update': '去更新',
  'update.tooNew.refresh': '刷新',
  'update.updating': '正在更新…',
  'update.failedReopen': '更新失败 · 联网后再试，不行就完全关闭柠檬记再打开',
  'update.stillOld': '已是最新版本，请稍后再试',
  'update.blocked.title': '请关掉其他打开的柠檬记窗口或标签页',
  'update.blocked.body': '别的窗口或标签页还在用旧版本，关掉以后这里会自动接着打开。你的内容都还在本机。',
  'app.crashed.title': '哎呀，卡住了',
  'app.crashed.refresh': '刷新一下',
  // 查到了新版本但 30 秒内没装好、接管（BANNER-sugg ⑤）：不重新载入，提示稍后再试（core/upgrade.ts 的 stalled）
  'update.stalled': '新版本还没装好 · 请稍后再试',
  // exe 里退出时本机会话没删掉（安全审查 A-1，app/ExitIncompleteScreen.tsx）；读取登录信息失败（代码审查建议 4）
  'exit.incomplete.title': '退出没完成',
  'exit.incomplete.body': '这台电脑上的登录信息没删掉，点“重试”再删一次。删掉以前不会回到已登录的界面。',
  'exit.incomplete.retry': '重试',
  'exit.incomplete.busy': '正在删除…',
  'exit.incomplete.failed': '还是没删掉，请稍后再试，或重新打开柠檬记',
  'exit.unavailable.title': '读不到这台电脑上的登录信息',
  'exit.unavailable.body': '请重新打开柠檬记。还不行的话，重启电脑后再试。',
  'exit.unavailable.reopen': '重新打开',
} as const;
