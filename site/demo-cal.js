// 演示页的日历：翻月（原地模糊淡换）、点日期看当天的安排、方向键在格子间走、新记的日程添到格子上。
// 日程放在一个 Map 里（日期 → [{ tm, title, c }]）：载入时读一次页面里写死的 data-list，之后新记的只进 Map，不往字符串里拼。
// 只用 demo-kit.js；demo.js 调 D.cal.*。
(function () {
  'use strict';

  var D = window.LemoDemo;
  var app = D.app;
  if (!app || !app.querySelector('.cal-box')) return;

  var box = app.querySelector('.cal-box');
  var months = D.all('.cal-m', box);
  var events = new Map();

  function cellsOf(month) { return D.all('.cal > div', month); }
  function monthOf(iso) { return parseInt(iso.slice(5, 7), 10); }
  function countIn(m) {
    var n = 0;
    events.forEach(function (list, iso) { if (monthOf(iso) === m) n += list.length; });
    return n;
  }
  function label(cell) {
    var n = (events.get(cell.getAttribute('data-iso')) || []).length;
    cell.setAttribute('aria-label', cell.getAttribute('data-day') + ' · ' + D.fmt('count', { n: n }));
  }

  // 载入：只读本月内的格子（前后月露出来的灰格子在别的月里已经有一份）
  months.forEach(function (month) {
    cellsOf(month).forEach(function (cell) {
      if (!cell.classList.contains('mute')) {
        var raw = cell.getAttribute('data-list') || '';
        events.set(cell.getAttribute('data-iso'), raw.split('|').filter(Boolean).map(function (it) {
          var p = it.split('~');
          return { tm: p[0], title: p[1], c: p[2] };
        }));
      }
      cell.removeAttribute('data-list');
    });
  });
  months.forEach(function (month) {
    cellsOf(month).forEach(function (cell) {
      cell.setAttribute('role', 'button');
      cell.tabIndex = -1;
      label(cell);
    });
  });

  function current() {
    return months.filter(function (m) { return !m.hidden && !m.classList.contains('swap-out'); })[0];
  }
  // 当前月只留一个 Tab 停靠点：选中的那天，没有就 1 号
  function rove(month, cell) {
    months.forEach(function (m) { cellsOf(m).forEach(function (c) { c.tabIndex = -1; }); });
    var target = cell || month.querySelector('.sel:not(.mute)') || month.querySelector('.cal > div:not(.mute)');
    if (target) target.tabIndex = 0;
    return target;
  }

  function show(next) {
    var cur = current();
    var j = months.indexOf(next);
    if (next !== cur) D.swap(cur, next);
    app.querySelector('[data-cal-title]').textContent = next.getAttribute('data-title');
    app.querySelector('[data-cal-sub]').textContent = next.getAttribute('data-sub');
    app.querySelector('[data-flip="-1"]').classList.toggle('is-off', j === 0);
    app.querySelector('[data-flip="1"]').classList.toggle('is-off', j === months.length - 1);
    rove(next);
  }

  function flip(dir) {
    var i = months.indexOf(current());
    var j = dir === 0 ? months.indexOf(box.querySelector('[data-m="11"]')) : i + dir;
    if (j < 0 || j >= months.length || j === i) return false;
    show(months[j]);
    return true;
  }

  function pick(cell) {
    D.all('.cal .sel', app).forEach(function (c) { c.classList.remove('sel'); });
    cell.classList.add('sel');
    var month = cell.closest('.cal-m');
    if (month === current()) rove(month, cell);
    var items = events.get(cell.getAttribute('data-iso')) || [];
    app.querySelector('[data-ds-day]').textContent = cell.getAttribute('data-day');
    app.querySelector('[data-ds-n]').textContent = D.fmt('count', { n: items.length });
    var ds = app.querySelector('[data-ds]');
    while (ds.firstChild) ds.removeChild(ds.firstChild);
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'rw ds-empty';
      empty.textContent = D.word('none');
      ds.appendChild(empty);
      return;
    }
    items.forEach(function (it) {
      var row = D.tpl('tpl-row');
      row.classList.remove('fx-row');
      var bar = document.createElement('i');
      bar.className = 'bar ' + it.c;
      D.slot(row, 'tm', it.tm);
      D.slot(row, 'title', it.title);
      row.querySelector('small').remove();
      row.querySelector('.tx').insertBefore(bar, row.querySelector('.tt'));
      ds.appendChild(row);
    });
    D.arm(ds);
  }

  // 新记的日程：进 Map；手机三个月和网页版月历里同一天的格子各添一笔；“本月 N 项”跟着变；正好选着这天就刷新下面的列表
  function add(r) {
    var list = events.get(r.iso) || [];
    // 示例句“明天下午三点和小金开会”和日历上写死的 11 月 25 日那条一模一样：已经有了就不再添一份，只翻过去给人看
    var dup = list.some(function (it) { return it.tm === r.time && it.title === r.title; });
    if (dup) return;
    list.push({ tm: r.time, title: r.title, c: 'y' });
    list.sort(function (a, b) { return a.tm < b.tm ? -1 : a.tm > b.tm ? 1 : 0; });
    events.set(r.iso, list);
    D.all('[data-iso="' + r.iso + '"]').forEach(function (cell) {
      if (cell.closest('.cal-m')) label(cell);
      if (cell.classList.contains('mute')) return;
      var ems = cell.querySelectorAll('em:not(.more)');
      var more = cell.querySelector('em.more');
      if (ems.length < (cell.closest('[data-app="web"]') ? 4 : 2)) { // 网页版格子大，照真 App 最多 4 条
        var em = document.createElement('em');
        em.className = 'y';
        em.textContent = r.title;
        cell.insertBefore(em, more);
      } else {
        if (!more) {
          more = document.createElement('em');
          more.className = 'more';
          more.textContent = '+0';
          cell.appendChild(more);
        }
        more.textContent = '+' + (parseInt(more.textContent.slice(1), 10) + 1);
      }
    });
    var m = monthOf(r.iso);
    var sub = D.fmt('calSub', { n: countIn(m) });
    var month = box.querySelector('[data-m="' + m + '"]');
    if (month) {
      month.setAttribute('data-sub', sub);
      if (month === current()) app.querySelector('[data-cal-sub]').textContent = sub;
    }
    // 网页版月历照真 App 把待办也算进“本月 N 项”，和手机那份数目不同：在它自己的数上加一
    D.all('[data-shot="web-cal"] [data-m="' + m + '"][data-n]').forEach(function (el) {
      var n = parseInt(el.getAttribute('data-n'), 10) + 1;
      el.setAttribute('data-n', String(n));
      el.textContent = D.fmt('calSub', { n: n });
    });
    var sel = app.querySelector('.cal-m .sel:not(.mute)');
    if (sel && sel.getAttribute('data-iso') === r.iso) pick(sel);
  }

  // 翻到这一天所在的月，并选中它（新记的日程落到日历上时用）
  function focusDay(iso) {
    var month = box.querySelector('[data-m="' + monthOf(iso) + '"]');
    if (!month) return;
    show(month);
    var cell = month.querySelector('[data-iso="' + iso + '"]');
    if (cell) pick(cell);
  }

  // 方向键在当前月的格子间走（一个 Tab 停靠点）；Enter、空格由 demo.js 统一当点击
  box.addEventListener('keydown', function (e) {
    var step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step) return;
    var cells = cellsOf(current());
    var i = cells.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    var j = Math.max(0, Math.min(cells.length - 1, i + step));
    rove(current(), cells[j]).focus();
  });

  rove(current());
  D.cal = { flip: flip, pick: pick, add: add, focusDay: focusDay };
})();
