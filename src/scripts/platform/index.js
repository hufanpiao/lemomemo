// 职责：平台能力入口。所有依赖运行环境（claude.ai / 以后的独立服务器 PWA / 浏览器本身）的能力都注册在 App.platform 下：
//       storage（存储适配器工厂）、env（时间与前台事件）、prefs（本机偏好）、notify（提示音与推送）。
//       storeError() 生成带中性错误码的错误对象，供各存储适配器使用。
// 依赖：无
App.platform = App.platform || {};
App.platform.storage = App.platform.storage || {};   // {"claude-db": 工厂函数, "mock-db": 工厂函数, 以后 "rest": ...}

// 中性错误码：forbidden 没有写权限 / not_found 记录不存在 / quota 存储已满 / network 网络或未知错误 /
//             unauthenticated 未登录；write 层另外会产生 timeout（超时）。
const CODES = ["forbidden", "not_found", "quota", "network", "unauthenticated", "timeout"];
App.platform.storeError = function storeError(code, cause){
  const e = new Error("存储错误：" + code);
  e.code = CODES.includes(code) ? code : "network";
  e.cause = cause;
  return e;
};
