// 违规 F7（代码审查第四轮必改 1、3）：每行一种
export const c1 = (() => 0).constructor('return 1')();
export const p1 = ({} as { __proto__: unknown }).__proto__;
export const p2 = Object.getPrototypeOf(async () => {});
export const s1 = ({} as Record<string, unknown>)['constructor'];
const k: string = String(1); export const c2 = ([] as unknown as Record<string, () => unknown>)[k]();
export const c3 = ({} as Record<string, unknown>)['De' + 'no'];
export const c4 = ({} as Record<string, unknown>)[`${k}y`];
export const w1 = new Worker('./w.ts', { type: 'module' });
export const w2 = typeof SharedWorker;
