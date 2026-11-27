// 推送负载 v1（架构 0.53 第 4 条、5.3“推送负载 v1”；B2 安全审查“六之三”、BE1-S2；代码审查 BE-1 M3、S1～S3）。push-dispatch、push-test 都只经
// buildPayload 组装，不手拼 JSON。输入按 type 分成三种（联合类型），输出只有这几个字段：
//   remind  { v: 1, type, user_id, kind, id, due_at, occurrenceKey?, title?, body?, snooze?: { label, minutes }, done?: { label }, ack?: { label } }
//           通知上两个按钮（R-294、R-307、R-308，负责人 11-03）：待办“推迟 + 完成”，日程、纪念日“推迟 + 知道了”；
//           SW 的 action 名：'snooze'（推迟 10 分钟）、'done'（完成，只给待办）、'ack'（知道了，只给日程和纪念日，只关通知、不改数据）；
//           推迟和完成走同一条 pending 路径、完成后能撤销（SW 和整页提醒由前端 A 接）；文案由服务器按 ui_locale 生成
//           （词典键 remind.push.action.snooze、remind.push.action.done、remind.push.action.ack；shared/logic/notify-text.ts 的 NOTIFY_ACTIONS、actionsFor）；
//           按类型守住：kind 不是 todo 的不带 done，kind 是 todo 的不带 ack（传了也丢）
//   resolve { v: 1, type, user_id, kind, id, due_at, occurrenceKey? }  不带标题、正文、snooze、done、ack（SW 用本地固定文案）
//   • occurrenceKey（可选，REMIND-close-occkey，11-04）：“同一次提醒”的标识，push-dispatch 调 shared/logic/remind-route.ts 的 occurrenceKey 算，
//     SW / 本机撤回通知时拿它比（旧客户端不认识这个键，忽略即可）。只认两种写法，别的一律不带（不抛错、这条照发）：
//       ① 等于 tag：<kind>:<id>:<due_at>（和本条的 kind、id、due_at 逐字相同）；
//       ② 全天日程：event:<id>:allday:<YYYY-MM-DD>:<0|1>（只在 kind 是 event 时，id 和本条相同；日期必须真实存在，安全审查 S1）。
//     所以只含小写 UUID、数字、字母和冒号、连字符，最长 62 字节（event: + UUID + :allday: + 日期 + :1）；不截断（截了就认不出是同一次），字节放不下照旧先截 body、title；
//   test    { v: 1, type, user_id }                            正好三个键
//   vault   { v: 1, type, user_id, event }                     正好四个键（B5 任务单 S2～S4、代定 D19）：隐私记锁定、改密码、重设、新绑定 Face ID 时推本人所有设备；
//           event 只有 locked、pin_changed、reset、webauthn_added 四种，文案由 SW 本地词典 push.vault.<event> 出（前端做），负载不带任何内容
//   • 永远没有地址、图片之类的字段（类型上就没有，运行时多给的键一律丢掉）；
//   • user_id 必带：SW 拿它和本机 owner 比对，对不上只显示 App 名（M9、FE-1）；
//   • 先校验（S3）：user_id、id 是小写 UUID，kind 认识，due_at 是正的安全整数；不合格抛 PushPayloadError，这一条记 push_failed、不影响别的；
//   • 文字（title、body、snooze.label、done.label、ack.label）先把 C0 控制字符（U+0000～U+001F）换成空格（S1），再按码点截：title、body 各 ≤ 300、label ≤ 40，
//     都含末尾的“…”，和 SW src/sw/push.ts 的 TEXT_MAX、LABEL_MAX、clipText 一致；snooze.minutes 不是 1～1440 的整数就整个不带 snooze（S2，SW 同样处理）；
//   • 整份 UTF-8 JSON ≤ 3071 字节，加 1 字节分隔放进 3072 一档（ece.ts PAD_TIERS）；放不下**先截 body（可以截到没有），再截 title**
//     （R-294，负责人 11-03 定：保住标题；取代 5.3 原来的“先截标题”，代码审查 BE-1 S1）；title 至少留 20 个码点、不截成没有；
//     截完还放不下抛 PushCryptoError('payload_too_large')。
// 通知的 tag 是 kind:id:due_at，整页提醒地址 /app/#/remind/<kind>/<id>?due=<due_at>，都由前端按这几个字段拼，负载里不放；
//   有了 occurrenceKey 以后 tag 仍由前端自己按 kind、id、due_at 拼，不从 occurrenceKey 取（安全审查 S3）。
//   撤回旧通知的兜底约定（代码审查 occurrenceKey M1、L1；架构 5.3“推送负载 v1”）：SW 拿 tag 和 occurrenceKey 两个都比，任一对上就撤回；
//   负载不带 occurrenceKey 时只比 tag。服务器 resolve 带的 occurrenceKey 按当初推的那一次算（push-dispatch logic.ts），但稍后、R-336、免打扰
//   这几样叠在一起时，以及推过以后换了时区（R-341：remind_at 按新时区重算，resolve 只能带 tag，复审 R2-L1），仍可能和当初那条不一样，
//   所以不能只比 occurrenceKey。
// 不 import npm 包、不碰 Deno 全局；Node 和 Deno 都能跑。
import { PAD_TIERS, PushCryptoError } from './ece.ts';

export type PayloadType = 'remind' | 'resolve' | 'test' | 'vault';
export type PayloadKind = 'event' | 'todo' | 'anniv';

/** 指向一次提醒的几项（remind、resolve 共有） */
interface ItemRef {
  user_id: string;
  kind: PayloadKind;
  id: string;
  /** 这一次提醒对应的时刻（毫秒），和 tag、整页提醒地址里的 due 一致 */
  due_at: number;
  /** “同一次提醒”的标识（shared 的 occurrenceKey）；不合上面两种写法就不带 */
  occurrenceKey?: string | null;
}
export interface RemindPayloadInput extends ItemRef {
  type: 'remind';
  /** 只在用户开着 push_show_title 时给 */
  title?: string | null;
  body?: string | null;
  snooze?: { label: string; minutes: number } | null;
  /** “完成”按钮的文字（只给待办，R-308）；label 为空就不带 */
  done?: { label: string } | null;
  /** “知道了”按钮的文字（只给日程、纪念日，R-308）；label 为空就不带 */
  ack?: { label: string } | null;
}
export interface ResolvePayloadInput extends ItemRef {
  type: 'resolve';
}
export interface TestPayloadInput {
  type: 'test';
  user_id: string;
}
/** 隐私记的安全通知（B5）：event 之外什么都不带；和 SW 的 src/sw/push-vault-data.ts 各一份，tests/shared/vault-parity.test.ts 核对 */
import { VAULT_PUSH_EVENTS, type VaultPushEvent } from './vault-events.ts';
export { VAULT_PUSH_EVENTS, type VaultPushEvent };
export interface VaultPayloadInput {
  type: 'vault';
  user_id: string;
  event: VaultPushEvent;
}
export type PayloadInput = RemindPayloadInput | ResolvePayloadInput | TestPayloadInput | VaultPayloadInput;

/** 负载字段本身不合格（S3）：调用方记 push_failed，只写这个原因码 */
export class PushPayloadError extends Error {
  readonly code = 'bad_payload' as const;
  constructor() {
    super('bad_payload');
  }
}

/** 明文最多多少字节（最大一档减去 1 字节分隔） */
export const MAX_PAYLOAD_BYTES = (PAD_TIERS[PAD_TIERS.length - 1] ?? 3072) - 1;
/** 标题、正文的长度上限（按码点数，Array.from 计，含截断时末尾的“…”）：架构 5.3（0.53）各 300 字，和 SW 的 TEXT_MAX 同一个数 */
export const TITLE_MAX = 300;
export const BODY_MAX = 300;
/** 推迟按键文字上限，和 SW 的 LABEL_MAX 一致 */
export const LABEL_MAX = 40;
/** 推迟分钟数 1～1440，和 SW 的 SNOOZE_MAX_MIN 一致 */
export const SNOOZE_MAX_MIN = 1440;
/** 按字节再截标题时至少留的码点数（S1：不截成没有，锁屏上还认得出是哪件事） */
export const TITLE_MIN_KEEP = 20;
const ELLIPSIS = '…';
const KINDS: ReadonlySet<string> = new Set<PayloadKind>(['event', 'todo', 'anniv']);
// 小写 UUID，和 SW 的 UUID_RE 同一条
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const te = new TextEncoder();

function encode(o: Record<string, unknown>): Uint8Array<ArrayBuffer> {
  return new Uint8Array(te.encode(JSON.stringify(o)));
}

/**
 * 控制字符和不可见的方向、分隔字符换成空格（安全审查建议 ②；前端 A 的 SW clipText 用同一套，两边保持一致）：
 * C0（U+0000～U+001F）、DEL（U+007F）、C1（U+0080～U+009F）、双向嵌入和覆盖（U+202A～U+202E）、双向隔离（U+2066～U+2069）、
 * 方向标记（U+200E、U+200F、U+061C）、行和段分隔（U+2028、U+2029）、BOM / 零宽不换行（U+FEFF）。
 * 通知里本来显示不出来或会把文字倒过来显示（伪装标题），转义后还多占字节
 */
export function isStrippedChar(cp: number): boolean {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)
    || cp === 0x200e || cp === 0x200f || cp === 0x061c || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff;
}
/** isStrippedChar 认的字符（不只 C0）一律换成空格 */
function strippedToSpace(s: string): string {
  let out = '';
  for (const ch of s) out += isStrippedChar(ch.codePointAt(0) as number) ? ' ' : ch;
  return out;
}

/** 按字符（码点）截到连省略号在内最多 n 个（和 SW 的 clipText 同一算法） */
function cut(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, Math.max(0, n - 1)).join('') + ELLIPSIS;
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v !== '' ? cut(strippedToSpace(v), max) : null);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isDueAt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const DAY_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
/** 真实存在的日期 YYYY-MM-DD（安全审查 S1：月 01～12、日不超过当月天数，闰年按公历；9999-99-99、2026-02-30 都不放行） */
function isRealDay(s: string): boolean {
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = mo === 2 ? (leap ? 29 : 28) : mo === 4 || mo === 6 || mo === 9 || mo === 11 ? 30 : 31;
  return d <= dim;
}
/**
 * occurrenceKey 只认 ① tag ② 全天日程两种写法（见文件头），都要和本条的 kind、id（、due_at）对得上。
 * 标准写法在 shared/logic/remind-route.ts 的 validOccurrenceKey（SW 调那一份，11-05）；这份文件在 Vitest、unit 的 tsc 里跑、不能 import _shared/gen，
 * 所以照抄（isRealDay 同）；两边逐条一致由 tests/shared/push/occkey-parity.test.ts 钉住，改一边必须同改另一边
 */
function occKey(v: unknown, kind: string, id: string, dueAt: number): string | null {
  if (typeof v !== 'string') return null;
  if (v === `${kind}:${id}:${dueAt}`) return v;
  const pre = `event:${id}:allday:`;
  if (kind !== 'event' || !v.startsWith(pre)) return null;
  const rest = v.slice(pre.length);
  const day = rest.slice(0, 10);
  return isRealDay(day) && (rest.slice(10) === ':0' || rest.slice(10) === ':1') ? v : null;
}
const isSnoozeMin = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= SNOOZE_MAX_MIN;

/** 组装并编码；返回 UTF-8 字节（交给 ece.ts 的 encryptPush）。字段不合格抛 PushPayloadError，放不下抛 PushCryptoError('payload_too_large') */
export function buildPayload(p: PayloadInput): Uint8Array<ArrayBuffer> {
  if (!isUuid(p.user_id)) throw new PushPayloadError();
  if (p.type === 'test') return encode({ v: 1, type: 'test', user_id: p.user_id });
  if (p.type === 'vault') {
    if (!(VAULT_PUSH_EVENTS as readonly string[]).includes(p.event)) throw new PushPayloadError();
    return encode({ v: 1, type: 'vault', user_id: p.user_id, event: p.event });
  }
  if ((p.type !== 'remind' && p.type !== 'resolve') || !KINDS.has(p.kind) || !isUuid(p.id) || !isDueAt(p.due_at)) throw new PushPayloadError();
  const base: Record<string, unknown> = { v: 1, type: p.type, user_id: p.user_id, kind: p.kind, id: p.id, due_at: p.due_at };
  const occ = occKey(p.occurrenceKey, p.kind, p.id, p.due_at);
  if (occ !== null) base.occurrenceKey = occ;
  if (p.type === 'resolve') return encode(base);

  let title = text(p.title, TITLE_MAX);
  let body = text(p.body, BODY_MAX);
  const sl = p.snooze ? text(p.snooze.label, LABEL_MAX) : null;
  const snooze = p.snooze && sl !== null && isSnoozeMin(p.snooze.minutes) ? { label: sl, minutes: p.snooze.minutes } : null;
  const dl = p.done && p.kind === 'todo' ? text(p.done.label, LABEL_MAX) : null;
  const done = dl !== null ? { label: dl } : null;
  const al = p.ack && p.kind !== 'todo' ? text(p.ack.label, LABEL_MAX) : null;
  const ack = al !== null ? { label: al } : null;
  const make = () => {
    const o: Record<string, unknown> = { ...base };
    if (title !== null) o.title = title;
    if (body !== null) o.body = body;
    if (snooze !== null) o.snooze = snooze;
    if (done !== null) o.done = done;
    if (ack !== null) o.ack = ack;
    return encode(o);
  };
  let out = make();
  // R-294：先截 body（截到没有为止），再截 title（至少留 TITLE_MIN_KEEP 个码点）；每次按超出的字节数估一个字符数往下截（一个字符最多 6 字节，按 4 估、多跑几轮）
  for (const which of ['body', 'title'] as const) {
    const floor = which === 'title' ? TITLE_MIN_KEEP : 2;
    for (let guard = 0; out.length > MAX_PAYLOAD_BYTES && guard < 64; guard++) {
      const cur = which === 'body' ? body : title;
      if (cur === null) break;
      const n = Array.from(cur).length;
      if (n <= floor && which === 'title') break;
      const over = out.length - MAX_PAYLOAD_BYTES;
      const keep = Math.max(floor, n - Math.max(1, Math.ceil(over / 4)));
      const next = which === 'body' && keep <= floor && n <= floor ? null : cut(cur, Math.min(keep, n - 1));
      if (which === 'body') body = next;
      else title = next;
      out = make();
    }
  }
  if (out.length > MAX_PAYLOAD_BYTES) throw new PushCryptoError('payload_too_large');
  return out;
}
