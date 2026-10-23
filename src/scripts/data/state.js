// 页面运行时状态：日程/待办数据、加载标记、待删除队列、新到达高亮、勾选动画暂缓时间，
// 以及当前视图、选中日期、本周起点、项目筛选等界面状态（视图记在 localStorage）。
// 依赖：core/date.js、logic/projects.js。
App.data = App.data || {};

const {today, mondayOf} = App.core.date;
const {projectList} = App.logic.projects;

const S = {
  events: [], todos: [],
  loaded: {ev:false, td:false},
  pendingDel: new Map(),   // id -> {coll, timer}
  localIds: new Set(), fresh: new Set(),
  holdUntil: 0, holdTimer: null,
  view: "today",
  selDay: today(), weekStart: mondayOf(today()), projFilter: null, showDone: false,
};
try { S.view = localStorage.getItem("pv-view") || "today"; } catch(e){}

App.data.state = S;
App.data.visEv = () => S.events.filter(e => !S.pendingDel.has(e.id));
App.data.visTd = () => S.todos.filter(t => !S.pendingDel.has(t.id));
App.data.projects = () => projectList(S.events, S.todos);
App.data.ready = () => S.loaded.ev && S.loaded.td;
