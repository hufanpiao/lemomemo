// 违规 F7（代码审查第八轮必改 ②）：Object.values / entries / assign 的参数、对象展开 { ...x }，类型是 EventTarget、{}、object 的也报
declare const et: EventTarget;
declare const empty: {};
declare const obj: object;
export const v1 = Object.values(et);
export const v2 = Object.entries(empty);
export const v3 = Object.assign({}, obj);
export const s1 = { ...et };
export const s2 = { ...(obj as object) };
