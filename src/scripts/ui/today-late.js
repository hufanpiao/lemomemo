// 职责：今天视图里的“没赶上”红色面板：列出截止日已过、还没完成的待办，每条可改到今天 / 明天，多条时可全部改到今天。
//       改期交给 data/write.js，提示文案在这里。
// 依赖：core/date.js、logic/items.js、data/state.js、data/write.js、ui/dom.js、ui/toast.js
App.ui = App.ui || {};

const {addDays, dayDiff, md} = App.core.date;
const {isLate} = App.logic.items;
const visTd = App.data.visTd, write = App.data.write;
const {$, h} = App.ui.dom;
const toast = App.ui.toast;

function reschedule(x, d, t){
  write.reschedule(x, d);
  toast.show("已改到"+(d === t ? "今天" : "明天"));
}
async function moveAll(list){
  await write.moveAll(list);
  toast.show(list.length+" 件已改到今天");
}
function renderLate(t){
  const lb = $("late"); lb.textContent = "";
  const late = visTd().filter(x => isLate(x, t)).sort((a,b) => a.due.localeCompare(b.due));
  if (!late.length) return;
  const p = h("section",{class:"panel late-panel","aria-labelledby":"h-late"},
    h("div",{class:"ph"}, h("h2",{id:"h-late"},late.length+" 件没赶上"),
      late.length > 1 ? h("button",{class:"btn-dark",type:"button",onclick:()=>moveAll(late)},"全部改到今天") : null));
  for (const x of late){
    p.append(h("div",{class:"late-row"},
      h("div",{class:"t"}, x.title, h("small",null,"原定 "+md(x.due)+"，晚了 "+(-dayDiff(x.due,t))+" 天")),
      h("div",{class:"mini"},
        h("button",{type:"button",onclick:()=>reschedule(x,t,t)},"今天"),
        h("button",{type:"button",onclick:()=>reschedule(x,addDays(t,1),t)},"明天"))));
  }
  lb.append(p);
}

App.ui.todayLate = {render: renderLate};
