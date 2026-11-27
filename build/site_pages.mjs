// 官网首页和演示页（中韩各一）的生成器：页面结构、App 样机、示例数据都只在这里写一份，产物是 site/{zh,ko}/{index,demo}.html。
// 首页的正文单放在 build/site_home.mjs（首页内容和样机画面的唯一源头），这里只把 <head> 和语言切换链接传过去。
//
// 用法：
//   node build/site_pages.mjs            # 重新生成四个页面
//   node build/site_pages.mjs --check    # 只比对：site/ 里的页面和这里生成的不一样就报错（build_site.mjs 的 checkSite 也调 renderPages 比对）
//
// 样机是照真 App（src 的今天、日历、待办、随手记；底栏图标照 src/kit/components/GlassBar/GlassBar.tsx 的 ICONS）用 HTML 重画的，
// 示例内容全是编的。页面不内联脚本和样式（官网 CSP），新节点由演示脚本从 <template> 复制、用 textContent 填字。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { solarTermIn, toLunarIn } from '../shared/logic/anniv/lunar.ts';
import { LUNAR_CN, TERMS_CN } from '../shared/logic/anniv/lunar-data.ts';
import { itemShort } from '../shared/logic/short.ts';
import { HOME_MODULES, homePage } from './site_home.mjs';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'site');

// 农历：中韩都按中国农历表（韩国表在这段日期没有数据；这一段两边的月日一样）。返回 [农历月, 农历日, 节气编号或 undefined]
function lunarOf(iso) {
  const d = toLunarIn(LUNAR_CN, iso);
  if (!d) throw new Error(`农历表里没有 ${iso}`);
  return [d.month, d.day, solarTermIn(TERMS_CN, iso) ?? undefined];
}

// ---------- 图标（底栏四个和“＋”照 src/kit/components/GlassBar/GlassBar.tsx 的 ICONS） ----------
const ICON = {
  today: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z',
  cal: 'M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM4 10h16M9 5v15M15 5v15M4 15h16',
  todo: 'M5 12.5l4.5 4.5L19 7.5',
  notes: 'M15 5l4 4-10 10H5v-4z',
  plus: 'M12 5v14M5 12h14',
  me: 'M12 4.6a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2zM5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  img: 'M5 5h14v14H5zM5 16l4-4 3 3 2-2 5 5M15 9.2a.2.2 0 1 0 0 .4.2.2 0 0 0 0-.4z',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4.5l3 1.8',
  down: 'M7 10l5 5 5-5',
  left: 'M14.5 6l-6 6 6 6',
  right: 'M9.5 6l6 6-6 6',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  face: 'M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 15.5c1.4 1.2 3.6 1.2 5 0',
  up: 'M12 19V6M6 11.5L12 5.5l6 6',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4',
  note: 'M6 6h12M6 11h12M6 16h8',
  later: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3h3M12 8.5v3.8l2.6 1.6', // 网页版“推迟”：带回转箭头的钟
  mic: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3', // 照 ChatBody 的麦克风钮
};
const ic = (name, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;
// 随手记“隐私记”一行的实心锁（真 App 是实心的）
const LOCK_SOLID = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11V8a4 4 0 0 1 8 0v3"/><rect class="fill" x="5.5" y="11" width="13" height="9.5" rx="2"/></svg>';
// 月历格子里纪念日的小爱心（照 calendar/ui/MonthGrid.tsx 的 HEART，viewBox 10×9）
const HEART = '<svg class="hrt" viewBox="0 0 10 9" aria-hidden="true"><path d="M5 8.6 1 4.7A2.3 2.3 0 0 1 5 1.6a2.3 2.3 0 0 1 4 3.1Z"/></svg>';

// 状态栏右侧：信号、Wi-Fi、电量（一张 svg）
const SB_ICONS = '<svg class="sb-ic" viewBox="0 0 76 13" aria-hidden="true">' +
  '<rect x="0" y="8.6" width="3.2" height="4.4" rx="1"/><rect x="4.6" y="6.2" width="3.2" height="6.8" rx="1"/>' +
  '<rect x="9.2" y="3.6" width="3.2" height="9.4" rx="1"/><rect x="13.8" y="1" width="3.2" height="12" rx="1"/>' +
  '<path class="sb-wifi" d="M23.2 4.9a10.4 10.4 0 0 1 13.6 0M25.8 7.8a6.6 6.6 0 0 1 8.4 0"/><circle cx="30" cy="11" r="1.8"/>' +
  '<rect class="sb-bat" x="45.5" y=".5" width="25" height="12" rx="3.8"/><rect x="47.5" y="2.5" width="17.5" height="8" rx="2"/>' +
  '<path class="sb-cap" d="M72 4.4v4.2c.9-.3 1.5-1.1 1.5-2.1s-.6-1.8-1.5-2.1z"/></svg>';

// ---------- 两种语言的示例数据（全是编的） ----------
const L = {
  zh: {
    lang: 'zh-Hans', brand: '柠檬记',
    date: '11月24日 周二',
    live: '进行中', now: '现在 10:20', ev: '产品周会',
    late: '没赶上', lateDays: '逾 1 天', snooze: '推迟', plan: '今天的安排',
    rows: { dentist: '牙医复诊', food: '买猫粮', mom: '给妈妈打电话', momSub: '20:00 提醒', dinner: '和小林吃饭',
      report: '交季度报告', ticket: '订周末的火车票', ticketSub: '今天截止', clothes: '整理冬天的衣服', clothesSub: '这周', book: '还小林的书', bookSub: '周五' },
    tabs: { today: '今天', cal: '日历', todo: '待办', notes: '随手记' },
    todoSub: '11月24日 周二 · 1 / 6 完成', todoChips: [['全部', 6, ''], ['工作', 2, 'work'], ['生活', 4, 'life']],
    todoSec: { over: '过期', today: '今天', later: '以后', done: '已完成' },
    notesSub: '11月24日 周二 · 共 5 条', all: '全部',
    vaultSec: '隐私', vault: '隐私记', vaultState: '已上锁 · 输入密码解锁', notesToday: '今天', noteInput: '想到什么，记一句…',
    notes: [['周末想去的咖啡馆：河边那家，带上电脑', 0], ['牛奶、鸡蛋、猫砂、洗衣液', 1], ['新项目的名字可以叫“晴天”', 2], ['体检报告周四出，记得去拿', 3], ['小林说喜欢那本旧书的封面', 4]],
    cats: ['地方', '购物', '灵感', '健康', '朋友'],
    // 下面五个写法模板也放进演示页的 #tpl-words，演示脚本按同一份填字
    fmt: { month: '{m}月', calSub: '2026年 · 本月 {n} 项', day: '{m}月{d}日 周{w}', md: '{m}月{d}日', count: '{n} 项' },
    calSeg: ['周', '月', '纪念日'], calToday: '今天', wd: ['日', '一', '二', '三', '四', '五', '六'], allDay: '全天',
    tomorrow: '明天', after: '后天', none: '这天没有安排', prevMonth: '上个月', nextMonth: '下个月',
    ev2: { weekly: ['周会', '产品周会'], check: ['体检', '体检'], meet: ['和小金开会', '和小金开会'], bday: ['小林生日', '小林生日'], expo: ['看展', '看展'],
      movie: ['看电影', '看电影'], anniv: ['结婚纪念日', '结婚纪念日'], party: ['年会', '年会'], xmas: ['圣诞聚会', '圣诞聚会'], dentist: ['牙医', '牙医复诊'], dinner: ['吃饭', '和小林吃饭'], move: ['搬家', '帮小金搬家'] },
    lunar: (m, d, term) => term ?? (d === 1 ? ['', '正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'][m] + '月' : lunarZh(d)),
    terms: { 18: '寒露', 19: '霜降', 20: '立冬', 21: '小雪', 22: '大雪', 23: '冬至' },
    lockTitle: '隐私记已上锁', lockOr: '或输入密码',
    said: '“明天下午三点和小金开会”', cardTag: '日程', cardTitle: '和小金开会', cardWhen: '明天 11月25日 15:00',
    listening: '正在听…',
    // 网页版（宽屏）样机的字：照真 App 网页版的中文词条
    web: {
      ai: 'AI 助手', aiPh: '问点什么，或者按住说',
      watch: { today: '在看今天', cal: '在看日历', todo: '在看待办', notes: '在看随手记' },
      ask: { today: ['今天先做什么？', '明天有什么', '帮我排今天'], cal: ['这周哪天比较空？', '下周有什么', '最近有什么纪念日'],
        todo: ['哪些事最急？', '哪些已经过期了', '按项目看'], notes: ['总结这周记的', '最近记了什么', '有没有能转成待办的'] },
      todaySub: '农历十月十六 · 3 天后 小林 生日', next: '下一件 14:00 牙医复诊 · 3 小时 40 分后',
      fortune: '今日运势', fortuneSet: '填生日', fortuneQ: '想按八字看每天的运势？', week: '本周', soon: '快到了', anniv: '纪念日',
      soonRows: [['小林 生日', '3 天后'], ['结婚纪念日', '9 天后']],
      sched: '今天的日程', todos: '今天的待办', done: '已完成 1', momDue: '20:00 截止',
      todoChips: [['全部', 5], ['生活', 3], ['工作', 2]],
      metas: { report: '! 过期 11/23 · 工作', mom: '生活 · 今天 20:00', ticket: '生活 · 今天', book: '工作 · 11/27', clothes: '生活 · 11/28' },
      progress: '今天进度', next7: '未来 7 天', next7N: '4 件', byProj: '按项目', projects: [['生活', 3], ['工作', 2]],
      notesSub: '5 条 · 今天记了 5 条', newCat: '＋ 新分类',
    },
    exit: '演示 · 回官网',
    // 演示页：详情、输入
    kindEv: '日程', kindTodo: '待办', kindNote: '随手记', fTime: '时间', fRemind: '提醒', fNote: '备注', fCat: '分类',
    remindEv: '提前 10 分钟', remindTodo: '到点提醒', demoOnly: '演示里不能改', today: '今天',
    typePh: '说一句，比如：明天下午三点和小金开会', typeLabel: '记一句', send: '记下',
    examples: ['明天下午三点和小金开会', '周六上午十点去游泳', '后天晚上七点看电影'],
    sorting: '正在整理…', saved: '已记下', exHint: '试试这几句',
  },
  ko: {
    lang: 'ko', brand: '레모',
    date: '11월 24일 화요일',
    live: '진행 중', now: '지금 10:20', ev: '제품 주간 회의',
    late: '놓친 일', lateDays: '1일 지남', snooze: '미루기', plan: '오늘 일정',
    rows: { dentist: '치과 재진료', food: '고양이 사료 사기', mom: '엄마한테 전화하기', momSub: '20:00 알림', dinner: '수진이랑 저녁',
      report: '분기 보고서 제출', ticket: '주말 기차표 예매', ticketSub: '오늘 마감', clothes: '겨울옷 정리', clothesSub: '이번 주', book: '수진이 책 돌려주기', bookSub: '금요일' },
    tabs: { today: '오늘', cal: '캘린더', todo: '할 일', notes: '메모' },
    todoSub: '11월 24일 화요일 · 1 / 6 완료', todoChips: [['전체', 6, ''], ['일', 2, 'work'], ['생활', 4, 'life']],
    todoSec: { over: '기한 지남', today: '오늘', later: '나중에', done: '완료' },
    notesSub: '11월 24일 화요일 · 모두 5개', all: '전체',
    vaultSec: '비밀', vault: '비밀 메모', vaultState: '잠김 · 비밀번호로 열기', notesToday: '오늘', noteInput: '떠오른 걸 한 줄로…',
    notes: [['주말에 갈 카페: 강변에 있는 곳, 노트북 챙기기', 0], ['우유, 달걀, 고양이 모래, 세제', 1], ['새 프로젝트 이름은 ‘맑음’ 어때', 2], ['건강검진 결과 목요일에 나옴, 받으러 가기', 3], ['수진이가 그 헌책 표지가 좋대', 4]],
    cats: ['장소', '쇼핑', '아이디어', '건강', '친구'],
    fmt: { month: '{m}월', calSub: '2026년 · 이번 달 {n}개', day: '{m}월 {d}일 {w}요일', md: '{m}월 {d}일', count: '{n}개' },
    calSeg: ['주', '월', '기념일'], calToday: '오늘', wd: ['일', '월', '화', '수', '목', '금', '토'], allDay: '종일',
    tomorrow: '내일', after: '모레', none: '이날은 일정이 없어요', prevMonth: '이전 달', nextMonth: '다음 달',
    ev2: { weekly: ['주간 회의', '제품 주간 회의'], check: ['건강검진', '건강검진'], meet: ['김 대리 회의', '김 대리랑 회의'], bday: ['수진 생일', '수진 생일'], expo: ['전시회', '전시회 보기'],
      movie: ['영화', '영화 보기'], anniv: ['결혼기념일', '결혼기념일'], party: ['송년회', '송년회'], xmas: ['크리스마스', '크리스마스 모임'], dentist: ['치과', '치과 재진료'], dinner: ['저녁', '수진이랑 저녁'], move: ['이사', '김 대리 이사 돕기'] },
    lunar: (m, d, term) => term ?? `${m}.${d}`,
    terms: { 18: '한로', 19: '상강', 20: '입동', 21: '소설', 22: '대설', 23: '동지' },
    lockTitle: '비밀 메모가 잠겨 있어요', lockOr: '또는 비밀번호 입력',
    said: '“내일 오후 세 시에 김 대리랑 회의”', cardTag: '일정', cardTitle: '김 대리랑 회의', cardWhen: '내일 11월 25일 15:00',
    listening: '듣고 있어요…',
    web: {
      ai: 'AI 도우미', aiPh: '물어보거나 누르고 말하세요',
      watch: { today: '오늘 보는 중', cal: '캘린더 보는 중', todo: '할 일 보는 중', notes: '메모 보는 중' },
      ask: { today: ['오늘 뭐부터 할까?', '내일 뭐 있어?', '오늘 일정 짜 줘'], cal: ['이번 주 언제 한가해?', '다음 주에 뭐 있어?', '다가오는 기념일은?'],
        todo: ['제일 급한 건?', '기한 지난 건?', '프로젝트별로 보기'], notes: ['이번 주 메모 요약', '최근에 뭐 적었지?', '할 일로 바꿀 만한 거 있어?'] },
      todaySub: '음력 10월 16일 · 3일 후 수진 생일', next: '다음 14:00 치과 재진료 · 3시간 40분 후',
      fortune: '오늘의 운세', fortuneSet: '생일 입력', fortuneQ: '사주로 매일 운세를 볼까요?', week: '이번 주', soon: '다가오는 날', anniv: '기념일',
      soonRows: [['수진 생일', '3일 후'], ['결혼기념일', '9일 후']],
      sched: '오늘 일정', todos: '오늘 할 일', done: '완료 1', momDue: '20:00 마감',
      todoChips: [['전체', 5], ['생활', 3], ['일', 2]],
      metas: { report: '! 기한 지남 11/23 · 일', mom: '생활 · 오늘 20:00', ticket: '생활 · 오늘', book: '일 · 11/27', clothes: '생활 · 11/28' },
      progress: '오늘 진행', next7: '앞으로 7일', next7N: '4개', byProj: '프로젝트별', projects: [['생활', 3], ['일', 2]],
      notesSub: '5개 · 오늘 5개 기록', newCat: '＋ 새 분류',
    },
    exit: '데모 · 홈으로',
    kindEv: '일정', kindTodo: '할 일', kindNote: '메모', fTime: '시간', fRemind: '알림', fNote: '메모', fCat: '분류',
    remindEv: '10분 전', remindTodo: '제시간에 알림', demoOnly: '데모에서는 고칠 수 없어요', today: '오늘',
    typePh: '한마디 적어 보세요. 예: 내일 오후 세 시에 김 대리랑 회의', typeLabel: '한 줄 기록', send: '기록',
    examples: ['내일 오후 세 시에 김 대리랑 회의', '토요일 오전 열 시에 수영', '모레 저녁 일곱 시에 영화'],
    sorting: '정리하는 중…', saved: '기록했어요', exHint: '이렇게 말해 보세요',
  },
};

const fill = (tpl, v) => tpl.replace(/\{(\w+)\}/g, (_, k) => String(v[k]));
for (const t of Object.values(L)) {
  t.month = (m) => fill(t.fmt.month, { m });
  t.calSub = (n) => fill(t.fmt.calSub, { n });
  t.dayLabel = (m, d, w) => fill(t.fmt.day, { m, d, w: t.wd[w] });
  t.count = (n) => fill(t.fmt.count, { n });
}

function lunarZh(d) {
  const n = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (d <= 10) return '初' + n[d];
  if (d < 20) return '十' + n[d - 10];
  if (d === 20) return '二十';
  if (d < 30) return '廿' + n[d - 20];
  return '三十';
}

// 日历上的示例日程：日期 → [[时间或 null（全天）, 事件键, 颜色]]
const EVENTS = (() => {
  const e = {};
  const add = (date, tm, k, c) => (e[date] ??= []).push([tm, k, c]);
  for (const d of ['10-06', '10-13', '10-20', '10-27', '11-03', '11-10', '11-17', '11-24', '12-01', '12-08', '12-15', '12-22', '12-29']) add(`2026-${d}`, '10:00', 'weekly', 'y');
  add('2026-10-17', '19:00', 'movie', 'b');
  add('2026-10-31', '09:00', 'move', 'y');
  add('2026-11-19', '09:30', 'check', 'b');
  add('2026-11-24', '14:00', 'dentist', 'b');
  add('2026-11-24', '19:30', 'dinner', 'p');
  add('2026-11-25', '15:00', 'meet', 'y');
  add('2026-11-27', null, 'bday', 'p');
  add('2026-11-28', '14:00', 'expo', 'b');
  add('2026-12-03', null, 'anniv', 'p');
  add('2026-12-12', '18:00', 'party', 'b');
  add('2026-12-25', '19:00', 'xmas', 'p');
  return e;
})();

// ---------- App 画面的小部件 ----------
const T = (l) => L[l];
const ck = (done = false) => `<span class="ck${done ? ' done' : ''}" role="checkbox" aria-checked="${done}"></span>`;
const hml = (on) => `<span class="hml">${['H', 'M', 'L'].map((x) => `<span${x === on ? ' class="on"' : ''}>${x}</span>`).join('')}</span>`;
const evRow = (tm, title, bar = '') =>
  `<div class="rw" data-kind="ev" data-when="${tm}"><span class="tm">${tm}</span><span class="tx">${bar ? `<i class="bar ${bar}"></i>` : ''}<span class="tt">${title}</span></span></div>`;
const todoRow = (title, sub, pr, done = false, red = false, cat = '') =>
  `<div class="rw rw-todo" data-kind="todo"${cat ? ` data-cat="${cat}"` : ''}>${ck(done)}<span class="tx${done ? ' strike' : ''}"><span class="dt"></span><span class="tt${done ? ' is-struck' : ''}">${title}</span>${sub ? `<small${red ? ' class="red"' : ''}>${sub}</small>` : ''}</span>${pr ? hml(pr) : ''}</div>`;
const lateCard = (t) =>
  `<div class="lt"><div class="rw rw-todo" data-kind="todo">${ck()}<span class="tx"><span class="dt"></span><span class="tt">${t.rows.report}</span><small class="red">${t.lateDays}</small></span><span class="pp">${ic('clock')}${t.snooze}</span></div></div>`;
const header = (title, sub, sub2 = '') =>
  `<div class="ap-hd"><div><p class="ap-t">${title}</p><span class="ap-bar"></span>${sub ? `<p class="ap-sub"${sub2}>${sub}</p>` : ''}</div><span class="ap-me">${ic('me')}</span></div>`;
const mascot = (cls = '') => `<span class="ms${cls}"><i></i></span>`;
const nowCard = (t) =>
  `<div class="nc"><div class="nc-top"><span class="pill">${t.live}</span><span class="nc-now">${t.now}</span></div>` +
  `<p class="nc-t">${t.ev}</p><div class="trk"><i></i><b></b></div><div class="nc-ts"><span>10:00</span><span>11:00</span><span>12:00</span></div>${mascot()}</div>`;
const PAGES = ['today', 'cal', 'todo', 'notes'];
const tabbar = (t, on, live = false) => {
  const i = PAGES.indexOf(on);
  if (!live) {
    return `<div class="tb"><span class="drop" data-i="${i}"></span>${PAGES.map((k) => `<span${k === on ? ' class="on"' : ''}>${ic(k)}<span>${t.tabs[k]}</span></span>`).join('')}</div>` +
      `<span class="fab">${ic('plus')}</span>`;
  }
  return `<div class="tb"><span class="drop drop-live" data-i="${i}"></span>${PAGES.map((k) => `<button type="button" data-go="${k}"${k === on ? ' class="on" aria-current="page"' : ''}>${ic(k)}<span>${t.tabs[k]}</span></button>`).join('')}</div>` +
    `<button type="button" class="fab" data-plus="1" aria-label="${t.typeLabel}">${ic('plus')}</button>`;
};
const sl = (label, n, red = false) => `<div class="sl${red ? ' red' : ''}"><span>${red ? '! ' : ''}${label}</span>${n == null ? '' : `<b>${n}</b>`}</div>`;

function todayList(t) {
  return `<div class="lc" data-list="today">${evRow('14:00', t.rows.dentist)}${todoRow(t.rows.food, '', 'M', true)}${todoRow(t.rows.mom, t.rows.momSub, 'M')}${evRow('19:30', t.rows.dinner)}</div>`;
}

// 一个月的格子：周日开头，5 行或 6 行。live（演示页能点的那份）才带 data-iso、data-day 和 data-list（这一天的日程：时间~标题~颜色，竖线隔开；
// 只有这里写死的示例，演示脚本载入时读进 Map，之后新记的不往这串里拼）
function monthGrid(t, y, m, live = false) {
  const first = new Date(Date.UTC(y, m - 1, 1));
  const start = new Date(first.getTime() - first.getUTCDay() * 864e5);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const rows = Math.ceil((first.getUTCDay() + days) / 7);
  let cells = '';
  let n = 0;
  for (let i = 0; i < rows * 7; i++) {
    const d = new Date(start.getTime() + i * 864e5);
    const iso = d.toISOString().slice(0, 10);
    const inM = d.getUTCMonth() === m - 1;
    const [lm, ld, term] = lunarOf(iso);
    const lab = t.lunar(lm, ld, term ? t.terms[term] : undefined);
    const wk = i % 7 === 0 || i % 7 === 6;
    const evs = EVENTS[iso] ?? [];
    if (inM) n += evs.length;
    const shown = evs.filter((e) => e[1] !== 'dentist' && e[1] !== 'dinner');
    const ems = (inM ? shown.slice(0, 2).map(([, k, c]) => `<em class="${c}">${t.ev2[k][0]}</em>`).join('') : '') + (inM && evs.length > shown.slice(0, 2).length ? `<em class="more">+${evs.length - shown.slice(0, 2).length}</em>` : '');
    const list = evs.map(([tm, k, c]) => `${tm ?? t.allDay}~${t.ev2[k][1]}~${c}`).join('|');
    const cls = [inM ? '' : 'mute', wk ? 'wk' : '', iso === '2026-11-24' ? 'today sel' : ''].filter(Boolean).join(' ');
    const data = live ? ` data-iso="${iso}" data-day="${t.dayLabel(d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())}" data-list="${list}"` : '';
    cells += `<div${cls ? ` class="${cls}"` : ''}${data}><b>${d.getUTCDate()}</b><small>${lab}</small>${ems}</div>`;
  }
  return { html: `<div class="cal rows${rows}">${cells}</div>`, n };
}
const calWd = (t) => `<div class="cal-wd">${t.wd.map((w) => `<span>${w}</span>`).join('')}</div>`;

const SCREENS = {
  today: (t, { bar = true, live = false } = {}) =>
    `<div class="ap pg" data-page="today">${header(t.date)}${nowCard(t)}${sl(t.late, 1, true)}${lateCard(t)}${sl(t.plan, 4)}${todayList(t)}</div>` +
    (bar ? tabbar(t, 'today', live) : ''),
  todo: (t) =>
    `<div class="ap pg" data-page="todo">${header(t.tabs.todo, t.todoSub)}<div class="chips" data-filter="todo">${t.todoChips.map(([n, c, k], i) => `<span data-f="${k}"${i === 0 ? ' class="on"' : ''}>${n} <b>${c}</b></span>`).join('')}</div>` +
    `<div class="sec" data-sec="over">${sl(t.todoSec.over, 1, true)}<div class="lt">${todoRow(t.rows.report, t.lateDays, 'H', false, true, 'work')}</div></div>` +
    `<div class="sec" data-sec="today">${sl(t.todoSec.today, 2)}<div class="lc">${todoRow(t.rows.ticket, t.rows.ticketSub, 'M', false, false, 'life')}${todoRow(t.rows.mom, t.rows.momSub, 'M', false, false, 'life')}</div></div>` +
    `<div class="sec" data-sec="later">${sl(t.todoSec.later, 2)}<div class="lc">${todoRow(t.rows.clothes, t.rows.clothesSub, 'L', false, false, 'life')}${todoRow(t.rows.book, t.rows.bookSub, 'L', false, false, 'work')}</div></div>` +
    `<div class="sec" data-sec="done">${sl(t.todoSec.done, 1)}<div class="lc">${todoRow(t.rows.food, '', null, true, false, 'life')}</div></div></div>`,
  notes: (t) => {
    const card = ([text, c]) => `<div class="nt" data-kind="note" data-cat="c${c}"><p class="tt">${text}</p><span class="nt-ft"><span class="cat c${c}">${t.cats[c]}</span>${ic('more', 'ic more')}</span></div>`;
    const left = [0, 2, 4].map((i) => card(t.notes[i])).join('');
    const right = [1, 3].map((i) => card(t.notes[i])).join('');
    return `<div class="ap pg" data-page="notes">${header(t.tabs.notes, t.notesSub)}<div class="chips" data-filter="notes"><span data-f="" class="on">${t.all} <b>5</b></span>${t.cats.map((c, i) => `<span data-f="c${i}"><i class="cat-dot c${i}"></i>${c} <b>1</b></span>`).join('')}</div>` +
      `${sl(t.vaultSec, null)}<div class="vr" data-kind="vault">${ic('lock')}<span>${t.vault}</span><small>${t.vaultState} ›</small></div>` +
      `${sl(t.notesToday, 5)}<div class="nts"><div>${left}</div><div>${right}</div></div>` +
      `<div class="ni"><span>${t.noteInput}</span><span class="ni-b">${ic('img')}</span></div></div>`;
  },
  cal: (t, { months = [11], live = false } = {}) => {
    const grids = months.map((m) => {
      const g = monthGrid(t, 2026, m, live);
      return `<div class="cal-m" data-m="${m}" data-title="${t.month(m)}" data-sub="${t.calSub(g.n)}"${m === 11 ? '' : ' hidden'}>${g.html}</div>`;
    }).join('');
    const nov = monthGrid(t, 2026, 11);
    return `<div class="ap pg" data-page="cal">${header(`<span data-cal-title>${t.month(11)}</span>${ic('down', 'ic dn')}`, t.calSub(nov.n), ' data-cal-sub')}` +
      `<div class="cal-bar"><span class="seg3">${t.calSeg.map((s, i) => `<span${i === 1 ? ' class="on"' : ''}>${s}</span>`).join('')}</span>${live
      ? `<span class="cal-nav"><button type="button" class="rd" data-flip="-1" aria-label="${t.prevMonth}">${ic('left')}</button><button type="button" class="pl" data-flip="0">${t.calToday}</button><button type="button" class="rd" data-flip="1" aria-label="${t.nextMonth}">${ic('right')}</button></span>`
      : `<span class="cal-nav"><span class="rd">${ic('left')}</span><span class="pl">${t.calToday}</span><span class="rd">${ic('right')}</span></span>`}</div>` +
      `${calWd(t)}<div class="cal-box">${grids}</div>` +
      `<span class="grab"></span><div class="ds-h"><span data-ds-day>${t.dayLabel(11, 24, 2)}</span><span data-ds-n>${t.count(3)}</span></div>` +
      `<div class="lc ds" data-ds>${evRow('10:00', t.ev, 'y')}${evRow('14:00', t.rows.dentist, 'b')}${evRow('19:30', t.rows.dinner, 'p')}</div></div>`;
  },
  lock: (t) =>
    `<div class="lk">${mascot(' ms-lg')}<b>${t.lockTitle}</b><span class="lk-face">${ic('face')}</span><span class="lk-dots"><i></i><i></i><i></i><i></i></span><span>${t.lockOr}</span></div>`,
};

function phone(inner, cls, { live = false, exit = '' } = {}) {
  return `<div class="ph ${cls}"${live ? '' : ' aria-hidden="true"'}><span class="ph-k k-act"></span><span class="ph-k k-vu"></span><span class="ph-k k-vd"></span><span class="ph-k k-pw"></span>` +
    `<div class="ph-bz"><div class="scr"${live ? ' data-app="phone"' : ''}><div class="sb"><span>10:20</span>${SB_ICONS}</div><span class="di"></span>${exit}${inner}<span class="hi"></span></div></div></div>`;
}

// ---------- 网页版窗口（照真 App 网页版：左边竖栏、中间一页、右边常驻 AI 栏；按 1440×900 排好，外面整体缩放） ----------
// 数字用等宽字（真 App 的 .num）
const mono = (s) => String(s).replace(/\d+(?:[:/]\d+)?/g, (m) => `<span class="n">${m}</span>`);
// 网页版用的待办：[键, 截止日, 截止时间, 优先级, 项目（0 生活、1 工作）]；照真 App 对照截图时的示例数据
const WTODO = [
  ['report', '2026-11-23', null, 'H', 1],
  ['mom', '2026-11-24', '20:00', 'M', 0],
  ['ticket', '2026-11-24', null, 'M', 0],
  ['book', '2026-11-27', null, 'L', 1],
  ['clothes', '2026-11-28', null, 'L', 0],
];
const ANNIV = new Set(['2026-11-27', '2026-12-03']); // 有纪念日的日子：月历格子里农历后面画小爱心
const WEEK_N = [0, 1, 5, 1, 0, 1, 2]; // 11-22～11-28 每天几件（日程加待办），“本周”卡的柱子
const NEXT7 = [55, 5, 5, 36, 36, 5, 5]; // 待办页“未来 7 天”：从今天（周二）起每天的柱高（设计像素，走 CSS 类）
const NOTE_TM = ['09:50', '09:20', '08:50', '08:20', '07:50'];

const wTodoRow = (t, k, sub, pr, { snooze = false, red = false } = {}) =>
  `<div class="rw rw-todo" data-kind="todo">${ck()}<span class="tx"><span class="dt p-${pr.toLowerCase()}"></span><span class="tt">${t.rows[k]}</span><small${red ? ' class="red"' : ''}>${mono(sub)}</small></span>` +
  `${snooze ? `<span class="pp">${ic('later')}${t.snooze}</span>` : hml(pr)}</div>`;
const wCh = (label, right = '') => `<p class="w-ch"><span>${label}</span>${right}</p>`;
const wHead = (title, sub, right = '', subAttr = '') =>
  `<div class="w-hd"><div><p class="w-t">${title}</p><p class="w-s"${subAttr}>${sub}</p></div>${right}</div>`;
const wChip = (label, n, on = false, dot = '') =>
  `<span${on ? ' class="on"' : ''}>${dot ? `<i class="cd ${dot}"></i>` : ''}${label}${n == null ? '' : `<b>${n}</b>`}</span>`;
const soonCard = (w) =>
  `<div class="w-card w-soon">${wCh(w.soon, `<span>${w.anniv}</span>`)}${w.soonRows.map(([n, d]) => `<p><span>${d}</span><b>${n}</b></p>`).join('')}</div>`;

function wToday(t, w) {
  const now = `<div class="w-now"><p class="w-nt"><span class="pill">${t.live}</span><span>${mono(t.now)}</span></p><p class="w-ev">${t.ev}</p>` +
    '<div class="w-trk"><i class="l"></i><i class="s"><b></b></i><i class="r"></i><span class="m"></span></div>' +
    `<p class="w-ticks">${['10:00', '11:00', '12:00', '13:00'].map((x) => `<span>${x}</span>`).join('')}</p><p class="w-nx">${mono(w.next)}</p>${mascot()}</div>`;
  const fortune = `<div class="w-card w-fort">${wCh(w.fortune, `<span>${w.fortuneSet} ›</span>`)}<p>${w.fortuneQ}</p></div>`;
  const strip = `<div class="w-card w-strip">${WEEK_N.map((_, i) => {
    const d = 22 + i;
    const evs = (EVENTS[`2026-11-${d}`] ?? []).filter((e) => e[0]);
    return `<div${d === 24 ? ' class="on"' : ''}><p><span>${t.wd[i]}</span><b>${d}</b></p>${evs.map(([, k, c]) => `<i${c === 'y' ? ' class="y"' : ''}>${t.ev2[k][1]}</i>`).join('')}</div>`;
  }).join('')}</div>`;
  const bars = `<div class="w-card w-bars">${wCh(w.week, `<span>${t.count(10)}</span>`)}<div class="w-bs">${WEEK_N.map((n, i) =>
    `<span${i === 2 ? ' class="on"' : ''}><small>${n || ''}</small><i class="f${n}"></i><em>${t.wd[i]}</em></span>`).join('')}</div></div>`;
  const sched = `<div class="w-card">${wCh(w.sched, '<b>3</b>')}<div class="lc w-sch" data-list="today">${evRow('10:00', t.ev)}${evRow('14:00', t.rows.dentist)}${evRow('19:30', t.rows.dinner)}</div></div>`;
  const todos = `<div class="w-card">${wCh(w.todos, '<b>4</b>')}<div class="lc w-tds" data-list="today-todo">` +
    `${wTodoRow(t, 'report', t.lateDays, 'H', { snooze: true })}${wTodoRow(t, 'mom', w.momDue, 'M')}${wTodoRow(t, 'ticket', t.rows.ticketSub, 'M')}</div><p class="w-fold">${mono(w.done)} ›</p></div>`;
  return wHead(t.date, w.todaySub) + `<div class="w-pg w-today">${now}${fortune}${strip}${bars}<div class="w-row3">${sched}${todos}${soonCard(w)}</div></div>`;
}

// 网页版月历：真 App 月视图固定六排（2026-11-01 正好是周日）；格子里日程、待办都画标签（照 shared/logic/short.ts 缩成 4 个字），最多 4 条再“+N”
function webMonth(t, live) {
  const start = Date.UTC(2026, 10, 1);
  let cells = '';
  let n = 0;
  for (let i = 0; i < 42; i++) {
    const d = new Date(start + i * 864e5);
    const iso = d.toISOString().slice(0, 10);
    const inM = d.getUTCMonth() === 10;
    const [lm, ld, term] = lunarOf(iso);
    const marks = [
      ...(EVENTS[iso] ?? []).filter((e) => e[0]).map(([, k, c]) => [itemShort(t.ev2[k][1]), c === 'y' ? 'y' : 'g']),
      ...WTODO.filter((x) => x[1] === iso).sort((a, b) => (a[2] ? 1 : 0) - (b[2] ? 1 : 0)).map(([k, , , , p]) => [itemShort(t.rows[k]), p ? 'y' : 'o']),
    ];
    if (inM) n += marks.length;
    const cls = [inM ? '' : 'mute', i % 7 === 0 || i % 7 === 6 ? 'wk' : '', iso === '2026-11-24' ? 'today' : ''].filter(Boolean).join(' ');
    const ems = marks.slice(0, 4).map(([s, c]) => `<em class="${c}">${s}</em>`).join('') + (marks.length > 4 ? `<em class="more">+${marks.length - 4}</em>` : '');
    cells += `<div${cls ? ` class="${cls}"` : ''}${live ? ` data-iso="${iso}"` : ''}><b>${d.getUTCDate()}</b><small>${t.lunar(lm, ld, term ? t.terms[term] : undefined)}${ANNIV.has(iso) ? HEART : ''}</small>${ems}</div>`;
  }
  return { html: `<div class="w-cal">${cells}</div>`, n };
}

function wCal(t, w, live) {
  const g = webMonth(t, live);
  const right = `<div class="w-calbar"><span class="w-seg">${t.calSeg.map((s, i) => `<span${i === 1 ? ' class="on"' : ''}>${s}</span>`).join('')}</span>` +
    `<span class="w-nav"><span>‹</span><span>${t.calToday}</span><span>›</span></span></div>`;
  const evs = [['10:00', t.ev, 'y'], ['14:00', t.rows.dentist, 'g'], ['19:30', t.rows.dinner, 'g']];
  const day = `<div class="w-card w-dayc"><p class="w-dh"><span>${t.dayLabel(11, 24, 2)}</span><span>${t.count(5)}</span></p>` +
    `<div class="w-pn">${evs.map(([tm, x, c]) => `<div class="rw"><span class="tm">${tm}</span><i class="bar ${c}"></i><span class="tt">${x}</span></div>`).join('')}</div>` +
    `<p class="w-dt"><i></i>${t.kindTodo} · 2</p><div class="w-pn">${wTodoRow(t, 'mom', w.metas.mom, 'M')}${wTodoRow(t, 'ticket', w.metas.ticket, 'M')}</div></div>`;
  return wHead(t.month(11), t.calSub(g.n), right, live ? ` data-m="11" data-n="${g.n}"` : '') +
    `<div class="w-pg w-calp"><div class="w-card w-month"><p class="w-wd">${t.wd.map((x) => `<span>${x}</span>`).join('')}</p>${g.html}</div>${day}${soonCard(w)}</div>`;
}

function wTodoPage(t, w) {
  const chips = `<div class="w-chips">${w.todoChips.map(([n, c], i) => wChip(n, c, i === 0)).join('')}</div>`;
  const sec = (label, n, rows, due, red = false) =>
    `<div class="w-sec${red ? ' red' : ''}"${due ? ` data-due="${due}"` : ''}><p class="w-gh"><span>${label}</span><b>${n}</b></p><div class="lc w-pn">${rows}</div></div>`;
  const side = `<div class="w-side"><div class="w-card">${wCh(w.progress, `<span>1 / 3</span>`)}<span class="w-pb w33"><i></i></span></div>` +
    `<div class="w-card">${wCh(w.next7, `<span>${w.next7N}</span>`)}<div class="w-bs7">${NEXT7.map((h, i) =>
      `<span${i === 0 ? ' class="on"' : ''}><i class="h${h}"></i><em>${t.wd[(i + 2) % 7]}</em></span>`).join('')}</div></div>` +
    `<div class="w-card w-proj">${wCh(w.byProj)}${w.projects.map(([n, c], i) => `<p><span>${n}</span><span>${c}</span></p><span class="w-pb ${i ? 'w40' : 'w60'}"><i></i></span>`).join('')}</div></div>`;
  return wHead(t.tabs.todo, t.todoSub, chips) + '<div class="w-pg w-todop"><div class="w-card w-tl">' +
    sec(`! ${t.todoSec.over}`, 1, wTodoRow(t, 'report', w.metas.report, 'H', { snooze: true, red: true }), '', true) +
    sec(t.todoSec.today, 2, wTodoRow(t, 'mom', w.metas.mom, 'M') + wTodoRow(t, 'ticket', w.metas.ticket, 'M'), '2026-11-24') +
    sec(t.dayLabel(11, 27, 5), 1, wTodoRow(t, 'book', w.metas.book, 'L'), '2026-11-27') +
    sec(t.dayLabel(11, 28, 6), 1, wTodoRow(t, 'clothes', w.metas.clothes, 'L'), '2026-11-28') +
    `<p class="w-fold">${mono(w.done)} ›</p></div>${side}</div>`;
}

function wNotes(t, w) {
  const chips = `<div class="w-chips">${wChip(t.all, 5, true)}${t.cats.map((c, i) => wChip(c, 1, false, `wc${i}`)).join('')}${wChip(w.newCat)}</div>`;
  const rows = t.notes.map(([text, c], i) =>
    `<div class="w-nr"><span class="tt">${text}</span><small><i class="cd wc${c}"></i>${t.cats[c]}</small><span class="n">${NOTE_TM[i]}</span>${ic('more', 'ic more')}</div>`).join('');
  return wHead(t.tabs.notes, w.notesSub, chips) +
    `<div class="w-pg w-notesp"><p class="w-gl">${t.vaultSec}</p><div class="w-vault">${LOCK_SOLID}<span>${t.vault}</span><small>${t.vaultState} ›</small></div>` +
    `<p class="w-gh"><span>${t.notesToday}</span><b>5</b></p><div class="w-nl">${rows}</div>` +
    `<div class="w-ni"><span>${t.noteInput}</span><span class="w-img">${ic('img')}</span></div></div>`;
}

function browser(t, page, live = false) {
  const w = t.web;
  const go = (k) => (live ? ` data-go="${k}"` : '');
  const rail = `<div class="rail"><span class="rail-plus"${live ? ` data-plus="1" aria-label="${t.typeLabel}"` : ''}>${ic('plus')}</span>` +
    `${PAGES.map((k) => `<span${go(k)}${k === page ? ' class="on"' : ''}>${ic(k)}${t.tabs[k]}</span>`).join('')}<span class="rail-me">${ic('me')}</span></div>`;
  const ai = `<div class="w-ai"><div class="w-aih"><span class="orb"></span><p><b>${w.ai}</b><span>${w.watch[page]}</span></p></div>` +
    `<p class="w-ask">${w.ask[page].map((q) => `<span>${q}</span>`).join('')}</p><div class="w-in"><span>${w.aiPh}</span><span class="mic">${ic('mic')}</span></div></div>`;
  const main = page === 'today' ? wToday(t, w) : page === 'cal' ? wCal(t, w, live) : page === 'todo' ? wTodoPage(t, w) : wNotes(t, w);
  return `<div class="br"${live ? '' : ' aria-hidden="true"'}><div class="br-bar"${live ? ' aria-hidden="true"' : ''}><span class="br-dots"><i></i><i></i><i></i></span><span class="br-nav">${ic('left')}${ic('right')}</span>` +
    `<span class="br-url">${ic('lock')}lemomemo.com/app/</span></div><div class="dk dk-${page}"${live ? ' data-app="web"' : ''}>${rail}<div class="dk-main">${main}</div>${ai}</div></div>`;
}

// ---------- 演示页用的模板（脚本复制后用 textContent 填字，不拼 HTML） ----------
function demoTemplates(t) {
  const detail = `<template id="tpl-detail"><div class="ap pg dt-pg" data-page="detail"><button type="button" class="back" data-back="1">${ic('left')}<span data-slot="back"></span></button>` +
    `<p class="dt-kind" data-slot="kind"></p><p class="dt-title" data-slot="title"></p>` +
    `<div class="lc dt-rows"><div class="rw"><span class="k">${ic('clock')}${t.fTime}</span><span class="v" data-slot="when"></span></div>` +
    `<div class="rw"><span class="k">${ic('bell')}${t.fRemind}</span><span class="v" data-slot="remind"></span></div>` +
    `<div class="rw"><span class="k">${ic('note')}${t.fNote}</span><span class="v muted">${t.demoOnly}</span></div></div></div></template>`;
  const lock = `<template id="tpl-lock"><div class="ap pg dt-pg dt-lock" data-page="detail"><button type="button" class="back" data-back="1">${ic('left')}<span>${t.tabs.notes}</span></button>${SCREENS.lock(t)}</div></template>`;
  const type = `<template id="tpl-type"><div class="dim"></div><div class="vs ts" role="dialog" aria-modal="true" aria-label="${t.typeLabel}"><span class="grab"></span>` +
    `<div class="ti"><input type="text" enterkeyhint="done" autocomplete="off" aria-label="${t.typeLabel}" placeholder="${t.typePh}"><button type="button" class="send" aria-label="${t.send}">${ic('up')}</button></div>` +
    `<p class="ex-h">${t.exHint}</p><div class="ex">${t.examples.map((e) => `<button type="button">${e}</button>`).join('')}</div>` +
    `<p class="vs-l" data-slot="sorting" hidden>${t.sorting}</p>` +
    `<div class="vc" hidden><span class="vc-tag" data-slot="kind"></span><b data-slot="title"></b><span data-slot="when"></span></div></div></template>`;
  const row = `<template id="tpl-row"><div class="rw fx-row" data-kind="ev"><span class="tm" data-slot="tm"></span><span class="tx"><span class="tt" data-slot="title"></span><small data-slot="sub"></small></span></div></template>`;
  const todo = `<template id="tpl-todo"><div class="rw rw-todo fx-row" data-kind="todo">${ck()}<span class="tx"><span class="dt"></span><span class="tt" data-slot="title"></span><small data-slot="sub"></small></span></div></template>`;
  // 网页版待办页按日期分组：记到还没有分组的日子时新开一组（data-due 和组名由 demo.js 填）
  const wsec = '<template id="tpl-wsec"><div class="w-sec"><p class="w-gh"><span data-slot="day"></span><b>0</b></p><div class="lc w-pn"></div></div></template>';
  const toast = `<template id="tpl-toast"><div class="toast" role="status"></div></template>`;
  const spark = `<template id="tpl-spark"><span class="spark"><b><i></i></b><b><i></i></b><b><i></i></b><b><i></i></b><b><i></i></b><b><i></i></b></span></template>`;
  const w = { kindEv: t.kindEv, kindTodo: t.kindTodo, kindNote: t.kindNote, remindEv: t.remindEv, remindTodo: t.remindTodo, today: t.today, saved: t.saved,
    tomorrow: t.tomorrow, after: t.after, none: t.none, wd: t.wd.join(','), calSub: t.fmt.calSub, day: t.fmt.day, md: t.fmt.md, count: t.fmt.count };
  const words = `<template id="tpl-words">${Object.entries(w).map(([k, v]) => `<span data-w="${k}">${v}</span>`).join('')}</template>`;
  return detail + lock + type + row + todo + wsec + toast + spark + words;
}

// 演示页的手机：四个页签都在一块屏幕里，底栏共用
function demoPhone(t, l) {
  const exit = `<a class="demo-exit" href="/${l}/">${t.exit}</a>`;
  const pages = `<div class="pages">${SCREENS.today(t, { bar: false })}${SCREENS.cal(t, { months: [10, 11, 12], live: true })}${SCREENS.todo(t)}${SCREENS.notes(t)}</div>`;
  return phone(pages.replace(/(<div class="ap pg" data-page="(?:cal|todo|notes)")/g, '$1 hidden') + tabbar(t, 'today', true), 'ph-demo', { live: true, exit });
}

const COPY = {
  zh: {
    nav: ['功能', '多端', '隐私', '常见问题'], navLabel: '主导航', demo: '演示', start: '开始使用', footLabel: '页脚', langLabel: '语言',
    privacy: '隐私说明', terms: '使用条款', win: '下载 Windows 版',
  },
  ko: {
    nav: ['기능', '여러 기기', '개인정보', '자주 묻는 질문'], navLabel: '주 메뉴', demo: '데모', start: '시작하기', footLabel: '바닥글', langLabel: '언어',
    privacy: '개인정보 처리 안내', terms: '이용약관', win: 'Windows 버전 다운로드',
  },
};

// 演示页的脚本，按这个顺序 defer 加载（后面的只依赖前面的，没有互相依赖）
export const DEMO_SCRIPTS = ['demo-kit.js', 'demo-type.js', 'demo-cal.js', 'demo.js'];

function head(l, { title, desc, ogTitle, ogDesc, path, home }) {
  const url = `https://lemomemo.com/${l}/${path}`;
  const xd = home ? 'https://lemomemo.com/' : `https://lemomemo.com/zh/${path}`;
  return `<!doctype html>
<!-- 由 build/site_pages.mjs 生成，改那里再重新生成 -->
<html lang="${T(l).lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="zh-Hans" href="https://lemomemo.com/zh/${path}">
<link rel="alternate" hreflang="ko" href="https://lemomemo.com/ko/${path}">
<link rel="alternate" hreflang="x-default" href="${xd}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${T(l).brand}">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDesc}">
<meta property="og:image" content="https://lemomemo.com/og-${l}.png">
<meta property="og:url" content="${url}">
<meta property="og:locale" content="${l === 'zh' ? 'zh_CN' : 'ko_KR'}">
<meta property="og:locale:alternate" content="${l === 'zh' ? 'ko_KR' : 'zh_CN'}">
<meta name="twitter:card" content="summary_large_image">
${home ? '<link rel="stylesheet" href="/index.css">' : '<link rel="stylesheet" href="/home.css">\n<link rel="stylesheet" href="/demo.css">'}
${home ? '<script src="/lp.js"></script>\n' : ''}<script src="/lang.js" defer></script>
${home
    ? HOME_MODULES.map((f) => `<link rel="modulepreload" href="/${f}">\n`).join('') + '<script type="module" src="/index.js"></script>\n'
    : DEMO_SCRIPTS.map((f) => `<script src="/${f}" defer></script>\n`).join('')}</head>`;
}

const logo = (l) => `<a class="logo" href="/${l}/"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>${T(l).brand}</a>`;
const langSw = (l, where) => {
  const zh = `<a href="/zh/${where}" data-lang="zh" hreflang="zh-Hans"${l === 'zh' ? ' aria-current="true"' : ' lang="zh-Hans"'}>中文</a>`;
  const ko = `<a href="/ko/${where}" data-lang="ko" hreflang="ko"${l === 'ko' ? ' aria-current="true"' : ' lang="ko"'}>한국어</a>`;
  return `${zh} ${ko}`;
};

/** 演示页的页顶（首页的页顶在 site_home.mjs）。四个链接回首页的四节，锚点都要在首页里有（checkSite 查） */
function demoNav(l) {
  const c = COPY[l];
  const ids = ['film', 'dev', 'safe', 'faq'];
  return `<header class="nav">${logo(l)}<nav class="links" aria-label="${c.navLabel}">${c.nav.map((n, i) => `<a href="/${l}/#${ids[i]}">${n}</a>`).join('')}</nav>` +
    `<a class="demo-link" href="/${l}/demo" aria-current="page">${c.demo}</a>` +
    `<nav class="lang" aria-label="${c.langLabel}">${langSw(l, 'demo')}</nav><a class="go" href="/app/">${c.start}</a></header>`;
}

function foot(l, page) {
  const c = COPY[l];
  return `<footer class="foot">${logo(l)}<nav aria-label="${c.footLabel}"><a href="/${l}/privacy">${c.privacy}</a><a href="/${l}/terms">${c.terms}</a><a href="/desktop/">${c.win}</a></nav>` +
    `<nav class="lang" aria-label="${c.langLabel}">${langSw(l, page === 'demo' ? 'demo' : '')}</nav></footer>`;
}

const DEMO = {
  zh: {
    meta: { title: '柠檬记 演示 — 不用注册先看看', desc: '不用注册，先看看柠檬记长什么样：今天、日历、待办、随手记，手机版和网页版都有。内容都是编的示例。', ogTitle: '柠檬记 演示', ogDesc: '不用注册，翻一翻柠檬记的今天、日历、待办和随手记。' },
    h1: ['先看看', '长什么样'], sub: '不用注册。切手机版、网页版，翻一翻四个页面。',
    dev: ['设备', '手机版', '网页版'], tabs: '页面',
    caps: { today: '打开就是今天：正在进行的、没赶上的、接下来的。', cal: '月历上一眼看到忙不忙，阴历和生日也在。', todo: '分轻重，带截止时间，做完一勾就划掉。', notes: '想到就记，AI 帮你分好类。' },
    tries: ['点待办前面的方框，勾掉它', '点黄色的“＋”，看一句话变成日程', '点底栏或左边栏，换页面'],
    note: '照真 App 做的演示，内容都是编的；不连网，你点的、记的都不保存，刷新就回到原样。', stage: 'App 画面',
    after: '想自己用？', need: '需要邀请码',
  },
  ko: {
    meta: { title: '레모 데모 — 가입 없이 둘러보기', desc: '가입 없이 레모를 둘러보세요: 오늘, 캘린더, 할 일, 메모를 휴대폰과 웹 화면으로 볼 수 있어요. 내용은 모두 지어낸 예시예요.', ogTitle: '레모 데모', ogDesc: '가입 없이 레모의 오늘, 캘린더, 할 일, 메모를 넘겨 보세요.' },
    h1: ['먼저', '둘러보기'], sub: '가입은 필요 없어요. 휴대폰과 웹을 바꿔 가며 네 화면을 넘겨 보세요.',
    dev: ['기기', '휴대폰', '웹'], tabs: '화면',
    caps: { today: '열면 바로 오늘: 진행 중인 일, 놓친 일, 다음 일.', cal: '달력에서 바쁜 날이 한눈에 보이고, 음력과 생일도 있어요.', todo: '중요도와 마감을 붙이고, 끝내면 체크 한 번.', notes: '떠오르면 적어 두세요. AI가 분류해 줘요.' },
    tries: ['할 일 앞의 네모를 눌러 체크해 보세요', '노란 “＋”를 누르면 한마디가 일정이 돼요', '하단 탭이나 왼쪽 메뉴로 화면을 바꿔요'],
    note: '실제 앱을 따라 만든 데모예요. 내용은 모두 지어낸 것이고, 인터넷에 연결하지 않으며 누르거나 기록한 건 저장되지 않아요. 새로고침하면 처음으로 돌아가요.', stage: '앱 화면',
    after: '직접 써 볼까요?', need: '초대 코드가 필요해요',
  },
};

function demoPage(l) {
  const t = T(l);
  const d = DEMO[l];
  const c = COPY[l];
  const pages = PAGES;
  const shots = `<div class="shot" data-shot="phone">${demoPhone(t, l)}</div>` +
    pages.map((p) => `<div class="shot shot-web" data-shot="web-${p}" hidden>${browser(t, p, true)}</div>`).join('');
  return `${head(l, { ...d.meta, path: 'demo', home: false })}
<body class="demo-body">
${demoNav(l)}
<main class="demo"><section class="demo-intro" aria-labelledby="demo-h"><h1 id="demo-h"><span>${d.h1[0]}</span><span>${d.h1[1]}</span></h1><p class="demo-sub">${d.sub}</p>` +
`<div class="demo-ctl"><div class="seg" role="group" aria-label="${d.dev[0]}"><button type="button" data-dev="phone" aria-pressed="true">${d.dev[1]}</button><button type="button" data-dev="web" aria-pressed="false">${d.dev[2]}</button></div>` +
`<div class="seg" role="group" aria-label="${d.tabs}">${pages.map((p, i) => `<button type="button" data-tab="${p}" aria-pressed="${i === 0}">${t.tabs[p]}</button>`).join('')}</div>` +
pages.map((p, i) => `<p class="cap" data-cap="${p}"${i ? ' hidden' : ''}>${d.caps[p]}</p>`).join('') +
`<ul class="try">${d.tries.map((x) => `<li>${x}</li>`).join('')}</ul></div><p class="demo-note">${d.note}</p></section>` +
`<section class="demo-stage" aria-label="${d.stage}">${shots}</section>` +
demoTemplates(t) +
`<section class="demo-after"><p>${d.after}</p><a class="go big" href="/app/">${c.start}</a><span>${d.need}</span></section></main>
${foot(l, 'demo')}
</body>
</html>
`;
}

/** 四个页面：{ 'zh/index.html': html, … } */
export function renderPages() {
  const out = {};
  for (const l of ['zh', 'ko']) {
    out[`${l}/index.html`] = homePage(l, { head, langSw, ic });
    out[`${l}/demo.html`] = demoPage(l);
  }
  return out;
}

/** site 目录里的页面和生成的不一样的：[相对路径] */
export function stalePages(siteDir = SITE) {
  return Object.entries(renderPages()).filter(([f, html]) => {
    try {
      return readFileSync(join(siteDir, ...f.split('/')), 'utf8').replace(/\r\n/g, '\n') !== html;
    } catch {
      return true;
    }
  }).map(([f]) => f);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const stale = stalePages();
    if (stale.length) {
      console.error(`这几个页面和 build/site_pages.mjs 生成的不一样（改生成器再跑 node build/site_pages.mjs）：${stale.join('、')}`);
      process.exit(1);
    }
    console.log('四个页面和生成器一致');
  } else {
    for (const [f, html] of Object.entries(renderPages())) writeFileSync(join(SITE, ...f.split('/')), html);
    console.log('已生成四个页面');
  }
}
