// 吉祥物一个角色的显示参数（只有类型）：目录 features/mascot/data/catalog.ts 填值，舞台 src/motion/mascot-stage.ts 读
/** 看向：画板坐标换成控制节点的坐标 */
export interface LookDef {
  /** 往画布派发指针移动，用素材自带的跟随（#15、#18、#19） */
  ptr?: boolean;
  /** 回到静止时发一次指针离开（#15 身体一圈是悬停发光区） */
  leave?: boolean;
  /** 直接挪这个节点 */
  node?: string;
  /** 挪名叫 eye1..eyeN 的节点（#13） */
  eyes?: number;
  max?: readonly [number, number];
  rest: readonly [number, number];
  /** 静止位置的画板坐标（和 rest 不同时才写） */
  restAB?: readonly [number, number];
  toLocal(x: number, y: number): [number, number];
  reach: number;
  /** 指针派发点夹在这个画板矩形里 [x0, y0, x1, y1]：出了素材感应范围眼睛会回正（#23） */
  box?: readonly [number, number, number, number];
  /** 点头、摇头的幅度（占 reach 的比例；#13 是眼睛位移） */
  wig?: number;
}

/** 事件和持续状态：待办勾完、新增、删除是一下子的；提醒在响（mail）、久不操作（sleep）持续到解除 */
export type MoodCue = 'done' | 'add' | 'del' | 'mail' | 'sleep';

/** 表情（#23 Aldo）：素材里加了直达通道，状态机数字输入 input 设成 n，任意状态转到 ring 里第 n 个（从 1 起，0 不指定）；
 *  驱动在 motion/mascot-moods.ts */
export interface MoodDef {
  /** 直达用的状态机数字输入 */
  input: string;
  /** 直达转场多长（ms，素材里的转场时长）：减少动态效果时等转场走完再停帧 */
  ms: number;
  /** 状态名（onStateChange 回报的名字），按原素材“下一个”触发的顺序：相邻关系照这个算 */
  ring: readonly string[];
  /** 平时回到的表情 */
  rest: string;
  /** 事件、持续状态对应的表情；没写的不反应 */
  on: Partial<Record<MoodCue, string>>;
  /** 空闲时随机去的表情 */
  random: readonly string[];
}

export interface MascotDef {
  url: string;
  /** 静态图：Rive 第一帧的图（build/gen_mascot_stills.mjs 出），Rive 载入前先显示、第一帧画出来同一帧换掉；没有就等 Rive */
  still?: string;
  artboard?: string;
  sm?: string;
  size: readonly [number, number];
  /** 显示的范围：x, y, 宽, 高（画板坐标） */
  crop: readonly [number, number, number, number];
  /** 画板四周加大了多少，crop 和 look 仍是原画板坐标（#19） */
  pad?: readonly [number, number];
  /** 不绑数据模型 */
  novm?: boolean;
  /** 可越过黄卡左边和下边，右边收在卡内（#19） */
  over?: boolean;
  /** 按卡片上半截定位：卡片底下多出“下一件…”这类行、卡片变高时不跟着往下掉（负责人 11-25：米粒、眼球）；不设的照旧贴底边站 */
  ride?: boolean;
  /** 载入时设的状态机输入（#19 眼睛颜色第 4 档是暖橙桃）；反应里 num 一步放完回到这里的值 */
  init?: Readonly<Record<string, number | boolean>>;
  look?: LookDef;
  /** 整体往指针那边偏这么多 CSS 像素，回静止时回正（#7 光球没有看向、只靠这个；#23 Aldo 和看向一起） */
  lean?: number;
  /** 待办勾完、新增、删除时的反应（短按没有形态的照 add）；带 moods 的由表情驱动，不写这个 */
  react?: Partial<Record<ReactCue, readonly ReactStep[]>>;
  /** 短按换形态：把这个数据模型数字加一，到 count 回 0（#23 Aldo） */
  forms?: { num: string; count: number };
  moods?: MoodDef;
}

export type ReactCue = Exclude<MoodCue, 'mail' | 'sleep'>;

/** 反应的一步，舞台（motion/mascot-stage.ts）按 do 解释；after 毫秒后再做（同一个输入、属性只留最新排的那次） */
export type ReactStep = { after?: number } & (
  /** 点头、摇头（按看向的幅度）、整体往上跳一下 */
  | { do: 'nod' | 'shake' | 'hop' }
  /** 状态机布尔输入：设成 true，ms 后回 false */
  | { do: 'pulse'; input: string; ms: number }
  /** 状态机数字输入：设成 value，ms 后回 init 里的值（没写回 0） */
  | { do: 'num'; input: string; value: number; ms: number }
  /** 状态机触发输入 */
  | { do: 'fire'; input: string }
  /** 数据模型枚举：设成 value；写了 back 就 ms 后改回 back（没写的由素材自己改回） */
  | { do: 'enum'; prop: string; value: string; back?: string; ms?: number }
  /** 数据模型触发 */
  | { do: 'trigger'; prop: string }
  /** 看向先回正前方停 ms 再放开（#15 勾完先看着你） */
  | { do: 'face'; ms: number }
);
