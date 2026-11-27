// 只读行界面的词条·中文（FA-2 只读行界面；11-06 从公共词典 zh.ts 挪出来，首屏瘦身，同 tz-zh.ts 的做法）：
// 行尾标记、重复事项横幅、“更新”。只给按需下载的部件用（kit 的 ReadonlyMark、ReadonlyRow，经 kit/hooks/useRoT.ts），
// 放在公共词典里会跟着首屏下载。ro.named（只读行的读屏名字：打勾圆圈、电脑周视图的块）11-06 也挪进来。加一条要同时加 ro-ko.ts
// as const：值保留字面量类型
export const roZh = {
  'ro.mark': '要新版本',
  'ro.markLabel': '要更新到新版本才能修改',
  'ro.repeat': '有 {n} 条重复事项要新版本才能完整显示',
  'ro.update': '更新',
  'ro.named': '{label}，要更新到新版本才能修改',
} as const;

export type RoMsgKey = keyof typeof roZh;
