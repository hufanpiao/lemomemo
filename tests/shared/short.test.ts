// shared/logic/short.ts（TC-B2-10、TC-B2-11；架构 5.12 第 2 点、R-104、第三轮架构 L3、第 9 节单元 short）
// emoji 的 ZWJ、变体选择符写成转义（LINT-bidi 不准原样出现）
import { describe, expect, it } from 'vitest';
import { parseSplit } from '../../shared/logic/parse/index.ts';
import { cutGraphemes, displayShort, graphemeCount, itemShort, projectShort, shortPatchOnTitleChange } from '../../shared/logic/short.ts';
import { eventsWrite } from '../../shared/schema/rows.ts';

const ZWJ = '\u200D';
/** 一家四口（男、女、女孩、男孩，ZWJ 连起来）：一个字形簇、7 个码点 */
const FAMILY = ['\u{1F468}', '\u{1F469}', '\u{1F467}', '\u{1F466}'].join(ZWJ);
const CAKE = '\u{1F382}';

describe('itemShort：前 4 个字形簇（TC-B2-10、R-446）', () => {
  const cases: readonly [string, string, string][] = [
    ['中文', '校对稿件给老李', '校对稿件'],
    ['韩文（空格跳过）', '회의 준비하기', '회의준비'],
    ['英文也只取前 4 个字形簇（R-104 不设例外）', 'SignPlex review', 'Sign'],
    ['emoji 开头、中间空格跳过', `${CAKE} 生日聚会`, `${CAKE}生日聚`],
    ['开头空白和标点去掉', '  【重要】 交报告', '重要交报'],
    ['开头的中文标点、英文标点', '“……校对”', '校对'],
    ['中间的标点也去（R-446）', '交《报告》给A', '交报告给'],
    ['不到 4 个字照原样', '开会', '开会'],
    ['只有一个字', '饭', '饭'],
    ['空标题', '', ''],
    ['只有空白和标点', ' 。，!? ', ''],
  ];
  for (const [name, title, want] of cases) {
    it(name, () => {
      expect(itemShort(title)).toBe(want);
    });
  }

  it('ZWJ 家庭 emoji 算一个字形簇', () => {
    expect(itemShort(`${FAMILY}${FAMILY}${FAMILY}${FAMILY}${FAMILY}`)).toBe(`${FAMILY}${FAMILY}${FAMILY}${FAMILY}`);
    expect(itemShort(`${FAMILY}家庭聚会`)).toBe(`${FAMILY}家庭聚`);
    expect(graphemeCount(FAMILY)).toBe(1);
  });

  it('带组合符号的字算一个字形簇（e + U+0301、韩文初中声分开写）', () => {
    expect(itemShort('été')).toBe('été');
    // 分开写的谚文字母（ᄒ ᅬ ᄋ ᅴ）NFC 规整成音节后取前 4 个（只有 3 个音节，全留）
    expect(itemShort('회의 준')).toBe('회의준');
  });

  it('projectShort 和 itemShort 同一个规则', () => {
    expect(projectShort('NEOX 品牌')).toBe('NEOX');
    expect(projectShort('  사이니지 광고')).toBe('사이니지');
    expect(projectShort('')).toBe('');
  });
});

describe('itemShort：开头是数字先缩写、去量词（R-446）', () => {
  const cases: readonly [string, string, string][] = [
    ['负责人截图：整千缩写、去“个”', '5000个瓶子出货', '5千瓶子'],
    ['负责人截图：9000 同样', '9000个瓶子出货', '9千瓶子'],
    ['不缩写的数字照留，量词照去', '3个会', '3会'],
    ['整万', '20000件T恤入库', '2万T恤'],
    ['整万优先于整千', '10000只口罩', '1万口罩'],
    ['不整千的照留', '1500箱货到港', '1500'],
    ['千分位逗号', '5,000个瓶子', '5千瓶子'],
    ['kg 不分大小写', '3000KG大米', '3千大米'],
    ['韩文整千用 천、去量词 개', '5000개 병 출고', '5천병출'],
    ['韩文整万用 만、去量词 상자', '20000상자 입고', '2만입고'],
    ['韩文不缩写的数字照留', '3명 회의', '3회의'],
    ['后面是年份：原样', '2000年计划', '2000'],
    ['后面是时刻：原样', '3点开会', '3点开会'],
    ['后面是小数点：原样', '1000.5元报销', '1000'],
    ['后面是日期：原样', '10月5号交稿', '10月5'],
    ['没有量词：只缩写（瓶子的“瓶”后面跟“子”，不当量词）', '3000瓶子', '3千瓶子'],
    ['量词照去', '3000瓶水', '3千水'],
    ['开头标点、空白后才是数字，中间标点也去', '【5000】个瓶子', '5千瓶子'],
    ['夹在数字中间的标点留着', '10:00开会', '10:0'],
    ['数字不在开头不动', '出货5000个', '出货50'],
  ];
  for (const [name, title, want] of cases) {
    it(`${name}：${title} → ${want}`, () => {
      expect(itemShort(title)).toBe(want);
    });
  }
});

describe('displayShort：用户手改照用；AI 不到 3 个字且按标题取更长时改按标题取（R-446）', () => {
  it('用户手改的（user）照原样，哪怕只有 1 个字', () => {
    expect(displayShort({ title: '校对稿件', short: '审', short_by: 'user' })).toBe('审');
  });
  it('AI 存的 2 字老数据：按标题取更长就用按标题取的', () => {
    expect(displayShort({ title: '5000个瓶子出货', short: '50', short_by: 'ai' })).toBe('5千瓶子');
    expect(displayShort({ title: '校对稿件', short: '校对', short_by: 'ai' })).toBe('校对稿件');
  });
  it('AI 存的不到 3 个字、按标题取也不更长：照用 AI 的', () => {
    expect(displayShort({ title: '开会', short: '会议', short_by: 'ai' })).toBe('会议');
  });
  it('AI 存的 3 个字以上照用', () => {
    expect(displayShort({ title: '校对稿件给老李', short: '审稿件', short_by: 'ai' })).toBe('审稿件');
    expect(displayShort({ title: '배드민턴 치기', short: '배드민턴', short_by: 'ai' })).toBe('배드민턴');
  });
  it('short 为 null 或只有空白时按标题取', () => {
    expect(displayShort({ title: '校对稿件', short: null, short_by: null })).toBe('校对稿件');
    expect(displayShort({ title: '회의 준비', short: '  ', short_by: 'ai' })).toBe('회의준비');
  });
});

describe('改标题时简称的来源（TC-B2-11，第三轮架构 L3）', () => {
  it("short_by = 'ai'：同一个 patch 里清空 short、short_by", () => {
    expect(shortPatchOnTitleChange({ short_by: 'ai' })).toEqual({ short: null, short_by: null });
  });
  it("short_by = 'user'：不动", () => {
    expect(shortPatchOnTitleChange({ short_by: 'user' })).toEqual({});
  });
  it('没有 short（null）：不动', () => {
    expect(shortPatchOnTitleChange({ short_by: null })).toEqual({});
  });

  it('两个 ZWJ 家庭 emoji 的简称能写进 events.short（≤ 32 码点）', () => {
    const short = `${FAMILY}${FAMILY}`;
    expect([...short].length).toBe(14);
    const row = {
      id: '00000000-0000-4000-8000-000000000001',
      title: '家庭聚会',
      date: '2026-11-03',
      time: null,
      tz: null,
      duration_min: 60,
      project: '',
      note: '',
      source: 'page',
      raw_text: '',
      location: '',
      short,
      short_by: 'user',
      push_show_title: null,
      batch_id: null,
      remind_min: null,
      remind_days: null,
      notified_for: null,
      snooze_at: null,
      deleted_at: null,
      undone: false,
      created_at: 1,
      updated_at: 1,
    };
    expect(eventsWrite.safeParse(row).success).toBe(true);
  });
});

describe('cutGraphemes：按字截，不把表情截成半个（代码审 D2）', () => {
  const SMILE = '\u{1F600}';
  const FAMILY = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'; // ZWJ 连起来的一家人，8 个 UTF-16 单元，算一个字
  const E_NFD = 'e\u0301'; // 带组合符号的 é，2 个单元算一个字

  it('放得下原样返回；放不下时整字整字地取，总长（UTF-16 单元）不超过上限', () => {
    expect(cutGraphemes('买牛奶', 160)).toBe('买牛奶');
    expect(cutGraphemes(`ab${SMILE}`, 3)).toBe('ab');
    expect(cutGraphemes(`ab${SMILE}c`, 4)).toBe(`ab${SMILE}`);
    expect(cutGraphemes(`a${FAMILY}`, 8)).toBe('a');
    expect(cutGraphemes(`a${FAMILY}`, 9)).toBe(`a${FAMILY}`);
    expect(cutGraphemes(E_NFD.repeat(3), 5)).toBe(E_NFD.repeat(2));
  });

  it('本机规则的标题：159 个字后面跟表情，不留半个表情，入队前的行约束（rows.ts title max 160）照样过', () => {
    const now = Date.UTC(2026, 9, 28, 1, 0);
    const title = parseSplit(`${'记'.repeat(159)}${SMILE}${SMILE}`, now, 'Asia/Seoul', 'zh', []).items[0]?.title ?? '';
    expect(title).toBe('记'.repeat(159));
    expect(title.length).toBeLessThan(161);
    expect(/[\uD800-\uDBFF]$/.test(title)).toBe(false);
  });
});
