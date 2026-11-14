// F13 对照：唯一的日志出口本身不报
export const codeLogger = (fn: string) => (c: string) => console.error(`${fn}: ${c}`);
