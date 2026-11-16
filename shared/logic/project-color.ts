// 项目色（架构 5.12 第 2 点：1–6 按项目名稳定分配，和列表里一致；没有项目用中性色 --mark-none，记为 0；R-440 起 AI 的 6 个固定类别查表、一类一色）
// 月历、周视图、列表页一律调这一个函数，颜色才对得上；读屏按项目汇总时也用同一个 normalizeProject 规整名字。
// 纯函数，前端和 Edge Functions 共用。
import { PROJECT_CATEGORIES } from './project-categories-data.ts';

/** AI 的固定类别（只写在 project-categories-data.ts；提示词、测试集 ① 判分经这里引用） */
export { PROJECT_CATEGORIES };

/** 项目色有几种（1–6）；0 是没有项目的中性色 */
export const PROJECT_COLORS = 6;

/** 项目色序号：0 = 没有项目（--mark-none），1–6 = 六种项目色 */
export type ProjectColor = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** 项目名规整：NFC、去掉首尾空白。分色和读屏汇总都按规整后的名字（“ NEOX”和“NEOX”算同一个项目） */
export function normalizeProject(project: string): string {
  return project.normalize('NFC').trim();
}

/** 固定类别（规整后）→ 颜色序号；其余名字走散列 */
const FIXED_COLORS: ReadonlyMap<string, ProjectColor> = new Map(
  [PROJECT_CATEGORIES.zh, PROJECT_CATEGORIES.ko].flatMap((l) => l.map((n, i) => [normalizeProject(n), (i + 1) as ProjectColor] as const)),
);

/** 项目名 → 颜色序号。固定类别查表（FIXED_COLORS）；别的名字用 FNV-1a 32 位散列规整后的名字，同一个名字在哪台设备、哪个页面都是同一个色 */
export function projectColorIndex(project: string): ProjectColor {
  const name = normalizeProject(project);
  if (name === '') return 0;
  const fixed = FIXED_COLORS.get(name);
  if (fixed !== undefined) return fixed;
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ((h % PROJECT_COLORS) + 1) as ProjectColor;
}
