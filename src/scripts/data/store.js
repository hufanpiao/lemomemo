// 职责：统一存储接口（适配器模式）。页面只通过 data/ 层用它，界面代码不直接调用；具体实现放在 platform/（claude-db）
//       或 tests/mock/（mock-db），由 app.js 一处配置选用。适配器没有 batch 时由这里逐条写。
// 依赖：无（适配器在启动时通过 use() 注入）
App.data = App.data || {};

/*
 * 适配器需要实现的方法（一个普通对象即可）：
 *
 *   connect(): Promise<boolean>
 *     连接存储。能用返回 true；当前环境没有这个存储（例如不在 claude.ai 里打开）返回 false。
 *   unavailableHint(): {title, text}   （可选）
 *     connect 返回 false 时页面上显示的提示，例如 {title:"数据没有连上。", text:" 请在 claude.ai 登录……"}。
 *
 *   subscribe(collection, onData, onError): () => void
 *     collection：集合名，目前只有 "events"（日程）和 "todos"（待办）。
 *     onData(snapshot)：每次集合有变化都调用一次，首次订阅也要调用一次（全量）。
 *       snapshot.items     —— 数组，集合里全部记录（含已软删除的），每条是 {...字段, id}；id 必须是文档 id，
 *                             记录数据里自带的 id 字段不能覆盖它
 *       snapshot.changes() —— 返回本次变化 [{type:"added"|"modified"|"removed", id}]，首次可为空数组
 *     onError(err)：连接中断等错误，err.code 为中性错误码。调用后这个订阅视为失效，data 层会重新订阅。
 *     返回值：取消订阅的函数。
 *
 *   newId(collection): string
 *     同步生成一个新记录的 id（写入前就要知道 id，用来识别“自己刚加的”记录，不做高亮）。
 *
 *   add(collection, id, data): Promise<void>      用 newId 得到的 id 新建一条记录
 *   update(collection, id, patch): Promise<void>  合并更新部分字段（值为 null 表示清空该字段）
 *   remove(collection, id): Promise<void>         彻底删除一条记录（页面上的“删除”是软删除，用 update 写 deletedAt）
 *   batch(ops): Promise<void>                     （可选）一次写多条，ops = [{op:"add"|"update"|"remove", coll, id, data}]
 *     写入失败时 reject，错误对象带中性错误码 code（用 App.platform.storeError 生成）：
 *       forbidden 没有写权限 / not_found 记录不存在 / quota 存储已满 / network 网络或未知 / unauthenticated 未登录
 *
 * 以后要加的 REST / 自建服务器适配器（这次不实现），建议对应关系：
 *   connect   → GET /api/me 校验登录（未登录返回 false，unavailableHint 提示去登录）
 *   subscribe → 先 GET /api/{collection} 拉全量，再用 WebSocket / SSE（或定时轮询）收增量，
 *               每次变化把本地缓存整理成 {items, changes()} 回调；断线时调用 onError
 *   newId     → 客户端生成（crypto.randomUUID()），服务器接受客户端 id
 *   add       → PUT    /api/{collection}/{id}   body: data
 *   update    → PATCH  /api/{collection}/{id}   body: patch
 *   remove    → DELETE /api/{collection}/{id}
 *   batch     → POST   /api/batch               body: ops（服务器端用事务）
 *   HTTP 401 → unauthenticated，403 → forbidden，404 → not_found，413/507 → quota，其他 → network。
 *   离线时可先写入 IndexedDB 队列，恢复网络后补发（配合 Service Worker）。
 */

let adapter = null;
const store = {
  connected: false,
  use(a){ adapter = a; store.connected = false; },
  async connect(){ store.connected = !!(adapter && await adapter.connect()); return store.connected; },
  unavailableHint: () => adapter && adapter.unavailableHint ? adapter.unavailableHint() : {title:"数据没有连上。", text:""},
  subscribe: (coll, onData, onError) => adapter.subscribe(coll, onData, onError),
  newId: coll => adapter.newId(coll),
  add: (coll, id, data) => adapter.add(coll, id, data),
  update: (coll, id, patch) => adapter.update(coll, id, patch),
  remove: (coll, id) => adapter.remove(coll, id),
  async batch(ops){
    if (adapter.batch) return adapter.batch(ops);
    for (const o of ops) await store[o.op](o.coll, o.id, o.data);
  },
};

App.data.store = store;
