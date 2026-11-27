// 功能 today 的词典·中文：电脑版今天页的面板。跟着 ui/TodayDesk.tsx 按需下载，不进首屏
export const todayDeskZh = {
  'desk.river': '今天的安排',
  'desk.week': '本周',
  'desk.soon': '最近的纪念日',
  'desk.notesN': '今天记的 {n}',
  'desk.keysTitle': '快捷键',
  // 标题右边的跳转（线框“日历 ›”“纪念日 ›”“随手记 ›”；› 由组件画，读屏不读）
  'desk.goCal': '日历',
  'desk.goAnniv': '纪念日',
  'desk.goNotes': '随手记',
  'desk.keys': 'J / K 上下 · E 完成 · Enter 编辑',
  // 快捷键提示块：exe 有全局热键（线框原文）；网页版没有全局热键，写页面里的 Ctrl+N
  'desk.tipExe': '在任何窗口按 Ctrl+Shift+空格（默认，可在设置里改）弹出打字框，写一句按 Enter 就记下。',
  'desk.tipWeb': '按 Ctrl+N 弹出打字框，写一句按 Enter 就记下。',
  'desk.lunar': '农历{d}',
  'desk.drawer': '详情',
  'desk.weekDay': '{s}，{w} {n} 件',   // s 是格子里看得见的字（TodayDesk.tsx dayName）
  'desk.soonNone': '还没有纪念日',   // 30 天内没有时显示最近的一个，一个纪念日都没有才写这句
  // 网页版今天页：周历、本周柱体、日程 / 待办两张卡（点哪天两张卡换成哪天）
  'desk.weekN': '{n} 项',
  // 周历、柱体下面的星期（参考页单字“日 一 … 六”）：一个字一天，从周日起
  'desk.wd': '日一二三四五六',
  'desk.today': '今天',
  'desk.sched': '{d}的日程',
  'desk.todos': '{d}的待办',
  'desk.schedNone': '这天没有日程',
  'desk.todosNone': '这天没有待办',
  // 今天的待办卡里已做完的收成一行（同待办页 list.g.doneN）
  'desk.doneN': '已完成 {n}',
} as const;
