// i18n-exempt: 解析词表
// 随手记的本机规则分类（B4 任务单 S5；架构 5.2 第 2839、2843 行、2.3 目录 shared/logic/notes/）。
// 两处用：① 前端 A 保存随手记时先算一次，写 category_source = 'rule'（不写 ai_status：系统列，客户端无权写，库默认 pending，等 ai-classify）；
//        ② ai-classify 遇到没同意、关了 AI、额度用完、出错的，只用这里的结果，写 ai_status = 'rule'，一条都不送 AI。
// 只从用户已有的分类里选，**不新建分类**（新建只有 AI 能提议，5.2）；选不出就返回 null，调用方保持 category_source = 'none'。
// 规则（先到先得）：
//   ① 分类名出现在标题、正文或标签里：名字最长的那个；一样长的按 sort、再按名字。
//      • 名字全是拉丁字母和数字的（“AI”“UX”“Side Project”）按词边界比：前后不能紧挨着字母或数字，“AI”不命中“email”；
//      • 其余按 search.ts 的中韩归一比子串；
//      • 归一后只有 1 个字的分类名不参加这一步（“书”“일”会误中太多），只在标题整个就是这个字时才算。
//   ② 常见类别词表：用户有一个分类叫词表里的某个名字（例如“购物”“쇼핑”），而文字里有这一类的词（“超市”“마트”），就归到它；
//      命中词最多的那一类优先，一样多按词表顺序。词表里没有单字词（“买”“课”“약”“책”误中太多，代码审查 11-10 第 1 条）。
//      • 中文词按归一后的子串比（中文不分词）；
//      • 韩文词按词比：文字先按空白和标点分词、去掉末尾助词（search.ts 的 termVariants），再和词整词比，
//        “러닝”不命中“머신러닝”；stems 里的词干（“맛있”“떠올”）只要求在词的开头。
//   ③ 都不中：null。
// 纯函数：不碰 DOM、不联网，前端和 Edge Functions 共用（Deno 经 _shared/gen/）。
import { isLiveCategory, type CategoryRow } from '../live-row.ts';
import { normalizeForSearch, termVariants } from '../search.ts';

export interface RuleNote {
  title?: string | null;
  body?: string | null;
  tags?: readonly string[] | null;
}

export interface RuleResult {
  category_id: string | null;
  /** 怎么选出来的：name（分类名出现在文字里）、lexicon（常见类别词表）；没选出为 null */
  by: 'name' | 'lexicon' | null;
}

/**
 * 常见类别：names 是用户可能起的分类名，words 是这一类常见的词（至少 2 个字），
 * stems 是韩文词干（只要求出现在词的开头，如“맛있다”“맛있는”）。只是起步的一份，按真实使用再补。
 */
export const LEXICON: readonly { names: readonly string[]; words: readonly string[]; stems?: readonly string[] }[] = Object.freeze([
  { names: ['工作', '公司', '업무', '회사', '일'], words: ['会议', '开会', '客户', '报告', '方案', '项目', '加班', '同事', '회의', '거래처', '보고서', '기획', '출장', '야근'] },
  { names: ['学习', '读书', '공부', '독서'], words: ['上课', '课程', '笔记', '考试', '复习', '单词', '教程', '读书', '강의', '수업', '시험', '복습', '단어', '교재'] },
  { names: ['购物', '买东西', '购物清单', '쇼핑', '장보기'], words: ['购买', '超市', '下单', '淘宝', '京东', '快递', '구매', '마트', '주문', '쿠팡', '택배', '장보기'] },
  { names: ['健康', '运动', '건강', '운동'], words: ['医院', '吃药', '体检', '跑步', '健身', '睡眠', '병원', '약국', '검진', '헬스', '러닝', '수면'] },
  { names: ['理财', '记账', '钱', '돈', '가계부', '재테크'], words: ['工资', '账单', '还款', '存钱', '基金', '花了', '월급', '카드값', '대출', '적금', '저축', '이체'] },
  { names: ['旅行', '出行', '여행'], words: ['机票', '酒店', '行程', '签证', '护照', '景点', '항공권', '호텔', '숙소', '일정표', '여권', '비자'] },
  { names: ['美食', '吃的', '菜谱', '맛집', '음식', '요리'], words: ['餐厅', '好吃', '菜谱', '做饭', '外卖', '咖啡', '식당', '레시피', '배달', '카페'], stems: ['맛있'] },
  { names: ['想法', '灵感', '点子', '아이디어', '생각'], words: ['想到', '灵感', '点子', '如果能', '아이디어'], stems: ['생각났', '떠올'] },
]);

const HANGUL = /\p{Script=Hangul}/u;
const LATIN_NUM = /^[\p{Script=Latin}\p{N}]+$/u;
/** 分词用：空白和标点（和 search.ts 的 queryTerms 一样） */
const SPLIT = /[\s\p{P}\p{Z}]+/u;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 文字分成词（归一），每个词再加上去掉助词的写法 */
function koWords(raw: string): Set<string> {
  const out = new Set<string>();
  for (const t of raw.normalize('NFKC').split(SPLIT)) {
    const n = normalizeForSearch(t);
    if (n !== '') for (const v of termVariants(n)) out.add(v);
  }
  return out;
}

/** 拉丁字母和数字的分类名按词边界比；名字里的空格、标点当作可有可无 */
function latinHit(rawLower: string, name: string): boolean {
  const parts = name.normalize('NFKC').toLowerCase().split(SPLIT).filter((x) => x !== '').map(escapeRe);
  if (parts.length === 0) return false;
  const re = new RegExp(`(?<![\\p{Script=Latin}\\p{N}])${parts.join('[\\s\\p{P}\\p{Z}]*')}(?![\\p{Script=Latin}\\p{N}])`, 'u');
  return re.test(rawLower);
}

/** 按规则给一条随手记选分类；categories 是这个用户的全部分类（删掉的、撤销的、合并掉的自动跳过） */
export function classifyByRules(note: RuleNote, categories: readonly CategoryRow[]): RuleResult {
  const title = normalizeForSearch(note.title ?? '');
  const raws = [note.title ?? '', note.body ?? '', ...(note.tags ?? [])];
  const text = raws.map(normalizeForSearch).filter((s) => s !== '').join('\n');
  if (text === '') return { category_id: null, by: null };
  const rawLower = raws.join('\n').normalize('NFKC').toLowerCase();
  const cats = categories.filter(isLiveCategory).map((c) => ({ c, n: normalizeForSearch(c.name) })).filter((x) => x.n !== '');

  // ① 分类名出现在文字里
  const nameHit = ({ c, n }: { c: CategoryRow; n: string }): boolean => {
    if ([...n].length < 2) return title === n;
    return LATIN_NUM.test(n) ? latinHit(rawLower, c.name) : text.includes(n);
  };
  const byName = cats
    .filter(nameHit)
    .sort((a, b) => [...b.n].length - [...a.n].length || (a.c.sort ?? 0) - (b.c.sort ?? 0) || (a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : 0));
  if (byName[0]) return { category_id: byName[0].c.id, by: 'name' };

  // ② 常见类别词表
  let words: Set<string> | null = null;
  const koHas = (w: string, stem: boolean): boolean => {
    words ??= koWords(raws.join('\n'));
    if (!stem) return words.has(w);
    for (const x of words) if (x.startsWith(w)) return true;
    return false;
  };
  let best: { id: string; hits: number } | null = null;
  for (const g of LEXICON) {
    const names = new Set(g.names.map(normalizeForSearch));
    const owner = cats.find(({ n }) => names.has(n));
    if (!owner) continue;
    let hits = 0;
    for (const w of g.words) {
      const n = normalizeForSearch(w);
      if (HANGUL.test(n) ? koHas(n, false) : text.includes(n)) hits++;
    }
    for (const w of g.stems ?? []) if (koHas(normalizeForSearch(w), true)) hits++;
    if (hits > 0 && (best === null || hits > best.hits)) best = { id: owner.c.id, hits };
  }
  if (best) return { category_id: best.id, by: 'lexicon' };
  return { category_id: null, by: null };
}
