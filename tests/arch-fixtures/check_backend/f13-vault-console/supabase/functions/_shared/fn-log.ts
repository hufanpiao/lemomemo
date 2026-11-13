// F13 对照：共用的日志出口（共用模块不归 F13 管）
export const codeLogger = (fn: string) => (c: string) => console.error(`${fn}: ${c}`);
