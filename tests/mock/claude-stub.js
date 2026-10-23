// 职责：模拟 window.claude：提供 claude.use("db") 的集合 / 文档接口（含 get；集合按需创建，logs 也能用）（与 claude.ai 数据库同形），用来在本地验证
//       platform/claude-db.js 适配器。数据默认取 plannerSampleData(现在)；测试可预先设置
//       globalThis.plannerStubSeed（自定义数据）、globalThis.plannerStubFail = "invalid_argument" 等（让写入失败）。
// 依赖：tests/mock/sample-data.js（未设置 plannerStubSeed 时）。build.py 把两者一起放进 dist/test-claude.html 的桩脚本。
(function(){
  const g = globalThis;
  const store = g.plannerStubSeed || g.plannerSampleData(Date.now());
  const subs = {events:[], todos:[], logs:[]};
  const bag = c => store[c] || (store[c] = {});
  const snap = c => ({docs:Object.entries(bag(c)).map(([id,v])=>({id,exists:true,data:()=>v})),docChanges:()=>[]});
  const emit = c => setTimeout(() => (subs[c] || []).forEach(f => f(snap(c))), g.plannerStubDelay == null ? 120 : g.plannerStubDelay);
  const failIf = async () => { if (g.plannerStubFail){ const e = new Error("stub"); e.code = g.plannerStubFail; throw e; } };
  let n = 0;
  const coll = c => ({
    async get(){ return snap(c); },
    onSnapshot(f){ (subs[c] = subs[c] || []).push(f); emit(c); return () => { subs[c] = subs[c].filter(x => x !== f); }; },
    doc(id){ id = id || ("m"+(++n)); return {id,
      async get(){ const v = bag(c)[id]; return {id, exists: !!v, data: () => v}; },
      async set(v){ await failIf(); bag(c)[id] = v; emit(c); },
      async update(v){ await failIf(); Object.assign(bag(c)[id], v); emit(c); },
      async delete(){ await failIf(); delete bag(c)[id]; emit(c); }}; }});
  g.window = g.window || g;
  g.window.claude = {use: async () => ({collection:coll})};
})();
