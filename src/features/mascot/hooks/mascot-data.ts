// 界面层读吉祥物目录、署名和设置值的入口（分层规则：ui 不直接读 data）
import { MASCOTS, PRIVATE_ID, type MascotChoice, type MascotDef } from '../data/catalog.ts';
import { PRIVATE_DEF } from '../data/mascot-private.ts';

export { DEFAULT_MASCOT, MASCOTS, MASCOT_IDS, PEEK, PRIVATE_ID } from '../data/catalog.ts';
export type { MascotChoice, MascotDef, MascotId } from '../data/catalog.ts';
export { CC_BY_URL, CREDITS, RIVE_RUNTIME, WEATHER_DATA } from '../data/credits-data.ts';
export { PRIVATE_DEF } from '../data/mascot-private.ts';
export { MASCOT_KEY, mascotOfRows, mascotValue, pickedMascot } from '../data/mascot-setting.ts';
export type { MascotRow } from '../data/mascot-setting.ts';

/** 一只的显示参数：#2 在私有模块，其余在目录 */
export const defOf = (id: MascotChoice): MascotDef => (id === PRIVATE_ID ? PRIVATE_DEF : MASCOTS[id]);
