// 职责：数据状态：整理过的日程 / 待办、加载标记、自己刚加的 id、别处新加的 id（高亮用）；
//       visEv/visTd 只返回没被软删除的条目，projects() 汇总项目名单，ready()/isConnected() 给界面判断加载和连接。
//       界面状态（当前页、选中日期等）不在这里，在 ui/view-state.js。
// 依赖：logic/items.js、logic/projects.js、data/store.js
App.data = App.data || {};

const {isLive} = App.logic.items;
const {projectList} = App.logic.projects;
const store = App.data.store;

const S = {
  events: [], todos: [],
  loaded: {ev:false, td:false},
  localIds: new Set(),   // 本页刚新建的 id：快照里看到它们不做“新到达”高亮
  fresh: new Set(),      // 别处（例如 Claude 在聊天里）刚加的 id：短暂高亮
};

App.data.state = S;
App.data.visEv = () => S.events.filter(isLive);
App.data.visTd = () => S.todos.filter(isLive);
App.data.projects = () => projectList(App.data.visEv(), App.data.visTd());
App.data.ready = () => S.loaded.ev && S.loaded.td;
App.data.isConnected = () => store.connected;
