// 长期记忆（R-495 AI 助手第 3 段；表 private.ai_memories）：写入校验、喂给模型的数据块、读写 SQL。ai-chat、ai-memory 共用这一份。
// 放在 _shared/ai 外面：这里不调 AI，撤回 AI 同意后用户照样要能看、能删自己的记忆（ai-memory 故意不过 aiAllowed）。
// 纯逻辑加 SQL 字符串，不 import _shared/gen、npm 包（Vitest 直接测，真库测试跑同一份 SQL）。
// 写入校验（checkMemory）：
// • 只收用户这一句原话里说过的：按字符二元组算覆盖率，工具结果、网页、图里才有的内容过不了（防提示注入，也保证隐私记内容进不来）；
// • 不记密码、验证码、密钥、证件、卡号这类，不记长串数字和令牌样的字符；不记像指令的话；
// • 超过 200 字的不截，直接不收（截出来的半句话不该当成“记住的事”）。
// 喂给模型（memoryBlock）：JSON 数组放在 <memories> 里，尖括号转义，提示词写明这是数据不是指令；合计不超过 PROMPT_MAX 字。
// 带哪几条（负责人 11-23“基本不限+按问题找”）：最近的几条，加上从全部记忆里按这一问找出来的，两边去重；费用不随条数涨。
// 检索（memoryTerms）：中韩日按字符二元组、其他文字按整词，写进 grams 列，在库里找。11-23 在 lemo-e2e 实测：pg_trgm、simple 全文对中韩短句都命中不了，二元组都命中。
// 查询先按 user_id 索引收窄到本人（最多 5000 行），在库里算命中数、排序、LIMIT。不建 GIN：&& 不是 leakproof，fn_ai 过 RLS 时用不上（11-23 实测）。

/** 去掉零宽、方向这类不可见字符（否则夹一个零宽字符就能绕过敏感词），控制字符换成空格，再按字符数截（ai-chat 的 draft_records 也用它） */
export const cleanText =(s: string, max: number): string => [...s.replace(/\p{Cf}/gu, '').replace(/\p{Cc}/gu, ' ')].slice(0, max).join('');

export const MEMORY_TEXT_MAX = 200;
export const MEMORIES_MAX = 5_000;
export const MEMORY_TURN_MAX = 2;
/** “记住的事”页一次拉几条 */
export const MEMORY_PAGE = 50;
/** 喂给模型的记忆合计最多几个字 */
export const PROMPT_MAX = 6_000;
/** 其中最近的最多几条、最多占几个字，其余留给和这一问相关的 */
export const RECENT_SHOWN = 12;
export const RECENT_CHARS = 2_000;
/** 按问题最多取回几条（够填满 PROMPT_MAX 的短句） */
export const RELATED_LIMIT = 60;
/** 一个问题最多用几个词条去找 */
export const QUERY_TERMS_MAX = 64;
/** 记忆里至少这么多二元组出现在用户原话里 */
export const OVERLAP_MIN = 0.6;
/** 语句超时（对话一轮总共只有 25 秒） */
export const MEMORY_STMT_MS = 3_000;
const stmtFor = (ms: number): string => `set local statement_timeout = '${Math.max(1, Math.floor(ms))}ms'`;
const STMT = stmtFor(MEMORY_STMT_MS);

/** 宽松归一：去掉全部空白和标点。只用来算覆盖率、查敏感词（点开写的 p.a.s.s 也要拦），不能用来判重 */
export const looseNorm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const ASCII_WORD = /[a-z0-9]/;
/** 判重键：去空白和一般标点，但数字字母之间的 . - / 和紧跟其后的 + #（3.5、C++、C#）算内容，否则改正会被当成重复丢掉 */
export function normMemory(s: string): string {
  const t = s.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  return t.replace(/[^\p{L}\p{N}]+/gu, (part: string, at: number) => {
    if (!ASCII_WORD.test(t.charAt(at - 1))) return '';
    const suffix = /^[+#]+/.exec(part);   // C++。 这样后面跟着句号的，留 ++ 去句号
    if (suffix) return suffix[0];
    return /^[./-]+$/.test(part) && ASCII_WORD.test(t.charAt(at + part.length)) ? part : '';
  });
}

function grams(norm: string): string[] {
  const c = [...norm];
  const out: string[] = [];
  for (let i = 1; i < c.length; i++) out.push(`${c[i - 1]}${c[i]}`);
  return out;
}

/** 记忆的二元组有多少出现在原话里（0～1） */
export function overlapOf(memory: string, said: string): number {
  const g = [...new Set(grams(looseNorm(memory)))];   // 去重：同一句重复几遍刷不高覆盖率
  if (g.length === 0) return 0;
  const have = new Set(grams(looseNorm(said)));
  return g.filter((x) => have.has(x)).length / g.length;
}

const SENSITIVE = /密码|口令|验证码|校验码|密钥|私钥|令牌|身份证|护照|银行卡|信用卡|卡号|账号|社保|门锁|门禁|支付码|비밀번호|비번|인증번호|주민등록|계좌|카드\s*번호|password|passwd|passcode|secret|token|api[\s_-]?key|\bpin\b|pin\s*\d+|\botp\b|\bcvv\b/iu;
/** 合法日期（1900～2099 年，- . / 分隔，前后不贴数字）：生日、纪念日能记，不算长串数字 */
const DATE_LIKE = /(?<![\d./-])((?:19|20)\d{2})([-./])(\d{1,2})\2(\d{1,2})(?![\d]|[-./]\d)/gu;
const isRealDate = (y: string, m: string, d: string): boolean => {
  const at = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return at.getUTCMonth() === Number(m) - 1 && at.getUTCDate() === Number(d);
};
/** 只隔着标点空白的一段数字 */
const DIGIT_RUN = /\d(?:[^\p{L}\d]*\d)+/gu;
/** 去掉合法日期后，一段里还有 8 位以上数字：卡号、证件号、电话这类（日期换成一个字母，前后的数字不会连起来） */
function hasLongDigits(wide: string): boolean {
  const rest = wide.replace(DATE_LIKE, (all: string, y: string, _sep: string, m: string, d: string) => (isRealDate(y, m, d) ? 'd' : all));
  return (rest.match(DIGIT_RUN) ?? []).some((run) => run.replace(/\D/g, '').length >= 8);
}
/** 连着 20 位以上字母数字：令牌样 */
const TOKEN_LIKE = /[A-Za-z0-9_-]{20,}/u;
const INSTRUCTION = /(?:忽略|无视|忘记|覆盖|绕过).{0,12}(?:指令|规则|提示|设定|限制)|系统提示|system\s*prompt|(?:ignore|disregard|forget|override).{0,24}(?:instruction|rule|prompt)|(?:지시|규칙|프롬프트).{0,8}(?:무시|잊어)/iu;

export type MemoryReject = 'empty' | 'too_long' | 'sensitive' | 'instruction' | 'not_said';

/** 模型给的一条 → 能存的文字和判重键；不合格回原因（只有固定词，进日志不带内容） */
export function checkMemory(raw: unknown, said: string): { text: string; norm: string } | { error: MemoryReject } {
  if (typeof raw !== 'string') return { error: 'empty' };
  const text = cleanText(raw, MEMORY_TEXT_MAX + 1).replace(/\s+/g, ' ').trim();
  const norm = normMemory(text);
  if (norm === '') return { error: 'empty' };
  if ([...text].length > MEMORY_TEXT_MAX || text.length > MEMORY_TEXT_MAX || norm.length > MEMORY_TEXT_MAX) return { error: 'too_long' };
  const wide = text.normalize('NFKC');   // 全角、空格、标点隔开的也要拦
  if (SENSITIVE.test(wide) || SENSITIVE.test(looseNorm(text)) || hasLongDigits(wide) || TOKEN_LIKE.test(wide)) return { error: 'sensitive' };
  if (INSTRUCTION.test(wide)) return { error: 'instruction' };
  if (overlapOf(text, said) < OVERLAP_MIN) return { error: 'not_said' };
  return { text, norm };
}

export interface MemoryRow {
  id: string;
  text: string;
  norm: string;
  at: number;
}

/** 这一轮能给模型看的几条（序号 m 从 1 起，remember 的 replaces 只认它们，不把 id 给模型）：先放最近的，再放相关的，同一条只放一次，合计不超过 PROMPT_MAX 字 */
export function promptMemories(recent: readonly MemoryRow[], related: readonly MemoryRow[] = []): MemoryRow[] {
  const out: MemoryRow[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const r of recent) {
    if (out.length >= RECENT_SHOWN || total + r.text.length > RECENT_CHARS) break;
    out.push(r);
    seen.add(r.id);
    total += r.text.length;
  }
  for (const r of related) {
    if (seen.has(r.id)) continue;
    if (total + r.text.length > PROMPT_MAX) break;
    out.push(r);
    seen.add(r.id);
    total += r.text.length;
  }
  return out;
}

const SPACED = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]+|[^\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
const NO_SPACE = /^[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** 一句话的检索词条（去重）：中韩日按字符二元组（只有一个字就留一个字），其他文字按整词；标点和 % _ \ 这类符号不进词条 */
export function memoryTerms(text: string): string[] {
  const out = new Set<string>();
  for (const run of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const seg of run.match(SPACED) ?? []) {
      if (!NO_SPACE.test(seg)) {
        out.add([...seg].slice(0, 32).join(''));
        continue;
      }
      const c = [...seg];
      if (c.length === 1) out.add(seg);
      for (let i = 1; i < c.length; i++) out.add(`${c[i - 1]}${c[i]}`);
    }
  }
  return [...out];
}


/** 喂给模型的数据块：JSON 里的尖括号转义，内容关不掉 <memories> */
export function memoryBlock(rows: readonly MemoryRow[]): string {
  const data = rows.map((r, i) => ({ m: i + 1, text: cleanText(r.text, MEMORY_TEXT_MAX) }));
  return `<memories>${JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</memories>`;
}

// ===== 读写（跑在 withAiUser 的事务里，app.uid 已设好，策略只放本人的行）=====

/** _shared/db.ts 的 Tx 满足它；不 import db.ts：真库测试在 Node 里跑 */
export interface MemoryTx {
  unsafe(sql: string, params?: never[]): PromiseLike<readonly unknown[]>;
}

/** 同一个人的写入排队：数条数和判重才不会被并发绕过 */
export const LOCK_SQL = `select pg_advisory_xact_lock(hashtextextended('ai_memories:' || $1::text, 0))`;
/** 新的在前，按 (updated_at, id) 往后翻页：翻页途中删、加都不会跳行 */
export const LIST_SQL = `select id, text, norm, created_at, updated_at from private.ai_memories
  where user_id = $1::uuid and deleted_at is null and ($2::bigint is null or (updated_at, id) < ($2::bigint, $3::uuid))
  order by updated_at desc, id desc limit $4::int`;
/** 按词条找：词条是参数（JSON 数组），不拼进 SQL，也不用 LIKE；命中词条多的在前，一样多的新的在前 */
export const RELATED_SQL = `with q as materialized (select array(select jsonb_array_elements_text($2::jsonb)) as k)
  select m.id, m.text, m.norm, m.created_at, m.updated_at from private.ai_memories m, q
  where m.user_id = $1::uuid and m.deleted_at is null and m.grams && q.k
  order by (select count(*) from unnest(m.grams) g where g = any(q.k)) desc, m.updated_at desc, m.id desc limit $3::int`;
export const SAME_NORM_SQL = `select id from private.ai_memories where user_id = $1::uuid and norm = $2::text and deleted_at is null limit 1`;
export const INSERT_SQL = `insert into private.ai_memories (user_id, text, norm, grams, created_at, updated_at)
  values ($1::uuid, $2::text, $3::text, array(select jsonb_array_elements_text($5::jsonb)), $4::bigint, $4::bigint) returning id`;
/** 改写：旧行软删（留着等撤销），新内容另插一行；回旧文字给提示条 */
export const RETIRE_SQL = `update private.ai_memories set deleted_at = $3::bigint
  where user_id = $1::uuid and id = $2::uuid and deleted_at is null returning id, text`;
/** 撤销改写能不能做：新行还在、旧行还留着、旧文字没被别的行占掉 */
export const CAN_SWAP_SQL = `select 1 from private.ai_memories n join private.ai_memories o on o.user_id = n.user_id
  where n.user_id = $1::uuid and n.id = $2::uuid and n.deleted_at is null and o.id = $3::uuid and o.deleted_at is not null
    and not exists (select 1 from private.ai_memories x where x.user_id = n.user_id and x.norm = o.norm and x.deleted_at is null and x.id <> n.id)`;
/** 这个人记忆的版本：增、删、改、撤销、清空都会变。开轮读一次，保存时在锁内比对 */
export const VERSION_SQL = `select concat_ws(':', l.n, l.at, s.n, s.at) as v
  from (select count(*) as n, coalesce(max(updated_at), 0) as at from private.ai_memories where user_id = $1::uuid and deleted_at is null) l,
       (select count(*) as n, coalesce(max(deleted_at), 0) as at from private.ai_memories where user_id = $1::uuid and deleted_at is not null) s`;
export const DELETE_SQL = `update private.ai_memories set deleted_at = $3::bigint
  where user_id = $1::uuid and id = $2::uuid and deleted_at is null returning id`;
/** 撤销：同样的话这期间又记过一条就不再恢复；时间不动，回到原来的位置 */
export const UNDO_SQL = `update private.ai_memories m set deleted_at = null
  where m.user_id = $1::uuid and m.id = $2::uuid and m.deleted_at is not null
    and not exists (select 1 from private.ai_memories o where o.user_id = m.user_id and o.norm = m.norm and o.deleted_at is null) returning m.id`;
export const COUNT_SQL = `select count(*)::int as n from private.ai_memories where user_id = $1::uuid and deleted_at is null`;
export const CLEAR_SQL = `delete from private.ai_memories where user_id = $1::uuid`;

const run = (tx: MemoryTx, sql: string, params: readonly unknown[]): PromiseLike<readonly unknown[]> => tx.unsafe(sql, params as never[]);

const rowOf = (r: Record<string, unknown>): MemoryRow => ({ id: String(r['id']), text: String(r['text']), norm: String(r['norm']), at: Number(r['created_at']) });
const countOf = async (tx: MemoryTx, uid: string): Promise<number> => Number(((await run(tx, COUNT_SQL, [uid])) as Record<string, unknown>[])[0]?.['n'] ?? 0);

export interface MemoryPage {
  items: MemoryRow[];
  /** 下一页从哪开始（updated_at.id）；null：到底了 */
  next: string | null;
  total: number;
}

/** “记住的事”页的一页 */
export async function listMemories(tx: MemoryTx, uid: string, cursor: string | null = null): Promise<MemoryPage> {
  await tx.unsafe(STMT);
  const [at = null, id = null] = cursor === null ? [] : cursor.split('.');
  const rows = (await run(tx, LIST_SQL, [uid, at, id, MEMORY_PAGE + 1])) as Record<string, unknown>[];
  const page = rows.slice(0, MEMORY_PAGE);
  const last = page.at(-1);
  return {
    items: page.map(rowOf),
    next: rows.length > MEMORY_PAGE && last ? `${String(last['updated_at'])}.${String(last['id'])}` : null,
    total: await countOf(tx, uid),
  };
}

/** 开轮第一步：最近的几条和记忆版本（版本读不到就不开记忆，免得把清空的内容写回） */
export async function recentMemories(tx: MemoryTx, uid: string, ms: number = MEMORY_STMT_MS): Promise<{ rows: MemoryRow[]; ver: string }> {
  await tx.unsafe(stmtFor(ms));
  const ver = await versionOf(tx, uid);
  const rows = ((await run(tx, LIST_SQL, [uid, null, null, RECENT_SHOWN])) as Record<string, unknown>[]).map(rowOf);
  return { rows, ver };
}

/** 开轮第二步：按这一问找旧记忆。单独一个事务，失败了调用方只用最近的 */
export async function relatedMemories(tx: MemoryTx, uid: string, said: string, ms: number = MEMORY_STMT_MS): Promise<MemoryRow[]> {
  const keys = memoryTerms(said).slice(0, QUERY_TERMS_MAX);
  if (keys.length === 0) return [];
  await tx.unsafe(stmtFor(ms));
  return ((await run(tx, RELATED_SQL, [uid, JSON.stringify(keys), RELATED_LIMIT])) as Record<string, unknown>[]).map(rowOf);
}

/** 要存的一条：replaces 是要改写的那条 id */
export interface MemoryWrite {
  text: string;
  norm: string;
  replaces: string | null;
}

/** 真存上的一条；改写时带被替换的旧行，撤销靠它换回去 */
export interface MemorySaved {
  id: string;
  text: string;
  replaced?: { id: string; text: string };
}

const versionOf = async (tx: MemoryTx, uid: string): Promise<string> => String(((await run(tx, VERSION_SQL, [uid])) as Record<string, unknown>[])[0]?.['v'] ?? '');

/** 存这一轮记下的，判重和上限只在这里（锁内）：
 *  ver 是开轮读的版本，这期间用户删过、清空过（或另一轮存过）就整批放弃，不把刚删的内容写回；
 *  重复的、满了的不存；replaces 没命中（旧行已被删）直接丢弃，不当新记忆插入 */
export async function saveMemories(tx: MemoryTx, uid: string, items: readonly MemoryWrite[], now: number, ver: string): Promise<MemorySaved[]> {
  await tx.unsafe(STMT);
  await run(tx, LOCK_SQL, [uid]);
  if ((await versionOf(tx, uid)) !== ver) return [];
  let count = await countOf(tx, uid);
  const out: MemorySaved[] = [];
  for (const it of items) {
    if (((await run(tx, SAME_NORM_SQL, [uid, it.norm])) as unknown[]).length > 0) continue;   // 已经记过（包括改写成和另一条一样）
    const keys = JSON.stringify(memoryTerms(it.text));
    let replaced: MemorySaved['replaced'];
    if (it.replaces !== null) {
      const old = ((await run(tx, RETIRE_SQL, [uid, it.replaces, now])) as Record<string, unknown>[])[0];
      if (old === undefined) continue;
      replaced = { id: String(old['id']), text: String(old['text']) };
    } else if (count >= MEMORIES_MAX) {
      continue;
    }
    const rows = (await run(tx, INSERT_SQL, [uid, it.text, it.norm, now, keys])) as Record<string, unknown>[];
    if (replaced === undefined) count += 1;   // 改写一删一加，条数不变
    out.push({ id: String(rows[0]?.['id']), text: it.text, ...(replaced ? { replaced } : {}) });
  }
  return out;
}

/** 撤销一次改写：同一事务里软删新行、恢复旧行 */
export async function undoReplace(tx: MemoryTx, uid: string, id: string, replaced: string, now: number): Promise<boolean> {
  await tx.unsafe(STMT);
  await run(tx, LOCK_SQL, [uid]);
  if (((await run(tx, CAN_SWAP_SQL, [uid, id, replaced])) as unknown[]).length === 0) return false;
  await run(tx, DELETE_SQL, [uid, id, now]);
  return ((await run(tx, UNDO_SQL, [uid, replaced])) as unknown[]).length > 0;
}

export async function deleteMemory(tx: MemoryTx, uid: string, id: string, now: number): Promise<boolean> {
  await tx.unsafe(STMT);
  return ((await run(tx, DELETE_SQL, [uid, id, now])) as unknown[]).length > 0;
}

/** 撤销一条：满 MEMORIES_MAX 条了不恢复 */
export async function undoMemory(tx: MemoryTx, uid: string, id: string): Promise<boolean> {
  await tx.unsafe(STMT);
  await run(tx, LOCK_SQL, [uid]);
  if ((await countOf(tx, uid)) >= MEMORIES_MAX) return false;
  return ((await run(tx, UNDO_SQL, [uid, id])) as unknown[]).length > 0;
}

export async function clearMemories(tx: MemoryTx, uid: string): Promise<void> {
  await tx.unsafe(STMT);
  await run(tx, LOCK_SQL, [uid]);
  await run(tx, CLEAR_SQL, [uid]);
}
