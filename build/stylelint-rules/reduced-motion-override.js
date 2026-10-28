// 柠檬记自写 Stylelint 规则 lemo/reduced-motion-override（架构 17.2 第 5 点“CSS 一侧的统一写法”；UI-4 L-1，B1）
// 凡是 transition / animation 动到位移或缩放（下称“动 transform”）的选择器，同一个文件里必须有两段减少动态效果的覆盖：
//   ① @media (prefers-reduced-motion: reduce) { <同一选择器> { … } }
//      - 媒体查询只认单独一条 (prefers-reduced-motion: reduce)，前面最多加 screen / all and；not …、再加别的条件都不算；
//      - 动画包在 (prefers-reduced-motion: no-preference) 里的（单独一条，前面最多 screen / all and，后面只能 and 接条件；
//        有逗号、or、not 的不算），不用这一段，但 data-rm 那段照样要写；
//      - 这一段要写在原声明**之后**（同优先级，后写的赢）；
//   ② :global(:root[data-rm="1"]) <同一选择器> { … }（不是 CSS Modules 的全局样式写 :root[data-rm="1"] <选择器>），放在最外层；
//   - 两段都不准写进 @layer（不在层里的声明总是赢过层里的，覆盖会输），写了直接报错；
//   - 原声明带 !important，覆盖也要带。
// 覆盖必须真的关掉：
//   - transition 一类写 none 或只动 opacity；只有原过渡动的仅是 transform / translate / scale / rotate 时，写 transform: none 也算；
//   - animation 一类写 none 或只动 opacity。
// 光有选择器、里面写别的（例如 color），不算覆盖。覆盖里还在动 transform 的，单独报。
// 选择器以类名开头、状态写在元素自身：.x[data-state=…]、.x:active、.x.is-on 把过渡的属性改了，两段覆盖里也要写回
// （transform 一类写 none；别的写回原值——和 .x 自己写的值一样，.x 没写的写 initial，初始值本来是 auto 的属性也可写 auto；
// 否则只是从“动画缩放”变成“瞬间缩放”，UI-4 L-1 原话）；
// 含 .x 却不以 .x 开头的（button.x、[data-on].x、:where(.x)、.wrap:hover .x），覆盖查不到，直接报错；
// .x 的 transform 引用的自定义属性只准在 .x 自己或它的状态里赋值；@scope 里不准写动位移的过渡、动画。
// “动 transform”的判断（看不清的一律按动算）：
//   - 属性名：放行名单（STATIC_PROP：opacity、各种颜色、box-shadow / text-shadow、fill / stroke、filter、visibility 等）以外的
//     一律按动算（transform、top、margin、width、gap、line-height、clip-path…），自定义属性 --* 也算；
//   - transition 简写没写属性名（等于 all）；transition-property 写 initial / unset / revert / revert-layer / inherit（等于 all）；
//   - var() 不是 --dur-* / --ease-*（解析不了里面是什么）；
//   - 属性名或值里有 CSS 转义 \（\74ransform 浏览器认成 transform），keyframes 里同样；
//   - animation 引用的 @keyframes 不在同文件，或者同名的任何一段改了上面这些属性。
// 嵌套写法里的 & 会展开成完整选择器再比。带 -webkit- 等前缀的属性按去掉前缀算。
// 违规样例在 tests/arch-fixtures/stylelint/a24-rm-*.module.css，tests/arch/stylelint.test.ts 证明拦得住
import stylelint from 'stylelint';

const {
  createPlugin,
  utils: { report, ruleMessages, validateOptions },
} = stylelint;

const ruleName = 'lemo/reduced-motion-override';

const HOW = '要写在原声明之后、不进 @layer，写 none、只动 opacity，或者（只动 transform 时）transform: none；原声明有 !important 覆盖也要带';
const messages = ruleMessages(ruleName, {
  missingMedia: (sel) =>
    `17.2 第 5 点（UI-4 L-1）：“${sel}”的 transition / animation 动到transform，同一文件里缺有效的 @media (prefers-reduced-motion: reduce) { ${sel} { … } } 覆盖（${HOW}）`,
  missingRm: (sel) =>
    `17.2 第 5 点（UI-4 L-1）：“${sel}”的 transition / animation 动到transform，同一文件里缺有效的 :global(:root[data-rm="1"]) ${sel} { … } 覆盖（${HOW}）`,
  overrideMoves: (sel) =>
    `17.2 第 5 点（UI-4 L-1）：减少动态效果的覆盖“${sel}”里还在动 transform，只能留 opacity 或写 none`,
  layer: (sel) =>
    `17.2 第 5 点（UI-4 L-1）：减少动态效果的覆盖“${sel}”不准写进 @layer（层里的声明会输给层外的原声明）`,
  stateMedia: (sel, prop) =>
    `17.2 第 5 点（UI-4 L-1）：“${sel}”把 ${prop} 改了，@media (prefers-reduced-motion: reduce) 里要在它之后把 ${sel} 的 ${prop} ${TRANSFORM_PROP.test(prop) ? '写回 none' : '写回原值（和原选择器的值一样；原选择器没写就写 initial，初始值本来是 auto 的属性也可写 auto）'}（否则还是瞬间缩放、位移）`,
  stateRm: (sel, prop) =>
    `17.2 第 5 点（UI-4 L-1）：“${sel}”把 ${prop} 改了，:global(:root[data-rm="1"]) 里要把 ${sel} 的 ${prop} ${TRANSFORM_PROP.test(prop) ? '写回 none' : '写回原值（和原选择器的值一样；原选择器没写就写 initial，初始值本来是 auto 的属性也可写 auto）'}（否则还是瞬间缩放、位移）`,
  shape: (sel, base, prop) =>
    `17.2 第 5 点（UI-4 L-1）：“${sel}”改了 ${base} 的 ${prop}，减少动态效果的覆盖查不到：选择器要以类名开头，状态写在元素自身（${base}[data-state=…]、${base}:active），不写标签前缀、属性前缀、:where()、父元素状态`,
  varOutside: (sel, base, prop) =>
    `17.2 第 5 点（UI-4 L-1）：${prop} 被 ${base} 的 transform 引用，只准在 ${base} 自己或它的状态选择器里赋值，“${sel}”里不行`,
  noPreference: (sel) =>
    `17.2 第 5 点（UI-4 L-1）：“${sel}”包在 @media (prefers-reduced-motion: no-preference) 里，这种包法管不到 data-rm 开关，仍要写 :global(:root[data-rm="1"]) ${sel} { … } 那段覆盖`,
  scope: (sel) =>
    `17.2 第 5 点（UI-4 L-1）：@scope 里不准写动位移的 transition / animation（“${sel}”）：作用域远近先于声明顺序比较，外面的减少动态效果覆盖会输`,
});

// 放行名单（主持人 10-29 第六轮定）：确定不会让元素位移、缩放、改尺寸、改排版的属性——颜色、阴影、不透明度、滤镜、可见性。
// 名单以外的一律按“动”算（17.2 第 6 点本来就只准动 transform 和 opacity）
const STATIC_PROP =
  /^(opacity|color|background-color|border(-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?-color|outline-color|text-decoration-color|text-emphasis-color|caret-color|accent-color|column-rule-color|box-shadow|text-shadow|fill|stroke|fill-opacity|stroke-opacity|stop-color|stop-opacity|flood-color|flood-opacity|lighting-color|filter|backdrop-filter|visibility|animation-timing-function|transition-timing-function)$/i;
const MOVE_PROP = { test: (p) => !STATIC_PROP.test(p) };
// 初始值本来就是 auto 的属性：状态“写回原值”时只有这些接受 auto，其余只认 initial
const AUTO_INITIAL = /^(width|height|min-width|min-height|block-size|inline-size|min-block-size|min-inline-size|top|right|bottom|left|inset(-[\w-]+)?|flex-basis)$/i;
/** 属性名或值里有 CSS 转义（\74ransform 浏览器认成 transform）：看不清，按动 transform 算 */
const hasEscape = (decl) => decl.prop.includes('\\') || decl.value.includes('\\');
const TRANSFORM_PROP = /^(transform|translate|scale|rotate)$/i;
const RM_PREFIX = /^(?::global\(\s*:root\[data-rm=["']1["']\]\s*\)|:root\[data-rm=["']1["']\])\s+/;
const STRICT_MEDIA = /^\s*(?:(?:only\s+)?(?:screen|all)\s+and\s+)?\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*$/i;
// no-preference 包法：单独一条，前面最多 screen / all and，后面只能用 and 接别的条件；有逗号、or、not 的都不算
const NOPREF_MEDIA =
  /^\s*(?:(?:only\s+)?(?:screen|all)\s+and\s+)?\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)(?:\s+and\s+\([^(),]*\))*\s*$/i;
const hasOrNot = (params) => params.includes(',') || /(?<![\w-])(or|not)(?![\w-])/i.test(params);
// transition / animation 简写里不是属性名、不是 keyframes 名字的关键字
const CSS_WIDE = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const KEYWORDS = new Set([
  'none', 'infinite', 'normal', 'reverse', 'alternate', 'alternate-reverse', 'forwards', 'backwards', 'both',
  'running', 'paused', 'initial', 'inherit', 'unset', 'revert', 'revert-layer', 'allow-discrete',
]);

const unprefix = (prop) => prop.toLowerCase().replace(/^-(webkit|moz|ms|o)-/, '');
const norm = (sel) => sel.trim().replace(/\s+/g, ' ').replace(/'/g, '"');
const offsetOf = (node) => node.source?.start?.offset ?? 0;
const isNone = (value) => value.trim().toLowerCase() === 'none';

/** 按最外层逗号切（括号里的逗号不切） */
function splitTop(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** 值里有没有不是 --dur-* / --ease-* 的 var()（解析不了，按动 transform 算） */
const hasForeignVar = (value) => /var\(\s*--(?!dur-|ease-)/i.test(value);

/** 去掉 var(…)、calc(…) 这类函数，剩下的才是属性名、关键字 */
function stripFunctions(value) {
  let out = value;
  let prev;
  do {
    prev = out;
    out = out.replace(/[\w-]+\([^()]*\)/g, ' ');
  } while (out !== prev);
  return out;
}

const wordsOf = (seg) =>
  stripFunctions(seg)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.startsWith('--') ? w : unprefix(w)));

/** 展开嵌套：返回这条规则完整的选择器列表（& 换成上级选择器，没有 & 就当后代） */
function resolveSelectors(rule) {
  let parent = rule.parent;
  while (parent && parent.type !== 'rule' && parent.type !== 'root') parent = parent.parent;
  const own = splitTop(rule.selector).map(norm);
  if (!parent || parent.type !== 'rule') return own;
  const ups = resolveSelectors(parent);
  const out = [];
  for (const up of ups) for (const s of own) out.push(norm(s.includes('&') ? s.replaceAll('&', up) : `${up} ${s}`));
  return out;
}

/** 这条规则外面包着的 at-rule（由内到外） */
function atAncestors(node) {
  const out = [];
  for (let p = node.parent; p; p = p.parent) if (p.type === 'atrule') out.push(p);
  return out;
}

/** 选择器的最后一个复合选择器（.wrap:hover .a → .a） */
function lastCompound(sel) {
  const parts = sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? sel;
}

/** 同文件里每个 @keyframes 名字动不动 transform（同名写了几段，任何一段动就算动） */
function keyframesMoves(root) {
  const map = new Map();
  root.walkAtRules(/keyframes$/i, (at) => {
    let moves = false;
    at.walkDecls((d) => {
      const p = unprefix(d.prop);
      if (MOVE_PROP.test(p) || p.startsWith('--') || hasForeignVar(d.value) || hasEscape(d)) moves = true;
    });
    const name = at.params.trim();
    map.set(name, (map.get(name) ?? false) || moves);
  });
  return map;
}

/** 这条声明属于哪一类（transition / animation），不是就返回 null */
function familyOf(decl) {
  const p = unprefix(decl.prop);
  if (p === 'transition' || p === 'transition-property') return 'transition';
  if (p === 'animation' || p === 'animation-name') return 'animation';
  // 属性名里有转义（\74ransition），看不出是什么，按会动的过渡算
  if (decl.prop.includes('\\')) return 'transition';
  return null;
}

/** 这条 transition / animation 声明动了什么：all = 看不清或全部；names = 动到的位移属性 */
function moved(decl, frames) {
  const prop = unprefix(decl.prop);
  const fam = familyOf(decl);
  const res = { all: false, names: new Set() };
  if (!fam) return res;
  if (hasForeignVar(decl.value) || hasEscape(decl)) return { all: true, names: res.names };
  for (const seg of splitTop(decl.value)) {
    const words = wordsOf(seg);
    if (words.length === 1 && words[0].toLowerCase() === 'none') continue;
    if (fam === 'transition') {
      // CSS 全局关键字（initial、unset、revert、revert-layer、inherit）用在 transition-property 上等于 all（或继承来的，看不清）
      if (words.some((w) => CSS_WIDE.has(w.toLowerCase()))) res.all = true;
      const names = words.filter((w) => !KEYWORDS.has(w.toLowerCase()));
      // transition 简写没写属性名（只有时长、曲线）= all
      if (prop === 'transition' && names.length === 0) res.all = true;
      for (const w of names) {
        if (w.startsWith('--') || w.toLowerCase() === 'all') res.all = true;
        else if (MOVE_PROP.test(w)) res.names.add(w.toLowerCase());
      }
    } else {
      // 除了 var()、calc() 以外的函数（:global(slide)、:local(…)、local(…)）一律按动算
      if (/(?<![\w-])(?!var\(|calc\()[\w-]+\(/i.test(seg)) res.all = true;
      for (const w of words) {
        if (KEYWORDS.has(w.toLowerCase()) || /^\d*\.?\d+$/.test(w)) continue;
        if (/^[a-z_][\w-]*$/i.test(w) || /^-[a-z_][\w-]*$/i.test(w)) {
          if (!frames.has(w) || frames.get(w) === true) res.all = true;
        } else {
          // 带引号的名字（"slide"）、去掉函数后剩下的标点、其他认不出的词：看不清，按动算
          res.all = true;
        }
      }
    }
  }
  return res;
}

const movesOf = (m) => m.all || m.names.size > 0;

const ruleFunction = (primary) => (root, result) => {
  if (!validateOptions(result, ruleName, { actual: primary, possible: [true] })) return;
  const frames = keyframesMoves(root);

  // 覆盖：context（media / rm）→ 选择器 → 这一段里的声明
  const overrides = { media: new Map(), rm: new Map() };
  const movers = []; // { decl, sel, fam, m }
  const normals = []; // { rule, sels }：普通上下文里的规则（找状态选择器用）

  const addOverride = (ctx, sel, rule) => {
    const list = overrides[ctx].get(sel) ?? [];
    rule.each((n) => {
      if (n.type === 'decl') list.push(n);
    });
    overrides[ctx].set(sel, list);
  };

  root.walkRules((rule) => {
    const ats = atAncestors(rule);
    if (ats.some((a) => /keyframes$/i.test(a.name))) return;
    const sels = resolveSelectors(rule);
    // 只认 reduce；(prefers-reduced-motion: no-preference) 里的是普通声明（系统设置那一路已经关了，但管不到 data-rm 开关）
    // not … (reduce) 不当覆盖段（它在“没开减少动态效果”时才成立），按普通声明处理
    const reducedMedia = ats.find(
      (a) => a.name.toLowerCase() === 'media' && /prefers-reduced-motion\s*:\s*reduce/i.test(a.params) && !/(?<![\w-])not(?![\w-])/i.test(a.params),
    );
    const noPref = ats.some((a) => a.name.toLowerCase() === 'media' && NOPREF_MEDIA.test(a.params) && !hasOrNot(a.params));
    const rmBases = sels.filter((s) => RM_PREFIX.test(s)).map((s) => norm(s.replace(RM_PREFIX, '')));
    const looksOverride = Boolean(reducedMedia) || rmBases.length > 0;
    if (looksOverride) {
      if (ats.some((a) => a.name.toLowerCase() === 'layer')) {
        report({ message: messages.layer(sels.join(', ')), node: rule, result, ruleName });
        return;
      }
      // 只认：外面只有一层严格写法的 media；或者 data-rm 写在最外层
      const validMedia = reducedMedia && ats.length === 1 && STRICT_MEDIA.test(reducedMedia.params);
      if (validMedia) for (const s of sels) addOverride('media', RM_PREFIX.test(s) ? norm(s.replace(RM_PREFIX, '')) : s, rule);
      if (ats.length === 0) for (const s of rmBases) addOverride('rm', s, rule);
      rule.each((node) => {
        if (node.type === 'decl' && movesOf(moved(node, frames))) {
          report({ message: messages.overrideMoves(sels.join(', ')), node, result, ruleName });
        }
      });
      return;
    }
    normals.push({ rule, sels });
    const inScope = ats.some((a) => a.name.toLowerCase() === 'scope');
    rule.each((node) => {
      if (node.type !== 'decl') return;
      const fam = familyOf(node);
      const m = fam ? moved(node, frames) : null;
      if (!m || !movesOf(m)) return;
      if (inScope) {
        report({ message: messages.scope(sels.join(', ')), node, result, ruleName });
        return;
      }
      for (const sel of sels) movers.push({ decl: node, sel, fam, m, noPref });
    });
  });

  /** ctx 这一段里能用来覆盖 node 的声明：media 段要写在 node 之后；node 带 !important 的覆盖也要带 */
  const usable = (ctx, sel, node) =>
    (overrides[ctx].get(sel) ?? []).filter(
      (d) => (ctx !== 'media' || offsetOf(d) > offsetOf(node)) && (!node.important || d.important),
    );

  /** 这一段覆盖有没有真的关掉这条 transition / animation */
  const neutralizes = (decls, fam, m) => {
    const famDecls = decls.filter((d) => familyOf(d) === fam);
    if (famDecls.length > 0 && famDecls.every((d) => !movesOf(moved(d, frames)))) return true;
    const transformOnly = !m.all && [...m.names].every((n) => TRANSFORM_PROP.test(n));
    if (fam === 'transition' && transformOnly && decls.some((d) => unprefix(d.prop) === 'transform' && isNone(d.value))) return true;
    return false;
  };

  const reported = new Set();
  for (const { decl, sel, fam, m, noPref } of movers) {
    // 包在 no-preference 里的：系统设置那一路已经关了，只差 data-rm 开关这一段
    for (const ctx of noPref ? ['rm'] : ['media', 'rm']) {
      if (neutralizes(usable(ctx, sel, decl), fam, m)) continue;
      const key = `${ctx}|${sel}|${offsetOf(decl)}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const message = ctx === 'media' ? messages.missingMedia(sel) : noPref ? messages.noPreference(sel) : messages.missingRm(sel);
      report({ message, node: decl, result, ruleName });
    }
  }

  // 状态和选择器写法：
  //   - 选择器以类名开头：改 base 的位移、尺寸的，只准是 base 自己或 base 的状态（base[…]、base:…、base.y）；
  //     含 base 的类名、却不以 base 开头的（button.a、[data-on].a、:where(.a):active、.wrap:hover .a、.list:hover .a）一律报；
  //   - 状态把过渡的属性改了，两段覆盖里也要写回（transform 一类写 none，别的位移属性、自定义属性写回原值）；
  //   - base 的 transform 引用的自定义属性，只准在 base 自己或它的状态里赋值。
  const info = new Map(); // base → { all, names, vars }
  for (const { sel, m } of movers) {
    const it = info.get(sel) ?? { all: false, names: new Set(), vars: new Set() };
    it.all ||= m.all;
    for (const n of m.names) it.names.add(n);
    info.set(sel, it);
  }
  for (const [base, it] of info) {
    for (const { rule, sels } of normals) {
      if (!sels.includes(base)) continue;
      rule.each((n) => {
        if (n.type === 'decl' && TRANSFORM_PROP.test(unprefix(n.prop))) {
          for (const v of n.value.matchAll(/var\(\s*(--[\w-]+)/gi)) it.vars.add(v[1]);
        }
      });
    }
  }
  /** base 自己写的这个属性的值（同一选择器写了几次取最后一次）；没写返回 null */
  const originalOf = (base, prop) => {
    let v = null;
    for (const { rule, sels } of normals) {
      if (!sels.includes(base)) continue;
      rule.each((n) => {
        if (n.type === 'decl' && n.prop === prop) v = n.value;
      });
    }
    return v;
  };
  const normValue = (v) => v.trim().replace(/\s+/g, ' ').toLowerCase();
  /** 覆盖里写回的值对不对：和 base 自己的值一样；base 没写的，写 auto 或 initial（自定义属性只认 initial） */
  const restores = (d, orig) => {
    if (orig !== null) return normValue(d.value) === normValue(orig);
    const v = normValue(d.value);
    return v === 'initial' || (v === 'auto' && AUTO_INITIAL.test(unprefix(d.prop)));
  };
  const isState = (s, base) => s !== base && s.startsWith(base) && /^[[:.]/.test(s.slice(base.length));
  const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const classOf = (base) => /^\.[\w-]+/.exec(lastCompound(base))?.[0];
  for (const { rule, sels } of normals) {
    for (const s of sels) {
      for (const [base, it] of info) {
        if (s === base) continue;
        const self = isState(s, base);
        const cls = classOf(base);
        const shapeBad = !self && Boolean(cls) && new RegExp(`${escapeRe(cls)}(?![\\w-])`).test(s);
        rule.each((n) => {
          if (n.type !== 'decl') return;
          const p = unprefix(n.prop);
          if (it.vars.has(n.prop)) {
            if (!self) {
              report({ message: messages.varOutside(s, base, n.prop), node: n, result, ruleName });
              return;
            }
          } else {
            const relevant = p !== 'all' && !p.startsWith('--') && MOVE_PROP.test(p) && (it.all || it.names.has(p));
            if (!relevant || (TRANSFORM_PROP.test(p) && isNone(n.value))) return;
            if (shapeBad) {
              report({ message: messages.shape(s, base, n.prop), node: n, result, ruleName });
              return;
            }
            if (!self) return;
          }
          for (const ctx of ['media', 'rm']) {
            const decls = usable(ctx, s, n);
            const ok = TRANSFORM_PROP.test(p)
              ? decls.some((d) => unprefix(d.prop) === p && isNone(d.value))
              : decls.some((d) => d.prop === n.prop && restores(d, originalOf(base, n.prop)));
            if (!ok) report({ message: ctx === 'media' ? messages.stateMedia(s, n.prop) : messages.stateRm(s, n.prop), node: n, result, ruleName });
          }
        });
      }
    }
  }
};

ruleFunction.ruleName = ruleName;
ruleFunction.messages = messages;
ruleFunction.meta = { url: 'docs/10-架构/架构设计-v4.md#172' };

export default createPlugin(ruleName, ruleFunction);
