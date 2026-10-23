// 职责：模拟存储适配器 "mock-db"：按 data/store.js 的统一接口实现，数据只在内存里；带 batch（一次写多条只推送一次）。
//       工厂参数 opts：seed 初始数据（默认 plannerSampleData(现在)）、delay 推送延迟毫秒（默认 120）、
//       fail(op, coll, id) 返回错误码就让这次写入失败、hang 为 true 时写入永不返回（测超时）。
// 依赖：platform/index.js（注册表 App.platform.storage、storeError）、tests/mock/sample-data.js（未传 seed 时）
App.platform = App.platform || {};
App.platform.storage = App.platform.storage || {};

App.platform.storage["mock-db"] = function createMockDb(opts){
  opts = opts || {};
  const data = opts.seed || globalThis.plannerSampleData(Date.now());
  const delay = opts.delay == null ? 120 : opts.delay;
  const subs = {events:[], todos:[], logs:[]};
  const bag = c => data[c] || (data[c] = {});
  const snap = c => ({items:Object.entries(bag(c)).map(([id,v]) => Object.assign({}, v, {id})), changes:() => []});
  const emit = c => setTimeout(() => (subs[c] || []).forEach(f => f(snap(c))), delay);
  const check = (op, c, id) => {
    if (opts.hang) return new Promise(() => {});
    const code = opts.fail && opts.fail(op, c, id);
    return code ? Promise.reject(App.platform.storeError(code)) : null;
  };
  const apply = (op, c, id, v) => {
    if (op === "add") bag(c)[id] = v;
    else if (op === "update"){ if (!bag(c)[id]) throw App.platform.storeError("not_found"); Object.assign(bag(c)[id], v); }
    else if (op === "remove") delete bag(c)[id];
  };
  const write = async (op, c, id, v) => { const bad = check(op, c, id); if (bad) return bad; apply(op, c, id, v); emit(c); };
  let n = 0;
  return {
    data,
    async connect(){ return true; },
    async get(c, id){ const v = bag(c)[id]; return v ? Object.assign({}, v, {id}) : null; },
    async list(c){ return snap(c).items; },
    subscribe(c, onData){ (subs[c] = subs[c] || []).push(onData); emit(c); return () => { subs[c] = subs[c].filter(f => f !== onData); }; },
    newId(){ return "m"+(++n); },
    add: (c, id, v) => write("add", c, id, v),
    update: (c, id, v) => write("update", c, id, v),
    remove: (c, id) => write("remove", c, id),
    async batch(ops){
      for (const o of ops){ const bad = check(o.op, o.coll, o.id); if (bad) return bad; }
      ops.forEach(o => apply(o.op, o.coll, o.id, o.data));
      [...new Set(ops.map(o => o.coll))].forEach(emit);
    },
  };
};
