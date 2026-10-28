// Turnstile 小验证页的脚本（不用内联脚本，CSP script-src 只有 'self' 和 challenges.cloudflare.com）。
// 记录：页面来源、Turnstile 脚本能否加载、出题、通过（只显示令牌长度和前 8 位，不显示整串）、错误码、CSP 违规。
(function () {
  function log(msg) {
    var li = document.createElement('li');
    li.textContent = new Date().toISOString().slice(11, 19) + '  ' + msg;
    document.getElementById('log').appendChild(li);
  }

  document.addEventListener('securitypolicyviolation', function (e) {
    log('CSP 违规：' + e.effectiveDirective + ' ← ' + (e.blockedURI || '(inline)'));
  });

  var widgetId = null;

  function render() {
    if (!window.turnstile) {
      log('Turnstile 脚本还没加载好');
      return;
    }
    var sel = document.getElementById('key').value;
    var key = sel === 'custom' ? document.getElementById('custom').value.trim() : sel;
    if (!/^[0-9a-zA-Z_-]{10,64}$/.test(key)) {
      log('sitekey 格式不对');
      return;
    }
    if (widgetId !== null) window.turnstile.remove(widgetId);
    log('出题，sitekey 前缀 ' + key.slice(0, 4) + '…');
    widgetId = window.turnstile.render('#widget', {
      sitekey: key,
      callback: function (token) {
        log('通过：令牌长度 ' + token.length + '，前 8 位 ' + token.slice(0, 8));
      },
      'error-callback': function (code) {
        log('出错：' + code + '（110200 一类表示主机名不在允许列表里）');
        return true;
      },
      'expired-callback': function () {
        log('令牌过期');
      },
      'timeout-callback': function () {
        log('交互超时');
      },
      'unsupported-callback': function () {
        log('这个浏览器不支持 Turnstile');
      },
    });
  }

  // Turnstile 的 onload 回调要挂在全局上
  window.onTurnstileLoad = function () {
    log('Turnstile 脚本已加载');
    render();
  };

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('origin').textContent = location.origin + '（' + navigator.userAgent + '）';
    document.getElementById('render').addEventListener('click', render);
    log('页面来源 ' + location.origin + '；window.__TAURI__ ' + (typeof window.__TAURI__ === 'undefined' ? '不存在' : '存在'));
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
    s.async = true;
    s.onerror = function () {
      log('Turnstile 脚本加载失败（网络或 CSP）');
    };
    document.head.appendChild(s);
  });
})();
