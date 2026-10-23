// 职责：连接存储并订阅 events / todos 两个集合：快照先经 normalize 整理再进状态，发 "change"；
//       别处新加的记录记入 fresh 短暂高亮（自己刚加的不算）；连不上发 "notice" unavailable；
//       订阅出错时发一次 "notice" lost，并按 RECONNECT_MS 逐步拉长间隔自动重新订阅，恢复后发 reconnected。
// 依赖：core/const.js、data/bus.js、data/store.js、data/state.js、data/normalize.js
App.data = App.data || {};

const C = App.core.C;
const emit = App.data.emit, store = App.data.store, S = App.data.state;
const {normalizeItem} = App.data.normalize;
const KEY = {events:"ev", todos:"td"};
const unsubs = {}, fails = {events:0, todos:0};

function markFresh(snap, key){
  if (!S.loaded[key]) return;
  for (const c of snap.changes()){
    if (c.type === "added" && !S.localIds.has(c.id)){ S.fresh.add(c.id); setTimeout(() => S.fresh.delete(c.id), C.FRESH_MS); }
  }
}
function watch(coll){
  const key = KEY[coll];
  if (unsubs[coll]){ try { unsubs[coll](); } catch(e){} }
  unsubs[coll] = store.subscribe(coll, snap => {
    if (fails[coll]){ fails[coll] = 0; emit("notice", {type:"reconnected"}); }
    markFresh(snap, key);
    S[coll] = snap.items.map(r => normalizeItem(coll, r));
    S.loaded[key] = true;
    emit("change");
  }, () => {
    if (!fails[coll]) emit("notice", {type:"lost"});
    const wait = C.RECONNECT_MS[Math.min(fails[coll], C.RECONNECT_MS.length - 1)];
    fails[coll]++;
    setTimeout(() => watch(coll), wait);
  });
}
async function start(){
  const ok = await store.connect();
  if (!ok){
    emit("notice", {type:"unavailable", hint: store.unavailableHint()});
    S.loaded.ev = S.loaded.td = true; emit("change"); return;
  }
  watch("events"); watch("todos");
}
function stop(){ for (const c in unsubs){ try { unsubs[c](); } catch(e){} delete unsubs[c]; } }

App.data.subscribe = {start, stop};
