// tests/build/ts-scan.ts 的底层扫描原语（scan、括号配对、顶层逗号切分、字面量、语句末尾），从 ts-scan.ts 拆出免超 max-lines；
// ts-scan.ts 引这些、原样转出 scan、matchClose 和 Scanned（调用方照旧从 ts-scan.ts 引）。不 import typescript，理由同 ts-scan.ts 头注释。

export type Scanned = { text: string; skel: string };

/** 这些词后面的 / 是正则开头（其余词、) ] } 和后置 ++ -- 后面是除号；if (…) 这类控制语句的条件括号之后例外，见 CONTROL_PAREN） */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'case', 'of', 'in', 'else', 'await', 'yield', 'void', 'throw', 'new', 'delete', 'do']);
/** 这些词后面的 ( … ) 是控制语句的条件：闭括号之后开始的是语句，/ 是正则开头（if (x) /re/.test(s)；FN-cov-gaps，10-30） */
const CONTROL_PAREN = new Set(['if', 'while', 'for', 'with']);

/** text：注释换成空格；skel：再把字符串、模板字面部分、正则字面量的内容换成空格（引号留着），用来找括号、调用 */
export function scan(code: string): Scanned {
  const text = code.split(''), skel = code.split('');
  const n = code.length;
  const blank = (arr: string[], from: number, to: number) => { for (let k = from; k < Math.min(to, n); k++) if (arr[k] !== '\n') arr[k] = ' '; };
  let prev = '', prevWord = '';
  /** prevWord 前一个非空白字符是不是 .（含 ?.、中间隔空白换行注释）：obj.for(k)、Symbol.for(k) 是方法调用不是控制语句（TSSCAN-sugg） */
  let wordAfterDot = false;
  /** 每层 ( 是不是控制语句的条件括号（一直配对到它的 )） */
  const parens: boolean[] = [];
  const regexOk = () => prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || REGEX_AFTER_WORD.has(prevWord);

  function template(start: number): number {
    let j = start + 1, lit = j;
    while (j < n && code[j] !== '`') {
      if (code[j] === '\\') { j += 2; continue; }
      if (code[j] === '$' && code[j + 1] === '{') {
        blank(skel, lit, j);
        prev = '{'; prevWord = '';
        j = run(j + 2, true);
        lit = j;
        continue;
      }
      j++;
    }
    blank(skel, lit, j);
    return j + 1;
  }

  /** 扫代码；inExpr（模板的 ${…}）时遇到本层的 } 返回它后面的下标 */
  function run(start: number, inExpr: boolean): number {
    let i = start, depth = 0;
    while (i < n) {
      const c = code[i] ?? '';
      const d = code[i + 1] ?? '';
      if (c === '/' && (d === '/' || d === '*')) {
        const cl = d === '/' ? code.indexOf('\n', i) : code.indexOf('*/', i + 2);
        const end = cl < 0 ? n : d === '/' ? cl : cl + 2;
        blank(text, i, end); blank(skel, i, end); i = end; continue;
      }
      if (c === '\'' || c === '"') {
        let j = i + 1;
        while (j < n && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
        blank(skel, i + 1, j); i = j + 1; prev = c; prevWord = ''; continue;
      }
      if (c === '`') { i = template(i); prev = '`'; prevWord = ''; continue; }
      if (c === '/' && regexOk()) {
        let j = i + 1, cls = false;
        while (j < n && code[j] !== '\n' && (cls || code[j] !== '/')) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code[j] === '[') cls = true; else if (code[j] === ']') cls = false;
          j++;
        }
        blank(skel, i + 1, j); i = j + 1; prev = ')'; prevWord = ''; continue;
      }
      if (/[\w$]/.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(code[j] ?? '')) j++;
        wordAfterDot = prev === '.'; prevWord = code.slice(i, j); prev = 'a'; i = j; continue;
      }
      if ((c === '+' || c === '-') && d === c) { prev = ')'; prevWord = ''; i += 2; continue; }
      if (c === '(') parens.push(prev === 'a' && !wordAfterDot && CONTROL_PAREN.has(prevWord));
      // 控制语句条件的 ) 之后当语句开头（prev 设成 ;），别的 ) 之后照旧是除号
      if (c === ')' && parens.pop() === true) { prev = ';'; prevWord = ''; i++; continue; }
      if (inExpr && c === '{') depth++;
      if (inExpr && c === '}') { if (depth === 0) return i + 1; depth--; }
      if (!/\s/.test(c)) { prev = c; prevWord = ''; }
      i++;
    }
    return n;
  }

  run(0, false);
  return { text: text.join(''), skel: skel.join('') };
}

/** skel 里 open 处的 ( [ { 对应的闭括号下标；找不到回 -1 */
export function matchClose(skel: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let k = open; k < skel.length; k++) {
    const ch = skel[k] ?? '';
    if (ch in pairs) stack.push(pairs[ch] ?? '');
    else if (ch === ')' || ch === ']' || ch === '}') { if (stack.pop() !== ch) return -1; if (stack.length === 0) return k; }
  }
  return -1;
}

/** 括号 open..close 之间按顶层逗号切开：[起, 止) 列表 */
export function splitTop(skel: string, open: number, close: number): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0, from = open + 1;
  for (let k = open + 1; k < close; k++) {
    const ch = skel[k];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { out.push([from, k]); from = k + 1; }
  }
  if (skel.slice(from, close).trim() !== '') out.push([from, close]);
  return out;
}

export const firstNonSpace = (s: string, at: number) => { let k = at; while (/\s/.test(s[k] ?? '')) k++; return k; };

/** 字符串字面量的内容（skel 里引号之间是空格，闭引号就是下一个同样的引号） */
export function literalAt(sc: Scanned, at: number): string | null {
  const q = sc.skel[at] ?? '', close = sc.skel.indexOf(q, at + 1);
  return (q !== '\'' && q !== '"' && q !== '`') || close < 0 ? null : sc.text.slice(at + 1, close);
}

/** 从 at 起到语句末尾：同层的 ; 或换行、或本层闭括号之前（不写分号的代码按换行断开） */
export function stmtEnd(skel: string, at: number): number {
  let depth = 0, k = at;
  for (; k < skel.length; k++) {
    const ch = skel[k] ?? '';
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; } else if (depth === 0 && (ch === ';' || ch === '\n')) break;
  }
  return k;
}
