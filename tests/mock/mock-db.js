// 模拟存储适配器 "mock-db"：按 data/store.js 的统一接口实现，数据只在内存里，示例数据与原 测试/mock.js 相同
// （日期按打开页面那天计算）；每次变化 120 ms 后推送一次全量快照。
// 由 build.py 拼进 dist/test.html 的脚本包（在 app.js 之前）。依赖：platform/index.js（注册表 App.platform.storage）。
App.platform = App.platform || {};
App.platform.storage = App.platform.storage || {};

App.platform.storage["mock-db"] = function createMockDb(){
  const pad=n=>String(n).padStart(2,"0"); const d=new Date(); const ymd=x=>x.getFullYear()+"-"+pad(x.getMonth()+1)+"-"+pad(x.getDate());
  const off=n=>{const x=new Date(d);x.setDate(x.getDate()+n);return ymd(x)}; const H=d.getHours();
  const data={events:{
    e1:{title:"NEOX 横版对片",date:off(0),time:pad(Math.max(8,H-1))+":00",durationMin:90,project:"NEOX",note:"腾讯会议"},
    e2:{title:"SignPlex 客户反馈会",date:off(0),time:pad(Math.min(22,H+1))+":30",durationMin:60,project:"SignPlex",source:"chat"},
    e3:{title:"SOIL STUDIO 现场踩点",date:off(1),time:"10:00",durationMin:180,project:"SOIL STUDIO",note:"望京"},
    e4:{title:"体检",date:off(3),time:"",project:""}},
   todos:{
    t1:{title:"交 SignPlex 韩文版成片",done:false,due:off(-2),important:true,project:"SignPlex",createdAt:1},
    t2:{title:"NEOX 竖版 4K 导出",done:false,due:off(0),important:false,project:"NEOX",createdAt:2},
    t3:{title:"挑 4 首配乐候选",done:false,due:off(5),important:false,project:"SOIL STUDIO",createdAt:3,source:"chat"},
    t4:{title:"整理素材盘",done:false,due:"",important:false,project:"",createdAt:4},
    t5:{title:"回复报价邮件",done:true,doneAt:Date.now()-3600e3,due:off(0),important:true,project:"",createdAt:5}}};
  const subs={events:[],todos:[]};
  const snap=c=>({items:Object.entries(data[c]).map(([id,v])=>Object.assign({id},v)),changes:()=>[]});
  const emit=c=>setTimeout(()=>subs[c].forEach(f=>f(snap(c))),120);
  let n=0;
  return {
    async connect(){ return true; },
    subscribe(c, onData){ subs[c].push(onData); emit(c); return ()=>{}; },
    newId(){ return "m"+(++n); },
    async add(c, id, v){ data[c][id]=v; emit(c); },
    async update(c, id, v){ Object.assign(data[c][id], v); emit(c); },
    async remove(c, id){ delete data[c][id]; emit(c); },
  };
};
