// 函数日志的出口（架构 5.5“函数里禁止打印请求体和明文”、A23）：只打一行“<函数名>: <错误码>”。
// vault、vault-image 两个目录里一律不准出现 console.（check_backend F13），日志只能经这里注入的 log(code)；
// code 只放固定的错误码和数字，不放请求体、明文、令牌、邮箱、user_id 原文（调用方守，代码审查看）。
// 不 import npm 包、不读环境变量，Vitest 直接测。

/** 超长的码截到 120 个字符（防止调用方误把一大段东西当码传进来） */
export const LOG_CODE_MAX = 120;

export function codeLogger(fn: string): (code: string) => void {
  return (code) => {
    console.error(`${fn}: ${String(code).slice(0, LOG_CODE_MAX)}`);
  };
}
