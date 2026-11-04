// 项目色类名（架构 5.12 第 2 点；和列表、月历同一个 projectColorIndex）：Remind.module.css 的 .pc0～.pc6 设 --pc
import { projectColorIndex } from '../../../../shared/logic/project-color.ts';
import styles from './Remind.module.css';

export function pcClass(project: string): string {
  return styles[`pc${projectColorIndex(project)}`] ?? '';
}
