// 10 种附件怎么显示、怎么预览（架构 5.13 第 1 点的格式表、第 3 点；架构约定 9.7“旧格式和带宏的只存不预览”）
// 纯 TS：不准 import React（A1）
import type { DocKind } from '../../../../shared/manifests/attachments.ts';

/** 预览方式：本机三种（在预览沙箱里）、ms 交给微软在线预览；null 只存不预览（带宏的、旧格式） */
export type PreviewWay = 'pdf' | 'docx' | 'xlsx' | 'ms' | null;

const WAY: Record<DocKind, PreviewWay> = { pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'ms', docm: null, xlsm: null, pptm: null, doc: null, xls: null, ppt: null };

export const previewOf = (k: DocKind): PreviewWay => WAY[k];

/** 只存不预览的两类（文案不同：“可能含宏” / “旧格式不能预览”） */
export const isMacro = (k: DocKind): boolean => k === 'docm' || k === 'xlsm' || k === 'pptm';

/** 列表上的类型标记（线框 ATT：PDF / W / X / P） */
export function markOf(k: DocKind): 'PDF' | 'W' | 'X' | 'P' {
  if (k === 'pdf') return 'PDF';
  if (k.startsWith('doc')) return 'W';
  if (k.startsWith('xls')) return 'X';
  return 'P';
}

/** 大小后面跟什么数：PDF、PPT 写页数，Excel 写表数（线框 sAtt），别的不写 */
export function countOf(k: DocKind): 'pages' | 'sheets' | null {
  if (k === 'pdf' || k === 'pptx') return 'pages';
  if (k === 'xlsx') return 'sheets';
  return null;
}

/** 字节数 → “1.2 MB”“86 KB”（线框写法；< 1 KB 也写 1 KB） */
export function sizeText(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
