// 职责：claude.ai 存储适配器：把 window.claude.use("db") 的集合 / 文档接口包装成 data/store.js 定义的统一接口；
//       把平台错误码映射成中性错误码；记录 id 一律以文档 id 为准（数据里的 id 字段不能覆盖它）。
//       连不上时的提示文案也由这里提供。全项目只有本文件访问 window.claude。
// 依赖：platform/index.js
App.platform = App.platform || {};

const storeError = App.platform.storeError;
const CODE_MAP = {
  invalid_argument: "forbidden", permission_denied: "forbidden", forbidden: "forbidden",
  not_found: "not_found",
  quota_exceeded: "quota", resource_exhausted: "quota",
  unauthenticated: "unauthenticated",
};
const toStoreError = e => storeError(CODE_MAP[e && e.code] || "network", e);

App.platform.storage["claude-db"] = function createClaudeDb(){
  let db = null;
  const refs = new Map();   // newId 生成的文档引用，add 时沿用同一个引用
  const ref = (coll, id) => {
    const key = coll + "/" + id, r = refs.get(key);
    if (r){ refs.delete(key); return r; }
    return db.collection(coll).doc(id);
  };
  const guard = async fn => { try { await fn(); } catch(e){ throw toStoreError(e); } };
  return {
    async connect(){
      db = window.claude && window.claude.use ? await window.claude.use("db") : null;
      return !!db;
    },
    unavailableHint: () => ({title:"数据没有连上。", text:" 请在 claude.ai 登录同一个账号后再打开这个页面。"}),
    subscribe(coll, onData, onError){
      return db.collection(coll).onSnapshot(s => onData({
        items: s.docs.map(d => Object.assign({}, d.data(), {id:d.id})),
        changes: () => s.docChanges().map(c => ({type:c.type, id:c.doc.id})),
      }), e => onError(toStoreError(e)));
    },
    newId(coll){ const r = db.collection(coll).doc(); refs.set(coll + "/" + r.id, r); return r.id; },
    add: (coll, id, data) => guard(() => ref(coll, id).set(data)),
    update: (coll, id, patch) => guard(() => db.collection(coll).doc(id).update(patch)),
    remove: (coll, id) => guard(() => db.collection(coll).doc(id).delete()),
    // 平台没有批量写入接口：不提供 batch，由 data/store.js 逐条写
  };
};
