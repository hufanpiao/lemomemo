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
  /** --ease-press：按下 */
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

/** 现成的 Motion transition（组件里直接用这些，不自己拼） */
export const tr = {
  press: { duration: dur.press, ease: ease.press },
  ui: { duration: dur.ui, ease: ease.out },
  sheet: { duration: dur.sheet, ease: ease.drawer },
  page: { duration: dur.sheet, ease: ease.standard },
  spring,
} as const;
