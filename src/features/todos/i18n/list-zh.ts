// 功能 todos 的词典·中文（架构 2.4）：待办列表页（B2 FA-2）和子任务（R-350：列表卡片、今天页进度、编辑页“子任务”区都在列表页那一包里）。
// 编辑页其余的在 zh.ts（那一份在审查中，列表另放一份）
export const listZh = {
  'list.title': '待办',
  'list.pullKey': '搜索本页', // R-437：标题行里平时看不见、Tab 到才出现的按钮（kit 的 PullKey）
  'list.all': '全部',
  'list.filter': '按项目筛选',
  'list.g.late': '过期',
  'list.g.today': '今天',
  'list.g.tomorrow': '明天',
  'list.g.later': '以后',
  'list.g.nodate': '没有日期',
  'list.g.doneN': '已完成 {n}',
  'list.empty': '还没有待办',
  // 副行的截止（R-434、R-436 确认图：逾期“! 过期 11/13 14:00”，其余“今天 14:00”“明天”“11/20 09:00”；日期、时刻等宽数字，拼法在 TodosPage 的 dueText）
  'list.due.late': '过期',
  'list.due.today': '今天',
  'list.due.tomorrow': '明天',
  // 标题下面一行等宽小字（R-436 第 2 条）：“11月15日 周日 · 1 / 10 完成”
  'list.sub': '{date} · {done} / {total} 完成',
  // 行右边 H / M / L（R-434）：读屏名字；编辑页的“优先级”三档在 zh.ts
  'list.prio': '优先级：{p}，点一下换成{next}',
  'list.prio.high': '高',
  'list.prio.mid': '中',
  'list.prio.low': '低',
  'list.done': '完成',
  'list.undoDone': '标成没完成',
  'list.delete': '删除',
  'list.deleted': '已删除',
  'list.undo': '撤销',
  'list.doneToast': '已完成',
  'list.err.save': '没保存上，稍后再试一次',
  'list.err.readonly': '这条要新版本才能修改',
  // 设置首页“完成 7 天后自动删除”（负责人 11-15 方案；ui/TodoSettings.tsx）
  'settings.autodel': '完成 7 天后自动删除',
  // R-350 子任务（方案 5.1、5.5、6.2、6.5）：列表卡片只能勾、看进度、收起；加删改在编辑页
  'items.progress': '{done}/{total}',
  'items.progress.a11y': '子任务已完成 {done} 项，共 {total} 项',
  'items.collapse': '收起',
  'items.expand': '展开',
  'items.collapse.a11y': '收起「{title}」的子任务',
  'items.expand.a11y': '展开「{title}」的子任务',
  'items.autoDone': '全部完成，已完成这条待办',
  // 编辑页“子任务”区（SubtaskEditor 在待办列表页那一包里，只用这一本词典，免得和编辑页共用词典多拆出一个分包）
  'items.title': '子任务',
  'items.add': '添加子任务',
  'items.itemLabel': '子任务「{title}」',
  'items.max': '最多 {n} 项',
  'items.needTitle': '写上标题才能加子任务',
  'items.delete': '删除「{title}」',
  'items.deleted': '已删除子任务',
  'items.move': '拖动排序「{title}」，也可以按 Alt + 上下方向键',
  'items.moveUp': '上移「{title}」',
  'items.moveDown': '下移「{title}」',
  'items.err.quota': '子任务最多 {n} 项，多出来的没有保存',
} as const;
