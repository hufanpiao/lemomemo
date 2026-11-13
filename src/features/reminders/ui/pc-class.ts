// 项目色类名（架构 5.12 第 2 点；和列表、月历同一个 projectColorIndex）：Remind.module.css 的 .pc0～.pc6 设 --pc
import { projectColorIndex } from '../../../../shared/logic/project-color.ts';
import styles from './Remind.module.css';

export function pcClass(project: string): string {
  return styles[`pc${projectColorIndex(project)}`] ?? '';
}

const MARK = { event: ['mkEv', 'mkEvSm'], todo: ['mkTd', 'mkTdSm'] } as const;

/** 类型记号的类名（日程竖条、待办空心圆；纪念日不用记号，画圆形头像，见 KindMark.tsx）；sm = 小号 */
export function markClass(kind: 'event' | 'todo', sm = false): string {
  return styles[MARK[kind][sm ? 1 : 0]] ?? '';
}
