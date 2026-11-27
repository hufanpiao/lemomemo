// 演示页的交互（只在 /zh/demo、/ko/demo 加载，排在 demo-kit.js、demo-type.js、demo-cal.js 后面）：照真 App 的操作做——底栏切页（液滴 + 原地模糊淡换）、
// 左右滑切页、点一行进详情再返回、勾掉待办（弹一下、外圈、小点、划线）、点“＋”打一句话记下（弹层在 demo-type.js，这里决定落到哪）、
// 日历（在 demo-cal.js）、待办和随手记按分类筛。电脑宽度另有网页版四张画面，和手机那台共用一个“当前页签”。
// 全是页面里写死的示例，不连网、不登录、不存东西、不用麦克风，刷新就回到原样。新节点一律从页面里的 <template> 复制、用 textContent 填字。
(function () {
  'use strict';

  var D = window.LemoDemo;
  var app = D.app;
  var all = D.all;
  var tpl = D.tpl;
  var slot = D.slot;
  var play = D.play;
  var word = D.word;
  var PAGES = ['today', 'cal', 'todo', 'notes'];
  var state = (D.state = { dev: 'phone', tab: 'today' });
  if (!app) return;

  // ---------- 电脑宽度：手机版 / 网页版、四个页面的按钮 ----------
  function syncControls() {
    all('[data-dev]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-dev') === state.dev)); });
    all('[data-tab]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-tab') === state.tab)); });
    all('[data-cap]').forEach(function (p) { p.hidden = p.getAttribute('data-cap') !== state.tab; });
  }

  // 网页版样机按设计宽排好，缩放到正好占满舞台的内宽（CSS 的 zoom 不能直接按容器宽算，所以在这里算好交给 --web-zoom）
  var stage = document.querySelector('.demo-stage');
  var demo = document.querySelector('.demo');
  function fitWeb() {
    if (!stage || state.dev !== 'web') return;
    var br = stage.querySelector('.shot-web .br'); // 四张网页版画面同一个设计宽，藏着的也读得到
    var inner = stage.clientWidth - 2 * parseFloat(getComputedStyle(stage).paddingLeft);
    var z = String(Math.floor((inner / parseFloat(getComputedStyle(br).width)) * 1000) / 1000);
    if (stage.style.getPropertyValue('--web-zoom') !== z) stage.style.setProperty('--web-zoom', z);
  }
  if (stage && window.ResizeObserver) new ResizeObserver(fitWeb).observe(stage);

  function showShots() {
    // 网页版时样机整行放在说明下面（.demo 单列、说明排两栏）
    [demo, stage].forEach(function (el) { if (el) el.classList.toggle('is-web', state.dev === 'web'); });
    fitWeb();
    all('.shot').forEach(function (s) {
      var name = s.getAttribute('data-shot');
      var on = state.dev === 'phone' ? name === 'phone' : name === 'web-' + state.tab;
      if (on && s.hidden) {
        s.hidden = false;
        play(s, 'fx-enter');
      } else if (!on) {
        s.hidden = true;
      }
    });
  }

  // ---------- 页签：手机和网页版走同一个 goTab ----------
  // 液滴：位置只由 data-i 决定（.drop[data-i] 的 translate），过渡在 .drop-live 上
  function moveDrop(i) { app.querySelector('.drop').setAttribute('data-i', String(i)); }
  function curPage() {
    return app.querySelector('.pages > .pg:not([hidden]):not(.swap-out):not([data-page="detail"])');
  }

  function goTab(name) {
    closeDetail(true);
    var cur = curPage();
    var next = app.querySelector('.pages > [data-page="' + name + '"]');
    state.tab = name;
    syncControls();
    moveDrop(PAGES.indexOf(name));
    all('.tb [data-go]', app).forEach(function (b) {
      var on = b.getAttribute('data-go') === name;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    all('[data-app="web"] .rail [data-go]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-go') === name); });
    if (!next || cur === next) return;
    next.scrollTop = 0;
    D.swap(cur, next);
  }

  // ---------- 手机：点一行进详情，返回（焦点回到原来那一行） ----------
  var opener = null;
  function focusTarget(row) { return row.querySelector('.tx[role="button"]') || row; }

  function openDetail(row) {
    var cur = curPage();
    if (!cur || app.querySelector('[data-page="detail"]')) return;
    var kind = row.getAttribute('data-kind');
    var pg;
    var backLabel = app.querySelector('.tb [data-go="' + cur.getAttribute('data-page') + '"] span').textContent;
    if (kind === 'vault') {
      pg = tpl('tpl-lock');
    } else {
      pg = tpl('tpl-detail');
      slot(pg, 'back', backLabel);
      var tt = row.querySelector('.tt');
      slot(pg, 'title', tt ? tt.textContent : '');
      var small = row.querySelector('small');
      var dsDay = row.closest('[data-ds]') ? app.querySelector('[data-ds-day]').textContent : word('today');
      var ev = kind === 'ev';
      var todo = kind === 'todo';
      slot(pg, 'kind', word(ev ? 'kindEv' : todo ? 'kindTodo' : 'kindNote'));
      slot(pg, 'when', small && small.textContent ? small.textContent : ev ? dsDay + ' ' + row.querySelector('.tm').textContent : word('today'));
      slot(pg, 'remind', ev ? word('remindEv') : todo ? word('remindTodo') : '—');
    }
    opener = row;
    pg.setAttribute('data-from', cur.getAttribute('data-page'));
    app.querySelector('.pages').appendChild(pg);
    app.classList.add('in-detail');
    play(pg, 'push-in');
    play(cur, 'push-under');
    pg.querySelector('[data-back]').focus({ preventScroll: true });
  }

  function closeDetail(instant) {
    var pg = app.querySelector('[data-page="detail"]');
    if (!pg) return;
    var under = app.querySelector('.pages > [data-page="' + pg.getAttribute('data-from') + '"]');
    var back = opener;
    opener = null;
    app.classList.remove('in-detail');
    if (instant) {
      pg.remove();
      return;
    }
    pg.setAttribute('data-page', 'closing');
    if (under) play(under, 'pop-back');
    play(pg, 'pop-out', function () { pg.remove(); });
    if (back && document.contains(back)) focusTarget(back).focus({ preventScroll: true });
  }

  // ---------- 勾掉待办 ----------
  function setDone(box, done) {
    var tx = box.parentElement.querySelector('.tx');
    box.classList.toggle('done', done);
    box.setAttribute('aria-checked', String(done));
    if (tx) { tx.classList.toggle('strike', done); tx.querySelector('.tt').classList.toggle('is-struck', done); }
  }

  function toggleTodo(box) {
    var done = !box.classList.contains('done');
    setDone(box, done);
    // 同一条待办在今天和待办两处各有一行（网页版是两张画面）：另一行跟着改，不放动画
    var tt = box.parentElement.querySelector('.tt');
    var kind = box.closest('[data-app]').getAttribute('data-app');
    all('[data-app="' + kind + '"] .rw-todo .tt').forEach(function (o) {
      if (tt && o !== tt && o.textContent === tt.textContent) setDone(o.closest('.rw-todo').querySelector('.ck'), done);
    });
    if (!done) return;
    play(box, 'fx-pop');
    play(box, 'fx-ring');
    if (!D.reduce) {
      var sp = tpl('tpl-spark');
      var gone = function () { sp.remove(); };
      box.appendChild(sp);
      sp.addEventListener('animationend', gone);
      setTimeout(gone, 1500); // 兜底：动画没放（标签页在后台）也会摘掉
    }
  }

  // ---------- 分类筛选 ----------
  function filter(chip) {
    var bar = chip.closest('[data-filter]');
    all('[data-f]', bar).forEach(function (c) {
      c.classList.toggle('on', c === chip);
      c.setAttribute('aria-pressed', String(c === chip));
    });
    var f = chip.getAttribute('data-f');
    var page = chip.closest('.pg');
    if (bar.getAttribute('data-filter') === 'notes') {
      all('.nt', page).forEach(function (n) { n.hidden = !!f && n.getAttribute('data-cat') !== f; });
    } else {
      all('.rw-todo', page).forEach(function (r) { r.hidden = !!f && r.getAttribute('data-cat') !== f; });
      all('.sec', page).forEach(function (s) { s.hidden = all('.rw-todo', s).every(function (r) { return r.hidden; }); });
    }
  }

  // ---------- 记下的一句落到哪：今天的进“今天的安排”；以后的日程进日历、以后的待办进待办页“以后” ----------
  function bump(el) {
    var b = el && el.querySelector('b');
    if (b && /^\d+$/.test(b.textContent)) b.textContent = String(parseInt(b.textContent, 10) + 1);
  }
  function put(list, r, web, before) {
    if (!list) return;
    var row = tpl(r.ev ? 'tpl-row' : 'tpl-todo');
    slot(row, 'tm', r.short);
    slot(row, 'title', r.title);
    slot(row, 'sub', r.when);
    if (before === undefined && r.ev && r.time) {
      before = null;
      all('.tm', list).some(function (tm) {
        if (/^\d\d:\d\d$/.test(tm.textContent) && tm.textContent > r.time) { before = tm.closest('.rw'); return true; }
        return false;
      });
    }
    list.insertBefore(row, before === undefined ? list.firstElementChild : before);
    bump(list.previousElementSibling);
    play(row, 'fx-row');
    D.arm(row, web);
  }

  // 网页版待办页按日期分组：这一天还没有组就新开一组，按日期插在后面的组前面（没有就插在“已完成”前）
  function webTodoList(r) {
    var list = document.querySelector('[data-shot="web-todo"] .w-tl');
    var sec = list && (list.querySelector('[data-due="' + r.iso + '"]') || tpl('tpl-wsec'));
    if (sec && !sec.parentNode) {
      sec.setAttribute('data-due', r.iso);
      slot(sec, 'day', r.full);
      list.insertBefore(sec, all('[data-due]', list).filter(function (s) { return s.getAttribute('data-due') > r.iso; })[0] || list.querySelector('.w-fold'));
    }
    return sec && sec.querySelector('.lc');
  }

  function land(r, web) {
    var tab = r.day === 0 ? 'today' : r.ev ? 'cal' : 'todo';
    if (r.ev) D.cal.add(r);
    if (r.day === 0) {
      put(app.querySelector('[data-list="today"]'), r, false);
      // 网页版今天页：日程进“今天的日程”，待办进“今天的待办”
      put(document.querySelector('[data-shot="web-today"] [data-list="' + (r.ev ? 'today' : 'today-todo') + '"]'), r, true);
    }
    if (!r.ev) {
      var todo = app.querySelector('[data-page="todo"]');
      put(todo.querySelector('[data-sec="' + (r.day === 0 ? 'today' : 'later') + '"] .lc'), r, false);
      bump(todo.querySelector('[data-filter] [data-f=""]'));
      filter(todo.querySelector('[data-filter] [data-f=""]'));
      put(webTodoList(r), r, true, null);
    }
    goTab(tab);
    if (web) showShots();
    else if (tab === 'cal') D.cal.focusDay(r.iso);
    toast(web ? document.querySelector('[data-shot="web-' + tab + '"] .dk') : app, word('saved') + ' · ' + r.when);
  }

  function toast(screen, text) {
    all('.toast', screen).forEach(function (t) { t.remove(); });
    var el = tpl('tpl-toast');
    screen.appendChild(el);
    el.textContent = text; // 先放进页面再填字，读屏才会念
    setTimeout(function () { el.remove(); }, 1800);
  }

  // ---------- 点按 ----------
  var swallow = false;
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (swallow) { swallow = false; e.preventDefault(); return; }
    var b = t.closest('[data-dev]');
    if (b) { state.dev = b.getAttribute('data-dev'); syncControls(); showShots(); return; }
    b = t.closest('[data-tab]');
    if (b) { goTab(b.getAttribute('data-tab')); showShots(); return; }
    if (!t.closest('.demo-stage') || t.closest('.vs')) return;
    var web = t.closest('[data-app="web"]');
    var go = t.closest('[data-go]');
    if (go) {
      goTab(go.getAttribute('data-go'));
      if (web) showShots();
      return;
    }
    if (t.closest('[data-back]')) { closeDetail(false); return; }
    var box = t.closest('.ck');
    if (box) { toggleTodo(box); return; }
    var plus = t.closest('[data-plus]');
    if (plus) {
      D.openType(web || app, { web: !!web, opener: plus, onDone: function (r) { land(r, !!web); } });
      return;
    }
    if (web) return;
    var f = t.closest('[data-flip]');
    if (f) { D.cal.flip(parseInt(f.getAttribute('data-flip'), 10)); return; }
    var chip = t.closest('[data-filter] [data-f]');
    if (chip) { filter(chip); return; }
    var cell = t.closest('.cal-m .cal > div');
    if (cell) { D.cal.pick(cell); return; }
    var row = t.closest('[data-kind]');
    if (row && !row.closest('[data-page="detail"]')) openDetail(row);
  });

  // 键盘：不是真按钮、但标了按钮或勾选框角色的（D.arm 补的），Enter、空格也能点
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if ((e.key !== 'Enter' && e.key !== ' ') || !t.getAttribute || /^(BUTTON|A|INPUT)$/.test(t.tagName)) return;
    var role = t.getAttribute('role');
    if (role !== 'button' && role !== 'checkbox') return;
    e.preventDefault();
    t.click();
  });

  // 窗口缩到手机宽度：网页版画面放不下，回到手机版
  var narrow = window.matchMedia && matchMedia('(max-width: 767px)');
  function onNarrow() {
    if (!narrow.matches || state.dev !== 'web') return;
    state.dev = 'phone';
    syncControls();
    showShots();
  }
  if (narrow) {
    if (narrow.addEventListener) narrow.addEventListener('change', onNarrow);
    else narrow.addListener(onNarrow);
  }

  // ---------- 左右滑：切页签；在月历上滑是翻月（只认手指，竖着滚动照旧） ----------
  var drag = null;
  var pages = app.querySelector('.pages');
  pages.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' || app.querySelector('[data-page="detail"]')) return;
    drag = { x: e.clientX, y: e.clientY, lock: 0, cal: !!e.target.closest('.cal-box'), el: null };
  });
  pages.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    if (!drag.lock && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) drag.lock = Math.abs(dx) > Math.abs(dy) * 1.2 ? 1 : -1;
    if (drag.lock !== 1 || D.reduce) return;
    drag.el = drag.cal ? app.querySelector('.cal-m:not([hidden]):not(.swap-out)') : curPage();
    if (drag.el) drag.el.style.translate = Math.max(-16, Math.min(16, dx * 0.15)) + 'px';
  });
  pages.addEventListener('pointerup', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x;
    var d = drag;
    drag = null;
    if (d.el) d.el.style.translate = '';
    if (d.lock !== 1 || Math.abs(dx) < 60) return;
    swallow = true;
    setTimeout(function () { swallow = false; }, 400);
    var step = dx < 0 ? 1 : -1;
    if (d.cal) { D.cal.flip(step); return; }
    var i = PAGES.indexOf(state.tab) + step;
    if (i >= 0 && i < PAGES.length) goTab(PAGES[i]);
  });
  pages.addEventListener('pointercancel', function () {
    if (drag && drag.el) drag.el.style.translate = '';
    drag = null;
  });

  // 按住当前页签：液滴放大一点（照 GlassBar 的 data-state="press"）
  var drop = app.querySelector('.drop');
  var tb = app.querySelector('.tb');
  tb.addEventListener('pointerdown', function (e) {
    var b = e.target.closest('[data-go]');
    if (b && b.classList.contains('on')) drop.classList.add('press');
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (n) {
    tb.addEventListener(n, function () { drop.classList.remove('press'); });
  });

  // 最后补键盘和读屏信息：e2e 等 .ck 有了 tabindex 才开始点（说明上面的监听都挂好了）
  syncControls();
  if (narrow) onNarrow();
  D.arm(app);
  all('[data-app="web"]').forEach(function (w) { D.arm(w, true); });
})();
