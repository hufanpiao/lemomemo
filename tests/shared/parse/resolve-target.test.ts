// 泛指词（generic-words）和 resolveTarget：批量改期的两路判定、取消和完成不批量（TC-B4b3-48 ⑥⑦，架构 5.14 第 7 点）。
import { describe, expect, it } from 'vitest';
import { isGenericText, specificWords } from '../../../shared/logic/parse/generic-words.ts';
import { resolveTarget, type PlusTarget } from '../../../shared/logic/parse/resolve-target.ts';

const T = '2026-11-02';
const TM = '2026-11-03';
const tg = (o: Partial<PlusTarget>): PlusTarget => ({ text: '', date: null, time: null, kinds: ['event', 'todo'], ...o });

describe('isGenericText', () => {
  it('整段是泛指词（去掉“的 / 这些 / 那些 / 들”和韩文助词）才算', () => {
    for (const s of ['任务', '这些任务', '事情', '的事', '할 일', '업무들', '거', '', '  ', '업무를', '일을', '할 일을', '것을', '거를', '业务', '待办事项']) {
      expect(isGenericText(s), s).toBe(true);
    }
  });
  it('有具体词的不算', () => {
    for (const s of ['采购任务', '구매 업무', '买牛奶', '구매 업무를', '找工作', '会']) expect(isGenericText(s), s).toBe(false);
  });
});

describe('specificWords', () => {
  it('丢掉整词是泛指词的、去掉中文粘着的泛指词尾巴', () => {
    expect(specificWords('采购任务')).toBe('采购');
    expect(specificWords('구매 업무')).toBe('구매');
    expect(specificWords('우유 구매 업무')).toBe('우유 구매');
    expect(specificWords('구매 업무를')).toBe('구매');
    expect(specificWords('우유 구매 업무를')).toBe('우유 구매');
    expect(specificWords('买牛奶 任务')).toBe('买牛奶');
  });
  it('前面不到 2 个字、或者本身不是泛指词结尾的原样', () => {
    expect(specificWords('找工作')).toBe('找工作');
    expect(specificWords('보고서 작성')).toBe('보고서 작성');
    expect(specificWords('任务')).toBe('');
    expect(specificWords('')).toBe('');
  });
});

describe('resolveTarget：改期', () => {
  it('⑦ R26：text“업무”+ with_overdue + 今天、没带 all → 补出 all', () => {
    const r = resolveTarget('reschedule', tg({ text: '업무를', date: T, kinds: ['todo'], with_overdue: true }));
    expect(r.target.all).toBe(true);
    expect(r.bulkRefused).toBe(false);
  });
  it('⑦ “明天的事推到后天”：泛指词或空 + 日子 + 没有时刻 → 批量', () => {
    expect(resolveTarget('reschedule', tg({ text: '事', date: TM })).target.all).toBe(true);
    expect(resolveTarget('reschedule', tg({ text: '', date: TM })).target.all).toBe(true);
  });
  it('⑦ “오늘 아직 안 끝난 일 전부 …”：输入已带 all → 保留', () => {
    expect(resolveTarget('reschedule', tg({ text: '일', date: T, with_overdue: true, all: true })).target.all).toBe(true);
  });
  it('⑦ R06、R16 具体词 + with_overdue：不补 all；输入带了 all 就保留', () => {
    for (const text of ['采购任务', '구매 업무를']) {
      const one = resolveTarget('reschedule', tg({ text, date: T, kinds: ['todo'], with_overdue: true })).target;
      expect('all' in one, text).toBe(false);
      expect(resolveTarget('reschedule', tg({ text, date: T, with_overdue: true, all: true })).target.all).toBe(true);
    }
  });
  it('⑦ 带了 all 却没有日子也没有 with_overdue → 去掉 all', () => {
    const r = resolveTarget('reschedule', tg({ text: '', all: true }));
    expect('all' in r.target).toBe(false);
  });
  it('⑦ text 为空或泛指词 + 日子 + 时刻 → 不批量', () => {
    expect('all' in resolveTarget('reschedule', tg({ text: '', date: TM, time: '15:00' })).target).toBe(false);
    expect('all' in resolveTarget('reschedule', tg({ text: '거', date: TM, time: '15:00' })).target).toBe(false);
  });
});

describe('resolveTarget：取消、完成', () => {
  it('⑥ 带 all → 输出不带 all；泛指词或空时 bulkRefused', () => {
    for (const intent of ['cancel', 'complete'] as const) {
      for (const [text, refused] of [['事', true], ['', true], ['할 일을', true], ['采购', false]] as const) {
        const r = resolveTarget(intent, tg({ text, date: T, with_overdue: true, all: true }));
        expect('all' in r.target, `${intent} ${text}`).toBe(false);
        expect(r.bulkRefused, `${intent} ${text}`).toBe(refused);
      }
    }
  });
  it('取消、text 为空、只有日子、没带 all → 不拒（交给 matchTarget 返回空）', () => {
    expect(resolveTarget('cancel', tg({ date: TM })).bulkRefused).toBe(false);
  });
});

describe('resolveTarget：不改输入、再跑一遍不变', () => {
  it('输入对象原样；输出再喂一遍结果相同', () => {
    const cases: [Parameters<typeof resolveTarget>[0], PlusTarget][] = [
      ['reschedule', tg({ text: '업무', date: T, with_overdue: true, kinds: ['todo'] })],
      ['reschedule', tg({ text: '', all: true })],
      ['reschedule', tg({ text: '采购', date: T, time: '15:00', all: true })],
      ['complete', tg({ text: '事', date: T, all: true, kinds: ['todo'] })],
    ];
    for (const [intent, input] of cases) {
      const before = JSON.stringify(input);
      const once = resolveTarget(intent, input);
      expect(JSON.stringify(input)).toBe(before);
      expect(resolveTarget(intent, once.target).target).toEqual(once.target);
      expect(once.target.text).toBe(input.text);
      expect(once.target.kinds).toEqual(input.kinds);
    }
  });
});
