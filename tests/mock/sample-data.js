// 职责：测试用示例数据（mock-db 适配器和 window.claude 桩共用这一份）：plannerSampleData(nowMs) 按“现在”生成
//       今天、明天、三天后的日程和一组待办（含过期、今天截止、已完成、Claude 代记的条目）。
// 依赖：无。在测试页里作为单独的 <script> 放在页面脚本之前；Node 测试里用 vm 加载。
globalThis.plannerSampleData = function plannerSampleData(nowMs){
  const pad=n=>String(n).padStart(2,"0"); const d=new Date(nowMs); const ymd=x=>x.getFullYear()+"-"+pad(x.getMonth()+1)+"-"+pad(x.getDate());
  const off=n=>{const x=new Date(d);x.setDate(x.getDate()+n);return ymd(x)}; const H=d.getHours();
  return {
    events:{
      e1:{title:"NEOX 横版对片",date:off(0),time:pad(Math.max(8,H-1))+":00",durationMin:90,project:"NEOX",note:"腾讯会议"},
      e2:{title:"SignPlex 客户反馈会",date:off(0),time:pad(Math.min(22,H+1))+":30",durationMin:60,project:"SignPlex",source:"chat"},
      e3:{title:"SOIL STUDIO 现场踩点",date:off(1),time:"10:00",durationMin:180,project:"SOIL STUDIO",note:"望京"},
      e4:{title:"体检",date:off(3),time:"",project:""}},
    todos:{
      t1:{title:"交 SignPlex 韩文版成片",done:false,due:off(-2),important:true,project:"SignPlex",createdAt:1},
      t2:{title:"NEOX 竖版 4K 导出",done:false,due:off(0),important:false,project:"NEOX",createdAt:2},
      t3:{title:"挑 4 首配乐候选",done:false,due:off(5),important:false,project:"SOIL STUDIO",createdAt:3,source:"chat"},
      t4:{title:"整理素材盘",done:false,due:"",important:false,project:"",createdAt:4},
      t5:{title:"回复报价邮件",done:true,doneAt:nowMs-3600e3,due:off(0),important:true,project:"",createdAt:5}},
  };
};
