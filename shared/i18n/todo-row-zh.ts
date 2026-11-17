// 待办行（kit TodoRow、useTodoRows）的词条·中文：待办页、日历日清单的待办组、今天页三处同一份（独立评审 11-17 第 9、10 条：
// 原来今天页词典、待办页 list 词典各一份，一字不差）。经 kit/hooks/useTodoRowWords.ts 取用；今天页的待办行在首屏，这份跟着首屏，只有十几条。
// 加一条要同时加 todo-row-ko.ts；as const：值保留字面量类型
export const todoRowZh = {
  // 方框的读屏名字：没勾“完成”，勾了“标成没完成”
  'row.done': '完成',
  'row.undoDone': '标成没完成',
  // 行尾 H / M / L 的读屏名字（R-434）
  'row.prio': '优先级：{p}，按一下换成{next}',
  'row.prio.high': '高',
  'row.prio.mid': '中',
  'row.prio.low': '低',
  // 副行“起步 / 大半”小标签
  'row.stage.1': '起步',
  'row.stage.2': '大半',
  // 页底提示条：打勾完成的撤销条、删除的撤销条、出错条
  'row.doneToast': '已完成',
  'row.deleted': '已删除',
  'row.undo': '撤销',
  'row.err.save': '没保存上，稍后再试一次',
  'row.err.readonly': '这条要新版本才能修改',
} as const;

export type TodoRowMsgKey = keyof typeof todoRowZh;
