// 对照：具体对象上的事件方法、类里同名方法的声明不报
const ctrl = new AbortController();
ctrl.signal.addEventListener('abort', () => {});
const target = new EventTarget();
target.dispatchEvent(new Event('x'));
export class Bus { addEventListener(_t: string): void {} dispatchEvent(): boolean { return true; } }
