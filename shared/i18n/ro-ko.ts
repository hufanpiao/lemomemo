// 只读行界面的词条·韩文（11-06 从公共词典 ko.ts 挪出来，见 ro-zh.ts 文件头）；审校标注随行带过来
// satisfies Record<RoMsgKey, string>：少一个键、多一个键都编译不过
import type { RoMsgKey } from './ro-zh.ts';

export const roKo = {
  'ro.mark': '새 버전 필요', // REVIEW(ko) FA-2 只读行新加
  'ro.markLabel': '새 버전으로 업데이트해야 수정할 수 있어요', // REVIEW(ko) FA-2 只读行新加
  'ro.repeat': '반복 항목 {n}개는 새 버전에서 모두 볼 수 있어요', // REVIEW(ko) FA-2 只读行新加
  'ro.update': '업데이트', // REVIEW(ko) FA-2 只读行新加
  'ro.named': '{label}, 새 버전으로 업데이트해야 수정할 수 있어요', // REVIEW(ko) FA-2 审查第 2、5 条：读屏名字后接 ro.markLabel（11-06 从 ko.ts 挪来）
} as const satisfies Record<RoMsgKey, string>;
