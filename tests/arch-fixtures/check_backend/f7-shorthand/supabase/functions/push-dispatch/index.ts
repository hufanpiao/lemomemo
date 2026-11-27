// 违规 F7（审查员第九轮低 1）：简写属性把全局事件属性、全局事件函数、Reflect 当值带走，和直接读一样报
export const h1 = { onunhandledrejection };
export const h2 = { addEventListener };
export const h3 = { Reflect };
export const h4 = { onerror, onload };
