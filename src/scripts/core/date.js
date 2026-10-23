// 职责：日期与时间纯函数。日期用 "YYYY-MM-DD" 字符串，时间用 "HH:MM"；解析、加减天数、相差天数、
//       分钟互转、本周一、“10月23日”格式；todayOf/minOfDay/hourOf 把毫秒时间戳换成当天日期和分钟。
//       “现在”一律由调用方传入（来自 core/clock.js），本文件不读系统时间。
// 依赖：无
App.core = App.core || {};

const WK = ["周日","周一","周二","周三","周四","周五","周六"];
const pad = n => String(n).padStart(2,"0");
const ymd = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const parse = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y,m-1,d); };
const addDays = (s,n) => { const d = parse(s); d.setDate(d.getDate()+n); return ymd(d); };
const dayDiff = (a,b) => Math.round((parse(a)-parse(b))/86400000);
const hm2m = t => { const [h,m] = t.split(":").map(Number); return h*60+m; };
const m2hm = m => pad(Math.floor(m/60)%24)+":"+pad(m%60);
function mondayOf(s){ const d = parse(s); return addDays(s, -((d.getDay()+6)%7)); }
const md = s => { const d = parse(s); return (d.getMonth()+1)+"月"+d.getDate()+"日"; };
const todayOf = ms => ymd(new Date(ms));
const minOfDay = ms => { const n = new Date(ms); return n.getHours()*60+n.getMinutes(); };
const hourOf = ms => new Date(ms).getHours();

App.core.date = {WK, pad, ymd, parse, addDays, dayDiff, hm2m, m2hm, mondayOf, md, todayOf, minOfDay, hourOf};
