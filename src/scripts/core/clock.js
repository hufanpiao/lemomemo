// 职责：统一时钟。create(env) 返回时钟：now()/today()/nowMin()/hour() 读当前时间；
//       start() 后每分钟发 "tick"，页面切回前台发 "wake"，日期变了（跨过零点）先发 "daychange" {prev, day}。
//       时间来源和定时器由 env 注入（正式运行用 platform/env.js，测试用假时钟），本文件不直接读系统时间。
// 依赖：core/const.js、core/date.js
App.core = App.core || {};

const C = App.core.C;
const {todayOf, minOfDay, hourOf} = App.core.date;

function create(env){
  const subs = {tick:[], wake:[], daychange:[]};
  const emit = (type, payload) => subs[type].slice().forEach(fn => fn(payload));
  let day = todayOf(env.now());
  const checkDay = () => {
    const d = todayOf(env.now());
    if (d !== day){ const prev = day; day = d; emit("daychange", {prev, day:d}); }
  };
  return {
    now: () => env.now(),
    today: () => todayOf(env.now()),
    nowMin: () => minOfDay(env.now()),
    hour: () => hourOf(env.now()),
    on(type, fn){ subs[type].push(fn); },
    start(){
      env.every(C.CLOCK_TICK_MS, () => { checkDay(); emit("tick"); });
      env.onVisible(() => { checkDay(); emit("wake"); });
    },
    checkDay,
  };
}

App.core.clock = {create};
