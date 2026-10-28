// 已登录的人访问首页，直接进 App（架构 16.1）。不加载任何数据接口的库，只看本机有没有登录信息，不解析、不验证；
// 令牌过期了 App 自己会去登录页。存储键和 App 里数据库客户端的默认规则一致：sb-<主机名第一段>-auth-token
// （正式 sb-lemomemo-auth-token，预览 sb-preview-auth-token，14.2 第 2 点）。
(function () {
  try {
    var key = 'sb-' + location.hostname.split('.')[0] + '-auth-token';
    if (localStorage.getItem(key)) location.replace('/app/');
  } catch {
    // 读不了 localStorage（隐私模式等）就留在首页
  }
})();
