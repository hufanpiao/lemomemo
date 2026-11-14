// Excel（.xlsx）预览（架构 5.13 第 3 点：SheetJS 只读，显示缓存的计算结果，不重新计算、不连外部链接；每张表最多 2000 行 × 50 列）。
// • SheetJS 用官方 tarball（cdn.sheetjs.com，package-lock 里锁 integrity）；只读值：cellFormula、cellHTML、cellStyles 都关掉
// • 表格用 DOM 一格一格写 textContent，不用 sheet_to_html（不把单元格内容当 HTML）
// • 超过 2000 行 × 50 列只显示前面部分，state 里 clipped = true，App 那边写“只显示前面部分，完整内容请下载”
// • prep：pages 是工作表数；纯文本是各表（表名一行，之后每行单元格的显示值用 Tab 隔开），同样只读前 2000 行 × 50 列，满 20000 字就停；没有缩略图
import { read, utils, type WorkBook, type WorkSheet } from 'xlsx';
import type { Post, View } from './main.ts';
import { TextSink, type Prep } from './prep-kit.ts';

export const MAX_ROWS = 2000;
export const MAX_COLS = 50;

const open = (bytes: ArrayBuffer): WorkBook =>
  read(new Uint8Array(bytes), { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false, cellNF: false, sheetStubs: false, bookVBA: false, WTF: false });

/** 一张表要显示的范围（前 MAX_ROWS 行 × MAX_COLS 列）和是否截掉了 */
function area(ws: WorkSheet): { r0: number; c0: number; rows: number; cols: number; clipped: boolean } {
  const ref = ws['!ref'];
  const full = ref ? utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
  const allRows = full.e.r - full.s.r + 1;
  const allCols = full.e.c - full.s.c + 1;
  return { r0: full.s.r, c0: full.s.c, rows: Math.min(allRows, MAX_ROWS), cols: Math.min(allCols, MAX_COLS), clipped: allRows > MAX_ROWS || allCols > MAX_COLS };
}

/** 单元格的显示值（缓存的格式化结果 w，没有就原值） */
function cellText(ws: WorkSheet, r: number, c: number): string {
  const cell = ws[utils.encode_cell({ r, c })] as { w?: string; v?: unknown } | undefined;
  return cell ? (cell.w ?? (cell.v === undefined ? '' : String(cell.v))) : '';
}

export async function render(root: HTMLElement, bytes: ArrayBuffer, post: Post): Promise<View> {
  const wb = open(bytes);
  const names = wb.SheetNames.map((n) => n.slice(0, 64));
  const box = document.createElement('div');
  box.className = 'pv-sheet';
  root.append(box);
  let sheet = 0;
  let zoom = 100;
  let clipped = false;

  function show(i: number): void {
    const ws = wb.Sheets[wb.SheetNames[i] ?? ''];
    box.replaceChildren();
    clipped = false;
    if (!ws) return;
    const a = area(ws);
    clipped = a.clipped;
    const t = document.createElement('table');
    const head = t.createTHead().insertRow();
    head.append(document.createElement('th'));
    for (let c = 0; c < a.cols; c++) {
      const th = document.createElement('th');
      th.textContent = utils.encode_col(a.c0 + c);
      head.append(th);
    }
    const body = t.createTBody();
    for (let r = 0; r < a.rows; r++) {
      const tr = body.insertRow();
      const th = document.createElement('th');
      th.textContent = String(a.r0 + r + 1);
      tr.append(th);
      for (let c = 0; c < a.cols; c++) tr.insertCell().textContent = cellText(ws, a.r0 + r, a.c0 + c);
    }
    box.append(t);
  }
  const state = (): void => post({ t: 'state', page: 1, pages: 1, zoom, sheets: names, sheet, clipped });
  show(0);
  state();
  return {
    page() {},
    zoom(z) {
      zoom = z;
      box.style.zoom = String(z / 100);
      state();
    },
    sheet(i) {
      if (i < 0 || i >= names.length) return;
      sheet = i;
      show(i);
      state();
    },
  };
}

/** 预览材料：工作表数、各表单元格显示值的纯文本，没有缩略图 */
export async function prep(bytes: ArrayBuffer): Promise<Prep> {
  const wb = open(bytes);
  const sink = new TextSink();
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    if (!sink.add(name)) break;
    const a = area(ws);
    let full = false;
    for (let r = 0; r < a.rows && !full; r++) {
      const cells: string[] = [];
      for (let c = 0; c < a.cols; c++) cells.push(cellText(ws, a.r0 + r, a.c0 + c));
      full = !sink.add(cells.join('\t'));
    }
    if (full) break;
  }
  return { pages: wb.SheetNames.length, text: sink.text, thumb: null };
}
