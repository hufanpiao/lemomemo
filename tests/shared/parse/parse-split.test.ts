// i18n-exempt: 解析词表
// 本机规则 parseSplit、confidence（B3 任务单 BE-2；架构 5.1、第 7 节）。
// TC-B3-09：AI 句库中韩各 30 条（Z01～Z30、K01～K30），拆出的条数、每条结果、confidence 都和期望一致；
// TC-B3-17 本机一半：表里判为“有把握”的句子结果全对（“有把握却错了”为 0 句，线是全库最多 2 句）；
// 另测句库规则句 Z41～Z46，TC-B3-30～34、40、47、54、59～63，bad_day，洛杉矶和 UTC 跨日。
// 结果的约定写法：类型首字母 标题 月-日 时刻 basis [C 带 confirm] [@项目] [! 重要] [纪念日 类型/历法/月-日/年] [d 时长]，多条用“ ‖ ”隔开。
import { describe, expect, it } from 'vitest';
import { confidence, parseSplit, type ParseResult } from '../../../shared/logic/parse/index.ts';

const SEOUL = 'Asia/Seoul';
const LA = 'America/Los_Angeles';
const UTC = 'UTC';
const PROJECTS = ['SignPlex', 'NEOX', '官网改版', '이사 준비'];
type Feat = 'event' | 'todo' | 'anniv';
const FEATS: readonly Feat[] = ['event', 'todo', 'anniv'];
/** 句库基准：2026-11-02（周一）10:00 首尔 */
const BANK_NOW = Date.UTC(2026, 10, 2, 1, 0);
/** 任务单主时钟：2026-10-28（周三）10:00 首尔 */
const NOW = Date.UTC(2026, 9, 28, 1, 0);

function fmt(r: ParseResult): string {
  return r.items
    .map((it) => {
      const day = it.date ?? it.due;
      let s = `${it.kind.charAt(0).toUpperCase()} ${it.title} ${day ? day.slice(5) : '-'} ${it.time ?? '-'} ${it.date_basis ?? '-'}`;
      if (it.confirm) s += ' C';
      if (it.project) s += ' @' + it.project;
      if (it.important) s += ' !';
      if (it.anniv) s += ` ${it.anniv.type}/${it.anniv.calendar}/${it.anniv.month}-${it.anniv.day}/${it.anniv.year}`;
      if (it.duration_min) s += ' d' + it.duration_min;
      return s;
    })
    .join(' ‖ ');
}

/** 第一条（没有就报错，测试里不用非空断言） */
function first(r: ParseResult): ParseResult['items'][number] {
  const it = r.items[0];
  if (!it) throw new Error('没有结果');
  return it;
}

const run = (text: string, now = NOW, tz = SEOUL, features: readonly Feat[] = FEATS): ParseResult =>
  parseSplit(text, now, tz, 'zh', PROJECTS, { features });

/** [编号, 原话, 有把握 s / 没把握 u, 期望] */
const BANK: [string, string, 's' | 'u', string][] = [
    ['Z01', '明天下午三点和NEOX开会', 's', 'E 和NEOX开会 11-03 15:00 rel @NEOX'],
    ['Z02', '后天上午十点半去医院复查', 's', 'E 去医院复查 11-04 10:30 rel'],
    ['Z03', '下周三下午两点半给SignPlex做演示', 's', 'E 给SignPlex做演示 11-11 14:30 rel @SignPlex'],
    ['Z04', '周五晚上七点和小王吃饭', 's', 'E 和小王吃饭 11-06 19:00 rel'],
    ['Z05', '这周日下午四点带孩子去游泳', 's', 'E 带孩子去游泳 11-08 16:00 rel'],
    ['Z06', '下个月5号交季度报告', 's', 'T 交季度报告 12-05 - rel'],
    ['Z07', '11月20号上午九点体检', 's', 'E 体检 11-20 09:00 md'],
    ['Z08', '今天两点去银行', 's', 'E 去银行 11-02 14:00 rel'],
    ['Z09', '明天下午两点到四点面试', 's', 'E 面试 11-03 14:00 rel d120'],
    ['Z10', '下周一上午九点一刻开部门例会', 's', 'E 开部门例会 11-09 09:15 rel'],
    ['Z11', '明天晚上和老李吃饭', 's', 'T 和老李吃饭 11-03 - rel'],
    ['Z12', '后天傍晚去取快递', 's', 'T 去取快递 11-04 - rel'],
    ['Z13', '今天下午五点前把合同发给小王', 's', 'T 把合同发给小王 11-02 17:00 rel'],
    ['Z14', '买牛奶和鸡蛋', 'u', 'T 买牛奶和鸡蛋 - - -'],
    ['Z15', '记得给车续保险', 'u', 'T 给车续保险 - - -'],
    ['Z16', '周五前把发票整理好', 's', 'T 把发票整理好 11-06 - rel'],
    ['Z17', '重要：明天交签证材料', 's', 'T 交签证材料 11-03 - rel !'],
    ['Z18', '不重要的事：有空整理一下书架', 'u', 'T 有空整理一下书架 - - -'],
    ['Z19', '小王说他下个月去NEOX上班了', 'u', 'T 小王说他下个月去NEOX上班了 - - - @NEOX'],
    ['Z20', '想法：首页可以加一个天气卡片', 'u', 'T 想法:首页可以加一个天气卡片 - - -'],
    ['Z21', '停车位在B2层C区35号', 'u', 'T 停车位在B2层C区35号 - - -'],
    ['Z22', '明天上午十一点和老李、小王一起过官网改版的方案', 's', 'E 和老李、小王一起过官网改版的方案 11-03 11:00 rel @官网改版'],
    ['Z23', '给SignPlex的张总回邮件', 'u', 'T 给SignPlex的张总回邮件 - - - @SignPlex'],
    ['Z24', '明天上午十点开会，下午三点去机场接人', 'u', 'E 开会 11-03 10:00 rel ‖ E 去机场接人 11-03 15:00 rel'],
    ['Z25', '买咖啡豆，交电费，周三前给NEOX发报价', 'u', 'T 买咖啡豆 - - - ‖ T 交电费 - - - ‖ T 给NEOX发报价 11-04 - rel @NEOX'],
    ['Z26', '周四上午九点看牙，十一点和张姐对账', 'u', 'E 看牙 11-05 09:00 rel ‖ E 和张姐对账 11-05 11:00 rel'],
    ['Z27', '周六下午四点打羽毛球，晚上七点和小王吃火锅', 'u', 'E 打羽毛球 11-07 16:00 rel ‖ E 和小王吃火锅 11-07 19:00 rel'],
    ['Z28', '11月20号是妈妈生日', 'u', 'A 妈妈生日 - - - birthday/solar/11-20/null'],
    ['Z29', '爸爸农历八月十五生日', 'u', 'A 爸爸生日 - - - birthday/lunar/8-15/null'],
    ['Z30', '5月18号是我们的结婚纪念日', 'u', 'A 我们的结婚纪念日 - - - anniversary/solar/5-18/null'],
    ['K01', '내일 오후 3시에 NEOX 미팅', 's', 'E NEOX 미팅 11-03 15:00 rel @NEOX'],
    ['K02', '모레 오전 10시 반 치과 예약', 's', 'E 치과 예약 11-04 10:30 rel'],
    ['K03', '다음 주 수요일 오후 2시에 SignPlex 발표', 's', 'E SignPlex 발표 11-11 14:00 rel @SignPlex'],
    ['K04', '금요일 저녁 7시에 민수랑 약속', 's', 'E 민수랑 약속 11-06 19:00 rel'],
    ['K05', '이번 주 일요일 오후 4시 아이 수영 수업', 's', 'E 아이 수영 수업 11-08 16:00 rel'],
    ['K06', '다음 달 5일까지 분기 보고서 제출', 's', 'T 분기 보고서 제출 12-05 - rel'],
    ['K07', '11월 20일 오전 9시 건강검진', 's', 'E 건강검진 11-20 09:00 md'],
    ['K08', '오늘 2시에 은행 가기', 's', 'E 은행 가기 11-02 14:00 rel'],
    ['K09', '내일 오후 2시부터 4시까지 면접', 's', 'E 면접 11-03 14:00 rel d120'],
    ['K10', '다음 주 월요일 오전 9시 15분 주간 회의', 's', 'E 주간 회의 11-09 09:15 rel'],
    ['K11', '내일 저녁에 지은이랑 밥 먹기', 's', 'T 지은이랑 밥 먹기 11-03 - rel'],
    ['K12', '모레 점심에 김 과장님이랑 식사', 's', 'T 김 과장님이랑 식사 11-04 - rel'],
    ['K13', '오늘 오후 5시까지 이 팀장님께 계약서 보내기', 's', 'T 이 팀장님께 계약서 보내기 11-02 17:00 rel'],
    ['K14', '우유랑 계란 사기', 'u', 'T 우유랑 계란 사기 - - -'],
    ['K15', '자동차 보험 갱신하기', 'u', 'T 자동차 보험 갱신하기 - - -'],
    ['K16', '금요일까지 영수증 정리', 's', 'T 영수증 정리 11-06 - rel'],
    ['K17', '중요: 내일 비자 서류 제출', 's', 'T 비자 서류 제출 11-03 - rel !'],
    ['K18', '안 급함, 시간 날 때 책장 정리', 'u', 'T 시간 날 때 책장 정리 - - -'],
    ['K19', '민수 다음 달에 NEOX로 이직한대', 'u', 'T 민수 다음 달에 NEOX로 이직한대 - - - @NEOX'],
    ['K20', '앱 홈 화면에 날씨 카드 넣으면 좋을 듯', 'u', 'T 앱 홈 화면에 날씨 카드 넣으면 좋을 듯 - - -'],
    ['K21', '주차 위치 B2층 C구역 35번', 'u', 'T 주차 위치 B2층 C구역 35번 - - -'],
    ['K22', '토요일 오전 10시 이사 준비 업체 견적 상담', 's', 'E 이사 준비 업체 견적 상담 11-07 10:00 rel @이사 준비'],
    ['K23', 'SignPlex 김 과장님께 메일 회신', 'u', 'T SignPlex 김 과장님께 메일 회신 - - - @SignPlex'],
    ['K24', '내일 오전 10시 회의, 오후 3시 공항 픽업', 'u', 'E 회의 11-03 10:00 rel ‖ E 공항 픽업 11-03 15:00 rel'],
    ['K25', '커피 원두 사기, 전기요금 내기, 수요일까지 NEOX에 견적서 보내기', 'u', 'T 커피 원두 사기 - - - ‖ T 전기요금 내기 - - - ‖ T NEOX에 견적서 보내기 11-04 - rel @NEOX'],
    ['K26', '목요일 오전 9시 치과 가고 11시에 김 과장님이랑 정산', 'u', 'E 치과 가 11-05 09:00 rel ‖ E 김 과장님이랑 정산 11-05 11:00 rel'],
    ['K27', '토요일 오후 4시 배드민턴, 저녁 7시 민수랑 고깃집', 'u', 'E 배드민턴 11-07 16:00 rel ‖ E 민수랑 고깃집 11-07 19:00 rel'],
    ['K28', '11월 20일 엄마 생신', 'u', 'A 엄마 생신 - - - birthday/solar/11-20/null'],
    ['K29', '아빠 생신은 음력 8월 15일', 'u', 'A 아빠 생신 - - - birthday/lunar/8-15/null'],
    ['K30', '5월 18일 결혼기념일', 'u', 'A 결혼기념일 - - - anniversary/solar/5-18/null'],
];

describe('TC-B3-09 / 17：句库中韩各 30 条', () => {
  for (const [id, text, sure, want] of BANK) {
    it(`${id} ${text}`, () => {
      const r = run(text, BANK_NOW);
      expect(fmt(r)).toBe(want);
      expect(confidence(r)).toBe(sure === 's' ? 'sure' : 'unsure');
    });
  }
  it('中韩各 30 条', () => {
    expect(BANK.filter((b) => b[0].startsWith('Z'))).toHaveLength(30);
    expect(BANK.filter((b) => b[0].startsWith('K'))).toHaveLength(30);
  });
});

/** [原话, 有把握, 期望]，用句库时钟 */
const RULE_SENTENCES: [string, 's' | 'u', string][] = [
  ['每周一上午九点开周会', 'u', 'E 每周一开周会 11-09 09:00 rel'],
  ['每个月15号交水费', 'u', 'T 每个月15号交水费 11-15 - rel'],
  ['10月30号下午两点和客户开会', 'u', 'E 和客户开会 10-30 14:00 md C'],
  ['1号交报告', 'u', 'T 交报告 11-01 - d C'],
  ['10月5号是爸妈的结婚纪念日', 'u', 'A 爸妈的结婚纪念日 - - - anniversary/solar/10-5/null'],
  ['昨天下午三点和小王见了客户', 's', 'E 和小王见了客户 11-01 15:00 rel'],
];

describe('句库规则句（R-163、R-166）', () => {
  for (const [text, sure, want] of RULE_SENTENCES) {
    it(text, () => {
      const r = run(text, BANK_NOW);
      expect(fmt(r)).toBe(want);
      expect(confidence(r)).toBe(sure === 's' ? 'sure' : 'unsure');
    });
  }
  it('Z43、Z44 的 confirm', () => {
    expect(first(run('10月30号下午两点和客户开会', BANK_NOW)).confirm).toEqual({ past: '2026-10-30', next: '2027-10-30' });
    expect(first(run('1号交报告', BANK_NOW)).confirm).toEqual({ past: '2026-11-01', next: '2026-12-01' });
  });
});

/** [用例, 原话, 期望]，主时钟 2026-10-28 首尔 */
const CASES: [string, string, string][] = [
  ['30', '每周一上午9点开周会', 'E 每周一开周会 11-02 09:00 rel'],
  ['30', '每天晚上8点吃药', 'E 每天吃药 10-28 20:00 rel'],
  ['30', '每月5号交房租', 'T 每月5号交房租 11-05 - rel'],
  ['31', '매주 월요일 9시 회의', 'E 매주 월요일 회의 11-02 09:00 rel'],
  ['32', '明天下午交报告', 'T 交报告 10-29 - rel'],
  ['32', '周五晚上给妈妈打电话', 'T 给妈妈打电话 10-30 - rel'],
  ['32', '모레 저녁 장보기', 'T 장보기 10-30 - rel'],
  ['33', '明天下午3点交报告', 'E 交报告 10-29 15:00 rel'],
  ['34', '明天中午吃午饭', 'T 吃午饭 10-29 - rel'],
  ['34', '내일 점심 먹기', 'T 점심 먹기 10-29 - rel'],
  ['34', '내일 저녁 식사', 'T 저녁 식사 10-29 - rel'],
  ['54', '내일 점심 약속', 'T 약속 10-29 - rel'],   // 架构审第九节 7a：时段词接别的名词一律去掉，不给“점심 약속”开特例
  ['54', '내일 저녁 약속', 'T 약속 10-29 - rel'],
  ['54', '모레 아침 운동', 'T 운동 10-30 - rel'],
  ['54', '금요일 점심 회의', 'T 회의 10-30 - rel'],
  ['54', '내일 저녁에 약속', 'T 약속 10-29 - rel'],
  ['54', '오늘 저녁 장보기', 'T 장보기 10-28 - rel'],
  ['40', '2026年10月30号开会', 'T 开会 10-30 - ymd'],
  ['40', '10月30号开会', 'T 开会 10-30 - md'],
  ['40', '30号开会', 'T 开会 10-30 - d'],
  ['40', '明天开会', 'T 开会 10-29 - rel'],
  ['40', '下周五开会', 'T 开会 11-06 - rel'],
  ['59', '下午三点 박 대리 电话', 'E 박 대리 电话 10-28 15:00 rel'],
  ['59', '下个月5号交房租', 'T 交房租 11-05 - rel'],
  ['59', '下周三开会', 'T 开会 11-04 - rel'],
  ['59', '这个月底交报告', 'T 交报告 10-31 - rel'],
  ['59', '다음 달 5일 회의', 'T 회의 11-05 - rel'],
  ['59', '每个月15号交水费', 'T 每个月15号交水费 11-15 - rel'],
  ['59', '10月20号开会，会后给小王打电话', 'T 开会 10-20 - md C ‖ T 会后给小王打电话 10-20 - md C'],
  ['60', '帮我登记一个待办，明天下午3点去银行办理业务', 'T 去银行办理业务 10-29 15:00 rel'],
  ['60', '할 일 하나 추가해 줘, 내일 10시부터 11시까지 보고서 작성', 'T 보고서 작성 10-29 10:00 rel'],
  ['60', '帮我记一个日程，周五和客户吃饭', 'E 和客户吃饭 10-30 - rel'],
  ['60', '일정 하나: 토요일 오후 등산', 'E 등산 10-31 - rel'],
  ['60', '明天整理待办清单', 'T 整理待办清单 10-29 - rel'],
  ['60', '일정표 만들기', 'T 일정표 만들기 - - -'],
  ['60', '把日程发给小王', 'T 把日程发给小王 - - -'],
  ['60', '일정 공유하기', 'T 일정 공유하기 - - -'],
  ['60', '부산 출장 일정 등록해 줘', 'E 부산 출장 - - -'],
  ['60', '프로젝트 회의 일정을 등록해 줘', 'E 프로젝트 회의 - - -'],
  ['60', '帮我 등록 一个待办，明天下午 3시에 去银行', 'T 去银行 10-29 15:00 rel'],
  ['60', '新建一个日程，明天上午10点见客户', 'E 见客户 10-29 10:00 rel'],
  ['60', '일정 하나 넣어 줘, 내일 오전 10시 고객 미팅', 'E 고객 미팅 10-29 10:00 rel'],
  ['60', '给日程加个备注', 'T 给日程加个备注 - - -'],
  ['60', '일정에 메모 넣어', 'T 일정에 메모 넣어 - - -'],
  ['60', '日程：明天交报告', 'E 交报告 10-29 - rel'],
  ['61', '明天提醒我交房租', 'T 交房租 10-29 - rel'],
  ['61', '周五记得买牛奶，帮我记一下', 'T 买牛奶 10-30 - rel'],
  ['61', '下午3点开会，设个提醒', 'E 开会 10-28 15:00 rel'],
  ['61', '帮我记个周五交房租', 'T 交房租 10-30 - rel'],
  ['61', '帮我安排一个明天上午10点到11点的项目会议', 'E 项目会议 10-29 10:00 rel d60'],
  ['61', '내일 우유 사는 걸 알려 줘', 'T 우유 사는 걸 10-29 - rel'],
  ['61', '금요일에 회의 잡아 줘', 'T 회의 10-30 - rel'],
  ['61', '토요일 병원 예약 등록해 줘', 'T 병원 예약 10-31 - rel'],
  ['61', '학원 등록하기', 'T 학원 등록하기 - - -'],
  ['61', '박 대리에게 일정 알려 주기', 'T 박 대리에게 일정 알려 주기 - - -'],
  ['61', '给小王安排工作', 'T 给小王安排工作 - - -'],
  ['61', '提醒小王交材料', 'T 提醒小王交材料 - - -'],
  ['61', '周五车辆登记', 'T 车辆登记 10-30 - rel'],
  ['61', '帮小王安排面试', 'T 帮小王安排面试 - - -'],
  ['62', '每年10月28日提醒我检查车险', 'T 每年10月28日检查车险 10-28 - rel'],
  ['62', '매년 3월 5일 자동차 보험 갱신', 'T 매년 3월 5일 자동차 보험 갱신 03-05 - rel'],
  ['62', '每年12月1日上午10点年度体检', 'E 每年12月1日年度体检 12-01 10:00 rel'],
  ['62', '每年10月28日是结婚纪念日', 'A 结婚纪念日 - - - anniversary/solar/10-28/null'],
  ['62', '매년 5월 3일 우리 기념일', 'A 우리 기념일 - - - anniversary/solar/5-3/null'],
  ['63', '这周五之前完成报价单、整理客户资料和发送邮件，帮我安排时间并设置提醒', 'T 完成报价单 10-30 - rel ‖ T 整理客户资料 10-30 - rel ‖ T 发送邮件 10-30 - rel'],
  ['63', '周五前写报告，时间你帮我排一下', 'T 写报告 10-30 - rel'],
  ['63', '금요일까지 보고서, 시간 잡아 줘', 'T 보고서 10-30 - rel'],
  ['R-183', '3点前交材料', 'T 交材料 10-28 15:00 rel'],
];

describe('任务单用例（主时钟 2026-10-28 周三 首尔）', () => {
  for (const [tc, text, want] of CASES) {
    it(`TC-B3-${tc} ${text}`, () => {
      expect(fmt(run(text))).toBe(want);
    });
  }
});

describe('提示条和 confidence', () => {
  it('TC-B3-30、31：带重复说法一律没把握、提示 recur，不写重复字段', () => {
    for (const s of ['每周一上午9点开周会', '每天晚上8点吃药', '每月5号交房租', '매주 월요일 9시 회의']) {
      const r = run(s);
      expect(r.hints.recur).toBe(true);
      expect(confidence(r)).toBe('unsure');
      expect(Object.keys(first(r)).includes('repeat')).toBe(false);
    }
  });
  it('Z40（只用空格分开的三件事、没有日子）：本机规则判没把握（架构审第九节 7b），兜底时保守记 1 条（原话照存 raw_text，用户能改）', () => {
    const r = run('买牛奶 交电费 给老李回电话');
    expect(confidence(r)).toBe('unsure');
    expect(r.items.length).toBe(1);
    expect(first(r).title).toBe('买牛奶交电费给老李回电话');
  });
  it('TC-B3-62 ②：매년 3월 5일 最近一次是 2027-03-05', () => {
    expect(first(run('매년 3월 5일 자동차 보험 갱신')).due).toBe('2027-03-05');
  });
  it('TC-B3-63：原话有安排时间才带 arrange；拆成 3 条没把握', () => {
    const r = run('这周五之前完成报价单、整理客户资料和发送邮件，帮我安排时间并设置提醒');
    expect(r.hints.arrange).toBe(true);
    expect(r.items).toHaveLength(3);
    expect(confidence(r)).toBe('unsure');
    expect(run('周五前写报告，时间你帮我排一下').hints.arrange).toBe(true);
    expect(run('금요일까지 보고서, 시간 잡아 줘').hints.arrange).toBe(true);
    expect(run('周五前写报告').hints.arrange).toBe(false);
    expect(run('明天下午3点开会，设个提醒').hints.arrange).toBe(false);
  });
  it('TC-B3-60 ①：点名待办、有截止时刻，有把握', () => {
    expect(confidence(run('帮我登记一个待办，明天下午3点去银行办理业务'))).toBe('sure');
  });
  it('bad_day：11月31号不认成日子、日期留空、提示月和日', () => {
    const r = run('11月31号开会');
    expect(r.hints.bad_day).toEqual({ month: 11, day: 31 });
    expect(first(r).due).toBeNull();
    expect(first(r).title).toBe('开会');
    expect(confidence(r)).toBe('unsure');
    expect(run('2월 30일 회의').hints.bad_day).toEqual({ month: 2, day: 30 });
  });
  it('带年份但那年没有的日子（2027年2月29日）也是 bad_day', () => {
    const r = run('2027年2月29日交材料');
    expect(r.hints.bad_day).toEqual({ month: 2, day: 29 });
    expect(first(r).due).toBeNull();
  });
  it('纪念日的说法没开 anniv 时记待办、没把握', () => {
    const r = run('11月20号是妈妈生日', NOW, SEOUL, ['event', 'todo']);
    expect(first(r).kind).toBe('todo');
    expect(first(r).anniv).toBeNull();
    expect(confidence(r)).toBe('unsure');
  });
  it('随手记的说法没把握', () => {
    expect(confidence(run('小王说他下个月去NEOX上班了'))).toBe('unsure');
    expect(run('想法：首页可以加一个天气卡片').doubts).toContain('note');
  });
  it('超长句子没把握；只说日子记 empty；空话不出错', () => {
    expect(run('明天开会' + '很'.repeat(600)).doubts).toContain('too_long');
    expect(run('明天').doubts).toContain('empty');
    expect(run('').items).toHaveLength(0);
  });
});

describe('代码审 M1～M3 回归（11-07）', () => {
  /** 2026-10-28（周三）23:30 首尔 */
  const LATE = Date.UTC(2026, 9, 28, 14, 30);
  /** 2026-10-28（周三）00:30 首尔 */
  const EARLY = Date.UTC(2026, 9, 27, 15, 30);
  const one = (text: string, now = NOW) => {
    const r = run(text, now);
    return [fmt(r), confidence(r)];
  };
  it('M1：今晚 / 晚上 1～5 点是第二天凌晨', () => {
    expect(one('今晚1点吃药')).toEqual(['E 吃药 10-29 01:00 rel', 'sure']);
    expect(one('晚上1点睡觉')).toEqual(['E 睡觉 10-29 01:00 rel', 'sure']);
    expect(one('今晚3点半看球赛', LATE)).toEqual(['E 看球赛 10-29 03:30 rel', 'sure']);
    expect(one('今晚11点睡觉', LATE)).toEqual(['E 睡觉 10-28 23:00 rel', 'sure']);
    expect(one('晚上八点吃药')).toEqual(['E 吃药 10-28 20:00 rel', 'sure']);
    expect(one('오늘 밤 1시에 약 먹기', LATE)).toEqual(['E 약 먹기 10-29 01:00 rel', 'sure']);
  });
  it('M1：没说日子的凌晨 / 새벽要看现在几点（23 点多说的是明天，00:30 说的是今天）', () => {
    expect(one('凌晨1点吃药', LATE)).toEqual(['E 吃药 10-29 01:00 rel', 'sure']);
    expect(one('凌晨1点吃药', EARLY)).toEqual(['E 吃药 10-28 01:00 rel', 'sure']);
    expect(one('새벽 1시에 약 먹기', LATE)).toEqual(['E 약 먹기 10-29 01:00 rel', 'sure']);
    expect(one('새벽 5시 비행기', LATE)).toEqual(['E 비행기 10-29 05:00 rel', 'sure']);
    expect(one('明天凌晨1点吃药', LATE)).toEqual(['E 吃药 10-29 01:00 rel', 'sure']);
  });
  it('M2：跨午夜的起止按第二天算时长', () => {
    expect(one('晚上11点到凌晨1点值班')).toEqual(['E 值班 10-28 23:00 rel d120', 'sure']);
    expect(one('밤 11시부터 새벽 1시까지 야간 근무')).toEqual(['E 야간 근무 10-28 23:00 rel d120', 'sure']);
    expect(one('明天下午两点到四点面试')).toEqual(['E 面试 10-29 14:00 rel d120', 'sure']);
  });
  it('M3：审查列的 5 句——星期数字不漏进标题，剩了日期、时刻、星期一律没把握，只有日子的段不丢', () => {
    expect(one('下周一到周三出差')).toEqual(['T 到周三出差 11-02 - rel', 'unsure']);
    expect(one('周五下午到周日去釜山')).toEqual(['T 到周日去釜山 10-30 - rel', 'unsure']);
    expect(one('明天10点和周五3点开会')).toEqual(['E 和周五3点开会 10-29 10:00 rel', 'unsure']);
    expect(one('明天上午10点开会和下午3点去银行')).toEqual(['E 开会和 3点去银行 10-29 10:00 rel', 'unsure']);
    expect(one('下周三、周四出差')).toEqual(['T 周四出差 11-04 - rel', 'unsure']);
    for (const t of ['下周一到周三出差', '周五下午到周日去釜山', '明天10点和周五3点开会', '下周三、周四出差']) {
      expect(run(t).items.map((x) => x.title).join(''), t).not.toMatch(/周[1-7]/);
    }
    expect(run('下周三、周四出差').doubts).toContain('leftover');
  });
  it('M3：只有日子的段并进下一段，不改原来的结果（明天下午，开会）；“3号楼”不算剩下的日子', () => {
    expect(one('明天下午，开会')).toEqual(['T 开会 10-29 - rel', 'sure']);
    expect(one('明天去3号楼开会')).toEqual(['T 去3号楼开会 10-29 - rel', 'sure']);
  });
  it('建议 1：重复说法同一段里的“明天 / 下周一”是开始的日子，不再记成今天', () => {
    expect(one('从下周一开始每天跑步')).toEqual(['T 每天跑步 11-02 - rel', 'unsure']);
    expect(one('明天交报告 每天跑步')).toEqual(['T 交报告每天跑步 10-29 - rel', 'unsure']);
    expect(one('다음 주 월요일부터 매일 달리기')).toEqual(['T 매일 달리기 11-02 - rel', 'unsure']);
    expect(one('每天跑步')).toEqual(['T 每天跑步 10-28 - rel', 'unsure']);
  });
  it('M28：没有具体时刻时句末的时段词去掉（“和老李 점심”→“和老李”、当天截止的待办），吃饭本身留着', () => {
    expect(fmt(run('和老李 점심'))).toBe('T 和老李 10-28 - rel');
    expect(fmt(run('내일 점심 먹기'))).toBe('T 점심 먹기 10-29 - rel');
  });
});

describe('TC-B3-47：一律按周一起始', () => {
  it('2026-11-01（周日）说“下周三” = 11-04', () => {
    const sun = Date.UTC(2026, 10, 1, 1, 0);
    expect(first(run('下周三开会', sun)).due).toBe('2026-11-04');
    expect(first(run('다음 주 수요일 회의', sun)).due).toBe('2026-11-04');
  });
});

describe('时区：只看传进来的 tz', () => {
  // 2026-10-28 06:00 UTC：首尔 10-28 15:00，洛杉矶 10-27 23:00
  const T1 = Date.UTC(2026, 9, 28, 6, 0);
  // 2026-10-28 16:00 UTC：UTC 还是 10-28，首尔已是 10-29 01:00
  const T2 = Date.UTC(2026, 9, 28, 16, 0);
  it('洛杉矶：“明天”按当地日子算', () => {
    expect(first(run('明天下午3点开会', T1, LA)).date).toBe('2026-10-28');
    expect(first(run('明天下午3点开会', T1, SEOUL)).date).toBe('2026-10-29');
  });
  it('每天的时刻：没过记今天，过了记明天', () => {
    expect(first(run('每天晚上11点半吃药', T1, LA)).date).toBe('2026-10-27');
    expect(first(run('每天晚上8点吃药', T1, SEOUL)).date).toBe('2026-10-28');
    expect(first(run('每天下午2点吃药', T1, SEOUL)).date).toBe('2026-10-29');
  });
  it('UTC 跨日：同一时刻首尔已是第二天', () => {
    expect(first(run('今天交报告', T2, UTC)).due).toBe('2026-10-28');
    expect(first(run('今天交报告', T2, SEOUL)).due).toBe('2026-10-29');
    expect(first(run('周五开会', T2, UTC)).due).toBe('2026-10-30');
  });
  it('UTC：只说几号、本月已过要问', () => {
    const r = run('20号交报告', T2, UTC);
    expect(first(r).date_basis).toBe('d');
    expect(first(r).confirm).toEqual({ past: '2026-10-20', next: '2026-11-20' });
  });
});
