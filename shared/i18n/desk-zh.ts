// 电脑版布局（5.9b）的词条·中文：今天页、随手记页共用（B6；做法同 ro-zh.ts）。只给按需下载的电脑版块用
// （kit 的 DeskLayout，经 kit/hooks/useDeskT.ts），放在公共词典里会跟着首屏下载。加一条要同时加 desk-ko.ts
// as const：值保留字面量类型
export const deskZh = {
  'desk.handle': '移动“{name}”',
  'desk.handleHint': '空格拿起，方向键移动，空格放下，Esc 取消',
  'desk.collapse': '收起“{name}”',
  'desk.resize': '第 {n} 栏和第 {m} 栏的宽度',
  'desk.more': '布局',
  'desk.lock': '锁定布局',
  'desk.collapsed': '收起的块',
  'desk.collapsedNone': '没有收起的块',
  'desk.restore': '放回“{name}”',
  'desk.reset': '恢复默认布局',
  'desk.saved': '布局已保存',
  'desk.undo': '撤销',
  'desk.picked': '拿起了“{name}”，第 {c} 栏第 {n} 个',
  'desk.at': '“{name}”，第 {c} 栏第 {n} 个',
  'desk.dropped': '放下了“{name}”，第 {c} 栏第 {n} 个',
  'desk.cancelled': '已取消，“{name}”回到第 {c} 栏第 {n} 个',
  'desk.toLeft': '抽屉换到左边',
  'desk.toRight': '抽屉换到右边',
} as const;

export type DeskMsgKey = keyof typeof deskZh;
