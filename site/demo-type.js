// 演示页：点黄色“＋”弹出输入（对话框），打一句话或点示例句，“正在整理…”一下变成日程卡，关掉以后把结果交给 onDone。
// 落到哪里（今天、日历、待办）由 demo.js 决定，这里只管弹层。只用 demo-kit.js，排在它后面加载。
(function () {
  'use strict';

  var D = window.LemoDemo;

  // opts：{ web: 是不是网页版画面, opener: 关掉以后焦点回到哪（“＋”）, onDone(r): 记好以后调，r 是 D.parse 的结果 }
  D.openType = function (screen, opts) {
    if (screen.querySelector('.ts')) return;
    var src = document.getElementById('tpl-type').content;
    var dim = src.querySelector('.dim').cloneNode(true);
    var sheet = src.querySelector('.vs').cloneNode(true);
    if (opts.web) sheet.classList.add('dk-sheet');
    screen.appendChild(dim);
    screen.appendChild(sheet);
    dim.classList.add('fx-fade-in');
    D.play(sheet, 'fx-up');
    var input = sheet.querySelector('input');
    var card = sheet.querySelector('.vc');
    var sorting = sheet.querySelector('[data-slot="sorting"]');
    var busy = false;
    var closed = false;
    var timers = [];
    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
    // 焦点进对话框：有鼠标的直接进输入框；手机上先停在弹层本身，不自动弹键盘挡住示例句
    sheet.tabIndex = -1;
    var fine = window.matchMedia && matchMedia('(pointer: fine)').matches;
    (fine ? input : sheet).focus({ preventScroll: true });

    function close(after) {
      if (closed) return;
      closed = true;
      timers.forEach(clearTimeout); // “正在整理…”时关掉，后面的插入就不做了
      dim.classList.remove('fx-fade-in');
      dim.classList.add('fx-fade-out');
      D.stop(sheet, 'fx-up');
      D.play(sheet, 'fx-down', function () {
        sheet.remove();
        dim.remove();
        if (opts.opener && document.contains(opts.opener)) opts.opener.focus({ preventScroll: true });
        if (after) after();
      });
    }
    function submit(text) {
      text = (text || '').trim();
      if (!text || busy) return;
      busy = true;
      input.value = text;
      sheet.focus({ preventScroll: true }); // 收起手机键盘，焦点仍在对话框里
      sheet.querySelector('.ex-h').hidden = true;
      sheet.querySelector('.ex').hidden = true;
      sorting.hidden = false;
      later(function () {
        var r = D.parse(text);
        sorting.hidden = true;
        D.slot(card, 'kind', r.ev ? D.word('kindEv') : D.word('kindTodo'));
        D.slot(card, 'title', r.title);
        D.slot(card, 'when', r.when);
        card.hidden = false;
        D.play(card, 'fx-card');
        later(function () {
          close(function () { opts.onDone(r); });
        }, D.reduce ? 600 : 1300);
      }, D.reduce ? 150 : 650);
    }

    dim.addEventListener('click', function () { close(); });
    sheet.addEventListener('click', function (e) {
      var ex = e.target.closest('.ex button');
      if (ex) submit(ex.textContent);
      else if (e.target.closest('.send')) submit(input.value);
    });
    // 对话框里：Esc 在哪都能关；Tab 在弹层里转圈，不跑到后面的页面上
    sheet.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter' && e.target === input && !e.isComposing) {
        e.preventDefault();
        submit(input.value);
      } else if (e.key === 'Tab') {
        var f = D.all('input, button', sheet).filter(function (x) { return !x.closest('[hidden]') && !x.disabled; });
        if (!f.length) return;
        var i = f.indexOf(document.activeElement);
        var j = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
        e.preventDefault();
        f[j].focus();
      }
    });
  };
})();
