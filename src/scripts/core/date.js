// 日期与时间工具：以 "YYYY-MM-DD" 字符串表示日期，提供解析、加减天数、相差天数、
// "HH:MM" 与分钟互转、本周一、“10月23日”格式。today()/nowMin() 读当前时间。
// 依赖：无。不碰 document / window，可在 Node 中直接加载（构建时每个文件各包一层函数作用域）。
App.core = App.core || {};

const WK = ["周日","周一","周二","周三","周四","周五","周六"];
const pad = n => String(n).padStart(2,"0");
const ymd = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const parse = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y,m-1,d); };
const today = () => ymd(new Date());
const addDays = (s,n) => { const d = parse(s); d.setDate(d.getDate()+n); return ymd(d); };
const dayDiff = (a,b) => Math.round((parse(a)-parse(b))/86400000);
const hm2m = t => { const [h,m] = t.split(":").map(Number); return h*60+m; };
const m2hm = m => pad(Math.floor(m/60)%24)+":"+pad(m%60);
const nowMin = () => { const n = new Date(); return n.getHours()*60+n.getMinutes(); };
function mondayOf(s){ const d = parse(s); return addDays(s, -((d.getDay()+6)%7)); }
const md = s => { const d = parse(s); return (d.getMonth()+1)+"月"+d.getDate()+"日"; };

App.core.date = {WK, pad, ymd, parse, today, addDays, dayDiff, hm2m, m2hm, nowMin, mondayOf, md};
