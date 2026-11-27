// ai-chat 的只读工具（R-492；实施计划 3.2）：工具说明、模型给的参数怎么校验、查到的行怎么编号交回模型。纯逻辑，不 import _shared/gen、npm 包。
// • 查记录、联网、看图的六个工具全部只读（第五节风险 2：不给改用户记录的工具）；第 3 段的 remember 只写“记住的事”这张表（R-495）。都登记在一张表 TOOL_TABLE 里：说明、要什么条件才给（need）、参数怎么校验（parse）。
//   给模型哪些（toolsFor）、模型调来的怎么解析（parseCall）都只照这张表，core.ts 按解析出来的 tool 一处 switch 分派；
// • 查库的四个：find_events、find_todos、search_notes、list_anniversaries，need 是它查的那一类（关了哪一类就不给查哪一类的工具，模型硬调按 unknown_tool 回）；
// • 参数先校验、夹到范围里（日子 YYYY-MM-DD、范围最长 RANGE_MAX_DAYS 天、关键词最多 TERMS_MAX 个、每个 ≤ TERM_MAX 字），不合格的回 {error} 交给模型，不查库；
// • 查到的行进 Registry：同一条（kind + id）只编一个序号 n（跨几次工具调用不重号），每个字段过 sanitize（防提示注入），
//   这一轮送出去的字数合计不超过 TOTAL_MAX（记录、网页来源和网页摘要一起算），放不下的不送、不编号（模型就引不到它）；每次最多 ROWS_MAX 条；
// • 隐私记：store 的随手记只查视图 private.ai_chat_notes（迁移 20261122090000，视图本身就不含隐私记、只含本人的行）。
// 第 2 段（联网、看图）的两个工具，也都只读：
// • web_search(q)（need web）：服务器调一次搜索接口（core.ts → WebSearcher.search；11-23 起 Brave / Tavily），搜到的网页进 Registry（kind web，键 web:<url>），
//   和记录一起编号，模型照样用 [n] 引；每页的摘要（findings，一页一段、截到 FINDING_MAX）带上这一页的编号，由模型自己读、自己概括。两家都没配密钥、请求没带 web 就不给；
// • look_note_images(n)（need note 和 images）：看 search_notes 查到的第 n 条随手记里存的图的缩略图（最多 NOTE_IMAGES_MAX 张）。n 只认这一轮送出去的随手记编号，
//   图只从视图 private.ai_chat_notes 连过去取（隐私记的图连不上，store.ts 的 NOTE_IMAGES_SQL），服务商不收图就不给；
// • search_notes 的每条随手记另带它的图已经识别出的描述（note_images.ai_desc，后台 ai-media 识别的），按关键词也能搜到图里的东西。
// 记日程待办（负责人 11-24）：draft_records(items)（need draft：请求带 draft、日程或待办开着）也不写库，只把要记的几段原话交回客户端，
//   客户端用打字条同一套本机规则拆成日程、待办出确认卡片，用户点“记下来”才经 outbox 写（shared/schema/chat.ts 的 drafts）。
import { cutUnits } from '../_shared/ai/cites.ts';
import { PROJECT_LEN, sanitize } from '../_shared/ai/parse-core.ts';
import { TITLE_MAX, type ToolDecl, type WebSource } from '../_shared/ai/provider.ts';
import { cleanText, MEMORY_TEXT_MAX } from '../_shared/memories.ts';

export { TITLE_MAX };

/** 能查的几类（和 shared/schema/chat.ts 的 CHAT_KINDS 相等，tests/edge/ai-chat.test.ts 钉住） */
export const KINDS = Object.freeze(['event', 'todo', 'note', 'anniv'] as const);
export type ChatKind = (typeof KINDS)[number];
export const ROWS_MAX = 30;
export const TOTAL_MAX = 20_000;
export const BODY_MAX = 300;
export const RANGE_MAX_DAYS = 400;
export const TERMS_MAX = 4;
export const TERM_MAX = 20;
/** 一次模型往返里最多处理几个工具调用（多的回 {error: 'too_many'}，不查库） */
export const CALLS_MAX = 4;
/** 一次查库的语句超时（store.ts 的 STMT_TIMEOUT 按它拼；core.ts 剩余预算不够它加一次往返就不查） */
export const QUERY_MS = 3_000;
/** look_note_images 一次最多看几张 */
export const NOTE_IMAGES_MAX = 3;
/** 一轮最多看几张随手记里的图（几次 look_note_images 合计） */
export const TURN_IMAGES_MAX = 6;
/** web_search 的查询词最长几个字 */
export const WEB_QUERY_MAX = 100;
/** 一条随手记最多带几张图的描述、每条描述最长几个字 */
export const NOTE_DESCS_MAX = 4;
export const DESC_MAX = 200;
/** 交给模型的每段网页摘要最长几个字（一页一段，一次联网最多 websearch.ts 的 WEB_RESULTS_MAX 段） */
export const FINDING_MAX = 300;
/** draft_records：一轮最多几段、每段最长几个字（和 shared/schema/chat.ts 的 CHAT_DRAFTS_MAX、CHAT_DRAFT_TEXT_MAX 相等，tests/edge/ai-chat.test.ts 钉住） */
export const DRAFTS_MAX = 5;
export const DRAFT_TEXT_MAX = 200;

/** 交给 store 查的条件（已校验） */
export type ToolQuery =
  | { tool: 'find_events'; from: string; to: string; terms: string[] }
  | { tool: 'find_todos'; status: 'open' | 'done' | 'overdue' | 'all'; from: string | null; to: string | null; terms: string[]; today: string }
  | { tool: 'search_notes'; terms: string[] }
  | { tool: 'list_anniversaries'; from: string; to: string };

/** 一个已校验的工具调用（core.ts 按 tool 一处 switch） */
export type Call =
  | ToolQuery | { tool: 'web_search'; query: string } | { tool: 'look_note_images'; n: number } | { tool: 'remember'; text: unknown; replaces: number | null }
  | { tool: 'draft_records'; items: string[]; projects: string[] };
export type ToolName = Call['tool'];

/** store 查出来的一行（date、time 是记录自己的日子和时刻文字；随手记的 date 是写下那天，由 store 按请求时区算好） */
export interface ChatRow {
  kind: ChatKind;
  id: string;
  title: string | null;
  date: string | null;
  time: string | null;
  where?: string | null;
  /** 纪念日的种类 birthday / anniversary / countdown（交给模型的 type） */
  sub?: string | null;
  done?: boolean;
  body?: string | null;
  /** 随手记里存了几张图（不含已删的；隐私记查不到，没有这一项） */
  images?: number;
  /** 这些图已经识别出的描述（ai-media 写的 ai_desc；没识别的没有） */
  descs?: readonly string[];
}

/** 给不给某个工具要看的条件：某一类开着、有联网服务商（且请求带 web）、服务商收图、请求带 memory、请求带 draft 且日程或待办开着其一 */
export type Need = ChatKind | 'web' | 'images' | 'memory' | 'draft';

/** R-497：项目名的比对口径（同 draft_records 原话的清洗：memories.ts 的 cleanText 去零宽、方向这类不可见字符，控制字符换空格；再合并空白、截到 parse-core.ts 的 PROJECT_LEN）。
 *  模型回写的项目名、给模型看的例子（sanitize 过，<data> 成了 <_data>）都先过这一道再比，core.ts 的 draftRecords 命中后交回例子里的原名 */
export function projectKeyOf(p: string): string {
  return [...cleanText(p, PROJECT_LEN * 2).replace(/\s+/g, ' ').trim()].slice(0, PROJECT_LEN).join('');
}

/** draft_records 的 items（只收字符串，同 remember 的清洗、合并空白、截到 DRAFT_TEXT_MAX，空的丢掉，最多 DRAFTS_MAX 段）
 *  连同和它一一对应的 projects（R-497：照以前怎么分的配的项目名，没配是空串；过 projectKeyOf）一起清洗；items 丢掉的那段，项目名一起丢，不错位。
 *  项目名是不是例子里出现过的由 core.ts 的 draftRecords 核 */
export function draftPairsOf(items: unknown, projects: unknown): { text: string; project: string }[] {
  if (!Array.isArray(items)) return [];
  const ps = Array.isArray(projects) ? projects : [];
  const out: { text: string; project: string }[] = [];
  for (let i = 0; i < items.length && out.length < DRAFTS_MAX; i++) {
    const x: unknown = items[i];
    if (typeof x !== 'string') continue;
    const text = cutUnits(cleanText(x, DRAFT_TEXT_MAX).replace(/\s+/g, ' ').trim(), DRAFT_TEXT_MAX);
    if (text === '') continue;
    const p: unknown = ps[i];
    const project = typeof p === 'string' ? projectKeyOf(p) : '';
    out.push({ text, project });
  }
  return out;
}

interface ToolSpec {
  decl: ToolDecl;
  /** 全部满足才给 */
  need: readonly Need[];
  /** 查库的工具查的是哪一类（回答上面那行“查了你的日程、待办……”）；联网、看图没有 */
  kind?: ChatKind;
  parse(args: Readonly<Record<string, unknown>>, today: string): Call | { error: string };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const dayNum = (d: string): number => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
const addDays = (d: string, n: number): string => new Date((dayNum(d) + n) * 86_400_000).toISOString().slice(0, 10);

/** 关键词：按空白拆开，去掉空的、过长的截短，最多 TERMS_MAX 个 */
export function termsOf(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  return [...new Set(v.split(/\s+/).map((t) => [...t].slice(0, TERM_MAX).join('')).filter((t) => t !== ''))].slice(0, TERMS_MAX);
}

const DAY = { type: 'string', description: 'YYYY-MM-DD' };
const Q = { type: 'string', description: '关键词，1～4 个，用空格隔开；不需要按词筛就不给' };

/** 全部工具（顺序就是给模型的顺序） */
const SPECS: readonly ToolSpec[] = [
  {
    decl: {
      name: 'find_events',
      description: `按日子范围查用户的日程（含首尾两天），可带关键词筛标题、地点、备注。范围最长 ${RANGE_MAX_DAYS} 天。`,
      parameters: { type: 'object', properties: { from: DAY, to: DAY, q: Q }, required: ['from', 'to'] },
    },
    need: ['event'],
    kind: 'event',
    parse(args) {
      const { from, to } = args;
      if (!isDay(from) || !isDay(to) || to < from) return { error: 'bad_range' };
      if (dayNum(to) - dayNum(from) > RANGE_MAX_DAYS) return { error: 'range_too_long' };
      return { tool: 'find_events', from, to, terms: termsOf(args['q']) };
    },
  },
  {
    decl: {
      name: 'find_todos',
      description: '查用户的待办。status：open 没做完、done 做完了、overdue 截止日已过还没做完、all 全部；可带截止日子范围（due_from、due_to）和关键词。',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['open', 'done', 'overdue', 'all'] }, due_from: DAY, due_to: DAY, q: Q },
        required: ['status'],
      },
    },
    need: ['todo'],
    kind: 'todo',
    parse(args, today) {
      const st = args['status'];
      const status = st === 'open' || st === 'done' || st === 'overdue' || st === 'all' ? st : null;
      if (status === null) return { error: 'bad_status' };
      const from = isDay(args['due_from']) ? args['due_from'] : null;
      const to = isDay(args['due_to']) ? args['due_to'] : null;
      if (from !== null && to !== null && to < from) return { error: 'bad_range' };
      return { tool: 'find_todos', status, from, to, terms: termsOf(args['q']), today };
    },
  },
  {
    decl: {
      name: 'search_notes',
      description: '按关键词查用户的随手记（标题、正文、或者随手记里的图的描述有其中任意一个词就算），新的在前。隐私记查不到。带图的随手记会给出图的张数和已识别的描述。',
      parameters: { type: 'object', properties: { q: { type: 'string', description: '关键词，1～4 个，用空格隔开' } }, required: ['q'] },
    },
    need: ['note'],
    kind: 'note',
    parse(args) {
      const terms = termsOf(args['q']);
      return terms.length === 0 ? { error: 'no_terms' } : { tool: 'search_notes', terms };
    },
  },
  {
    decl: {
      name: 'list_anniversaries',
      description: '查从今天起多少天内要到的生日、纪念日、倒数日（按下一次的日子排）。',
      parameters: { type: 'object', properties: { within_days: { type: 'integer', description: `1～${RANGE_MAX_DAYS}，默认 365` } } },
    },
    need: ['anniv'],
    kind: 'anniv',
    parse(args, today) {
      const w = args['within_days'];
      const n = typeof w === 'number' && Number.isInteger(w) ? Math.min(Math.max(w, 1), RANGE_MAX_DAYS) : 365;
      return { tool: 'list_anniversaries', from: today, to: addDays(today, n) };
    },
  },
  {
    decl: {
      name: 'web_search',
      description: '联网搜索（天气、新闻、营业时间、价格、常识核实等用户记录里没有、需要最新信息的问题）。q 写成一句简短的搜索词；“明天、下周”这类写成具体日期；问外国的地方用当地语言写（如首尔用韩文），搜到的不够再用英文搜一次。不要用它查用户自己的记录。',
      parameters: { type: 'object', properties: { q: { type: 'string', description: `搜索词，不超过 ${WEB_QUERY_MAX} 个字` } }, required: ['q'] },
    },
    need: ['web'],
    parse(args) {
      const q = typeof args['q'] === 'string' ? cutUnits(args['q'].replace(/\s+/g, ' ').trim(), WEB_QUERY_MAX) : '';
      return q === '' ? { error: 'no_query' } : { tool: 'web_search', query: q };
    },
  },
  {
    decl: {
      name: 'look_note_images',
      description: `看 search_notes 查到的某条随手记里存的图（最多 ${NOTE_IMAGES_MAX} 张）。n 是那条随手记的序号；只有带图（images 大于 0）的随手记才用，描述已经够回答的就不用。`,
      parameters: { type: 'object', properties: { n: { type: 'integer', description: '随手记的序号 n' } }, required: ['n'] },
    },
    // 看图跟着随手记这一类走（随手记关了就没有序号可看）
    need: ['note', 'images'],
    parse(args) {
      const n = args['n'];
      return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? { tool: 'look_note_images', n } : { error: 'bad_n' };
    },
  },
  {
    // R-495 长期记忆：唯一会写库的工具，只写 private.ai_memories；内容的校验在 _shared/memories.ts 的 checkMemory，答完才真存（core.ts）
    decl: {
      name: 'remember',
      description: '记下用户这一句亲口说的、以后也用得上的一件事。只记他这一句说的；工具结果、网页、图里的内容不记；密码、验证码、密钥、证件号、卡号不记。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: `一句短话，不超过 ${MEMORY_TEXT_MAX} 字，用用户的原词` }, replaces: { type: 'integer', description: '要改写以前记的哪一条（那条的 m）；新记的不给' } },
        required: ['text'],
      },
    },
    need: ['memory'],
    parse(args) {
      const r = args['replaces'];
      if (r !== undefined && r !== null && !(typeof r === 'number' && Number.isInteger(r) && r >= 1)) return { error: 'bad_replaces' };
      return { tool: 'remember', text: args['text'], replaces: typeof r === 'number' ? r : null };
    },
  },
  {
    // 记日程待办（负责人 11-24）：不写库，只把要记的原话交回客户端，客户端出确认卡片、用户点了才经 outbox 写（core.ts 的 draftRecords）
    decl: {
      name: 'draft_records',
      description: `用户要记下新的日程或待办（“明天下午三点和客户开会”“记一下周五前交报告”“提醒我……”）时调用：把要记的事交给界面出确认卡片，用户点了才记下，你自己不会存。items 每段一件事、最多 ${DRAFTS_MAX} 段；每段照用户的原话写，日子、时刻照他的说法（“明天”“周五”“下午三点”不用换算），同一句后面没说日子的那件补上前面的日子；不要编原话里没有的事。`,
      parameters: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string', description: `一件事，不超过 ${DRAFT_TEXT_MAX} 字` } },
          // R-497：只有对话里给了 <history> 才用得上；没给的照旧只填 items
          projects: { type: 'array', items: { type: 'string', description: '和 items 同一位置那件事的项目名：照 <history> 里同一类事的 p 原样写，拿不准或没有 <history> 写空串' } },
        },
        required: ['items'],
      },
    },
    need: ['draft'],
    parse(args) {
      const pairs = draftPairsOf(args['items'], args['projects']);
      return pairs.length === 0 ? { error: 'no_items' } : { tool: 'draft_records', items: pairs.map((d) => d.text), projects: pairs.map((d) => d.project) };
    },
  },
];

export const TOOL_TABLE: ReadonlyMap<string, Readonly<ToolSpec>> = new Map(SPECS.map((s) => [s.decl.name, Object.freeze(s)]));

/** 全部工具的说明（单测核对“名字里没有写、改、删”） */
export const TOOLS: readonly ToolDecl[] = Object.freeze(SPECS.map((s) => s.decl));

/** 查库的工具查的是哪一类；联网、看图回 undefined */
export const kindOf = (tool: ToolName): ChatKind | undefined => TOOL_TABLE.get(tool)?.kind;

/** 第 2 段两项条件：web 有联网服务商、请求带了 web；images 服务商收图 */
export type Extras = { web: boolean; images: boolean; memory?: boolean; draft?: boolean };

/** 这个人能用的类型（门第 ② 步的 gate.features）加第 2 段两项 → 给模型的工具（need 全满足的才给）。
 *  draft：请求带了 draft，且日程、待办至少开着一类（卡片只记这两类） */
export function toolsFor(kinds: readonly ChatKind[], extras: Extras = { web: false, images: false }): ToolDecl[] {
  const on = new Set<Need>(kinds);
  if (extras.web) on.add('web');
  if (extras.images) on.add('images');
  if (extras.memory === true) on.add('memory');
  if (extras.draft === true && (on.has('event') || on.has('todo'))) on.add('draft');
  return SPECS.filter((s) => s.need.every((n) => on.has(n))).map((s) => s.decl);
}

/** 模型给的工具名和参数 → 已校验的调用；不认得的名字回 unknown_tool，不合格回 {error}（交回给模型，不查库）。today：用户时区的今天 */
export function parseCall(name: string, args: Readonly<Record<string, unknown>>, today: string): Call | { error: string } {
  const spec = TOOL_TABLE.get(name);
  return spec ? spec.parse(args, today) : { error: 'unknown_tool' };
}

export interface RecordRef {
  kind: ChatKind;
  id: string;
  title: string;
  date: string | null;
  time: string | null;
  done?: boolean;
}
/** 网页来源（url 原样：搜索接口给的网址） */
export interface WebRef {
  kind: 'web';
  title: string;
  url: string;
  site: string;
}
export type Ref = RecordRef | WebRef;

const cp = (s: string): number => [...s].length;
const TIME_RE = /^(\d{2}):(\d{2})/;
const hm = (t: string | null): string | null => {
  const m = t === null ? null : TIME_RE.exec(t);
  return m ? `${m[1]}:${m[2]}` : null;
};

/** 一条记录的键：kind:id（不同类的 id 理论上不会撞，键里带上类型，三处——编号、order、refs——同一个口径） */
export const keyOf = (r: { kind: ChatKind; id: string }): string => `${r.kind}:${r.id}`;

/** 这一轮里送出去的记录：同一条（同一个 keyOf）只编一个号；order[n-1] 是第 n 条的键（relinkCites 用） */
export class Registry {
  readonly order: string[] = [];
  private readonly refs = new Map<string, Ref>();
  private readonly nOf = new Map<string, number>();
  private total = 0;

  get size(): number {
    return this.order.length;
  }

  /** 记录有几条（不算网页来源；回答上面那行“找到 N 条”） */
  get records(): number {
    return this.order.filter((k) => !k.startsWith('web:')).length;
  }

  /** 网页来源有几条（“联网查了 N 个网页”） */
  get webs(): number {
    return this.order.length - this.records;
  }

  /** 按键（keyOf）取给前端的条目 */
  ref(key: string): Ref | undefined {
    return this.refs.get(key);
  }

  /** 第 n 条是不是送出去的随手记：是回它的 id，不是（没这个号、不是随手记）回 null（look_note_images 只认这一轮送出去的随手记） */
  noteAt(n: number): string | null {
    const key = this.order.at(n - 1);
    return n >= 1 && key !== undefined && key.startsWith('note:') ? key.slice(5) : null;
  }

  /** 还能放下 size 个字就记上、回 true；放不下回 false（不记） */
  private fit(size: number): boolean {
    if (this.total + size > TOTAL_MAX) return false;
    this.total += size;
    return true;
  }

  /**
   * 联网结果（搜索接口搜到的网页，每页带自己的摘要）→ 交回模型的 {sources:[{n, kind:'web', title, site}], findings:[{text, cite:[n]}]}：
   * 网页进编号（同一个网址只编一个号），这一页的摘要在这里按 FINDING_MAX 截一次、cite 就是这一页的编号；
   * 网页、摘要都计入 TOTAL_MAX：放不下的网页不编号（它的摘要也不送），放不下的摘要不送
   */
  takeWeb(sources: readonly WebSource[]): Record<string, unknown> {
    const out: Record<string, unknown>[] = [];
    const cites: { text: string; cite: number[] }[] = [];
    for (const s of sources) {
      const key = `web:${s.url}`;
      const title = sanitize(s.title, TITLE_MAX);
      const site = sanitize(s.site, TITLE_MAX);
      let n = this.nOf.get(key);
      if (n === undefined) {
        if (!this.fit(cp(title) + cp(site))) continue;
        this.order.push(key);
        n = this.order.length;
        this.nOf.set(key, n);
        this.refs.set(key, { kind: 'web', title: cutUnits(s.title.trim(), TITLE_MAX), url: s.url, site: s.site });
      }
      out.push({ n, kind: 'web', title, ...(site !== '' ? { site } : {}) });
      const t = sanitize(s.text, FINDING_MAX);
      if (t !== '' && this.fit(cp(t))) cites.push({ text: t, cite: [n] });
    }
    return { sources: out, findings: cites };
  }

  /** 查到的行 → 交回模型的 {records:[{n, kind, title, when?, where?, done?, text?}], more?}；字数放不下的不送 */
  take(rows: readonly ChatRow[]): { records: Record<string, unknown>[]; more?: number } {
    const records: Record<string, unknown>[] = [];
    const shown = rows.slice(0, ROWS_MAX);
    for (const r of shown) {
      const key = keyOf(r);
      const title = sanitize(r.title ?? '', TITLE_MAX);
      const time = hm(r.time);
      const when = [r.date ?? '', time ?? ''].filter((x) => x !== '').join(' ');
      const where = sanitize(r.where ?? '', TITLE_MAX);
      const text = sanitize(r.body ?? '', BODY_MAX);
      // 随手记的图：张数和已识别的描述（描述是 AI 写的，照样过 sanitize）
      const descs = (r.descs ?? []).slice(0, NOTE_DESCS_MAX).map((d) => sanitize(d, DESC_MAX)).filter((d) => d !== '');
      let n = this.nOf.get(key);
      if (n === undefined) {
        if (!this.fit(cp(title) + cp(when) + cp(where) + cp(text) + descs.reduce((a, d) => a + cp(d), 0))) break;
        this.order.push(key);
        n = this.order.length;
        this.nOf.set(key, n);
        // 给前端的标题用原文（前端按纯文本画；sanitize 的转义只是给模型看的）
        const shownTitle = cutUnits((r.title ?? '').trim(), TITLE_MAX);
        this.refs.set(key, { kind: r.kind, id: r.id, title: shownTitle, date: r.date, time, ...(r.kind === 'todo' ? { done: r.done === true } : {}) });
      }
      records.push({
        n, kind: r.kind, title, ...(when !== '' ? { when } : {}), ...(where !== '' ? { where } : {}), ...(r.sub ? { type: sanitize(r.sub, 20) } : {}),
        ...(r.kind === 'todo' ? { done: r.done === true } : {}), ...(text !== '' ? { text } : {}),
        ...(r.images ? { images: r.images } : {}), ...(descs.length > 0 ? { image_desc: descs } : {}),
      });
    }
    const more = rows.length - records.length;
    return more > 0 ? { records, more } : { records };
  }
}

/** 关键词 → ilike 用的 %词%（转义 \ % _）；没有关键词时回 null（不按词筛）。store.ts 的四句查询用；放这里是因为它不碰数据库，单测直接引 */
export const likeOf = (terms: readonly string[]): string[] | null =>
  terms.length === 0 ? null : terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
