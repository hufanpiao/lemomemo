// 公共词典·中文（架构 2.4）：服务器也要用的词条（推送文案、错误码、公共按钮）和日期格式
// 键名按“页面.用途”，参数写成 {name}。只在某个功能界面上用的词条放 src/features/<功能>/i18n/
// as const：值保留字面量类型，t() 才能按占位符推导参数
export const zh = {
  'app.name': '柠檬记',
  // B0 占位页上的设置入口（PLACEHOLDER-settings-link，B2 换真页面时去掉）；和 settings.title 同词，kit 用不了功能的词典所以放这里
  'app.settings': '设置',
  // FA-7 底栏（负责人 11-05：4 个页签，随手记点了显示“即将推出”；“＋”按页新建日程或待办）
  'nav.label': '主导航', // 底栏和电脑版侧栏共用，不分宽窄（主持人 11-05，宽屏侧栏不在底部，D5）
  'nav.today': '今天',
  'nav.calendar': '日历',
  'nav.todos': '待办',
  'nav.notes': '随手记',
  'nav.newEvent': '新建日程',
  'nav.newTodo': '新建待办',
  'nav.add': '打字记一条', // B3 M4：“＋”点一下打开打字条（原来是新建日程 / 新建待办）
  'nav.plusPreparing': '准备中', // B3 Q4：打字条还没下载好就点了“＋”
  'nav.plusClose': '关闭',
  'notes.soon': '即将推出',
  'common.ok': '好',
  'common.cancel': '取消',
  'common.retry': '重试',
  'common.close': '关闭',
  'error.unknown': '出了点问题，请稍后再试',
  'error.offline': '现在没有网络',
  'feature.off': '这个功能还没有开启',
  'update.required': '需要更新才能继续同步 · 你记下的内容都还在本机',
  'update.available': '柠檬记有新版本',
  'update.reopen': '重新打开',
  'update.tooNew.title': '本机数据是新版本写的，请更新 App',
  'update.tooNew.body': '这台设备上的数据由更新版本的柠檬记写入，当前版本读不了。更新以后就能接着用，你的内容都还在本机。',
  'update.tooNew.update': '去更新',
  'update.tooNew.refresh': '刷新',
  'update.updating': '正在更新…',
  'update.failed': '更新失败 · 联网后再试',
  'update.stillOld': '已是最新版本，请稍后再试',
  'update.update': '更新',
  'update.queued': '有 {n} 条等更新后同步 · 内容还在本机',
  'update.newVersion': '有新版本',
  'update.blocked.title': '请关掉其他打开的柠檬记窗口或标签页',
  'update.blocked.body': '别的窗口或标签页还在用旧版本，关掉以后这里会自动接着打开。你的内容都还在本机。',
  'app.crashed.title': '哎呀，卡住了',
  'app.crashed.refresh': '刷新一下',
  'remind.push.event': '{time} {title}',
  // 全天日程不写时刻（R-333）：前一天提醒“明天 · 名称”，当天提醒“今天 · 名称”
  'remind.push.allDayToday': '今天 · {title}',
  'remind.push.allDayTomorrow': '明天 · {title}',
  // 全天日程、通知只显示有几项时也不写时刻（R-334）
  'remind.push.hiddenAllDayToday': '今天有 1 项日程',
  'remind.push.hiddenAllDayTomorrow': '明天有 1 项日程',
  'remind.push.hiddenAllDay': '有 1 项日程',
  // 推送文案（B2 BE-2，shared/logic/notify-text.ts）：待办有截止时刻时的正文；不写标题时整条只有“几点有 1 项日程 / 待办”（R-188 保留项，R-294 分开说）；通知上“推迟”“完成”两个按钮（R-294）；经 Claude 记下的加前缀
  'remind.push.todoDue': '{time} 截止',
  'remind.push.hidden': '{time} 有 1 项日程',
  'remind.push.hiddenTodo': '{time} 有 1 项待办',
  'remind.push.hiddenAnniv': '{time} 有 1 项纪念日',
  'remind.push.action.snooze': '推迟',
  'remind.push.action.done': '完成',
  'remind.push.action.ack': '知道了',
  'remind.push.fromClaude': '来自 Claude · {text}',
  // SW 收到 resolve 推送（另一台设备已处理这条提醒）：替换同 tag 的旧通知，静默；负载不带标题（B2 任务单“接口先定”第 2 条），文案固定
  'push.resolved': '已在另一台设备上处理',
  // SW 收到 push-test 的测试推送（设置 › 提醒“发一条测试通知”）：文案固定，不用负载里的字
  'push.test': '这是一条测试通知，推送已经通了',
  'fmt.monthDay': '{m}月{d}日',
  'fmt.monthDayWeek': '{m}月{d}日 {w}',
  'fmt.wd.0': '周日',
  'fmt.wd.1': '周一',
  'fmt.wd.2': '周二',
  'fmt.wd.3': '周三',
  'fmt.wd.4': '周四',
  'fmt.wd.5': '周五',
  'fmt.wd.6': '周六',
  // 主 App 收到 account_disabled、探测说账号正常，但 5 分钟内已重新载入过一次：同步暂停（app/sync-wiring.ts 限次，10-30 复审建议）；按钮沿用 update.reopen
  'update.syncPaused': '同步暂停，请稍后重新打开',
  // 查到了新版本但 30 秒内没装好、接管（BANNER-sugg ⑤）：不重新载入，提示稍后再试（core/upgrade.ts 的 stalled）
  'update.stalled': '新版本还没装好 · 请稍后再试',
  // 只读行（FA-2）的词条全在 ro-zh.ts、ro-ko.ts（不进首屏）
  // exe 里退出时本机会话没删掉（安全审查 A-1，app/ExitIncompleteScreen.tsx）；读取登录信息失败（代码审查建议 4）
  'exit.incomplete.title': '退出没完成',
  'exit.incomplete.body': '这台电脑上的登录信息没删掉，点“重试”再删一次。删掉以前不会回到已登录的界面。',
  'exit.incomplete.retry': '重试',
  'exit.incomplete.busy': '正在删除…',
  'exit.incomplete.failed': '还是没删掉，请稍后再试，或重新打开柠檬记',
  'exit.unavailable.title': '读不到这台电脑上的登录信息',
  'exit.unavailable.body': '请重新打开柠檬记。还不行的话，重启电脑后再试。',
  'exit.unavailable.reopen': '重新打开',
  // 时区的通俗说法（tz.*）11-05 挪到 shared/i18n/tz-zh.ts、tz-ko.ts：只有登录页的恢复页和邮件用，不进主 App 首屏的公共词典
} as const;
