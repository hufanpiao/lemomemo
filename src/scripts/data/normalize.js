// 职责：快照进来先整理字段，再进状态：强制类型（字符串、数字、布尔）、日期和时间补零（"2026-1-5" → "2026-01-05"、
//       "9:5" → "09:05"，认不出就置空）、限制长度、deletedAt 统一为毫秒数或 null；id 一律用文档 id。
//       v3 提醒字段：remindMin（日程）/ remindDays 只认合法取值，null 表示“不提醒”，不合法或缺失时去掉该字段（按默认规则提醒，
//       需求澄清 #2）；snoozeAt、notifiedFor、remindAt 统一为毫秒数或 null。待办也有 note（#20）。
//       Claude 写入的不规范数据不会让页面出错。未知字段原样保留。纯函数。
// 依赖：core/const.js、core/date.js
App.data = App.data || {};

const C = App.core.C;
const {pad} = App.core.date;

const str = (v, max) => {
  const s = typeof v === "string" ? v : typeof v === "number" && isFinite(v) ? String(v) : "";
  return max ? s.slice(0, max) : s;
};
const num = (v, dflt) => { const n = Number(v); return v !== null && v !== "" && isFinite(n) ? n : dflt; };
const bool = v => v === true || v === "true" || v === 1;
function date(v){
  const m = typeof v === "string" && v.trim().match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (!m) return "";
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? y+"-"+pad(mo)+"-"+pad(d) : "";
}
function time(v){
  const m = typeof v === "string" && v.trim().match(/^(\d{1,2})[:：](\d{1,2})$/);
  if (!m) return "";
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? pad(h)+":"+pad(mi) : "";
}
const deletedAt = v => { const n = num(v, 0); return n > 0 ? n : null; };
const msOrNull = v => { const n = num(v, 0); return n > 0 ? n : null; };
// 提醒选项：raw 里没有这个键、或取值不合法 → 返回 undefined（调用方删掉该键，按默认规则）；null → 不提醒
function remindOpt(raw, key, allowed){
  if (!(key in raw)) return undefined;
  const v = raw[key];
  if (v === null || v === "null" || v === false) return null;
  const n = Number(v);
  return v !== "" && allowed.includes(n) ? n : undefined;
}
function remindFields(out, raw, kind){
  const keys = kind === "event" ? [["remindMin", C.REMIND_EVENT_OPTIONS.filter(x => x !== null)], ["remindDays", [0, 1]]] : [["remindDays", [0, 1]]];
  for (const [k, allowed] of keys){
    const v = remindOpt(raw, k, allowed);
    if (v === undefined) delete out[k]; else out[k] = v;
  }
  if (kind !== "event") delete out.remindMin;
  out.snoozeAt = msOrNull(raw.snoozeAt); out.notifiedFor = msOrNull(raw.notifiedFor); out.remindAt = msOrNull(raw.remindAt);
  return out;
}
const duration = v => { const n = num(v, 0); return n > 0 ? n : C.DEFAULT_DURATION_MIN; };

function common(raw){
  return {
    title: str(raw.title, C.TITLE_MAX), project: str(raw.project, C.PROJECT_MAX),
    source: str(raw.source), rawText: str(raw.rawText, C.RAW_MAX),
    createdAt: num(raw.createdAt, 0), updatedAt: num(raw.updatedAt, 0), deletedAt: deletedAt(raw.deletedAt),
  };
}
function normalizeEvent(raw, id){
  raw = raw || {};
  const out = Object.assign({}, raw, common(raw), {
    date: date(raw.date), time: time(raw.time), durationMin: duration(raw.durationMin), note: str(raw.note, C.NOTE_MAX),
  });
  remindFields(out, raw, "event");
  out.id = String(id);
  return out;
}
function normalizeTodo(raw, id){
  raw = raw || {};
  const out = Object.assign({}, raw, common(raw), {
    done: bool(raw.done), doneAt: num(raw.doneAt, 0), due: date(raw.due), important: bool(raw.important),
  });
  out.note = str(raw.note, C.NOTE_MAX);
  remindFields(out, raw, "todo");
  out.id = String(id);
  return out;
}
// coll："events" | "todos"；raw 为适配器给的记录（其中 id 已是文档 id）
const normalizeItem = (coll, raw) => coll === "events" ? normalizeEvent(raw, raw.id) : normalizeTodo(raw, raw.id);

App.data.normalize = {normalizeEvent, normalizeTodo, normalizeItem, date, time};
