// 这次打开 App 的吉祥物状态（只在内存，不落盘）：MascotHost、useMascotAdmin 的模块级状态收在这一个对象里
// • landed：已经降落过（只有第一次加载才降落，回今天页、换角色直接出现）
// • kept：留着的舞台（进二级页再回来时吉祥物一直在；换了角色才销毁；#2 的文件照旧不进任何缓存）
// • admin：管理员身份这次打开问到哪了（hooks/useMascotAdmin.ts）
import type { MascotChoice } from '../data/catalog.ts';
import type { Stage } from './stage.ts';

export interface AdminState {
  /** 服务器这次打开里最后一次答的；null = 还没答过 */
  answer: boolean | null;
  /** 第一次问已经等过 ADMIN_WAIT_MS */
  waited: boolean;
  asking: boolean;
  tries: number;
  waitT: ReturnType<typeof setTimeout> | undefined;
  retryT: ReturnType<typeof setTimeout> | undefined;
}

export interface MascotSession {
  landed: boolean;
  kept: { id: MascotChoice; anchor: HTMLDivElement; rv: HTMLDivElement; stage: Stage } | null;
  admin: AdminState;
}

const fresh = (): MascotSession => ({
  landed: false,
  kept: null,
  admin: { answer: null, waited: false, asking: false, tries: 0, waitT: undefined, retryT: undefined },
});

export const mascotSession: MascotSession = fresh();

/** 测试用：回到刚打开 App（留着的舞台一并销毁；admin 换成新对象，还在路上的回答认不出就丢掉） */
export function resetMascotSession(): void {
  clearTimeout(mascotSession.admin.waitT);
  clearTimeout(mascotSession.admin.retryT);
  mascotSession.kept?.stage.destroy();
  Object.assign(mascotSession, fresh());
}
