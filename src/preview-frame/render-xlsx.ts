// Excel（.xlsx）预览（架构 5.13 第 3 点：SheetJS 只读，显示缓存的计算结果，不重新计算、不连外部链接；每张表最多 2000 行 × 50 列）。
// • SheetJS 用官方 tarball（cdn.sheetjs.com，package-lock 里锁 integrity）；只读值：cellFormula、cellHTML、cellStyles 都关掉
// • 表格用 DOM 一格一格写 textContent，不用 sheet_to_html（不把单元格内容当 HTML）
// • 超过 2000 行 × 50 列只显示前面部分，state 里 clipped = true，App 那边写“只显示前面部分，完整内容请下载”
import { read, utils, type WorkBook } from 'xlsx';
import type { Post, View } from './main.ts';

export const MAX_ROWS = 2000;
export const MAX_COLS = 50;

export async function render(root: HTMLElement, bytes: ArrayBuffer, post: Post): Promise<View> {
  const wb: WorkBook = read(new Uint8Array(bytes), { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false, cellNF: false, sheetStubs: false, bookVBA: false, WTF: false });
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
    const ref = ws['!ref'];
    const full = ref ? utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
    const rows = Math.min(full.e.r - full.s.r + 1, MAX_ROWS);
    const cols = Math.min(full.e.c - full.s.c + 1, MAX_COLS);
    clipped = full.e.r - full.s.r + 1 > MAX_ROWS || full.e.c - full.s.c + 1 > MAX_COLS;
    const t = document.createElement('table');
    const head = t.createTHead().insertRow();
    head.append(document.createElement('th'));
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th');
      th.textContent = utils.encode_col(full.s.c + c);
      head.append(th);
    }
    const body = t.createTBody();
    for (let r = 0; r < rows; r++) {
      const tr = body.insertRow();
      const th = document.createElement('th');
      th.textContent = String(full.s.r + r + 1);
      tr.append(th);
      for (let c = 0; c < cols; c++) {
        const cell = ws[utils.encode_cell({ r: full.s.r + r, c: full.s.c + c })] as { w?: string; v?: unknown } | undefined;
        tr.insertCell().textContent = cell ? (cell.w ?? (cell.v === undefined ? '' : String(cell.v))) : '';
      }
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
