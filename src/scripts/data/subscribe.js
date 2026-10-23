// 订阅：连接存储后订阅 events / todos 两个集合，收到快照就更新状态并重绘；
// 别处新加的记录短暂高亮（自己刚加的不高亮）；连不上时显示提示；断线时提示刷新。
// 依赖：data/store.js、data/state.js；调用时用到 ui/render.js、ui/toast.js。
App.data = App.data || {};

const store = App.data.store, S = App.data.state;

async function start(){
  const ok = await store.connect();
  if (!ok){
    App.ui.render.showNoData();
    S.loaded.ev = S.loaded.td = true; App.ui.render(); return;
  }
  const lost = () => App.ui.toast.show("和云端的连接断了，刷新页面即可恢复", "刷新", () => location.reload(), 60000);
  const mark = (snap, key) => {
    if (S.loaded[key]){
      for (const c of snap.changes()){
        if (c.type === "added" && !S.localIds.has(c.id)){ S.fresh.add(c.id); setTimeout(() => S.fresh.delete(c.id), 2400); }
      }
    }
  };
  store.subscribe("events", s => { mark(s,"ev"); S.events = s.items; S.loaded.ev = true; App.ui.render(); }, lost);
  store.subscribe("todos", s => { mark(s,"td"); S.todos = s.items; S.loaded.td = true; App.ui.render(); }, lost);
}

App.data.subscribe = {start};
