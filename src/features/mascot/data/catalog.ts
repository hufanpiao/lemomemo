// 吉祥物目录（方案目录 接入要点.md）：文件、画板、裁切、看向的控制节点、反应，数值照定稿演示页
// • .riv 由 Vite 发到 /app/assets/，不进预缓存（sw/routes.ts 的 excludedFromPrecache），选中哪个才下载哪个
// • still：Rive 载入前先显示的静态图（Rive 第一帧，build/gen_mascot_stills.mjs 出，同样不进预缓存）；#15 开场是入场动画，不放
// • #2 是同人作品，不随 App 分发，不在这张表里：参数和下载在 ./mascot-private.ts，只有管理员能用
// • 反应（react）、载入时的输入（init）、表情（moods）、形态（forms）都写在这里，舞台（motion/mascot-stage.ts）只解释数据、不认 id；
//   写的输入、属性、状态名都要在素材里（__tests__/mascot.test.ts 的目录一致性按字节查）
// 署名见 ./credits-data.ts，存储的键和解码见 ./mascot-setting.ts

import type { MascotDef, ReactStep } from '../../../../shared/schema/mascot.ts';

export type { MascotDef };

const same = (x: number, y: number): [number, number] => [x, y];
const nod: ReactStep = { do: 'nod' };
const shake: ReactStep = { do: 'shake' };

export const MASCOT_IDS = ['15', '3', '7', '13', '18', '19', '20', '22', '23'] as const;
export type MascotId = (typeof MASCOT_IDS)[number];
/** 私有的 #2 */
export const PRIVATE_ID = '2';
export type MascotChoice = MascotId | typeof PRIVATE_ID;
/** 没选过的人默认 Aldo；管理员没选过是 #2（mascot-setting.ts） */
export const DEFAULT_MASCOT: MascotId = '23';
/** 官网首页样机是按这 7 只画的（静帧缩略图、换吉祥物的演示时间线），后加的不进官网（build/site_home.mjs、build_site.mjs） */
export const SITE_MASCOT_IDS: readonly MascotId[] = ['15', '3', '7', '13', '18', '19', '20'];

/** #13 七个米粒的布尔输入：勾完时依次蹦一下 */
const MEEPLES = ['Blue', 'BigO', 'Yellow', 'Teal', 'LilO', 'Purple', 'BigBlue'];

export const MASCOTS: Record<MascotId, MascotDef> = {
  '15': {
    url: new URL('../assets/milly.riv', import.meta.url).href,
    size: [800, 800],
    crop: [150, 223, 500, 400],
    ride: true,
    look: { ptr: true, leave: true, rest: [400, 420], toLocal: same, reach: 400, wig: 0.4 },
    react: {
      done: [{ do: 'face', ms: 1300 }, nod],
      add: [{ do: 'enum', prop: 'agentState', value: 'typing', back: 'Idle', ms: 1200 }],
      del: [{ do: 'trigger', prop: 'dizzyTrigger' }],
    },
  },
  '3': {
    url: new URL('../assets/cat.riv', import.meta.url).href,
    still: new URL('../assets/cat.still.webp', import.meta.url).href,
    size: [500, 500],
    crop: [85, 90, 330, 340],
    novm: true,
    look: { node: 'Face_CONTROL', rest: [256.75, 255.75], toLocal: same, reach: 200 },
    react: { done: [nod, { do: 'hop' }], add: [nod], del: [shake] },
  },
  '7': {
    url: new URL('../assets/orb.riv', import.meta.url).href,
    still: new URL('../assets/orb.still.webp', import.meta.url).href,
    artboard: 'Orb',
    sm: 'Orb',
    size: [400, 400],
    crop: [10, 0, 380, 380],
    lean: 8,
    react: {
      done: [{ do: 'trigger', prop: 'tap' }, { do: 'enum', prop: 'state', value: 'speaking', back: 'idle', ms: 1200 }],
      add: [{ do: 'enum', prop: 'state', value: 'listening', back: 'idle', ms: 1200 }],
      del: [{ do: 'trigger', prop: 'interrupt' }],
    },
  },
  '13': {
    url: new URL('../assets/meeples.riv', import.meta.url).href,
    still: new URL('../assets/meeples.still.webp', import.meta.url).href,
    artboard: 'Meeple',
    sm: 'Meeples',
    size: [1920, 1080],
    crop: [360, 200, 1120, 714.1],
    novm: true,
    look: { eyes: 14, max: [5, 4], rest: [0, 0], toLocal: same, reach: 1, wig: 4 },
    react: {
      done: MEEPLES.map((input, j): ReactStep => ({ do: 'pulse', input, ms: 700, after: j * 90 })),
      add: [{ do: 'pulse', input: 'BigBlue', ms: 900 }, nod],
      del: [shake],
    },
  },
  '18': {
    url: new URL('../assets/boy.riv', import.meta.url).href,
    still: new URL('../assets/boy.still.webp', import.meta.url).href,
    artboard: 'Artboard',
    size: [1000, 1000],
    crop: [280, 140, 540, 540],
    novm: true,
    look: { ptr: true, rest: [500, 450], toLocal: same, reach: 450, wig: 0.6 },
    react: { done: [nod], add: [nod], del: [shake] },
  },
  '19': {
    url: new URL('../assets/bob.riv', import.meta.url).href,
    still: new URL('../assets/bob.still.webp', import.meta.url).href,
    artboard: 'NO START',
    sm: 'State Machine',
    size: [1163, 1155],
    pad: [240, 140],
    crop: [80, 40, 520, 420],
    novm: true,
    over: true,
    ride: true,
    init: { 'Eye Color Number': 4 },
    look: { ptr: true, rest: [341, 300], toLocal: same, reach: 250, wig: 0.3 },
    react: { done: [{ do: 'num', input: 'Eye Color Number', value: 3, ms: 1200 }, nod], add: [nod], del: [shake] },
  },
  '20': {
    url: new URL('../assets/catbot.riv', import.meta.url).href,
    still: new URL('../assets/catbot.still.webp', import.meta.url).href,
    artboard: 'RobotCat_02',
    size: [600, 600],
    crop: [90, 40, 440, 540],
    novm: true,
    look: {
      node: 'Controller',
      rest: [68.12, -407.85],
      restAB: [262.99, 259],
      toLocal: (x, y) => [(314.08 - x) / 0.75, (y - 564.91) / 0.75],
      reach: 150,
    },
    react: { done: [{ do: 'fire', input: 'Walk' }, { do: 'fire', input: 'StopWalk', after: 1200 }, nod], add: [nod], del: [shake] },
  },
  // 去底、去掉肚子上的 PUSH 字；裁切比试接时的 [80,55,340,470] 宽高各放大 1/0.88、底边和中线不动，显示小约 12%
  // 笑一下：数据模型枚举 poses 设成 giggle，播完素材自己的事件把它改回 idle
  '22': {
    url: new URL('../assets/monster.riv', import.meta.url).href,
    still: new URL('../assets/monster.still.webp', import.meta.url).href,
    size: [500, 559],
    crop: [57, -9, 386, 534],
    look: { ptr: true, rest: [252, 230], toLocal: same, reach: 220, wig: 0.3 },
    react: { done: [{ do: 'enum', prop: 'poses', value: 'giggle' }], add: [{ do: 'enum', prop: 'poses', value: 'giggle' }], del: [shake] },
  },
  // 原样白：去底、按钮只藏外观（点击区和状态机不动）、文字气泡的字体换成 1×1 空资源；裁切底边对齐原作地面线 y≈305
  // 状态机加了直达通道：数字输入 mood + 任意状态到 9 个表情各一条转场（条件 mood == 序号 + 1，500ms，照原转场）
  '23': {
    url: new URL('../assets/aldo.riv', import.meta.url).href,
    still: new URL('../assets/aldo.still.webp', import.meta.url).href,
    size: [600, 450],
    crop: [150, 28, 300, 278],
    // 眼睛跟手：素材的位移和指针离中心的距离成正比，指针出了素材的感应范围眼睛就回正（11-26 实测：往右过 ~260、往下过 ~180 就回正），
    // 所以半径放到 240（负责人 11-26 选“放大一半”），再夹在 box 里不出感应范围；点按时整只往手指那边偏 lean 像素
    look: { ptr: true, leave: true, rest: [300, 260], toLocal: same, reach: 240, box: [50, 20, 550, 430] },
    lean: 5,
    forms: { num: 'detailsIndex', count: 6 },
    moods: {
      input: 'mood',
      ms: 500,
      // ring 的顺序就是素材直达输入的序号（mood == 序号 + 1），Sad、Upset 留在环上占位，只是不再用
      ring: ['Idle', 'Happy', 'Think', 'Wink', 'Sad', 'No', 'Upset', 'Mail', 'Sleep'],
      rest: 'Idle',
      on: { done: 'Happy', del: 'No', mail: 'Mail', sleep: 'Sleep' },
      // 负责人 11-26：难过（Sad）、不高兴（Upset）“再也不出现”
      random: ['Idle', 'Happy', 'Think', 'Wink', 'No'],
    },
  },
};

/** 输入框小人 #11 */
export const PEEK: MascotDef = { url: new URL('../assets/chat.riv', import.meta.url).href, size: [500, 434], crop: [160, 28, 190, 152] };
