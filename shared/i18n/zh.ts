// 公共词典·中文（架构 2.4）：服务器也要用的词条（推送文案、错误码、公共按钮）和日期格式
// 键名按“页面.用途”，参数写成 {name}。只在某个功能界面上用的词条放 src/features/<功能>/i18n/
// as const：值保留字面量类型，t() 才能按占位符推导参数
// App 名、退出屏、出错屏、升级整屏提示的词条在 boot-zh.ts（两种语言的整份词典都没下载到时的兜底，只写那一份），这里展开
import { bootZh } from './boot-zh.ts';

export const zh = {
  ...bootZh,
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
  'update.update': '更新',
  'update.queued': '有 {n} 条等更新后同步 · 内容还在本机',
  'update.newVersion': '有新版本',
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
  // 时长（fmt.ts 的 fmtDur）：“13 分钟”“1 小时 13 分”“2 天 9 小时”，前面有天、小时时分钟写“分”（视觉稿 kDur）
  'fmt.dur.d': '{n} 天',
  'fmt.dur.h': '{n} 小时',
  'fmt.dur.m': '{n} 分钟',
  'fmt.dur.mTail': '{n} 分',
  // 主 App 收到 account_disabled、探测说账号正常，但 5 分钟内已重新载入过一次：同步暂停（app/sync-wiring.ts 限次，10-30 复审建议）；按钮沿用 update.reopen
  'update.syncPaused': '同步暂停，请稍后重新打开',
  // 只读行（FA-2）的词条全在 ro-zh.ts、ro-ko.ts（不进首屏）
  // 日程在某一天的写法（R-444）：“全天”和跨天的几句，日历日清单和周视图、今天页、全屏提醒页共用这一套（event-span.ts 的 spanTextOn 给键和参数，kit/hooks/useSpanT.ts 翻译）。
  // 中间整天行首“持续”；最后一天行首“至 18:00”；没到最后一天的标题下面“至 11月20日 18:00”；跨天的全天日程“第 2/3 天”
  'span.allDay': '全天',
  'span.ongoing': '持续',
  'span.until': '至 {t}',
  'span.untilDate': '至 {m}月{d}日 {t}',
  'span.dayOf': '第 {i}/{n} 天',
  // 时区的通俗说法（tz.*）11-05 挪到 shared/i18n/tz-zh.ts、tz-ko.ts：只有登录页的恢复页和邮件用，不进主 App 首屏的公共词典
} as const;
