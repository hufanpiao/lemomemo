// 送服务器函数（ai-parse、ai-voice）失败的种类和异常：fn-post 的 postFn 抛，打字流程（type-flow）和录音流程按 fail 归类、判要不要自动重试。
// 单独成一个文件：fn-post 引它不用顺带引进 type-flow 和本机解析库（claude-link-api 只要 sendFn），record-logic 引类型也不用绕一圈。
// 纯 TS：不准 import React（A1）

/** 失败的种类：network = 连接都没建立（fetch 抛 TypeError）；其余都不自动重试 */
export type SendFail = 'network' | 'timeout' | 'http' | 'bad_response';

export class SendError extends Error {
  readonly fail: SendFail;
  constructor(fail: SendFail) {
    super(fail);
    this.fail = fail;
    this.name = 'SendError';
  }
}
