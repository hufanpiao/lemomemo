// 选中的吉祥物：按账号存在 settings 的 ui.mascot（值 {v: 1, id}，同 ui.font）
// • 普通账号：没选过、认不出、存着 #2 的都按默认 Aldo
// • 管理员（useMascotAdmin）：没手动选过别的就是 #2（负责人 11-26“我默认是二号，其他人是aldo”）
// • 管理员身份还没读到时调用方先不挂（MascotHost、MascotSettings），不会先出 Aldo 再换
import type { Row } from '../../../core/store.ts';
// 生效值（没删、没撤销）用 platform/look.ts 的 liveSetting：不引 core/setting-read，那份在 lazy-data 块，这个块本来不依赖它
import { liveSetting } from '../../../platform/look.ts';
import { DEFAULT_MASCOT, MASCOT_IDS, PRIVATE_ID, type MascotChoice, type MascotId } from './catalog.ts';

export const MASCOT_KEY = 'ui.mascot';

export interface MascotRow extends Row {
  readonly key?: unknown;
  readonly value?: unknown;
  readonly deleted_at?: unknown;
  readonly undone?: unknown;
}

export const mascotValue = (id: MascotChoice): { v: 1; id: MascotChoice } => ({ v: 1, id });

/** 手动选过的；没选过、认不出的是 null */
export function pickedMascot(rows: readonly MascotRow[]): MascotChoice | null {
  const v = liveSetting(rows, MASCOT_KEY);
  const id = v !== null && typeof v === 'object' ? (v as { id?: unknown }).id : undefined;
  if (id === PRIVATE_ID) return PRIVATE_ID;
  return (MASCOT_IDS as readonly unknown[]).includes(id) ? (id as MascotId) : null;
}

export function mascotOfRows(rows: readonly MascotRow[], admin = false): MascotChoice {
  const picked = pickedMascot(rows);
  if (admin) return picked ?? PRIVATE_ID;
  return picked === null || picked === PRIVATE_ID ? DEFAULT_MASCOT : picked;
}
