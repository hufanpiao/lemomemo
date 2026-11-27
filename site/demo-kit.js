// 演示页（只在 /zh/demo、/ko/demo 加载）的公用小工具：词条、复制模板、放一次动画、原地模糊淡换、给能点的东西补上键盘和读屏信息，
// 以及“一句话 → 日程”的解析。挂在 window.LemoDemo 上。
// 四个脚本按顺序 defer 加载，后面的只用前面的，没有互相依赖：demo-kit.js（这里）→ demo-type.js（点“＋”打字）→ demo-cal.js（日历）→ demo.js（其余，并把它们串起来）。
// 全是页面里写死的示例，不连网、不存东西、不用麦克风，刷新就回到原样。
(function () {
  'use strict';

  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var words = document.getElementById('tpl-words');

  // 词条只有一份：页面里的 #tpl-words（build/site_pages.mjs 按语言生成）；{m}{d}{w}{n} 这类写法模板也在里面
  function word(k) {
    var el = words && words.content.querySelector('[data-w="' + k + '"]');
    return el ? el.textContent : '';
  }
  function fmt(k, v) {
    return word(k).replace(/\{(\w+)\}/g, function (_, n) { return String(v[n]); });
  }
  var WD = word('wd').split(',');

  function all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  // 和 all 一样，root 自己对得上也算（给刚插进来的一行补键盘信息时用）
  function own(sel, root) { return (root.matches && root.matches(sel) ? [root] : []).concat(all(sel, root)); }
  function tpl(id) { return document.getElementById(id).content.firstElementChild.cloneNode(true); }
  function slot(root, name, text) {
    var el = root.querySelector('[data-slot="' + name + '"]');
    if (el) el.textContent = text;
    return el;
  }

  // ---------- 放一次动画 ----------
  // 加上动画类，等 animationend（以 CSS 里的时长为准）；兜底定时器按算出来的时长再宽松 200ms。放完摘掉类、调 done。
  // 同一个元素同一个类再放、或 stop()，先取消上一次（不调它的 done）：0.9 秒内来回切页时，旧的“淡出后藏掉”不会把刚切回来的页藏掉。
  var running = new WeakMap();
  function seconds(list) {
    return String(list).split(',').map(function (x) { return parseFloat(x) * (/ms$/.test(x.trim()) ? 1 : 1000) || 0; });
  }
  function animMs(el) {
    var most = 0;
    [getComputedStyle(el), getComputedStyle(el, '::before')].forEach(function (cs) {
      var d = seconds(cs.animationDuration);
      var l = seconds(cs.animationDelay);
      d.forEach(function (x, i) { most = Math.max(most, x + (l[i] || 0)); });
    });
    return most;
  }
  function stop(el, cls) {
    var map = running.get(el);
    if (map && map[cls]) map[cls]();
  }
  function names(el) {
    return [getComputedStyle(el).animationName, getComputedStyle(el, '::before').animationName].join(',').split(/\s*,\s*/);
  }
  function play(el, cls, done) {
    stop(el, cls);
    var map = running.get(el) || {};
    running.set(el, map);
    el.classList.remove(cls);
    void el.offsetWidth;
    var before = names(el);
    el.classList.add(cls);
    // 这个类带来的动画名：同一个元素上同时放着别的动画（勾选框的弹一下和外圈）时，只认自己的 animationend
    var mine = names(el).filter(function (n) { return n !== 'none' && before.indexOf(n) < 0; });
    var timer = 0;
    function cleanup() {
      clearTimeout(timer);
      el.removeEventListener('animationend', onEnd);
      if (map[cls] === cancel) delete map[cls];
      el.classList.remove(cls);
    }
    function cancel() { cleanup(); }
    function finish() {
      cleanup();
      if (done) done();
    }
    function onEnd(e) {
      if (e.target === el && el.classList.contains(cls) && (!mine.length || mine.indexOf(e.animationName) >= 0)) finish();
    }
    map[cls] = cancel;
    el.addEventListener('animationend', onEnd);
    timer = setTimeout(finish, animMs(el) + 200);
  }

  // 原地模糊淡换：旧的淡没、新的从模糊到清晰（页签互切、日历翻月同一份）
  function swap(cur, next) {
    stop(next, 'swap-out');
    if (cur) stop(cur, 'swap-in');
    next.hidden = false;
    play(next, 'swap-in');
    if (cur && cur !== next) {
      cur.style.translate = '';
      play(cur, 'swap-out', function () { cur.hidden = true; });
    }
  }

  // ---------- 键盘和读屏 ----------
  // 给 root 里能点的东西补上角色、名字和 Tab 停靠点；新插进来的行再调一次就行（重复调没关系）
  var uid = 0;
  function arm(root, web) {
    own('.ck', root).forEach(function (ck) {
      var tt = ck.parentElement.querySelector('.tt');
      if (tt && !tt.id) tt.id = 'dt' + ++uid;
      if (tt) ck.setAttribute('aria-labelledby', tt.id);
      ck.tabIndex = 0;
    });
    own('[data-filter] [data-f]', root).forEach(function (c) {
      c.setAttribute('role', 'button');
      c.setAttribute('aria-pressed', String(c.classList.contains('on')));
      c.tabIndex = 0;
    });
    if (web) {
      own('[data-go], [data-plus]', root).forEach(function (b) {
        if (b.tagName !== 'BUTTON') b.setAttribute('role', 'button');
        b.tabIndex = 0;
      });
      return;
    }
    // 能进详情的行：行里有勾选框的，把文字那块当按钮（不让按钮套着勾选框）；别的整行是按钮
    own('[data-kind]', root).forEach(function (row) {
      if (row.closest('[data-page="detail"]')) return;
      var target = row.querySelector('.ck') ? row.querySelector('.tx') : row;
      if (!target) return;
      target.setAttribute('role', 'button');
      target.tabIndex = 0;
    });
  }

  // ---------- 一句话 → 日程：认今天/明天/后天/周几（中韩）、上午下午、几点几分或半 ----------
  var CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  var KN = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12 };
  function num(s) {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (KN[s] != null) return KN[s];
    if (s === '十') return 10;
    if (s.charAt(0) === '十') return 10 + (CN[s.charAt(1)] || 0);
    if (s.indexOf('十') > 0) return (CN[s.charAt(0)] || 0) * 10 + (CN[s.charAt(2)] || 0);
    return CN[s] != null ? CN[s] : NaN;
  }
  var BASE = new Date(2026, 10, 24); // 演示里的“今天”：2026-11-24 周二
  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  function parse(text) {
    var t = text;
    var day = 0;
    var m = /(明天|明日|내일)/.exec(t);
    if (m) { day = 1; t = t.replace(m[0], ' '); }
    m = /(后天|後天|모레)/.exec(t);
    if (m) { day = 2; t = t.replace(m[0], ' '); }
    m = /(今天|오늘)/.exec(t);
    if (m) { day = 0; t = t.replace(m[0], ' '); }
    m = /(?:周|星期|礼拜)([一二三四五六日天])/.exec(t) || /([월화수목금토일])요일/.exec(t);
    if (m) {
      var target = '日一二三四五六'.indexOf(m[1]);
      if (target < 0) target = m[1] === '天' ? 0 : '일월화수목금토'.indexOf(m[1]);
      day = (target - BASE.getDay() + 7) % 7 || 7;
      t = t.replace(m[0], ' ');
    }
    var hh = null;
    var mm = 0;
    m = /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:点|:|：)\s*(半|\d{1,2}分?|[一二三四五六七八九十]{1,3}分)?/.exec(t) ||
      /(새벽|아침|오전|낮|오후|저녁|밤)?\s*(\d{1,2}|열한|열두|다섯|여섯|일곱|여덟|아홉|한|두|세|네|열)\s*시\s*(반|\d{1,2}\s*분)?\s*(?:에)?/.exec(t);
    if (m) {
      hh = num(m[2]);
      if (m[3]) mm = /半|반/.test(m[3]) ? 30 : num(m[3].replace(/[分분\s]/g, '')) || 0;
      if (/下午|傍晚|晚上|오후|저녁|밤/.test(m[1] || '') && hh < 12) hh += 12;
      if (/中午|낮/.test(m[1] || '') && hh < 11) hh += 12;
      if (isNaN(hh) || hh > 23) hh = null;
      t = t.replace(m[0], ' ');
    }
    // 只去掉两头的空白和标点（不碰“에”：“에어컨”这类词开头就是它）
    var title = t.replace(/^[\s，,。.、]+|[\s，,。.、]+$/g, '').replace(/\s{2,}/g, ' ') || text.trim();
    var d = new Date(BASE.getTime() + day * 864e5);
    var time = hh == null ? '' : pad2(hh) + ':' + pad2(mm);
    var dayWord = day === 0 ? word('today') : day === 1 ? word('tomorrow') : day === 2 ? word('after') : '';
    var md = day > 2 ? fmt('day', { m: d.getMonth() + 1, d: d.getDate(), w: WD[d.getDay()] }) : fmt('md', { m: d.getMonth() + 1, d: d.getDate() });
    return {
      title: title,
      ev: !!time,
      day: day,
      time: time,
      iso: d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
      when: (dayWord ? dayWord + ' ' : '') + md + (time ? ' ' + time : ''),
      short: day === 0 ? time || word('today') : dayWord || (d.getMonth() + 1) + '/' + d.getDate(),
      full: fmt('day', { m: d.getMonth() + 1, d: d.getDate(), w: WD[d.getDay()] }), // 网页版待办页的日期组标题
    };
  }

  window.LemoDemo = {
    reduce: reduce,
    word: word,
    fmt: fmt,
    WD: WD,
    all: all,
    tpl: tpl,
    slot: slot,
    play: play,
    stop: stop,
    swap: swap,
    arm: arm,
    parse: parse,
    app: document.querySelector('[data-app="phone"]'),
  };
})();
