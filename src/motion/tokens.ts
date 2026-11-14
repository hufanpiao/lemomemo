// 动效令牌的 TS 写法（架构 17.2 第 1 点、17.3）：和 src/styles/tokens.css 是同一组值的两种写法，
// 由 src/motion/__tests__/tokens.test.ts 比对两边一致（数值来源：docs/02-设计/皮肤-v4/令牌/tokens.json）。
// 单位按 Motion 的习惯换成秒；曲线是 cubic-bezier 的四个数。
// 这是 A24 的唯一例外文件：别处传给 Motion 的 duration、ease 只能引用这里的常量。

/** 时长（秒） */
export const dur = {
  /** --dur-press 120ms：按下 */
  press: 0.12,
  /** --dur-ui 220ms：提示条、勾选、淡入淡出、列表增删 */
  ui: 0.22,
  /** --dur-sheet 380ms：弹层、录音面板、页面切换 */
  sheet: 0.38,
  /** --dur-drop 0.55s：底栏液滴（R-155，唯一超过 400ms 的例外） */
  drop: 0.55,
  /** --dur-glass 0.3s：液态玻璃深浅切换 */
  glass: 0.3,
  /** --dur-drop-press 0.25s：按住当前选中的页签时液滴放大（FA-7 设计动效评审 D3） */
  dropPress: 0.25,
  /** --dur-splash-* ：启动画面（src/styles/splash.css，R-254 方向 B）专用，别处不用 */
  splashStill: 0.8,
  splashBar2: 1,
  splashBar3: 1.2,
  splashBreathe: 1.6,
  splashDark: 0.6,
  splashOutRm: 0.12,
  splashFailsafe: 6,
} as const;

export type Bezier = readonly [number, number, number, number];

/** 曲线令牌 → CSS / WAAPI 的 cubic-bezier() 字符串（motion/index.ts、desk-sort.ts 共用） */
export const bezierCss = (b: Bezier): string => `cubic-bezier(${b.join(',')})`;

/** 曲线 */
export const ease = {
  /** --ease-standard：只留给页面切换 */
  standard: [0.2, 0, 0, 1],
  /** --ease-spring（带过冲）：只用于按下回弹和庆祝类 */
  spring: [0.34, 1.32, 0.64, 1],
  /** --ease-out：提示条、列表项、淡入这类进场 */
  out: [0.23, 1, 0.32, 1],
  /** --ease-drawer：弹层、录音面板这类抽屉 */
  drawer: [0.32, 0.72, 0, 1],
  /** --ease-drop：液滴 */
  drop: [0.34, 1.45, 0.5, 1],
  /** --ease-gel：液滴拉伸 */
  gel: [0.3, 0.9, 0.4, 1],
  /**
   * --ease-press：按住液滴鼓起（玻璃皮肤，R-143）。回冲 1.5，**不要用于按下那一段**：Pressable 按下用 ease.out、松开用 ease.spring（UI4-B1-C3），
   * 用它会缩过按下的 scale(0.97)（Pressable.module.css）再弹回。现在全站没人用；令牌表要留（tokens.json 同一句说明，11-05 主持人定保留并注明）
   */
  press: [0.3, 1.5, 0.5, 1],
  /** --ease-splash-breathe：启动画面竖条起伏（等于 ease-in-out），别处不用 */
  splashBreathe: [0.42, 0, 0.58, 1],
} as const satisfies Record<string, Bezier>;

/** 弹簧：刚度 380、阻尼比 0.78、质量 1；Motion 用 damping，按 m = 1 换算成 2·ζ·√k（17.2） */
export const SPRING_STIFFNESS = 380;
export const SPRING_DAMPING_RATIO = 0.78;
export const SPRING_MASS = 1;
export const spring = {
  type: 'spring',
  stiffness: SPRING_STIFFNESS,
  damping: 2 * SPRING_DAMPING_RATIO * Math.sqrt(SPRING_STIFFNESS * SPRING_MASS),
  mass: SPRING_MASS,
} as const;

/** TS 常量和 CSS 变量的对应关系（测试用它逐项比对） */
export const cssVarOf = {
  dur: {
    press: '--dur-press',
    ui: '--dur-ui',
    sheet: '--dur-sheet',
    drop: '--dur-drop',
    glass: '--dur-glass',
    dropPress: '--dur-drop-press',
    splashStill: '--dur-splash-still',
    splashBar2: '--dur-splash-bar2',
    splashBar3: '--dur-splash-bar3',
    splashBreathe: '--dur-splash-breathe',
    splashDark: '--dur-splash-dark',
    splashOutRm: '--dur-splash-out-rm',
    splashFailsafe: '--dur-splash-failsafe',
  },
  ease: {
    standard: '--ease-standard',
    spring: '--ease-spring',
    out: '--ease-out',
    drawer: '--ease-drawer',
    drop: '--ease-drop',
    gel: '--ease-gel',
    press: '--ease-press',
    splashBreathe: '--ease-splash-breathe',
  },
} as const satisfies { dur: Record<keyof typeof dur, string>; ease: Record<keyof typeof ease, string> };

/** 弹层退场是进场的几倍（MOTION-sheet-exit，B2 动效自查 11-04）：用户主动关闭时“快收”，进出不对称；
 * 取 0.6～0.7 的中间值，由 --dur-sheet 推出来，不另起一个令牌（380ms × 0.65 ≈ 247ms） */
export const SHEET_EXIT_RATIO = 0.65;

/** 列表收拢晚几帧开始（B2 FA-5 第三轮设计审查 P1，11-04）：离开的那一项先淡出两帧（≈ 33 ms），下面的行再收上来，
 * 今天页“没赶上”整组离开时，紧贴在卡片下沿的“今天的安排”第一帧移动时残影已在 0.25 以下。
 * 由 --dur-ui 推出来（220ms × 0.15 = 33ms），不另起令牌；减少动态效果时不用（layout 本来就直接到位） */
export const LIST_LAYOUT_LAG_RATIO = 0.15;
export const LIST_LAYOUT_LAG = dur.ui * LIST_LAYOUT_LAG_RATIO;

/**
 * 吞掉“补来的那一下 click”最多等多久（毫秒；swallow-click.ts 的 swallowNextClick 的默认时限）。
 * 只管“一直没等到 click 时监听挂多久”：新的一次按下、pointercancel 一律作废，所以取一个能盖住几处的值就够
 * （R-420 审查第 12 条合成一个：原来翻页、左滑行 600，按住“＋”800，换页守卫晚到的那一下 1000，取最大的 1000）
 */
export const TAP_SWALLOW_MS = 1000;

/** 现成的 Motion transition（组件里直接用这些，不自己拼） */
export const tr = {
  // 同上：只给“按住液滴鼓起”留着，不要拿来做按下回弹（11-05）
  press: { duration: dur.press, ease: ease.press },
  ui: { duration: dur.ui, ease: ease.out },
  sheet: { duration: dur.sheet, ease: ease.drawer },
  /** 弹层退场：同一条抽屉曲线，时长是进场的 SHEET_EXIT_RATIO 倍 */
  sheetExit: { duration: dur.sheet * SHEET_EXIT_RATIO, ease: ease.drawer },
  page: { duration: dur.sheet, ease: ease.standard },
  spring,
} as const;
