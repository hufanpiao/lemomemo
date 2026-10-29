// 对照：类的方法、构造器、属性初始化里的 this，类方法里的箭头函数，模块顶层的 this；参数类型具体的 Object.keys / values / entries / assign 不报
export class Counter {
  n = 0;
  readonly me = this;
  constructor(start: number) { this.n = start; }
  inc() { const add = () => { this.n += 1; }; add(); return this.n; }
}
export const top = typeof this;
const rec: Record<string, number> = { a: 1 };
export const k = Object.keys(rec);
export const v = Object.values(rec);
export const e = Object.entries(rec);
export const c = Object.assign({}, rec);
