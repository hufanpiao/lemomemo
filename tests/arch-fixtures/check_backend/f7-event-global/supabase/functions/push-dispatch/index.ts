// 违规 F7（代码审查第八轮必改 ①）：全局的事件监听 / 派发——不带对象前缀，或挂在 globalThis / self / window 上
addEventListener('x', () => {});
dispatchEvent(new Event('x'));
removeEventListener('x', () => {});
globalThis.addEventListener('x', () => {});
self.dispatchEvent(new Event('x'));
(globalThis as typeof globalThis).removeEventListener('x', () => {});
