// 职责：统一时钟。create(env) 返回时钟：now()/today()/nowMin()/hour() 读当前时间；
//       start() 后每到整分钟（之后 CLOCK_ALIGN_MS 毫秒内）发一次 "tick"；每次都按当时的时间重新对齐，不会越跑越偏；
//       页面切回前台发 "wake" 并重新对齐；日期变了（跨过零点）先发 "daychange" {prev, day}。
//       时间来源和定时器由 env 注入（正式运行用 platform/env.js，测试用假 env），本文件不直接读系统时间。
// 依赖：core/const.js、core/date.js
App.core = App.core || {};

const C = App.core.C;
const {todayOf, minOfDay, hourOf} = App.core.date;

// 到下一个整分钟还差多少毫秒，再加 CLOCK_ALIGN_MS 的余量（保证触发时已经跨过整分钟）
const msToNextMinute = ms => C.CLOCK_TICK_MS - (ms % C.CLOCK_TICK_MS) + C.CLOCK_ALIGN_MS;

// env：{now(), after(ms, fn) → 句柄, cancel(句柄), onVisible(fn)}
function create(env){
  const subs = {tick:[], wake:[], daychange:[]};
  const emit = (type, payload) => subs[type].slice().forEach(fn => fn(payload));
  let day = todayOf(env.now()), timer = null;
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
      const schedule = () => {
        if (timer != null) env.cancel(timer);
        timer = env.after(msToNextMinute(env.now()), () => { timer = null; checkDay(); emit("tick"); schedule(); });
      };
      schedule();
      env.onVisible(() => { checkDay(); emit("wake"); schedule(); });
    },
    checkDay,
  };
}

App.core.clock = {create, msToNextMinute};
