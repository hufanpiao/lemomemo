// 写入结果 → 界面要的一个码，只在这里换（架构 10.1；原来列表页、最近删除、提醒各写一份）。纯 TS，只认 edit-save 的结果类型
// readonly 出只读提示；silent 不提示（switching：页面马上跳走）；其余没写进去的都算 failed
import type { SaveOutcome } from './edit-save.ts';

export type ActionResult = 'ok' | 'failed' | 'readonly' | 'silent';

export const actionResult = (r: SaveOutcome): ActionResult => (r === 'saved' ? 'ok' : r === 'readonly' ? 'readonly' : r === 'switching' ? 'silent' : 'failed');
