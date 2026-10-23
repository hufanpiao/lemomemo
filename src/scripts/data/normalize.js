// 职责：快照进来先整理字段，再进状态：强制类型（字符串、数字、布尔）、日期和时间补零（"2026-1-5" → "2026-01-05"、
//       "9:5" → "09:05"，认不出就置空）、限制长度、deletedAt 统一为毫秒数或 null；id 一律用文档 id。
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
  return Object.assign({}, raw, common(raw), {
    date: date(raw.date), time: time(raw.time), durationMin: duration(raw.durationMin), note: str(raw.note, C.NOTE_MAX),
  }, {id: String(id)});
}
function normalizeTodo(raw, id){
  raw = raw || {};
  const out = Object.assign({}, raw, common(raw), {
    done: bool(raw.done), doneAt: num(raw.doneAt, 0), due: date(raw.due), important: bool(raw.important),
  });
  if ("note" in raw) out.note = str(raw.note, C.NOTE_MAX);
  out.id = String(id);
  return out;
}
// coll："events" | "todos"；raw 为适配器给的记录（其中 id 已是文档 id）
const normalizeItem = (coll, raw) => coll === "events" ? normalizeEvent(raw, raw.id) : normalizeTodo(raw, raw.id);

App.data.normalize = {normalizeEvent, normalizeTodo, normalizeItem, date, time};
