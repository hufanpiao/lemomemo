// 核对 version-gate 的免查名单（架构 0.27 第 1 点、TC-B0-52）：名单里写了、supabase/functions/ 下却没有的函数报错。
// 0.32（R-213，14.2 第 10、11 点）另查：免查规则里不准再有 /storage/v1/（客户端不访问 Supabase Storage）；
// /files 的 PUT 必须查版本，POST sign 和 GET 不查（TC-B0-51）。
// CI 由运维接进流水线。需要 Node 22.18 以上（直接 import .ts）。
//
// 用法：node build/check_version_gate.mjs [--functions-dir <目录>]
// 退出码：0 通过；1 有问题。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function checkExemptFunctions(exempt, functionsDir) {
  const errors = [];
  const seen = new Set();
  for (const f of exempt) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(f.name)) errors.push(`函数名不合规：${f.name}`);
    if (seen.has(f.name)) errors.push(`名单里重复：${f.name}`);
    seen.add(f.name);
    if (!Array.isArray(f.methods) || f.methods.length === 0) errors.push(`${f.name}：没写方法`);
    // B1 K10 安全审查：方法只能是大写的 HTTP 方法（小写、OPTIONS、拼错的写了等于没免，或者免错）；
    // 客户端经 /sb 调的项（caller = client）不准用 '*'：只免旧版本必须能做的那几个方法
    for (const m of Array.isArray(f.methods) ? f.methods : []) {
      if (m !== '*' && !HTTP_METHODS.has(m)) errors.push(`${f.name}：方法只能是大写的 ${[...HTTP_METHODS].join('、')} 或 '*'（${m}）`);
      if (m === '*' && f.caller === 'client') errors.push(`${f.name}：客户端调用的函数（caller = client）不准免查全部方法（'*'），只列旧版本必须能用的方法`);
    }
    const dir = join(functionsDir, f.name);
    if (!existsSync(dir) || !statSync(dir).isDirectory() || !existsSync(join(dir, 'index.ts'))) {
      errors.push(`名单里有、supabase/functions/ 下却没有：${f.name}`);
    }
  }
  return errors;
}

/** 0.32 的几条：rules 是 EXEMPT_RULES，needs 是 needsVersionCheck */
export function checkRules(rules, needs) {
  const errors = [];
  for (const r of rules) {
    if (r.path.startsWith('/storage/')) errors.push(`免查规则里不准有存储（0.32）：${r.method} ${r.path}`);
    if (r.path.startsWith('/files/')) errors.push(`/files 不进免查规则，由 needsVersionCheck 按方法判断（0.32）：${r.method} ${r.path}`);
  }
  const cases = [
    ['PUT', '/files/v1/o/images/u/n/i.webp', true],
    ['PUT', '/files/v1/o/files/u/n/i.pdf', true],
    ['POST', '/files/v1/sign', false],
    ['GET', '/files/v1/o/images/u/n/i.webp', false],
    ['POST', '/storage/v1/object/sign/images', true],
    ['POST', '/storage/v1/object/list/images', true],
  ];
  for (const [m, p, want] of cases) {
    if (needs(m, p) !== want) errors.push(`needsVersionCheck(${m} ${p}) 应该是 ${want}`);
  }
  return errors;
}

// ---------- 迁移里写进 app_config.min_client_version 的值（B1 K10 安全审查低优先级 ②） ----------
// 两道版本门只认每段 1～6 位（'^\d{1,6}\.\d{1,6}\.\d{1,6}$'），超过 6 位的值会被当“格式不对”而放行所有人。
// 数据库约束原来（0001_core.sql）是 '^\d+\.\d+\.\d+$'，迁移 20261029190000_core_min_client_version_check.sql 起收紧到同一写法，
// 负责人在控制台手改也受它管（发布清单写明格式）。这里在 CI 里提前核对迁移里写的每个值，不用等到 supabase db reset 才报。
const MIN_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** 按顶层逗号切开（引号、括号里的逗号不算） */
function splitTop(text) {
  const out = [];
  let depth = 0, q = false, cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      cur += c;
      if (c === "'" && text[i + 1] === "'") { cur += "'"; i++; } else if (c === "'") q = false;
      continue;
    }
    if (c === "'") q = true;
    else if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) { out.push(cur); return { parts: out, end: i }; } depth--; }
    else if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return { parts: out, end: text.length };
}

// 去掉 -- 行注释和 /* … */ 块注释（Postgres 的块注释能嵌套，这里按嵌套计数）
function stripSqlComments(sql) {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      if (nl < 0) break;
      i = nl - 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else i++;
      }
      out += ' ';
      i--;
      continue;
    }
    out += sql[i];
  }
  return out;
}

const DOLLAR_RE = /\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g;
/** $$ 函数体里能写表、能拼 SQL 的关键字：体里同时出现 min_client_version 就看不出写进去的值 */
const BODY_WRITE_RE = /\b(update|insert|merge|execute|copy)\b/i;

/**
 * 迁移文本里和 min_client_version 有关的写入：
 * • literals：$$ 外面 update … set min_client_version = '…'、insert into …app_config (…) values (…) 里的值（不是字面量的原样放进来，也会报）；
 * • opaque：$$ 包起来的函数体、DO 块里出现 min_client_version，而且体里有 update / insert / merge / execute / copy 的——
 *   取不到字面量，一律报（偏严，K10 复审）。只读的体（比如迁移 20261029190000 开头核对现有值的 DO 块）不报。
 */
export function minVersionFindings(sql) {
  const code = stripSqlComments(sql);
  const opaque = [];
  for (const m of code.matchAll(DOLLAR_RE)) {
    if (/min_client_version/i.test(m[0]) && BODY_WRITE_RE.test(m[0])) opaque.push(m[0].slice(0, 60).replace(/\s+/g, ' '));
  }
  const outside = code.replace(DOLLAR_RE, ' ');
  const literals = [];
  for (const m of outside.matchAll(/min_client_version\s*=\s*'([^']*)'/gi)) literals.push(m[1]);
  for (const m of outside.matchAll(/insert\s+into\s+(?:public\.)?app_config\s*\(([^)]*)\)\s*values\s*\(/gi)) {
    const cols = m[1].split(',').map((c) => c.trim().toLowerCase());
    const idx = cols.indexOf('min_client_version');
    if (idx < 0) continue;
    const { parts } = splitTop(outside.slice(m.index + m[0].length));
    const v = (parts[idx] ?? '').trim();
    const lit = /^'([^']*)'$/.exec(v);
    if (lit) literals.push(lit[1]);
    else if (!/^null$/i.test(v)) literals.push(v);   // 不是字面量也报：看不出写进去的是什么
  }
  return { literals, opaque };
}

/** 只要 $$ 外面取得到的字面量（老接口，测试和别处用） */
export function minVersionLiterals(sql) {
  return minVersionFindings(sql).literals;
}

export function checkMigrationMins(migrationsDir) {
  const errors = [];
  if (!existsSync(migrationsDir)) return errors;
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    const { literals, opaque } = minVersionFindings(readFileSync(join(migrationsDir, f), 'utf8'));
    for (const v of literals) {
      if (!MIN_RE.test(v)) errors.push(`${f}：min_client_version 写成了 ${v}，版本门只认每段 1～6 位的三段数字（不认的值会放行所有人）`);
    }
    for (const b of opaque) {
      errors.push(`${f}：$$ 函数体里写 min_client_version，取不到字面量（${b}…）；改成 $$ 外面的 update / insert 写字面量`);
    }
  }
  return errors;
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--functions-dir');
  const functionsDir = resolve(ROOT, i >= 0 ? args[i + 1] : 'supabase/functions');
  const { EXEMPT_FUNCTIONS, EXEMPT_RULES, needsVersionCheck } = await import('../functions/sb/version-gate.ts');
  // B1 K10：免查函数的唯一出处是 shared/version-gate-list.ts（转发层只取 caller = client 的几项），整份都核对
  const { FUNCTION_VERSION_EXEMPTIONS } = await import('../shared/version-gate-list.ts');
  const errors = [
    ...checkExemptFunctions(FUNCTION_VERSION_EXEMPTIONS, functionsDir),
    ...checkRules(EXEMPT_RULES, needsVersionCheck),
    ...checkMigrationMins(resolve(ROOT, 'supabase/migrations')),
  ];
  if (errors.length) {
    console.error('version-gate 免查名单检查没通过：');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`version-gate 免查名单检查通过（${FUNCTION_VERSION_EXEMPTIONS.length} 个函数，其中转发层放行 ${EXEMPT_FUNCTIONS.length} 个）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
