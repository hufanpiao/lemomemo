// 职责：全项目共用的常量（默认值、长度上限、动画时长、提示条时长、时钟间隔等），避免魔法数字散落在各处。
//       改动画时长时要同步检查对应的 CSS（注释里写了是哪一条）。
// 依赖：无
App.core = App.core || {};

App.core.C = {
  // 数据默认值与上限
  DEFAULT_DURATION_MIN: 60,     // 日程没写时长时按 1 小时
  NO_DUE: "9999",               // 排序时“没有截止日”排在最后
  TITLE_MAX: 160,               // 与 index.html 标题输入框 maxlength 一致
  PROJECT_MAX: 40,              // 与项目输入框 maxlength 一致
  NOTE_MAX: 200,                // 与备注输入框 maxlength 一致
  RAW_MAX: 1000,                // 原话最多保留的字数

  // 动画（毫秒）
  DONE_ANIM_MS: 960,            // 勾选后停顿再重排：todo.css .tb .tt 划线 .28s + 停留
  DONE_ANIM_REDUCED_MS: 800,    // 系统开了“减少动态效果”时的停顿
  SHEET_ANIM_MS: 340,           // 弹出层收起：sheet.css .sheet transition .34s
  FRESH_MS: 2400,               // 别处新加的条目高亮：todo.css @keyframes fresh 2.2s + 余量
  TOAST_LEAVE_MS: 200,          // 提示条淡出：toast.css .toast transition .2s

  // 提示条
  TOAST_MS: 3000,               // 普通提示
  TOAST_UNDO_MS: 8000,          // 带“撤销”的提示
  TOAST_RETRY_MS: 6000,         // 保存失败、带“重试”的提示
  TOAST_LOST_MS: 60000,         // 连接中断、带“刷新”的提示
  TOAST_MAX: 3,                 // 最多同时叠放几条
  DELETE_TITLE_CHARS: 12,       // 删除提示里显示标题的前几个字

  // 时间轴
  TL_PX_PER_HOUR: 52,
  TL_HOURS_BEFORE: 1,           // 现在之前至少显示 1 小时
  TL_HOURS_AFTER: 3,            // 现在之后至少显示 3 小时
  TL_MIN_HOURS: 4,              // 至少显示 4 小时
  TL_BLOCK_MIN_PX: 30,          // 色块最小高度
  TL_META_MIN_PX: 40,           // 色块高于这个才显示时间行

  // 列表
  SOON_DAYS: 2,                 // “今天要做”包含两天内到期的
  DUE_COUNTDOWN_DAYS: 7,        // 7 天内显示“还剩 N 天”
  UPCOMING_MAX: 30,             // “接下来”最多列多少项
  OLD_DONE_MAX: 100,            // 折叠的已完成最多显示多少项
  WEEK_DOTS_MAX: 3,             // 日期条每天最多几个小圆点
  TOMORROW_PREVIEW_HOUR: 18,    // 几点以后预告明天
  NARROW_NAV_PX: 380,           // 窄于这个宽度时导航只显示当前页文字

  // 提醒（v3，需求澄清 #1–#5、#28–#30）
  REMIND_EVENT_DEFAULT_MIN: 15,       // 有时间的日程默认提前 15 分钟
  REMIND_EVENT_OPTIONS: [null, 0, 15, 30, 60, 1440],   // 不提醒 / 准时 / 15 / 30 / 1 小时 / 1 天
  REMIND_DAY_MORNING_MIN: 9 * 60,     // 待办、全天日程“当天”提醒在 9:00
  REMIND_ALLDAY_PREV_MIN: 20 * 60,    // 全天日程“前一天”提醒在 20:00
  REMIND_TODO_PREV_MIN: 9 * 60,       // 待办“前一天”提醒在 9:00
  REMIND_STALE_MS: 60 * 60000,        // 提醒时刻过去 60 分钟以上就不再发（#30）
  PUSH_LEAD_MS: 15 * 60000,           // 定时推送宁可提前 15 分钟（#5）
  SNOOZE_MS: 10 * 60000,              // “10 分钟后”

  // 最近删除（v3，ADR-006）
  TRASH_KEEP_DAYS: 30,                // 软删除 30 天后彻底清理

  // 运行日志（v3，ADR-010）
  LOG_MAX_ENTRIES: 500,               // 每台设备每天一条文档，最多 500 条
  LOG_KEEP_DAYS: 90,                  // 保留 90 天
  LOG_FLUSH_MS: 30000,                // 每 30 秒写一次（切到后台时立即写）

  // 时钟、写入与连接
  CLOCK_TICK_MS: 60000,         // 每分钟刷新一次时间轴和倒计时
  CLOCK_ALIGN_MS: 200,          // tick 安排在整分钟后 200 毫秒（要求 1 秒内）
  WRITE_TIMEOUT_MS: 10000,      // 写入超过 10 秒没回应算失败
  RECONNECT_MS: [3000, 10000, 30000, 60000],   // 断线后第 1、2、3、4+ 次重连的等待
};
