// 注销申请成功、或导出时发现账号停用 / 在冷静期以后离开这台设备（R-256 ⑤）：实现挪到 core/account-leave.ts（B4 插图，S13 PROBE-files，
// 随手记的插图上传也要走同一套），这里原样转出，设置页的引用不变
export {
  createLeaveAccount,
  defaultAccountLeaveDeps,
  leaveForDisabled,
  type AccountLeaveDeps,
  type AccountLeaveNotice,
  type DisabledLeaveDeps,
  type LeaveAccount,
} from '../../../core/account-leave.ts';
