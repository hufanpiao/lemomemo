// 现在该放哪只：今天页（MascotHost）和设置页（MascotSettings）共用一处判断
// • 手动选了公开角色：不用等管理员身份，直接是它
// • 没手动选过、或选的是 #2：要等管理员身份（最多 ADMIN_WAIT_MS，之后没答按普通账号），免得先下一只再换
import { mascotOfRows, pickedMascot, PRIVATE_ID, type MascotChoice, type MascotRow } from './mascot-data.ts';
import { useMascotAdmin } from './useMascotAdmin.ts';

export interface MascotChoiceState {
  /** null = 还不知道放哪只（在等管理员身份） */
  id: MascotChoice | null;
  /** 管理员身份：null = 还在等 */
  admin: boolean | null;
}

/** list = true：要列出可选的角色（设置页），不管选了哪只都要问管理员身份（决定列表里有没有 #2） */
export function useMascotChoice(rows: readonly MascotRow[], list = false): MascotChoiceState {
  const picked = pickedMascot(rows);
  const need = list || picked === null || picked === PRIVATE_ID;
  const admin = useMascotAdmin(need);
  const known = admin !== null || (picked !== null && picked !== PRIVATE_ID);
  return { id: known ? mascotOfRows(rows, admin === true) : null, admin };
}
