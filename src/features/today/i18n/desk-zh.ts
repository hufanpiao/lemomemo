// 功能 today 的词典·中文：电脑版今天页的面板（B6，5.9b；线框 s1 电脑画面）。跟着 ui/TodayDesk.tsx 按需下载，不进首屏
export const deskZh = {
  'desk.river': '今天的安排',
  'desk.week': '本周',
  'desk.soon': '快到了',
  'desk.notesN': '今天记的 {n}',
  'desk.keysTitle': '快捷键',
  // 标题右边的跳转（线框“日历 ›”“纪念日 ›”“随手记 ›”；› 由组件画，读屏不读）
  'desk.goCal': '日历',
  'desk.goAnniv': '纪念日',
  'desk.goNotes': '随手记',
  'desk.keys': 'J / K 上下 · E 完成 · Enter 编辑',
  // 快捷键提示块：exe 有全局热键（线框原文）；网页版没有全局热键，写页面里的 Ctrl+N
  'desk.tipExe': '在任何窗口按 Ctrl+Alt+空格 弹出打字框，写一句按 Enter 就记下。',
  'desk.tipWeb': '按 Ctrl+N 弹出打字框，写一句按 Enter 就记下。',
  'desk.lunar': '农历{d}',
  'desk.drawer': '详情',
  'desk.weekDay': '{w} {n} 件',
  'desk.soonNone': '{n} 天内没有纪念日',
} as const;
