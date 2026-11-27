// i18n-exempt: 解析词表
// localIntent：逐组句式、有没有把握、query、target、to（架构 5.14 第 2、3、7 点；TC-B4b3-44 ①、47、48 ⑥⑦ 的本机部分）。
import { describe, expect, it } from 'vitest';
import { localIntent, type LocalIntent } from '../../../shared/logic/parse/intent.ts';
import { takeKindWords } from '../../../shared/logic/parse/marks.ts';

const SEOUL = 'Asia/Seoul';
const LA = 'America/Los_Angeles';
/** 句库基准：2026-11-02（周一）10:00 首尔 */
const NOW = Date.UTC(2026, 10, 2, 1, 0);
const T = '2026-11-02';
const TM = '2026-11-03';
const li = (s: string, tz = SEOUL, scope?: 'main' | 'vault'): LocalIntent => localIntent(s, NOW, tz, scope ? { scope } : {});
const ALL3 = ['event', 'todo', 'note'];
/** 只取 want 里写到的键再比（Deno 替身没有 toMatchObject） */
function sub(actual: unknown, want: unknown): unknown {
  if (want === null || typeof want !== 'object' || Array.isArray(want) || actual === null || typeof actual !== 'object') return actual;
  const a = actual as Record<string, unknown>;
  return Object.fromEntries(Object.keys(want).map((k) => [k, sub(a[k], (want as Record<string, unknown>)[k])]));
}
const like = (actual: unknown, want: unknown, label?: string) => expect(sub(actual, want), label).toEqual(want);

describe('基本查找、总结：祈使位置才有把握', () => {
  it('“帮我找 / 搜一下 / 찾아줘 / 뭐 있어 / 有什么…？”→ search、有把握', () => {
    for (const s of ['帮我找一下证件', '搜一下发票', '여권 찾아줘', '내일 뭐 있어?', '明天有什么安排？', '查一下快递单号']) {
      const r = li(s);
      expect(r.intent, s).toBe('search');
      expect(r.sure, s).toBe(true);
    }
    expect(li('明天有什么安排？').query).toEqual({ text: '安排', range: { from: TM, to: TM }, kinds: ALL3, done: 'any' });
    expect(li('帮我找一下证件').query?.text).toBe('证件');
  });
  it('B4b-3 补的句式：找一下 / 找找 / 搜 / 查找 X、X 在哪（里 / 儿）、X 어디 있어 → search、有把握，查询词是 X', () => {
    const cases: [string, string][] = [
      ['找一下 牙医', '牙医'], ['找一下牙医', '牙医'], ['找找护照', '护照'], ['搜 发票', '发票'], ['查找快递单号', '快递单号'],
      ['牙医在哪', '牙医'], ['护照在哪里？', '护照'], ['合同放在哪儿', '合同'], ['여권 어디 있어?', '여권'], ['계약서 어디야', '계약서'],
    ];
    for (const [s, q] of cases) like(li(s), { intent: 'search', sure: true, query: { text: q, range: null } }, s);
  });
  it('B4b-3 补的句式不误伤记下（D-15）：找人办事、在哪办的事由、“查看”', () => {
    for (const s of ['找一下小王签字', '明天找找房东退押金', '下午去银行问问在哪办', '明天查看合同', '周五搜集资料写报告']) {
      const r = li(s);
      expect(r.intent === 'record' || !r.sure, s).toBe(true);
    }
  });
  it('“总结一下 / 정리해 줘”→ summarize、有把握；“下周”是下周一到下周日', () => {
    like(li('总结一下这周的随手记'), { intent: 'summarize', sure: true, query: { range: { from: T, to: '2026-11-08' }, kinds: ['note'], done: 'any' } });
    like(li('정리해 줘'), { intent: 'summarize', sure: true });
    expect(li('总结一下下周的安排').query?.range).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    like(li('总结一下这个月的待办').query, { range: { from: '2026-11-01', to: '2026-11-30' }, kinds: ['todo'] });
    like(li('다음 달 일정 정리해 줘').query, { range: { from: '2026-12-01', to: '2026-12-31' }, kinds: ['event'] });
  });
  it('句首是名词或动作用法、同句还有日子或别的动作：没把握（像是要记的事，D-15）', () => {
    for (const s of ['总结报告周五交', '汇总表明天发给小王', '汇总一下报销单交财务', '搜一下资料写报告', '帮我找资料周五上传', '보고서 금요일까지 정리해 줘']) {
      expect(li(s).sure, s).toBe(false);
    }
    for (const s of ['帮我总结一下这周的随手记', '帮我找交通卡', '总结一下下周的安排']) expect(li(s).sure, s).toBe(true);
    expect([li('帮我总结一下这周的随手记').query?.text, li('请帮我找证件').query?.text]).toEqual(['', '证件']);
  });
  it('韩文“담주”和“다음 주”同义：整周范围', () => {
    for (const s of ['담주 일정 정리해 줘', '다음 주 일정 정리해 줘']) like(li(s), { intent: 'summarize', sure: true, query: { range: { from: '2026-11-09', to: '2026-11-15' } } }, s);
  });
  it('名词用法的“总结 / 汇总 / ？”不算有把握（D-15）', () => {
    for (const s of ['周五前交季度总结', '下周三写项目总结', '把汇总表发给小王', '明天开会？', '매주 금요일 오후 5시에 提醒我整理本周工作总结。']) {
      expect(li(s).sure, s).toBe(false);
    }
  });
  it('还有没认出的时间说法：没把握', () => {
    for (const s of ['总结一下上周的随手记', '帮我找下个月初的安排', '帮我找最近的发票', '지난주 메모 정리해 줘', '帮我找明天下午三点的会']) {
      expect(li(s).sure, s).toBe(false);
    }
  });
  it('两边都沾（请求说法 + 查找）：没把握', () => {
    const r = li('提醒我明天查一下快递');
    expect(r.intent).toBe('search');
    expect(r.sure).toBe(false);
  });
  it('两边都沾：句首就是祈使查找、句中又有请求说法（“记得 / 记一下”）→ 没把握；去掉请求说法的同类句有把握', () => {
    for (const s of ['帮我找记得带的东西', '帮我找一下记一下的内容']) like(li(s), { intent: 'search', sure: false }, s);
    for (const s of ['帮我找要带的东西', '帮我找一下会议的内容']) like(li(s), { intent: 'search', sure: true }, s);
  });
  it('祈使查找又命中列出、冲突、总结：一律没把握', () => {
    for (const s of ['明天有什么冲突？', '查一下有哪些发票', '搜一下发票汇总', '帮我找一下总结']) like(li(s), { intent: 'search', sure: false }, s);
  });
  it('批量词、相关待办、今天没完成：查找也没把握；同句去掉这些说法有把握', () => {
    for (const s of ['帮我找所有发票', '帮我找相关待办', '帮我找今天没完成的报告']) like(li(s), { intent: 'search', sure: false }, s);
    for (const s of ['帮我找发票', '帮我找报告']) like(li(s), { intent: 'search', sure: true }, s);
  });
  it('“下个月”跨年：12 月说下个月是次年 1 月', () => {
    const dec = Date.UTC(2026, 11, 2, 1, 0);
    expect(localIntent('总结一下下个月的待办', dec, SEOUL).query?.range).toEqual({ from: '2027-01-01', to: '2027-01-31' });
    expect(localIntent('다음 달 일정 정리해 줘', dec, SEOUL).query?.range).toEqual({ from: '2027-01-01', to: '2027-01-31' });
  });
});

describe('一组都没命中：记下、有把握', () => {
  it('普通记事', () => {
    for (const s of ['明天下午三点开会', '买牛奶', '내일 일정 알려 줘']) like(li(s), { intent: 'record', sure: true, query: null, target: null, to: null }, s);
  });
  it('“完成 + 宾语”“查看”“확인하기”是要做的事', () => {
    for (const s of ['周五之前完成报价单', '금요일까지 견적서 완료하기', '明天查看合同', '내일 계약서 확인하기']) expect(li(s).intent, s).toBe('record');
  });
  it('批量词、相关待办、今天没完成：记下但没把握；同句去掉这些说法有把握', () => {
    for (const s of ['整理所有发票', '周五前处理相关待办', '今天没完成的报告']) like(li(s), { intent: 'record', sure: false }, s);
    for (const s of ['整理发票', '周五前处理待办', '今天的报告']) like(li(s), { intent: 'record', sure: true }, s);
  });
});

describe('句式表外的取消、改期、完成说法：不许当成有把握的记下（架构 5.14 第 2、7 点；TC-B4b3-51）', () => {
  /** R09、R15、T-K45、T-M45（测试集 ③）和 TC-B4b3-48 ⑥、TC-B4b3-51 的原句 */
  const SUSPECT = [
    '取消我明天下午的项目会议。', '내일 프로젝트 회의를 오후 2시로 변경해 줘.', '건강검진 목요일로 변경', '건강검진 推迟到周四',
    '今天的事都标完成', '今天没完成的都取消', '取消 NEOX 对片和相关待办', '会议延期到周五', '把例会改期', '회의 연기해 줘', '보고서 작성 완료',
  ];
  it('本机要么认成取消 / 改期 / 完成，要么判记下但没把握', () => {
    for (const s of SUSPECT) {
      const r = li(s);
      expect(r.intent === 'record' && r.sure, s).toBe(false);
    }
  });
  it('TC-B4b3-48 ⑥ 两句：没把握（在线交给 AI，离线先按记下保存）', () => {
    for (const s of ['今天没完成的都取消', '今天的事都标完成']) expect(li(s).sure, s).toBe(false);
  });
});

describe('列出、冲突、截止到今天（没把握的查找）', () => {
  it('列出类 → search、没把握', () => {
    for (const s of ['列出明天的待办', '给我看下周的日程', '显示今天的安排', '这周有哪些会', '내일 일정 보여 줘', '할 일 목록', '내일 회의 있는지 확인해 줘', '내일 뭐 있는지 알려 줘']) {
      const r = li(s);
      expect(r.intent, s).toBe('search');
      expect(r.sure, s).toBe(false);
    }
  });
  it('冲突 → search、kinds [event]、done any、range 是那一天', () => {
    for (const s of ['明天下午有没有冲突的日程', '내일 일정 겹치는지 확인해 줘']) {
      like(li(s), { intent: 'search', sure: false, query: { range: { from: TM, to: TM }, kinds: ['event'], done: 'any' } }, s);
    }
  });
  it('TC-B4b3-44 ①：截止到今天 → {from: null, to: 今天}、kinds [todo]、done open', () => {
    for (const s of ['帮我列出今天所有未完成的待办', '오늘 완료하지 않은 할 일 보여 줘', '今天还没做的有哪些', '오늘 미완료 목록 보여 줘']) {
      like(li(s), { intent: 'search', sure: false, query: { range: { from: null, to: T }, kinds: ['todo'], done: 'open' } }, s);
    }
    expect(li('미완료 보고서 정리').intent).toBe('record');
  });
  it('设备时区：洛杉矶的今天', () => {
    expect(li('今天没完成的有哪些', LA).query?.range).toEqual({ from: null, to: '2026-11-01' });
  });
});

describe('完成、取消', () => {
  it('完成说法各一句 → complete、kinds [todo]、不带 to、没把握', () => {
    const ss = ['把报告标记为已完成', '报告标成完成', '报告打个勾', '报告打钩', '把报告勾掉', '报告做完了', '报告搞定了', '보고서 완료로 표시해 줘', '보고서 완료 처리', '보고서 체크해 줘'];
    for (const s of ss) {
      const r = li(s);
      like(r, { intent: 'complete', sure: false, to: null, target: { kinds: ['todo'] } }, s);
      expect(['报告', '보고서'], s).toContain(r.target?.text);
    }
  });
  it('取消：日子、时刻；“下午”不编时刻', () => {
    like(li('明天下午三点的会取消了'), { intent: 'cancel', sure: false, target: { text: '会', date: TM, time: '15:00', kinds: ['event', 'todo'] }, to: null });
    expect(li('내일 오후 프로젝트 회의를 취소해 줘').target).toEqual({ text: '프로젝트 회의를', date: TM, time: null, kinds: ['event', 'todo'] });
    for (const s of ['周五的聚餐不去了', '明天的例会不开了', '내일 회의 취소됐어', '나 내일 모임 안 가']) expect(li(s).intent, s).toBe('cancel');
  });
  it('韩文类型词连同复数“들”和助词一起取走：不剩“들은”“을”当关键词；后面还连着韩文字的只取类型词', () => {
    like(li('할 일들은 취소해 줘'), { intent: 'cancel', target: { text: '', kinds: ['todo'] } });
    like(li('오늘 완료하지 않은 할 일을 모두 보여 줘.'), { intent: 'search', query: { text: '모두', kinds: ['todo'] } });
    like(li('내일 오후에 일정이 겹치는지 확인해 줘.'), { intent: 'search', query: { text: '확인해 줘', kinds: ['event'] } });
    const st = { text: ' 일정이랑 할 일들 메모도 ' };
    expect([takeKindWords(st), st.text.trim().split(/\s+/)]).toEqual([{ todo: true, event: true, note: true }, ['이랑']]);
  });
  it('相关待办：只开提示开关，后半句不进 target', () => {
    const r = li('내일 오후 회의 취소해 줘，顺便把相关待办也删除。');
    like(r, { intent: 'cancel', relatedTodos: true, target: { text: '회의', date: TM, kinds: ['event', 'todo'] } });
    expect(li('明天下午三点的会取消了').relatedTodos).toBe(false);
  });
  it('相关待办：没有标点时只去掉“相关待办”那一段，前面的日子和事由留着（TC-B4b3-49 韩文原句）', () => {
    like(li('내일 오후 회의 취소하고 관련 할 일도 지워 줘'), { intent: 'cancel', relatedTodos: true, target: { text: '회의', date: TM, time: null, kinds: ['event', 'todo'] } });
    like(li('明天的会取消了 顺便把相关待办也删了'), { intent: 'cancel', relatedTodos: true, target: { text: '会', date: TM, time: null } });
    like(li('明天的会取消了和相关的待办'), { intent: 'cancel', relatedTodos: true, target: { text: '会', date: TM } });
  });
  it('相关待办在前、用“和 / 랑”接原条目，或用标点断开：原条目留着', () => {
    for (const s of ['把相关待办和明天的会都取消了', '相关待办和明天的会都取消了', '相关待办不用管，明天的会取消了']) {
      like(li(s), { intent: 'cancel', relatedTodos: true, target: { text: '会', date: TM } }, s);
    }
    like(li('관련 할 일이랑 내일 회의 취소해 줘'), { intent: 'cancel', relatedTodos: true, target: { text: '회의', date: TM } });
  });
  it('前后各说一次取消、完成：两处说法都不进 target', () => {
    for (const s of ['明天的会取消了，相关待办也取消了', '明天的会不开了，相关的待办也取消了']) like(li(s), { intent: 'cancel', target: { text: '会', date: TM } }, s);
    like(li('내일 회의 취소하고 관련 할 일도 취소해 줘'), { intent: 'cancel', target: { text: '회의', date: TM } });
    like(li('把明天的会标记为已完成，相关待办也标记为已完成'), { intent: 'complete', target: { text: '会', date: TM } });
  });
  it('相关待办夹在中间：后面的取消、改期说法留着', () => {
    like(li('明天的会和相关待办都取消了'), { intent: 'cancel', relatedTodos: true, target: { text: '会', date: TM } });
    like(li('내일 회의랑 관련 할 일 취소해 줘'), { intent: 'cancel', relatedTodos: true, target: { text: '회의', date: TM } });
    like(li('明天的会和相关待办都改到周五'), { intent: 'reschedule', relatedTodos: false, target: { text: '会', date: TM }, to: { date: '2026-11-06', time: null } });
  });
  it('TC-B4b3-48 ⑥：“都 + 泛指词或空”和“全部 / 所有”一样 → bulkRefused、不带 all；“都 + 具体词”按单条', () => {
    for (const s of ['今天没完成的都标成完成', '今天的事都打勾', '明天的事都取消了', '明天全部取消了', '今天的所有待办都打勾']) {
      const r = li(s);
      expect(r.bulkRefused, s).toBe(true);
      expect(r.target !== null && 'all' in r.target, s).toBe(false);
    }
    for (const s of ['明天的会都取消了', '首都机场的会取消了']) like(li(s), { intent: 'cancel', bulkRefused: false, target: { text: s.startsWith('首都') ? '首都机场的会' : '会' } }, s);
  });
  it('“所有 + 泛指词”的完成 → bulkRefused、不带 all', () => {
    const r = li('今天所有没完成的待办都标记为完成');
    expect(r.intent).toBe('complete');
    expect(r.bulkRefused).toBe(true);
    expect(r.target !== null && 'all' in r.target).toBe(false);
    like(r.target, { date: T, with_overdue: true, kinds: ['todo'] });
  });
});

describe('改期', () => {
  it('中文在改期说法处一分为二', () => {
    like(li('周五和小王的饭局改到下周五晚上七点'), {
      intent: 'reschedule', sure: false, target: { date: '2026-11-06', time: null }, to: { date: '2026-11-13', time: '19:00' },
    });
    like(li('把明天的项目会议改到下午2点'), { target: { text: '项目会议', date: TM }, to: { date: null, time: '14:00' } });
  });
  it('韩文取紧挨“로”前面、能整段解析成日子或时刻的最长一段', () => {
    like(li('금요일 민수랑 저녁 약속 모레로 미뤄 줘'), { intent: 'reschedule', target: { date: '2026-11-06' }, to: { date: '2026-11-04', time: null } });
    like(li('내일 회의 4시로 바꿔 줘'), { target: { text: '회의', date: TM }, to: { date: null, time: '16:00' } });
    like(li('회의 다음 주 월요일로 옮겨 줘'), { target: { text: '회의', date: null }, to: { date: '2026-11-09', time: null } });
  });
  it('改期说法后面取不出日子也取不出时刻 → 记下、没把握', () => {
    like(li('把会议改到线上'), { intent: 'record', sure: false, target: null, to: null });
  });
  it('批量：“都 + 改期说法”', () => {
    like(li('今天没做完的事情都推到明天'), {
      intent: 'reschedule', target: { date: T, time: null, with_overdue: true, all: true, kinds: ['todo'] }, to: { date: TM, time: null },
    });
  });
  it('“首都”“다음”不算批量词', () => {
    expect(li('首都机场的会改到周五').target?.all === undefined).toBe(true);
    expect(li('회의 다음 주 월요일로 미뤄 줘').target?.all === undefined).toBe(true);
  });
  it('TC-B4b3-48 ⑦：没说具体事但带了时刻 → 不批量', () => {
    for (const s of ['明天下午3点的改到4点', '내일 3시 거 4시로 바꿔 줘']) {
      const r = li(s);
      like(r, { intent: 'reschedule', target: { date: TM, time: '15:00', kinds: ['event', 'todo'] }, to: { date: null, time: '16:00' } }, s);
      expect(r.target?.all === undefined, s).toBe(true);
    }
  });
  it('TC-B4b3-48 ④：“今天 + 具体词 + 没完成的”和“今天没完成的 + 具体词”取出同一个关键词', () => {
    for (const s of ['今天采购没完成的都推到后天', '今天采购还没做的都推到后天', '今天没完成的采购都推到后天']) {
      like(li(s), { intent: 'reschedule', target: { text: '采购', date: T, with_overdue: true, all: true, kinds: ['todo'] }, to: { date: '2026-11-04' } }, s);
    }
  });
  it('R26 原句：all 由 resolveTarget 补出', () => {
    like(li('今天没完成的 업무를 모레로 미뤄 줘。'), {
      intent: 'reschedule', target: { date: T, with_overdue: true, all: true, kinds: ['todo'] }, to: { date: '2026-11-04', time: null },
    });
  });
  it('点名定 kinds：待办 → [todo]，日程 → [event]', () => {
    like(li('这周五的待办都挪到下周一').target, { kinds: ['todo'], date: '2026-11-06', all: true });
    like(li('明天的日程都推到后天').target, { kinds: ['event'], date: TM, all: true });
  });
  it('设备时区：洛杉矶的“今天”', () => {
    like(li('今天没做完的事情都推到明天', LA), { target: { date: '2026-11-01' }, to: { date: '2026-11-02' } });
  });
});

describe('隐私记页面和超长输入', () => {
  it('scope vault：取消、改期、完成按记下；查找不变', () => {
    for (const s of ['明天下午三点的会取消了', '把明天的项目会议改到下午2点', '报告打个勾']) {
      like(li(s, SEOUL, 'vault'), { intent: 'record', sure: false, target: null, to: null }, s);
    }
    like(li('帮我找一下证件', SEOUL, 'vault'), { intent: 'search', sure: true });
  });
  it('超过 500 字：没把握、不抛错', () => {
    expect(li('帮我找一下' + '证件'.repeat(300)).sure).toBe(false);
    expect(li('买'.repeat(600)).sure).toBe(false);
  });
});

describe('“今天 X 没完成的”：查找和取消、改期、完成共用 takeOverdue，中间的 X 留下当关键词', () => {
  it('查找：query.text 是中间的关键词，range 截止到今天、kinds [todo]、done open', () => {
    for (const s of ['查一下今天采购没完成的', '今天采购没完成的有哪些？']) {
      like(li(s), { intent: 'search', sure: false, query: { text: '采购', range: { from: null, to: T }, kinds: ['todo'], done: 'open' } }, s);
    }
  });
  it('同一句说成完成：target.text 也是“采购”', () => {
    like(li('把今天采购没完成的标记为已完成'), { intent: 'complete', target: { text: '采购', date: T, with_overdue: true, kinds: ['todo'] } });
  });
  it('中间只有“还 / 所有 / 아직 / 중에서”这类字：query.text 为空，不拿它们当关键词', () => {
    for (const s of ['今天还有哪些没做完的', '查一下今天所有没完成的', '오늘 아직 못 한 할 일 보여 줘', '오늘 할 일 중에서 아직 완료하지 않은 거 보여 줘']) {
      const q = li(s).query;
      expect([q?.range?.from, q?.done], s).toEqual([null, 'open']);
      expect(['', '거'], s).toContain(q?.text);
    }
  });
});

describe('韩文“안 가”：带词尾的说法认成取消（取消一律没把握），“가”开头的别的词不算', () => {
  it('안 가 / 안 가요 / 안 가기로 했어 / 안 가게 됐어 / 안 가겠어 / 안 가려고 해 → cancel、没把握、target 是“회의”', () => {
    for (const s of ['내일 회의 안 가', '내일 회의 안 가요', '내일 회의 안 가기로 했어', '내일 회의 안 가게 됐어', '내일 회의 안 가겠어', '내일 회의 안 가려고 해', '내일 회의 안 갈래', '내일 회의 안 갈게요', '내일 회의 안 갈 거야', '내일 회의 안 갑니다']) {
      like(li(s), { intent: 'cancel', sure: false, target: { text: '회의', date: TM, time: null } }, s);
    }
  });
  it('안 가져 / 안 가져가 / 안 가방 / 안 가르쳐：不是取消', () => {
    for (const s of ['우산 안 가져', '내일 우산 안 가져가', '안 가방', '수학 안 가르쳐 줘', '내일 옷 안 갈아입어', '타이어 안 갈아도 돼']) expect(li(s).intent, s).not.toBe('cancel');
  });
});

describe('查找、总结的说法表：命中、祈使位置、去掉句式从同一张表生成', () => {
  it('句首客气话“请 / 帮我”后面跟任何一个句首说法都算祈使', () => {
    for (const s of ['帮我搜一下发票', '请查一下快递单号', '请帮我总结一下这周的会']) expect(li(s).sure, s).toBe(true);
  });
  it('“看一下”单说只去掉、不算命中；配“有什么”才算查找', () => {
    like(li('下周三 회의 겹치는지 看一下'), { intent: 'search', query: { text: '회의', kinds: ['event'] } });
    like(li('看一下明天有什么'), { intent: 'search', sure: true, query: { text: '' } });
    expect(li('看一下报告').intent).toBe('record');
  });
});
