// 本机库 planner-v4 里 SW 和页面共用的名字和记录形状（第三方审查后端-5）：库名、owner 仓和它的键、pending_actions 仓、
// 通知按键（推迟、完成）的类型和推迟分钟数的上限。SW 不准引 core（A19）、platform 不引 core，两边都从这里引，只定义这一处
// （原来 src/sw/pending.ts、platform/exit-basics.ts、core/pending-actions.ts、sw/push-actions.ts 各一份，靠测试逐项核对）
// 不 import 任何东西：SW 包和首屏都引它（tests/build/local-db-shared.test.ts 钉住）

/** 本机库名（core/cache.ts 的 DB_NAME、platform/exit-basics.ts 的删库、SW 写 pending_actions 都用它） */
export const LOCAL_DB_NAME = 'planner-v4';
/** 记“这个库归哪个账号”的仓；唯一一条记录的键是 OWNER_KEY，值是 user_id */
export const OWNER_STORE = 'owner';
export const OWNER_KEY = 'user_id';
/** SW 记通知按键的仓（页面启动后转进 outbox） */
export const PENDING_STORE = 'pending_actions';

/** 推迟分钟数的范围（1 分钟～1 天；后端一律发 10） */
export const SNOOZE_MAX_MIN = 24 * 60;
export const isSnoozeMin = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= SNOOZE_MAX_MIN;

/** 通知上的“推迟”按键（iPhone 的网页推送不显示按钮、exe 的通知不带按钮，只影响 Edge 安装版） */
export interface SnoozeAction {
  readonly type: 'snooze';
  /** 推迟多少分钟（1～SNOOZE_MAX_MIN 的整数） */
  readonly minutes: number;
  /** 按的是哪一次到点（推送里的 due_at，epoch ms）：页面转成 outbox 时据此判断这一次是不是已经处理过 */
  readonly due_at: number;
}

/** “完成”（只待办，R-294、R-307）：和推迟同一条 pending 路径，页面转成 outbox，整页提醒里能撤销 */
export interface DoneAction {
  readonly type: 'done';
  /** 按的是哪一次到点（同 SnoozeAction.due_at） */
  readonly due_at: number;
}

/** pending_actions 里的一项（SW 写、页面读；0.29 续第 107 条②）。不准存明文标题、正文 */
export interface SwPendingAction {
  readonly id: string;
  readonly user_id: string;
  readonly row_table: 'events' | 'todos' | 'anniversaries';
  readonly row_id: string;
  readonly action: SnoozeAction | DoneAction;
  /** epoch ms */
  readonly created_at: number;
}
