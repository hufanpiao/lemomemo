// shared/logic/notes/classify-rules.ts（B4 任务单 S5；架构 5.2 第 2839、2843 行；TC-B4-05 的本机一侧）
// 只从已有分类里选、不新建；分类名出现在文字里优先（最长的）；常见类别词表；删掉的、撤销的、合并掉的分类不选；单字分类名只认整个标题。
import { describe, expect, it } from 'vitest';
import type { CategoryRow } from '../../../shared/logic/live-row.ts';
import { classifyByRules, LEXICON } from '../../../shared/logic/notes/classify-rules.ts';

const cats: CategoryRow[] = [
  { id: 'work', name: '工作', sort: 0 },
  { id: 'shop', name: '购物', sort: 1 },
  { id: 'signplex', name: 'SignPlex', sort: 2 },
  { id: 'travel-ko', name: '여행', sort: 3 },
  { id: 'book', name: '书', sort: 4 },
  { id: 'old', name: '健康', sort: 5, deleted_at: 1793581200000 },
  { id: 'merged', name: '学习', sort: 6, merged_into: 'work' },
  { id: 'undone', name: '宠物', sort: 7, undone: true },
];

describe('classifyByRules', () => {
  it('分类名出现在标题、正文或标签里：选它（大小写、全角、空格不影响）', () => {
    expect(classifyByRules({ title: 'signplex 发布说明' }, cats)).toEqual({ category_id: 'signplex', by: 'name' });
    expect(classifyByRules({ title: '笔记', body: 'ＳｉｇｎＰｌｅｘ 下周' }, cats)).toEqual({ category_id: 'signplex', by: 'name' });
    expect(classifyByRules({ title: '随便', tags: ['购物'] }, cats).category_id).toBe('shop');
  });
  it('几个分类名都出现：名字最长的那个；一样长按 sort', () => {
    expect(classifyByRules({ title: 'SignPlex 工作安排' }, cats).category_id).toBe('signplex');
    expect(classifyByRules({ title: '购物和工作' }, cats).category_id).toBe('work');
  });
  it('词表：用户有“购物”这个分类，文字里有“超市”就归进去；韩文同理', () => {
    expect(classifyByRules({ title: '周末去超市' }, cats)).toEqual({ category_id: 'shop', by: 'lexicon' });
    expect(classifyByRules({ title: '항공권 예약하기' }, cats)).toEqual({ category_id: 'travel-ko', by: 'lexicon' });
  });
  it('词表命中几类：命中词最多的那类', () => {
    expect(classifyByRules({ title: '开会前去超市买咖啡，下单快递' }, cats).category_id).toBe('shop');   // 购物 4 个词、工作 1 个
  });
  it('词表里的类别，用户没有对应分类：不选、不新建', () => {
    expect(classifyByRules({ title: '明天去医院体检' }, cats)).toEqual({ category_id: null, by: null });   // 健康已删
  });
  it('删掉的、撤销的、合并掉的分类不选', () => {
    expect(classifyByRules({ title: '健康 学习' }, cats).category_id).toBeNull();
    expect(classifyByRules({ title: '宠物' }, cats).category_id).toBeNull();   // 宠物是撤销了的分类
  });
  it('单字分类名只在标题整个就是这个字时才算', () => {
    expect(classifyByRules({ title: '书' }, cats).category_id).toBe('book');
    expect(classifyByRules({ title: '书包坏了' }, cats).category_id).toBeNull();
  });
  it('空的随手记、没有分类：null', () => {
    expect(classifyByRules({ title: '', body: null, tags: [] }, cats)).toEqual({ category_id: null, by: null });
    expect(classifyByRules({ title: '周末去超市' }, [])).toEqual({ category_id: null, by: null });
  });
  it('词表反例（代码审查 11-10 第 1 条）：单字词去掉了；韩文按词比，长词里含着的不算', () => {
    const all: CategoryRow[] = [
      { id: 'health', name: '건강', sort: 0 }, { id: 'study', name: '学习', sort: 1 },
      { id: 'shop', name: '购物', sort: 2 }, { id: 'food', name: '맛집', sort: 3 },
    ];
    expect(classifyByRules({ title: '친구랑 약속' }, all).category_id).toBeNull();        // 약 → 약속
    expect(classifyByRules({ title: '식당 예약' }, all).category_id).toBe('food');       // 식당 中，约（예약）不算健康
    expect(classifyByRules({ title: '계약서 검토' }, all).category_id).toBeNull();
    expect(classifyByRules({ title: '정책 정리, 책상 정리' }, all).category_id).toBeNull(); // 책 → 정책/책상
    expect(classifyByRules({ title: '머신러닝 스터디' }, all).category_id).toBeNull();     // 러닝 → 머신러닝
    expect(classifyByRules({ title: '今天我买单' }, all).category_id).toBeNull();           // 买 → 买单
    expect(classifyByRules({ title: '课间休息' }, all).category_id).toBeNull();             // 课
  });
  it('韩文词带助词也认：先去助词再整词比；词干只看词的开头', () => {
    const all: CategoryRow[] = [{ id: 'health', name: '건강', sort: 0 }, { id: 'food', name: '맛집', sort: 1 }, { id: 'idea', name: '아이디어', sort: 2 }];
    expect(classifyByRules({ title: '아침 러닝을 했다' }, all)).toEqual({ category_id: 'health', by: 'lexicon' });
    expect(classifyByRules({ title: '병원에서 검진' }, all).category_id).toBe('health');
    expect(classifyByRules({ title: '여기 진짜 맛있는 곳' }, all).category_id).toBe('food');
    expect(classifyByRules({ title: '갑자기 떠올랐다' }, all).category_id).toBe('idea');
    expect(classifyByRules({ title: '안 맛있' + '어서 별로' }, [{ id: 'x', name: '건강' }]).category_id).toBeNull();
  });
  it('拉丁字母和数字的分类名按词边界比（代码审查 11-10 第 2 条）', () => {
    const lat: CategoryRow[] = [{ id: 'ai', name: 'AI', sort: 0 }, { id: 'ux', name: 'UX', sort: 1 }, { id: 'side', name: 'Side Project', sort: 2 }, { id: 'y', name: '2027', sort: 3 }];
    expect(classifyByRules({ title: 'send email to Tom' }, lat).category_id).toBeNull();
    expect(classifyByRules({ title: 'linux 装机' }, lat).category_id).toBeNull();
    expect(classifyByRules({ title: '学AI课', body: null }, lat).category_id).toBe('ai');       // 中文挨着也算词边界
    expect(classifyByRules({ title: '整理 ai 笔记' }, lat).category_id).toBe('ai');
    expect(classifyByRules({ title: 'Ｕｘ 走查' }, lat).category_id).toBe('ux');                // 全角也认
    expect(classifyByRules({ title: '周末做 side-project' }, lat).category_id).toBe('side');     // 名字里的空格可有可无
    expect(classifyByRules({ title: '周末做 sideproject' }, lat).category_id).toBe('side');
    expect(classifyByRules({ title: '订单号 120270' }, lat).category_id).toBeNull();
    expect(classifyByRules({ title: '2027 计划' }, lat).category_id).toBe('y');
  });
  it('词表每一类都有中韩两种分类名，词至少 2 个字', () => {
    const ko = /\p{Script=Hangul}/u;
    const zh = /\p{Script=Han}/u;
    for (const g of LEXICON) {
      expect(g.names.some((n) => ko.test(n)) && g.names.some((n) => zh.test(n)), g.names.join('/')).toBe(true);
      expect(g.words.every((w) => [...w.trim()].length >= 2), g.words.join('/')).toBe(true);   // 没有单字词
    }
  });
});
