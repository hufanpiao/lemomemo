// View Transitions 的名字统一在这里（架构 17.2 第 3 点）：
// • 动态名字：vtName() 生成 vt-item-<id> 这类，写在内联 style 上
// • 固定名字（页面骨架，如设置和注销两屏的顶栏）：写在 CSS Modules 里，名字必须登记在 VT_FIXED（UI4-B1-low X-5）；
//   CSS 里出现没登记的 view-transition-name，tests/arch 的 vt-names 测试会报错
// 同一时刻页面上不能有两个同名元素：开发版每次切页画完新页面后检查，重名就在控制台报错（reportDuplicateVtNames，motion/index.ts 调）

export function vtName(kind: 'item' | 'plus' | 'nav', id = ''): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '');
  return safe ? `vt-${kind}-${safe}` : `vt-${kind}`;
}

/** 写在 CSS 里的固定名字（CSS 里直接写这些字面值；base.css 的 ::view-transition-*(名字) 也只准用这些） */
export const VT_FIXED = {
  /** 设置、注销账号、设置 › 日历几屏的顶栏（SettingsPage.module.css .top）：切换时先出后入（base.css） */
  pageHead: 'page-head',
  /** 底栏和“＋”（B2 FA-7，GlassBar.module.css）：切页时不跟着淡入淡出，直接用新的（base.css） */
  tabbar: 'tabbar',
  tabbarAdd: 'tabbar-add',
  /** 顶部渐变模糊带的两层（入口页的 .lemo-top-8、.lemo-top-2，base.css）：切页时不跟着整页淡掉（动效复审 M5，11-06） */
  topBlur8: 'top-blur-8',
  topBlur2: 'top-blur-2',
} as const;

/** 一个元素实际生效的 view-transition-name：读计算样式，CSS Modules 里起的名字和内联 style 都算（X-5：原来只扫内联 style） */
function nameOf(el: Element): string {
  const v = getComputedStyle(el).getPropertyValue('view-transition-name').trim();
  return v === 'none' ? '' : v;
}

/** 找出重名的 view-transition-name（返回重名的名字） */
export function findDuplicateVtNames(root: ParentNode): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const el of root.querySelectorAll('*')) {
    const n = nameOf(el);
    if (!n) continue;
    if (seen.has(n)) dup.add(n);
    seen.add(n);
  }
  return [...dup];
}

/** 开发版：有重名就在控制台报错（同名的两个元素会让这次 View Transition 直接失败） */
export function reportDuplicateVtNames(root: ParentNode): void {
  const dup = findDuplicateVtNames(root);
  if (dup.length > 0) console.error(`[vt] duplicate view-transition-name: ${dup.join(', ')}`);
}
