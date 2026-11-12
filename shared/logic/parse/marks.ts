// i18n-exempt: 解析词表
// 本机规则的标记和收尾（B3 任务单 BE-2；移植 v3 parse-marks.js；架构 5.1 R-195、续第 150、166、167、170 条，R-200）：
//   • takeNamedKind：原话点名“待办 / 待办事项 / 할 일”记待办、点名“日程 / 일정”记日程（R-195），点名词连同“一个 / 一条 / 하나”去掉；
//     点名词是请求动词（记 / 记下 / 记个 / 登记 / 添加 / 安排 / 등록 / 추가 / 잡아 / 만들어）的宾语才算；
//     “加 / 新建 / 建 / 设 / 넣어”太宽，只在“加一个 / 新建一个 / 建一个 / 设一个 + 点名词”“点名词 + 하나 넣어 / 点名词을(를) 넣어”算；
//     句首“일정 하나:”“할 일 하나 추가해 줘”也算。点名词后接“清单 / 列表 / 表 / 本 / 표 / 목록 / 앱”的是内容，
//     别的动作的宾语（“把日程发给小王”“일정 공유하기”“给日程加个备注”“일정에 메모 넣어”）不算——这些都不落在上面的句式里。
//   • stripRequests：对柠檬记说的请求不进标题，句首句中句尾都去（中韩词表照 5.1）；是事由的不去：
//     “提醒 / 告诉 / 알려”带了别的对象（“提醒小王交材料”，“박 대리에게 일정 알려 주기”）、“登记 / 등록”不带“帮我 / 해 줘”的（“车辆登记”“학원 등록하기”）、
//     “给 / 为 / 帮 + 别人 + 安排”（“给小王安排工作”“帮小王安排面试”）。只删请求说法本身，不改词尾（“우유 사는 걸”照留）。
//   • arrangeHint：原话有“安排时间 / 排一下时间 / 시간 잡아 / 일정 짜”时，提示条加“具体时间请自己排”（R-200）。
//   • takeImportant、findProject、cleanTitle：同 v3（重要只认“重要 / 紧急 / 중요 / 급함”，“不重要 / 안 급함”不算；
//     项目名长的优先、英文名前后不能紧挨字母数字）；标题另去掉口头语（嗯 / 那个 / 음 / 그러니까）和开头的“的 / 并 / 然后”。
import { take, type Rest } from './text.ts';

/** 点名的类型：todo / event；没点名为 null */
export type NamedKind = 'todo' | 'event' | null;

const ZH_TODO = '(?:待办事项|待办)';
const ZH_EVENT = '(?:日程)';
const CONTENT_TAIL = '(?!\\s*(?:清单|列表|表|本|표|목록|앱))';
const KO_TODO = '(?:할\\s*일)';
const KO_EVENT = '(?:일정)(?!표)';

function namedRules(): [RegExp, NamedKind][] {
  const zhVerb = '(?:帮我|给我|替我|请)?\\s*(?:记下|记个|记|登记|添加|安排|등록|추가)\\s*(?:一个|一条|个|条)?\\s*';
  const zhNew = '(?:帮我|给我|替我|请)?\\s*(?:新建|建|加|设)\\s*(?:一个|一条)\\s*';
  const koVerb = '(?:을|를)?\\s*(?:하나\\s*)?(?:등록|추가)(?:해|하여)?\\s*(?:줘|주세요|줄래)?';
  const koVerb2 = '(?:을|를)?\\s*(?:하나\\s*)?(?:잡아|만들어)\\s*(?:줘|주세요)?';
  const koPut = '(?:\\s*하나|을|를)\\s*넣어\\s*(?:줘|주세요)?';
  const koHead = '^\\s*(?:%K)\\s*하나\\s*(?:추가해|등록해|넣어)?\\s*(?:줘|주세요)?\\s*[:：,，]?';
  const out: [RegExp, NamedKind][] = [];
  for (const [zh, ko, kind] of [[ZH_TODO, KO_TODO, 'todo'], [ZH_EVENT, KO_EVENT, 'event']] as const) {
    out.push([new RegExp(zhVerb + zh + CONTENT_TAIL), kind]);
    out.push([new RegExp(zhNew + zh + CONTENT_TAIL), kind]);
    out.push([new RegExp(koHead.replace('%K', ko)), kind]);
    out.push([new RegExp('^\\s*' + zh + '\\s*[:：]'), kind]);   // 句首“日程：”“待办：”
    out.push([new RegExp(ko + koVerb), kind]);
    out.push([new RegExp(ko + koVerb2), kind]);
    out.push([new RegExp(ko + koPut), kind]);
  }
  return out;
}
const NAMED = namedRules();

/** 韩文类型词后面紧跟的复数“들”和助词（“할 일들은”“일정을”“메모도”）：和类型词一起取走，免得剩下“들은”当关键词；
 *  后面还连着别的韩文字（“일정이랑”）就只取类型词本身 */
const KO_KIND_TAIL = '(?:들?(?:은|는|이|가|을|를|도|만)?(?![가-힣]))?';
/** 原话说到的类型词（不看是不是请求动词的宾语；“日程表 / 일정표”不算）：“＋”的查找、取消、改期定 kinds 用 */
const TODO_WORD = new RegExp(`${ZH_TODO}|${KO_TODO}${KO_KIND_TAIL}`, 'g');
const EVENT_WORD = new RegExp(`${ZH_EVENT}(?!表)|${KO_EVENT}${KO_KIND_TAIL}`, 'g');
const NOTE_WORD = new RegExp(`随手记|메모${KO_KIND_TAIL}`, 'g');

/** 取走一类词，返回原话里有没有 */
function takeAll(st: Rest, re: RegExp): boolean {
  const next = st.text.replace(re, ' ');
  const hit = next !== st.text;
  st.text = next;
  return hit;
}

/** 认出并取走原话里的类型词（待办、日程、随手记），返回说到了哪几种；类型词只在这里认 */
export function takeKindWords(st: Rest): { todo: boolean; event: boolean; note: boolean } {
  const todo = takeAll(st, TODO_WORD);
  const event = takeAll(st, EVENT_WORD);
  return { todo, event, note: takeAll(st, NOTE_WORD) };
}

/** 认出点名并取走（点名词、请求动词、“一个 / 하나”一起）；没点名返回 null */
export function takeNamedKind(st: Rest): NamedKind {
  for (const [re, kind] of NAMED) {
    if (take(st, re)) return kind;
  }
  return null;
}

/** 请求说法（长的在前）。韩文只认“…해 줘 / 줘”这种对 App 说的祈使形，“등록하기”“알려 주기”是事由 */
const REQUESTS: RegExp[] = [
  /帮我安排时间|时间你?帮我排一下|帮我排一下时间|排一下时间|帮我排一下/,
  /(?:帮我|给我|替我)安排(?:一个|一下)?/,
  /帮我记一下|帮我记个|帮我记下|帮我登记|记一下|记个/,
  /设置提醒|设个提醒|提醒我一下|提醒一下|提醒我|记得/,
  /(?:帮我)?(?:做|设|建)(?:一)?个倒数日|디데이\s*만들어\s*(?:줘|주세요)/,
  /(?<![에게한테께]\s?)(?:(?:으)?라고\s*)?알려\s*(?:줘|주세요)/,
  /알림으로\s*등록해\s*(?:줘|주세요)|알림\s*설정해\s*(?:줘|주세요)/,
  /등록해\s*(?:줘|주세요)|추가해\s*(?:줘|주세요)|기억해\s*(?:줘|주세요)/,
  /시간\s*잡아\s*(?:줘|주세요)|잡아\s*(?:줘|주세요)/,
];

/** 去掉全部请求说法（一句里可能有几处）；“알려 줘”前面 6 个字内有“에게 / 한테 / 께”的是事由，不去 */
export function stripRequests(st: Rest): void {
  for (const re of REQUESTS) {
    for (let i = 0; i < 4; i++) {
      const m = st.text.match(re);
      if (!m) break;
      if (/알려/.test(m[0]) && /(?:에게|한테|께)\s*\S*\s*$/.test(st.text.slice(0, m.index))) break;
      st.text = st.text.replace(m[0], ' ');
    }
  }
}

const ARRANGE_RE = /安排时间|排一下时间|帮我排一下|时间你?帮我排|시간\s*잡아|일정\s*짜/;
export function arrangeHint(text: string): boolean {
  return ARRANGE_RE.test(text);
}

// 重要。“不重要的事”这类修饰用法：不标重要，标题保留；单独的“不重要 / 안 중요”：不标重要，从标题去掉
const KEEP = ['不重要的', '不紧急的'];
const MARK = (i: number) => String.fromCharCode(0xe001) + String(i);
export function takeImportant(st: Rest): boolean {
  take(st, /^\s*(?:不重要|不紧急)的事\s*[:：]/);   // 句首“不重要的事：”是说明，不进标题（AI 句库 Z18）
  KEEP.forEach((w, i) => { st.text = st.text.split(w).join(MARK(i)); });
  take(st, /不重要|不紧急|안\s*(?:중요|급)(?:함|해|한)?/);
  const hit = Boolean(take(st, /重要的?|紧急的?|중요한|중요(?:함|해)?|급함|급해|긴급/));
  KEEP.forEach((w, i) => { st.text = st.text.split(MARK(i)).join(w); });
  return hit;
}

const isWordChar = (c: string): boolean => /[A-Za-z0-9]/.test(c);
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 项目：名字长的优先、不分大小写；英文名前后不能紧挨英文字母或数字（“UI”不会命中“GUI”） */
export function findProject(text: string, names: readonly string[]): string {
  for (const p of [...names].sort((a, b) => b.length - a.length)) {
    if (!p) continue;
    const re = new RegExp((isWordChar(p.charAt(0)) ? '(?<![A-Za-z0-9])' : '') + esc(p) + (isWordChar(p.charAt(p.length - 1)) ? '(?![A-Za-z0-9])' : ''), 'i');
    if (re.test(text)) return p;
  }
  return '';
}

const EDGE = /^[\s，,。.、；;:：？?]+|[\s，,。.、；;:：？?]+$/g;
const FILLER_HEAD = /^(?:嗯|啊|呃|那个|就是|음|어|그러니까|그)(?=\s|[一-鿿]|$)\s*/;

/** 标题：去掉感叹号、多余空白、首尾标点、开头的“前 / 之前 / 的 / 并 / 然后”、口头语和 v3 的“记得 / 提醒我”等口头请求 */
export function cleanTitle(text: string): string {
  let s = text.replace(/[!！]+/g, ' ').replace(/\s+/g, ' ').replace(/(?<=[一-鿿])\s+(?=[一-鿿])/g, '');
  s = s.replace(/\s*([，,。、；;])(?:\s*[，,。、；;])+/g, '$1').replace(EDGE, '');
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(FILLER_HEAD, '').replace(EDGE, '');
    s = s.replace(/^(?:之前|以前|前|的|并且|并|然后|再|还有|啊|에)\s*/, '').replace(/^(?:在|要|得|记得|提醒我|帮我记一下|记一下)\s*/, '').replace(EDGE, '');
    s = s.replace(/\s*(?:啊|吧|了吧|并|和|还有)$/, '').replace(EDGE, '');
    if (s === before) break;
  }
  return s;
}
