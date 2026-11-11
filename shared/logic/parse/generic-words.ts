// i18n-exempt: 解析词表
// “＋”取消、改期、完成里说的泛指词（任务、할 일……）：词表只在这里定义，resolve-target、match-target 共用（架构 5.14 第 7 点）。
// 不变量：先按 search.ts 归一，再去掉“的 / 这些 / 那些”、一层韩文助词（search-data.ts 的词表）和末尾的“들”，整段等于词表之一才算泛指。
import { KO_TRAILING_PARTICLES } from '../search-data.ts';
import { normalizeForSearch, queryTerms } from '../search.ts';

export const GENERIC_WORDS: readonly string[] = Object.freeze([
  '任务', '待办', '待办事项', '事情', '事', '业务', '工作', '活', '할 일', '일', '업무', '작업', '것', '거',
]);
const GENERIC = new Set(GENERIC_WORDS.map(normalizeForSearch));
/** 中文粘在具体词后面的泛指词尾巴（两个字以上的，长的先试）：“采购任务”→“采购” */
const TAILS = [...GENERIC].filter((g) => [...g].length >= 2).sort((a, b) => b.length - a.length);
const ZH_FILLER = /这些|那些|的/g;
/** 去掉泛指词尾巴后前面至少还要剩几个字（“找工作”不动） */
const TAIL_KEEP_MIN = 2;

/** 已归一的一个词是不是泛指词 */
function isGenericWord(word: string): boolean {
  const cur = word.replace(ZH_FILLER, '');
  if (cur === '') return true;
  const forms = [cur];
  const p = KO_TRAILING_PARTICLES.find((x) => cur.endsWith(x) && cur.length > x.length);
  if (p !== undefined) forms.push(cur.slice(0, cur.length - p.length));
  return forms.some((f) => GENERIC.has(f) || (f.endsWith('들') && GENERIC.has(f.slice(0, -1))));
}

/** 整段话是不是只说了泛指词（空串、只有空白标点也算） */
export function isGenericText(text: string): boolean {
  return isGenericWord(normalizeForSearch(text));
}

/** 取关键词：整词是泛指词的丢掉，中文粘着的泛指词尾巴去掉；结果用空格连起来给 matchScore */
export function specificWords(text: string): string {
  const out: string[] = [];
  for (const t of queryTerms(text)) {
    if (isGenericWord(t)) continue;
    const tail = TAILS.find((g) => t.endsWith(g) && [...t].length - [...g].length >= TAIL_KEEP_MIN);
    out.push(tail === undefined ? t : t.slice(0, t.length - tail.length));
  }
  return out.join(' ');
}
