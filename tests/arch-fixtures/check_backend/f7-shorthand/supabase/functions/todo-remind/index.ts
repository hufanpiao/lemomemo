// 对照：简写属性的同名变量是本地声明的（局部变量、参数）不报
const onerror = () => 0;
export const a = { onerror };
export function b(onload: number, addEventListener: string) { return { onload, addEventListener }; }
