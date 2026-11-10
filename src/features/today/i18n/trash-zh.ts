// 功能 today 的词典·中文：“最近删除”页（B2 FA-2；B4 S2 加随手记）。从 zh.ts 拆出来（B4 首屏额度：zh.ts 跟着今天页进首屏，这一份只跟着“最近删除”页的分包走）
export const trashZh = {
  'trash.title': '最近删除',
  'trash.back': '返回',
  'trash.note': '删除的日程、待办和随手记在这里留 30 天，之后自动清理',
  'trash.empty': '最近删除里没有东西',
  'trash.left': '{n} 天后清理',
  'trash.restore': '恢复',
  'trash.restored': '已恢复',
  'trash.kind.events': '日程',
  'trash.kind.todos': '待办',
  'trash.kind.notes': '随手记',
} as const;
