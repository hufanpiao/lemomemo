// 对照：具体对象上的事件属性、同名的局部变量 / 参数 / 对象属性不报
const ws = new WebSocket('wss://example.invalid');
ws.onerror = () => {};
ws.onmessage = null;
export function run(onerror: (e: unknown) => void) { const onload = 1; onerror(onload); }
export const handlers = { onunload: 1 };
