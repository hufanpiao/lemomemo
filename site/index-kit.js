// 官网首页脚本：公用小工具、页面语言、测试钩子、手机里的演示剧本（每一项一段按时间播的小剧本）。
// 首页的脚本都是 ES 模块，入口是 index.js；页面由 build/site_home.mjs 生成，样式是 index.css。
// 只用 el.style 写样式（CSP style-src 'self'）。
const doc = document.documentElement;
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const seg = (u, a, b) => clamp((u - a) / (b - a));
const sm = (x) => x * x * (3 - 2 * x);
const eo = (x) => 1 - Math.pow(1 - x, 3);
const eio = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
/** 和 CSS cubic-bezier 同一条曲线（二分求 t，便宜、稳） */
const bez = (x1, y1, x2, y2) => {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let lo = 0, hi = 1, m = x;
    for (let i = 0; i < 18; i++) { m = (lo + hi) / 2; if (((ax * m + bx) * m + cx) * m < x) lo = m; else hi = m; }
    return ((ay * m + by) * m + cy) * m;
  };
};
const eOut = bez(0.23, 1, 0.32, 1);   // 先快后慢（--e-out）
/** 浏览器空闲时再做（首帧以后）；不支持 requestIdleCallback 就晚一点做 */
const idle = (fn, to) => ('requestIdleCallback' in window ? requestIdleCallback(() => fn(), { timeout: to || 1500 }) : setTimeout(fn, 80));
/** 300ms 没滚动、再等浏览器空闲才做（建小人、收尾预播这类一下就要 100ms 以上的活，不放在滚动中） */
let LAST_SC = 0;
addEventListener('scroll', () => { LAST_SC = performance.now(); }, { passive: true });
const quiet = (fn) => {
  const go = () => { if (performance.now() - LAST_SC < 300) { setTimeout(go, 150); return; } idle(() => { if (performance.now() - LAST_SC < 300) go(); else fn(); }, 1000); };
  go();
};
const f3 = (x) => (Math.round(x * 1000) / 1000).toString();
const SC = new WeakMap();
const put = (el, k, v) => { let o = SC.get(el); if (!o) SC.set(el, (o = {})); if (o[k] !== v) { o[k] = v; if (k[0] === '-') el.style.setProperty(k, v); else el.style[k] = v; } };

/* ================= 语言：中文、韩文各一页（/zh/、/ko/），从 <html lang> 读；切语言走页脚和页顶的链接 ================= */
const lang = doc.lang === 'ko' ? 'ko' : 'zh';
const L = (zh, ko) => (lang === 'ko' ? ko : zh);
// ⑭ 那一屏：从页面当前语言切到另一种
const lz = $('.s-lang .L-zh'), lk = $('.s-lang .L-ko'), oz = $('.s-lang .op-zh'), ok = $('.s-lang .op-ko');
if (lz) {
  const a = lang === 'ko' ? lk : lz, b = lang === 'ko' ? lz : lk;
  a.classList.add('L0'); a.classList.remove('L1'); b.classList.add('L1'); b.classList.remove('L0');
  (lang === 'ko' ? ok : oz).className = 'op op-' + lang + ' start'; (lang === 'ko' ? oz : ok).className = 'op op-' + (lang === 'ko' ? 'zh' : 'ko') + ' other';
}

/* ================= 手机里的演示：每一项一段按时间播的小剧本（进屏播、出屏停） =================
   事件：['tap', 按下, 松开, 点哪里]、['hold', …]（长按）、['drag', 按下, 松开, 从哪, dx, dy, 跟着动的元素, mdx, mdy, 停到几秒]、['swipe', 按下, 抬手, 从哪, dx, dy, 弧线]（画面不跟手）
         ['c', 开始, 结束, 元素('' = 这一屏), 类名]、['type', 开始, 结束, 元素]（字一个个打出来）
   “@” 开头的选择器在整台手机里找（例如右下角的 ＋）。%o = 另一种语言。先按下，画面再反应。 */
const DEMO = {
  // 11-26 第五轮：每段出结果的时间（res）压到 2.5 秒内，整段循环（dur）不超过 6 秒；演示时间跟着滚动走——每一项前 70% 的滚动把时间从 0 推到 res，
  // 停手以后照时钟往后播（两者取大的）；still 是减少动态效果、截图冻结时停的那一刻
  // 短按＋（tap，手指点一下就松）：打字条弹出 → 打字 → 签边打边填 → 点“记下” → 正在识别 → 记成今天的待办
  type: { dur: 6.0, res: 2.3, still: 3.0, ev: [['tap', 0.4, 0.5, '@.fab'], ['c', 0.52, 2.2, '', 'tbon'], ['type', 0.75, 1.45, '.tb-f .ty'], ['c', 0.75, 2.2, '', 'typed'], ['c', 1.05, 99, '', 'fill'], ['c', 1.05, 99, '.pf', 'alt'], ['c', 1.05, 99, '.pf-n', 'alt'],
    // 打字时手指在键盘上点几下（和长按＋的按住不放区分开）
    ['tap', 0.78, 0.84, '.kbd > p:nth-child(2) > span:nth-child(7)'], ['tap', 1.01, 1.07, '.kbd > p:nth-child(1) > span:nth-child(8)'], ['tap', 1.24, 1.3, '.kbd > p:nth-child(3) > span:nth-child(7)'],
    ['tap', 1.62, 1.72, '.tb-save'], ['c', 1.72, 2.2, '', 'recog'], ['c', 2.25, 99, '', 'added'], ['c', 2.25, 99, '.cnt5', 'alt'], ['c', 2.35, 5.2, '', 'toaston']] },
  // 打字条打“总结一下这周的日程” → 按记下 → 结果层整屏打开（本机认出是“总结”，不走 AI 判断）→ 正在总结… → 总结正文 + 依据
  sum: { dur: 6.0, res: 2.3, still: 3.6, ev: [['tap', 0.4, 0.5, '@.fab'], ['c', 0.52, 1.55, '', 'tbon'], ['type', 0.7, 1.2, '.tb-f .ty'], ['c', 0.7, 1.55, '', 'typed'],
    ['tap', 0.74, 0.8, '.kbd > p:nth-child(1) > span:nth-child(6)'], ['tap', 0.97, 1.03, '.kbd > p:nth-child(2) > span:nth-child(4)'],
    ['tap', 1.3, 1.4, '.tb-save'], ['c', 1.45, 99, '', 'aso'], ['c', 1.45, 2.2, '', 'swait'], ['c', 2.2, 99, '', 'sdone']] },
  // 长按＋（hold，外圈一圈圈往外走）
  voice: { dur: 6.0, res: 2.2, still: 2.8, ev: [['hold', 0.4, 1.6, '@.fab'], ['c', 0.45, 2.0, '', 'recon'], ['c', 0.55, 1.6, '.wave', 'live'], ['type', 0.65, 1.45, '.heard .ty'], ['c', 1.6, 2.0, '', 'busy'], ['c', 2.05, 99, '', 'added'], ['c', 2.15, 5.3, '', 'toaston']] },
  find: { dur: 6.0, res: 2.2, still: 3.0, ev: [['tap', 0.4, 0.5, '.fd-in'], ['c', 0.5, 99, '', 'focus'], ['type', 0.6, 1.25, '.fd-in .ty'], ['c', 1.3, 1.8, '', 'wait'], ['c', 1.8, 99, '', 'res'], ['tap', 3.4, 3.5, '.fr1'], ['c', 3.5, 5.2, '.fr1', 'hl']] },
  chat: { dur: 6.0, res: 2.4, still: 3.2, ev: [['tap', 0.35, 0.45, '.ch-in'], ['c', 0.45, 99, '', 'focus'], ['type', 0.55, 1.2, '.ch-in .ty'], ['tap', 1.38, 1.48, '.send'], ['c', 1.5, 99, '', 'sent'], ['c', 1.6, 2.2, '', 'think'], ['c', 2.2, 99, '', 'anson'], ['tap', 3.8, 3.9, '.src > span'], ['c', 3.9, 5.3, '.src > span', 'hl']] },
  aip: { dur: 5.5, res: 2.1, still: 3.2, ev: [['tap', 0.45, 0.55, '.o2'], ['c', 0.55, 99, '', 'own'], ['tap', 1.3, 1.4, '.pv-c'], ['c', 1.4, 99, '', 'pcl'], ['c', 2.0, 99, '', 'memhl']] },
  week: { dur: 5.6, res: 1.9, still: 2.4, ev: [['tap', 0.45, 0.55, '.prev'], ['c', 0.55, 1.42, '', 'b1'], ['tap', 1.3, 1.42, '.prev'], ['c', 1.42, 4.22, '', 'b2'], ['tap', 4.1, 4.22, '.wk-today']] },
  month: { dur: 5.6, res: 2.4, still: 3.6, ev: [['tap', 0.45, 0.55, '.cn-m'], ['c', 0.58, 99, '', 'mon'], ['tap', 1.9, 2.0, '.cn-n'], ['c', 2.03, 99, '', 'nx']] },
  anv: { dur: 5.6, res: 2.4, still: 3.2, ev: [['tap', 0.4, 0.5, '@.fab'], ['c', 0.53, 99, '', 'form'], ['type', 0.85, 1.3, '.anf .ty'], ['tap', 1.5, 1.6, '.sl2 .b'], ['c', 1.6, 99, '', 'lunar'], ['tap', 2.05, 2.15, '.r3'], ['c', 2.15, 99, '', 'r3on']] },
  fort: { dur: 6.0, res: 2.4, still: 3.4, ev: [['tap', 0.45, 0.55, '.bt'], ['c', 0.58, 1.55, '', 'bday'], ['tap', 1.3, 1.4, '.bday .ok'], ['c', 1.55, 99, '', 'fortune']] },
  // 点火车票那一行的 H → 换成高 → 这一行挪到“今天”最前（妈妈那条往下让）
  todo: { dur: 6.0, res: 2.4, still: 3.2, ev: [['tap', 0.45, 0.55, '.r-train .hml .h'], ['c', 0.55, 99, '.r-train', 'p-up'], ['c', 0.55, 99, '.lc-today', 'swap'], ['drag', 1.0, 1.55, '.r-book .tx', -86, 0, '.r-book .sw-face', -72, 0, 4.6], ['tap', 1.95, 2.05, '.r-mom .ck'], ['c', 2.05, 99, '.r-mom', 'done'], ['c', 2.05, 99, '.r-mom .tx', 'strike'], ['c', 2.05, 99, '.cnt1', 'alt']] },
  sub: { dur: 6.0, res: 2.4, still: 3.0, ev: [['tap', 0.3, 0.4, '.r-wint .tx'], ['c', 0.42, 1.55, '', 'edit'], ['tap', 0.85, 0.93, '.ed-add'], ['c', 0.93, 99, '', 'added'], ['type', 0.98, 1.25, '.ed-s3 .ty'], ['drag', 1.32, 1.55, '.ed .grab', 0, 150], ['tap', 1.75, 1.83, '.sb2 .ck'], ['c', 1.83, 99, '', 'c2'], ['tap', 2.02, 2.1, '.sb3 .ck'], ['c', 2.1, 99, '', 'c3'], ['c', 2.3, 99, '', 'all'], ['c', 2.3, 99, '.cnt4', 'alt'], ['c', 2.4, 5.3, '', 'toaston']] },
  // 点输入框打一句 → 点图片键 → 选一张 → 小图放在输入行上面 → 点“记下” → 新一条带着这张图当封面落进来，再贴上分类
  note: { dur: 6.0, res: 2.5, still: 3.4, ev: [['tap', 0.3, 0.4, '.nt-f'], ['c', 0.4, 99, '', 'focus'], ['type', 0.5, 0.95, '.nt-f .ty'], ['c', 0.5, 2.05, '', 'has'], ['tap', 1.1, 1.2, '.nt-img'], ['c', 1.22, 1.7, '', 'pick'], ['tap', 1.45, 1.55, '.pk-g .pk-on'], ['c', 1.7, 2.05, '', 'picked'], ['tap', 1.9, 2.0, '.nt-add'], ['c', 2.05, 99, '', 'added'], ['c', 2.05, 99, '.cnt2', 'alt'], ['c', 2.05, 99, '.cnt3', 'alt'], ['c', 2.4, 99, '', 'tagon']] },
  vault: { dur: 5.6, res: 2.2, still: 3.0, ev: [['tap', 0.4, 0.5, '.vb1'], ['c', 0.53, 99, '', 'pinpad'], ['tap', 0.8, 0.88, '.k1'], ['c', 0.88, 99, '', 'd1'], ['tap', 1.07, 1.15, '.k9'], ['c', 1.15, 99, '', 'd2'], ['tap', 1.34, 1.42, '.k9'], ['c', 1.42, 99, '', 'd3'], ['tap', 1.61, 1.69, '.k2'], ['c', 1.69, 99, '', 'd4'], ['c', 1.85, 99, '', 'open']] },
  // 四次划、每 1 秒一次（['swipe', 按下, 抬手, 起手处, dx, dy, 拇指弧线往上鼓几 px]）：左边缘往右三次，今天 → 日历 → 待办 → 随手记；第四次从右边缘往左划进设置
  swipe: { dur: 5.6, res: 2.4, still: 4.6, ev: [['swipe', 0.35, 0.7, '.edge-l', 150, 12, 26], ['c', 0.7, 1.7, '', 'p1'], ['c', 0.7, 1.7, '@.tb', 't1'],
    ['swipe', 1.35, 1.7, '.edge-l', 150, 12, 26], ['c', 1.7, 2.7, '', 'p2'], ['c', 1.7, 2.7, '@.tb', 't2'],
    ['swipe', 2.35, 2.7, '.edge-l', 150, 12, 26], ['c', 2.7, 99, '', 'p3'], ['c', 2.7, 99, '@.tb', 't3'],
    ['swipe', 3.35, 3.7, '.edge-r', -150, 12, 26], ['c', 3.7, 99, '', 'set'], ['c', 3.7, 99, '@.tb', 'pout'], ['c', 3.7, 99, '@.fab', 'pout']] },
  masc: { dur: 6.0, res: 2.5, still: 4.0, ev: [['tap', 0.4, 0.48, '.mo1'], ['c', 0.48, 0.86, '', 'q1'], ['tap', 0.78, 0.86, '.mo2'], ['c', 0.86, 1.24, '', 'q2'], ['tap', 1.16, 1.24, '.mo3'], ['c', 1.24, 1.62, '', 'q3'], ['tap', 1.54, 1.62, '.mo4'], ['c', 1.62, 2.0, '', 'q4'], ['tap', 1.92, 2.0, '.mo5'], ['c', 2.0, 2.38, '', 'q5'], ['tap', 2.3, 2.38, '.mo6'], ['c', 2.38, 99, '', 'q6']] },
  font: { dur: 5.0, res: 1.0, still: 1.0, ev: [['tap', 0.4, 0.48, '.f1'], ['c', 0.48, 0.75, '', 'dl1'], ['c', 0.75, 1.4, '', 'sel1'], ['tap', 1.3, 1.38, '.f2'], ['c', 1.38, 1.6, '', 'dl2'], ['c', 1.6, 2.25, '', 'sel2'], ['tap', 2.15, 2.23, '.f3'], ['c', 2.23, 2.45, '', 'dl3'], ['c', 2.45, 3.6, '', 'sel3'], ['tap', 3.5, 3.58, '.f0']] },
  av: { dur: 5.6, res: 2.5, still: 3.2, ev: [['tap', 0.35, 0.45, '.avb .b1'], ['c', 0.48, 2.25, '', 'cropon'], ['drag', 0.8, 1.3, '.cr-box', -40, -30, '.cr-img', -40, -30, 2.3], ['drag', 1.48, 1.83, '.kn', 46, 0, '.kn', 46, 0, 2.3], ['c', 1.48, 99, '', 'zoom'], ['tap', 2.0, 2.08, '.crop .ok'], ['c', 2.25, 99, '', 'set']] },
  lang: { dur: 5.0, res: 1.7, still: 2.6, ev: [['tap', 0.4, 0.5, '.L0 .r-lang'], ['c', 0.53, 1.5, '', 'pk'], ['tap', 1.05, 1.15, '.op-%o'], ['c', 1.2, 99, '', 'flip']] },
  // 隐私那一节（不在故事段里）：点“隐私记” → 整页推进去（锁着）→ 点“输入密码” → 密码整页直接出现 → 按 1、9、9、2（第 4 位按下就交出、圆点清空）→ 解锁那一层淡出，露出隐私记
  vsafe: { dur: 5.2, still: 3.4, ev: [['tap', 0.4, 0.5, '.vrow'], ['c', 0.53, 99, '', 'vpush'], ['tap', 1.02, 1.12, '.vs-b1'], ['c', 1.12, 99, '', 'vpin'],
    ['tap', 1.42, 1.5, '.vs-k1'], ['c', 1.5, 2.28, '', 'vd1'], ['tap', 1.67, 1.75, '.vs-k9'], ['c', 1.75, 2.28, '', 'vd2'], ['tap', 1.92, 2.0, '.vs-k9'], ['c', 2.0, 2.28, '', 'vd3'], ['tap', 2.2, 2.28, '.vs-k2'], ['c', 2.5, 99, '', 'vopen']] }
};
const ITEMS = [['type', 0], ['voice', 0], ['sum', 0], ['find', 0], ['chat', 0], ['aip', 0], ['week', 1], ['month', 1], ['anv', 1], ['fort', 1], ['todo', 2], ['sub', 2], ['note', 2], ['vault', 2], ['swipe', 3], ['masc', 3], ['font', 3], ['av', 3], ['lang', 3]];
/** 测试钩子：e2e 在页面脚本运行前用 addInitScript 放进来一个空对象 window.__lemoTest，页面把运行状态写在上面、从上面读 freeze（截图定格）。
 *  正式访问时没有这个对象，页面什么也不往 window 上挂（不靠构建标志，也不靠查询参数） */
const T = window.__lemoTest || null;
/** 几个模块共用、会变的值：k 是动起来那段的手机缩放（吉祥物画布的清晰度跟着它）；relay 是多端那一节高度变了以后，让动起来那段重算位置 */
const ST = { k: 1, relay: null };

export { doc, RM, $, $$, clamp, seg, sm, eo, eio, lerp, eOut, idle, quiet, f3, SC, put, lang, L, DEMO, ITEMS, LAST_SC, T, ST };
