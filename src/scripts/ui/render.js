// 渲染调度与抬头：render() 依次重绘抬头、今天、日程、待办（勾选动画期间暂缓）；
// 抬头显示月日、星期年份和“今天完成 / 没赶上”胶囊；showNoData() 显示数据未连接提示。
// 依赖：core/date.js、core/dom.js、data/state.js；调用时用到 ui/today、schedule、todos、nav。
App.ui = App.ui || {};

const {WK, ymd, parse, today} = App.core.date;
const {$, h} = App.core.dom;
const S = App.data.state, visTd = App.data.visTd;

function render(){
  const wait = S.holdUntil - Date.now();
  if (wait > 0){ clearTimeout(S.holdTimer); S.holdTimer = setTimeout(render, wait + 10); return; }
  renderHead(); App.ui.today.render(); App.ui.schedule.render(); App.ui.todos.render();
}

function renderHead(){
  const t = today(), d = parse(t);
  $("hd-md").innerHTML = ""; $("hd-md").append((d.getMonth()+1)+"", h("small",null,"月"), d.getDate()+"", h("small",null,"日"));
  $("hd-sub").textContent = WK[d.getDay()] + "  " + d.getFullYear() + "年";
  const chips = $("hd-chips"); chips.textContent = "";
  const doneToday = visTd().filter(x => x.done && x.doneAt && ymd(new Date(x.doneAt)) === t).length;
  const late = visTd().filter(x => !x.done && x.due && x.due < t).length;
  if (doneToday) chips.append(h("span",{class:"chip"},"今天完成 ",h("b",null,doneToday)," 件"));
  if (late) chips.append(h("button",{class:"chip late",type:"button",onclick:()=>{ App.ui.nav.go("today"); $("late").scrollIntoView({behavior:"smooth",block:"center"}); }},h("b",null,late)," 件没赶上"));
}

function showNoData(){
  const n = $("notice"); n.hidden = false; n.textContent = "";
  n.append(h("strong",null,"数据没有连上。"), " 请在 claude.ai 登录同一个账号后再打开这个页面。");
}

render.head = renderHead;
render.showNoData = showNoData;
App.ui.render = render;
