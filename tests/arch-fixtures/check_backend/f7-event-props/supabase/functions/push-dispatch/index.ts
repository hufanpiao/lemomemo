// 违规 F7（代码审查第八轮低）：全局事件属性——不带对象前缀，或挂在 globalThis / self / window 上，赋值、读取都报
onunhandledrejection = () => {};
onerror = null;
onload = () => {};
onbeforeunload = null;
onunload = null;
globalThis.onerror = null;
self.onunhandledrejection = null;
export const read = typeof onload;
