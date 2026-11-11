// 编辑页共用词条·中文（架构 10.1“共用状态词典”）：待办、日程、随手记三个编辑页的保存状态、只读、删除和撤销，各页一字不差的只放这一份。
// 只给按需下载的编辑页用（kit 的 EditNotices.tsx 经 useEditT），不进首屏。各页不同的“写上标题才会保存”“格式不对”留在各功能词典。加一条要同时加 edit-ko.ts
export const editZh = {
  'edit.st.idle': '改了就自动保存',
  'edit.st.saving': '正在保存…',
  'edit.st.saved': '已自动保存',
  'edit.st.failed': '没保存上，内容还在这里，稍后再改一次',
  'edit.st.unavailable': '这台设备现在存不了，内容还在这里，稍后再改一次',
  'edit.st.readonly': '这条要新版本才能修改',
  'edit.st.missing': '找不到这一条，可能已在别的设备上删除',
  'edit.update': '更新',
  'edit.delete': '删除',
  'edit.deleted': '已删除。30 天内可以在“最近删除”里找回。',
  'edit.undo': '撤销',
} as const;

export type EditMsgKey = keyof typeof editZh;
