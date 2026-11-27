// 吉祥物舞台的入口：动画在 motion/mascot-stage.ts，下载在 platform/rive-load.ts（#2 走私有桶），这里接到一起
import { createStage as createMascotStage, type MoodFlag as MascotFlag, type ReactKind as MascotReact, type Stage as MascotStage, type StageCallbacks } from '../../../motion/mascot-stage.ts';
import { loadRiv, loadRive, loadStill } from '../../../platform/rive-load.ts';
import type { MascotDef } from '../data/catalog.ts';
import { downloadPrivateRiv, PRIVATE_URL } from '../data/mascot-private.ts';

export type ReactKind = MascotReact;
export type MoodFlag = MascotFlag;
export type Stage = MascotStage;

export const createStage = (el: HTMLElement, def: MascotDef, cb: StageCallbacks = {}): Stage =>
  createMascotStage(el, def, cb, { rive: loadRive, riv: (url) => (url === PRIVATE_URL ? downloadPrivateRiv() : loadRiv(url)), still: loadStill });
