// i18n-exempt: 解析词表
// “＋”取消、改期、完成里说的泛指词（任务、할 일……）：词表只在这里定义，resolve-target、match-target 共用（架构 5.14 第 7 点）。
// 不变量：只有 specificWords 一个判定口径，isGenericText 就是“取完关键词什么都不剩”；词先按 search.ts 归一，
// 再去掉“的 / 这些 / 那些”、韩文助词（search.ts 的 termVariants，去完至少剩 1 个字）和末尾的“들”；带空格的泛指词（할 일）连着两段一起认。
import { normalizeForSearch, queryTerms, termVariants } from '../search.ts';

export const GENERIC_WORDS: readonly string[] = Object.freeze([
  '任务', '待办', '待办事项', '事情', '事', '业务', '工作', '活', '할 일', '일', '업무', '작업', '것', '거',
]);
/** 归一后的泛指词（search.ts 的归一会去掉空格：“할 일”→“할일”） */
const GENERIC = new Set(GENERIC_WORDS.map(normalizeForSearch));
/** 词表里带空格的泛指词最多几段 */
const MAX_PARTS = Math.max(...GENERIC_WORDS.map((w) => queryTerms(w).length));
/** 中文粘在具体词后面的泛指词尾巴（两个字以上的，长的先试）：“采购任务”→“采购” */
const TAILS = [...GENERIC].filter((g) => [...g].length >= 2).sort((a, b) => b.length - a.length);
const ZH_FILLER = /这些|那些|的/g;
/** 去掉泛指词尾巴后前面至少还要剩几个字（“找工作”不动） */
const TAIL_KEEP_MIN = 2;

/** 已归一的一个词是不是泛指词 */
function isGenericWord(word: string): boolean {
  const cur = word.replace(ZH_FILLER, '');
  if (cur === '') return true;
  return termVariants(cur, 1).some((f) => GENERIC.has(f) || (f.endsWith('들') && GENERIC.has(f.slice(0, -1))));
}

/** 取关键词：泛指词（含连着几段组成的“할 일”）丢掉，中文粘着的泛指词尾巴去掉；结果用空格连起来给 matchScore */
export function specificWords(text: string): string {
  const terms = queryTerms(text);
  const out: string[] = [];
  for (let i = 0; i < terms.length; ) {
    let k = Math.min(MAX_PARTS, terms.length - i);
    while (k > 1 && !isGenericWord(terms.slice(i, i + k).join(''))) k--;
    const t = terms[i] ?? '';
    i += k;
    if (k > 1 || isGenericWord(t)) continue;
    const tail = TAILS.find((g) => t.endsWith(g) && [...t].length - [...g].length >= TAIL_KEEP_MIN);
    out.push(tail === undefined ? t : t.slice(0, t.length - tail.length));
  }
  return out.join(' ');
}

/** 整段话是不是只说了泛指词（空串、只有空白标点也算） */
export function isGenericText(text: string): boolean {
  return specificWords(text) === '';
}
