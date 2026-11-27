// D1 的 auth.users 守卫（0.36 第 1 条 ①，TC-B0-121）：把密码置空的触发器 users_guard_no_password 和 before 触发器白名单的判定（纯函数）。
// 10-30 从 build/d1/checks.ts 原样挪出（W1 超行），行为不变；checks.ts 的 runD1 查库后调这里，并原样转出这些导出

/** 0001_core.sql 里 auth.users 上把密码置空的触发器（0.36 第 1 条 ①，TC-B0-121） */
export const GUARD_NO_PASSWORD = 'users_guard_no_password';
/** en = tgenabled，ty = tgtype，fs.f = 调的函数；def = 带 WHEN 条件时的 pg_get_triggerdef（tgqual 为空时是 null）；
 *  na = tgattr 里的列数（update of 列）；src = 调的函数的 prosrc */
export interface GuardRow { en: string; ty: number | string; fs: string; f: string; def: string | null; na: number | string; src: string }

/** 0001_core.sql 原样的 WHEN 条件（只在要写进非空密码时才触发，语义上和不带条件一样）。
 *  代码审查有条件通过 5 要求 tgqual 为空，但 0001 已发布、带着这个条件，D1 在真库上必须放行它；除它以外的任何条件都报 */
const GUARD_WHEN_0001 = "coalesce(new.encrypted_password, '') <> ''";
/** 0001_core.sql 里 private.guard_no_password() 的函数体（$$ 之间的原文）。代码审查第三轮必改 3：不再只看“含有置空那一句”，
 *  规范化后整段比较（if false 包起来、写在注释里、先置空再赋回都对不上） */
const GUARD_BODY_0001 = "\nbegin\n  new.encrypted_password := '';\n  return new;\nend ";
/** auth.users 上允许的 before insert / update 触发器（白名单，第三轮低）：只有 0001 的这一个 */
const AUTH_USERS_BEFORE_OK = [GUARD_NO_PASSWORD];

/** SQL 规范化：去掉 -- 和 /* *\/ 注释；字符串字面量（'…'，'' 是转义）原样保留；字符串以外的部分转小写、去掉空白，
 *  casts = 再去掉类型转换（::text、::character varying，类型名只认一个词或 character varying，吞不掉后面的 or / and），
 *  parens = 再去掉括号。第三轮低：WHEN 规范化时字符串字面量的内容不动（'x' 和 '' 不会被当成一样） */
export function sqlNorm(s: string, opt: { casts?: boolean; parens?: boolean } = {}): string {
  let out = '', buf = '', i = 0;
  const n = s.length;
  const flush = () => {
    let t = buf.toLowerCase();
    if (opt.casts) t = t.replace(/::\s*(?:character\s+varying|[a-z_][a-z0-9_]*)(?:\s*\(\s*\d+\s*\))?/g, ' ');
    if (opt.parens) t = t.replace(/[()]/g, ' ');
    out += t.replace(/\s+/g, '');
    buf = '';
  };
  while (i < n) {
    if (s.startsWith('--', i)) { const j = s.indexOf('\n', i); i = j < 0 ? n : j; buf += ' '; continue; }
    if (s.startsWith('/*', i)) { const j = s.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; buf += ' '; continue; }
    if (s[i] === "'") {
      let j = i + 1;
      while (j < n && !(s[j] === "'" && s[j + 1] !== "'")) j += s[j] === "'" ? 2 : 1;
      flush();
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    buf += s[i];
    i++;
  }
  flush();
  return out;
}
const normWhen = (s: string) => sqlNorm(s, { casts: true, parens: true });

/** S6：users_guard_no_password 那一行（pg_trigger 查出来的，没有就是 undefined）→ 问题列表。
 *  单独导出给 tests/build/d1-guard-no-password.test.ts：真 Supabase 上 postgres 不是 auth.users 的属主，
 *  disable 不了这个触发器，“没启用”这一支只能在这里和离线 PGlite 的违规样例里证明 */
export function checkGuardNoPassword(g: GuardRow | undefined): string[] {
  if (!g) return [`auth.users 上没有触发器 ${GUARD_NO_PASSWORD}（0.36 第 1 条 ①：账号不许有密码）`];
  const out: string[] = [];
  // tgenabled：O = 平时触发（origin、local），A = 始终触发（含 replica），两种都行；D = 停用，R = 只在 replica 下触发
  if (g.en !== 'O' && g.en !== 'A') out.push(`auth.users 的触发器 ${GUARD_NO_PASSWORD} 平时不触发（tgenabled = '${g.en}'：D 是停用、R 是只在 replica 下触发；要 'O' 或 'A'）`);
  // tgtype 位：1 = for each row，2 = before，4 = insert，16 = update；8 = delete、32 = truncate、64 = instead of 不该有
  const ty = Number(g.ty);
  if ((ty & 0b1111111) !== (1 | 2 | 4 | 16)) out.push(`auth.users 的触发器 ${GUARD_NO_PASSWORD} 不是 before insert or update for each row（tgtype = ${ty}）`);
  // 代码审查有条件通过 5：update of 列（tgattr 非空）——改别的列时不触发
  if (Number(g.na) > 0) out.push(`auth.users 的触发器 ${GUARD_NO_PASSWORD} 写成了 update of 列（tgattr 有 ${g.na} 列），要整行 update 都触发`);
  // 代码审查有条件通过 5：WHEN 条件（tgqual 非空）——只放行 0001 原样的那一个
  if (g.def !== null) {
    const when = /\sWHEN\s+\(([\s\S]*)\)\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\s/i.exec(g.def)?.[1];
    if (when === undefined || normWhen(when) !== normWhen(GUARD_WHEN_0001)) {
      out.push(`auth.users 的触发器 ${GUARD_NO_PASSWORD} 带了 WHEN 条件（${when ?? g.def}），只准不带条件或 0001 原样的 when (${GUARD_WHEN_0001})`);
    }
  }
  if (`${g.fs}.${g.f}` !== 'private.guard_no_password') out.push(`auth.users 的触发器 ${GUARD_NO_PASSWORD} 调的是 ${g.fs}.${g.f}()，不是 private.guard_no_password()`);
  // 代码审查第三轮必改 3：函数体规范化后和 0001 原文整段比较（只差空白、大小写、注释的算一样）
  else if (sqlNorm(g.src) !== sqlNorm(GUARD_BODY_0001)) out.push(`private.guard_no_password() 的函数体和 0001 不一样（规范化后整段比较；要的是 new.encrypted_password := ''; return new;），可能不再把密码置空`);
  return out;
}

/** 第三轮低：auth.users 上 before insert / update 的触发器（name = tgname，ty = tgtype）→ 白名单以外的都报
 *  （别的 before 触发器排在 users_guard_no_password 后面就能把密码改回去）。单独导出给 tests/build/d1-guard-no-password.test.ts */
export function checkAuthUsersTriggers(rows: readonly { name: string; ty: number | string }[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const ty = Number(r.ty);
    if ((ty & 2) && (ty & (4 | 16)) && !AUTH_USERS_BEFORE_OK.includes(r.name)) {
      out.push(`auth.users 上有白名单以外的 before insert / update 触发器 ${r.name}（只准 ${AUTH_USERS_BEFORE_OK.join('、')}；排在后面的 before 触发器能把密码改回去）`);
    }
  }
  return out;
}
