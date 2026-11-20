// 读行里的列值（改善报告第七节“低风险的重复清理”：原来二十来个文件各写一行同样的小工具）
// • str：不是字符串当空串
// • strOrNull：不是字符串当 null（空串照旧是空串）
// 只收一个参数：可以直接 .map(str)。要别的兜底值、或空串也当 null 的，各自写（calendar/data/event-edit.ts）
// 纯函数，前端各层、SW、服务器函数都能用
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
