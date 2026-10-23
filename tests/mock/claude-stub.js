// 模拟 window.claude（v2 时代的 测试/mock.js 原样迁来）：提供 claude.use("db") 的集合 / 文档接口和一组示例数据，
// 用来在本地验证 platform/claude-db.js 适配器。由 build.py 拼进 dist/test-claude.html（放在页面脚本之前，单独一个 <script>）。
// 依赖：无。
(function(){
  const pad=n=>String(n).padStart(2,"0"); const d=new Date(); const ymd=x=>x.getFullYear()+"-"+pad(x.getMonth()+1)+"-"+pad(x.getDate());
  const off=n=>{const x=new Date(d);x.setDate(x.getDate()+n);return ymd(x)}; const H=d.getHours();
  const store={events:{
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
  const snap=c=>({docs:Object.entries(store[c]).map(([id,v])=>({id,exists:true,data:()=>v})),docChanges:()=>[]});
  const emit=c=>setTimeout(()=>subs[c].forEach(f=>f(snap(c))),120);
  let n=0;
  const coll=c=>({onSnapshot(f){subs[c].push(f);emit(c);return()=>{}},
    doc(id){id=id||("m"+(++n));return{id,async set(v){store[c][id]=v;emit(c)},async update(v){Object.assign(store[c][id],v);emit(c)},async delete(){delete store[c][id];emit(c)}}}});
  window.claude={use:async()=>({collection:coll})};
})();
