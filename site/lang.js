// 页脚“中文 / 한국어”切换（架构 16.4）：记下手动选择，再照常跟着链接跳到对应网址。
// 以后访问 `/` 都按 cookie 走；App 登录前也会读 pv-locale 和这个 cookie。没有 JS 时链接照样能跳，只是不记住。
document.addEventListener('click', function (e) {
  var t = e.target;
  var a = t && t.closest ? t.closest('a[data-lang]') : null;
  if (!a) return;
  var lang = a.getAttribute('data-lang');
  if (lang !== 'zh' && lang !== 'ko') return;
  var secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = 'lemo_lang=' + lang + '; Path=/; Max-Age=31536000; SameSite=Lax' + secure;
  try {
    localStorage.setItem('pv-locale', lang);
  } catch (err) {
    // 存不了就只靠 cookie
  }
});
