// claude.ai 存储适配器：把 window.claude.use("db") 的集合 / 文档接口包装成 data/store.js 定义的统一接口。
// 这是全项目唯一直接访问 window.claude 的地方；以后的下载、提醒推送等平台能力也放在 platform/ 下。
// 依赖：无（注册到 App.platform.storage["claude-db"]，由 app.js 选用）。
App.platform = App.platform || {};
App.platform.storage = App.platform.storage || {};

App.platform.storage["claude-db"] = function createClaudeDb(){
  let db = null;
  const refs = new Map();   // newId 生成的文档引用，add 时沿用同一个引用
  const doc = (coll, id) => {
    const key = coll + "/" + id, r = refs.get(key);
    if (r){ refs.delete(key); return r; }
    return db.collection(coll).doc(id);
  };
  return {
    async connect(){
      db = window.claude && window.claude.use ? await window.claude.use("db") : null;
      return !!db;
    },
    subscribe(coll, onData, onError){
      return db.collection(coll).onSnapshot(s => onData({
        items: s.docs.map(d => Object.assign({id:d.id}, d.data())),
        changes: () => s.docChanges().map(c => ({type:c.type, id:c.doc.id})),
      }), onError);
    },
    newId(coll){ const r = db.collection(coll).doc(); refs.set(coll + "/" + r.id, r); return r.id; },
    add: (coll, id, data) => doc(coll, id).set(data),
    update: (coll, id, patch) => db.collection(coll).doc(id).update(patch),
    remove: (coll, id) => db.collection(coll).doc(id).delete(),
  };
};
