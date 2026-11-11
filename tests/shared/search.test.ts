// shared/logic/search.ts（TC-B4-04；B4 任务单 S4、硬约束 2；架构 1.3 B4 行、0.29 续第 163 条“中韩归一”）
// 中韩关键词、空格和标点、大小写、全角、已删除的不出；韩文助词去掉再找；排序；match-target 用的 matchScore。
// 零宽字符写成转义（LINT-bidi 不准原样出现）
import { describe, expect, it } from 'vitest';
import { matchScore, MAX_TERMS, normalizeForSearch, queryTerms, searchItems, termVariants } from '../../shared/logic/search.ts';

interface N { id: string; title: string | null; body: string | null; tags?: string[]; deleted_at?: number | null }
const notes: N[] = [
  { id: 'a', title: '周五开会资料', body: '记得带 U 盘', deleted_at: null },
  { id: 'b', title: '회의 준비', body: '자료 출력하기', deleted_at: null },
  { id: 'c', title: '买牛奶', body: '超市 开会 前顺路', deleted_at: null },
  { id: 'd', title: '开会（已删）', body: null, deleted_at: 1793581200000 },
  { id: 'e', title: null, body: 'SignPlex 发布说明', tags: ['工作'] },
];
const fields = (n: N) => [n.title, n.body, ...(n.tags ?? [])];
const ids = (q: string) => searchItems(notes, q, fields).map((h) => h.item.id);

describe('归一：NFKC、小写、去空白标点零宽', () => {
  it('全角转半角、大小写、空白和标点都去掉', () => {
    expect(normalizeForSearch('ＳｉｇｎＰｌｅｘ　发布！')).toBe('signplex发布');
    expect(normalizeForSearch('회의, 준비…')).toBe('회의준비');
    expect(normalizeForSearch('开\u200B会\u200D')).toBe('开会');
  });
  it('韩文分开的字母（NFD）拼回音节，和普通写法一样', () => {
    expect(normalizeForSearch('회의'.normalize('NFD'))).toBe('회의');
  });
  it('emoji 这类符号保留', () => {
    expect(normalizeForSearch('\u{1F382} 生日')).toBe('\u{1F382}生日');
  });
});

describe('查询拆词', () => {
  it('按空白和标点拆，去空、去重', () => {
    expect(queryTerms(' 开会，资料  开会 ')).toEqual(['开会', '资料']);
    expect(queryTerms('，。 !! ')).toEqual([]);
  });
  it(`最多取 ${MAX_TERMS} 个词`, () => {
    expect(queryTerms(Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '))).toHaveLength(MAX_TERMS);
  });
  it('韩文词末尾的助词去掉再试；去掉后不足 2 个字的不去；中文不处理', () => {
    expect(termVariants('회의를')).toEqual(['회의를', '회의']);
    expect(termVariants('자료에서')).toEqual(['자료에서', '자료']);
    expect(termVariants('나는')).toEqual(['나는']);
    expect(termVariants('开会的')).toEqual(['开会的']);
  });
  it('叠用的助词最多去两层，每层去完至少剩 2 个字（代码审查 11-10 第 3 条）', () => {
    expect(termVariants('회의에서도')).toEqual(['회의에서도', '회의에서', '회의']);
    expect(termVariants('친구에게는')).toEqual(['친구에게는', '친구에게', '친구']);
    expect(termVariants('엄마한테도')).toEqual(['엄마한테도', '엄마한테', '엄마']);
    expect(termVariants('금요일까지도')).toEqual(['금요일까지도', '금요일까지', '금요일']);
    expect(termVariants('에게는')).toEqual(['에게는', '에게']);                  // 再去就不足 2 个字
    expect(termVariants('회의에서도는')).toEqual(['회의에서도는', '회의에서도', '회의에서']);   // 最多两层
    expect(termVariants('일에서도', 1)).toEqual(['일에서도', '일에서', '일']);   // keepMin 1：泛指词表的单字词用
  });
  it('叠用助词的查询能找到原文（회의에서도 → 회의 자료）', () => {
    expect(matchScore(['회의 자료'], '회의에서도')).toBeGreaterThan(0);
    expect(matchScore(['친구 생일'], '친구에게는')).toBeGreaterThan(0);
  });
});

describe('searchItems（TC-B4-04）', () => {
  it('中文关键词：标题或正文命中都出；标题命中的排前面', () => {
    expect(ids('开会')).toEqual(['a', 'c']);
  });
  it('韩文关键词，空格不同也能找到；带助词也能找到', () => {
    expect(ids('회의준비')).toEqual(['b']);
    expect(ids('회의를')).toEqual(['b']);
    expect(ids('자료')).toEqual(['b']);
  });
  it('几个词都要命中（顺序不限，可以分在不同字段）', () => {
    expect(ids('资料 开会')).toEqual(['a']);
    expect(ids('开会 牛奶')).toEqual(['c']);
    expect(ids('开会 不存在的词')).toEqual([]);
  });
  it('大小写、全角都不影响；标签也查', () => {
    expect(ids('signplex')).toEqual(['e']);
    expect(ids('ＳＩＧＮＰＬＥＸ')).toEqual(['e']);
    expect(ids('工作')).toEqual(['e']);
  });
  it('已删除的不出', () => {
    expect(ids('已删')).toEqual([]);
  });
  it('空查询、只有标点：返回空', () => {
    expect(ids('')).toEqual([]);
    expect(ids(' ，。')).toEqual([]);
  });
  it('分数一样保持传入顺序；limit 截断', () => {
    const same = [{ id: '1', title: 'x 开会' }, { id: '2', title: '开会 y' }, { id: '3', title: '开会' }];
    expect(searchItems(same, '开会', (n) => [n.title]).map((h) => h.item.id)).toEqual(['1', '2', '3']);
    expect(searchItems(same, '开会', (n) => [n.title], { limit: 2 }).map((h) => h.item.id)).toEqual(['1', '2']);
    expect(searchItems(same, '开会', (n) => [n.title], { limit: -1 })).toEqual([]);
  });
});

describe('matchScore（match-target 的命中关复用）', () => {
  it('没命中 0；命中标题每词 2 分，命中别的字段每词 1 分', () => {
    expect(matchScore(['周五开会', '会议室 3'], '开会')).toBe(2);
    expect(matchScore(['周五', '开会'], '开会')).toBe(1);
    expect(matchScore(['周五开会', '会议室'], '开会 会议室')).toBe(3);
    expect(matchScore(['周五开会'], '牛奶')).toBe(0);
    expect(matchScore([null, undefined, ''], '开会')).toBe(0);
  });
});
