// tools/e2e/real-backend.mjs 的护栏和 config 改写（纯函数、常量），从 real-backend.mjs 原样拆出免超 max-lines（E2E-REAL ⑦，10-30）。
// 行为不变：real-backend.mjs 用 export * 原样转出，调用方（tests/build/e2e-real-backend.test.ts、playwright.real.config.ts）照旧从 real-backend.mjs 引。
// 各项的说明见 real-backend.mjs 头注释“护栏”一节。不起子进程、不读写文件（ROOT 只是路径计算）。
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
/** supabase 命令唯一的 cwd（相对仓库根目录）；--workdir 一律是 . */
export const E2E_WORKDIR = '.e2e-sb';
export const E2E_PROJECT_ID = 'lemo-e2e';
export const E2E_REDIRECT = 'http://127.0.0.1:8789/app/';
/** e2e 专用：调高发信上限（仓库 config 是 30，见文件头） */
export const E2E_EMAIL_SENT = 1000;
/** 端口白名单：55320～55329，外加 edge runtime 的 inspector 8084 */
export const ALLOWED_PORT_RANGE = [55320, 55329];
export const ALLOWED_EXTRA_PORTS = [8084];
/** 改写时要挪走的端口段（别人占着的，闭区间）：表里没有的端口项落在这里就挪进 553xx 的同一个尾号 */
export const FORBIDDEN_PORT_RANGES = [
  [54320, 54329],
  [58320, 58329],
];
/** 要复制进 .e2e-sb/supabase/ 的东西（.env*、.temp、tests、snippets 不复制） */
export const COPY_ITEMS = ['migrations', 'functions', 'seed.sql', 'templates', 'config.toml'];
/** up 清空 .e2e-sb/supabase/ 时留着的（CLI 自己的状态） */
export const KEEP_ON_CLEAN = ['.temp', '.branches'];

/**
 * 端口改写表：[小节, 键, e2e 的值]。
 * required = true 的项不管原文有没有都要显式写出来（没写 CLI 就用 543xx 默认值，会撞 lemomemo）；
 * 其余（smtp_port、pop3_port）原文写了才改。[inbucket] 是 [local_smtp] 的旧名，两个都认。
 */
export const PORT_TARGETS = [
  { section: 'api', key: 'port', value: 55321, required: true },
  { section: 'db', key: 'port', value: 55322, required: true },
  { section: 'db', key: 'shadow_port', value: 55320, required: true },
  { section: 'db.pooler', key: 'port', value: 55329, required: true },
  { section: 'studio', key: 'port', value: 55323, required: true },
  { section: 'local_smtp', alias: 'inbucket', key: 'port', value: 55324, required: true },
  { section: 'local_smtp', alias: 'inbucket', key: 'smtp_port', value: 55325, required: false },
  { section: 'local_smtp', alias: 'inbucket', key: 'pop3_port', value: 55326, required: false },
  { section: 'analytics', key: 'port', value: 55327, required: true },
  { section: 'analytics', key: 'vector_port', value: 55328, required: true },
  { section: 'edge_runtime', key: 'inspector_port', value: 8084, required: true },
];

const SECTION_RE = /^\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/;
const KEY_RE = /^(\s*)([A-Za-z0-9_]+)(\s*=\s*)(.*?)(\s*(?:#[^"]*)?)$/;

/**
 * 值原文是不是本行就完整结束的单行值：没有 """ / '''（多行字符串的开头或结尾）、引号在本行配对、[ ] { } 在本行配对。
 * 不是就返回 false，调用方当成认不出的行——多行字符串里可以藏一段假的 [api] port = 55321，按标准 TOML 那段只是字符串，
 * CLI 实际用默认的 54321（审查必改，10-30）
 */
export function isCompleteValue(v) {
  if (v.includes('"""') || v.includes("'''")) return false;
  let quote = '';
  let depth = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = '';
    } else if (quote === "'") {
      if (c === "'") quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth < 0) return false;
    } else if (c === '#') break;
  }
  return quote === '' && depth === 0;
}

/** 逐行解析 TOML 里用得到的部分：每行所在小节、键、值原文（只认本行完整的单行值；注释行跳过；认不出的行 kind = 'other'） */
export function parseLines(text) {
  let section = '';
  return text.split('\n').map((raw) => {
    const line = raw.replace(/\r$/, '');
    if (/^\s*#/.test(line) || line.trim() === '') return { raw, section, kind: 'blank' };
    const s = SECTION_RE.exec(line);
    if (s) {
      section = s[1];
      return { raw, section, kind: 'section' };
    }
    // 行里有 \u、\U、\x、\e（转义写的键名或值，如 "port"、TOML 1.1 的 \x3a）一律认不出：按原文找会被绕过（复审必改、建议，10-30）
    if (/\\[uUxe]/.test(line)) return { raw, section, kind: 'other' };
    const k = KEY_RE.exec(line);
    // 值里有 {（行内表，或数组里套行内表）一律认不出：表里的键可能是端口；仓库 config 里一个行内表都没有
    // 值加上行尾那段一起查：KEY_RE 可能把 # 之后带引号的部分划进 tail
    if (k && !k[4].includes('{') && isCompleteValue(`${k[4]}${k[5]}`)) {
      return { raw, section, kind: 'key', indent: k[1], key: k[2], eq: k[3], value: k[4], tail: k[5] };
    }
    return { raw, section, kind: 'other' };
  });
}

/** 允许用 env(...) 的值（section、key、值原文都写死）；仓库 config 只有 [auth.captcha] secret 这一处 */
export const ENV_ALLOWED = [{ section: 'auth.captcha', key: 'secret', value: '"env(SUPABASE_AUTH_CAPTCHA_SECRET)"' }];
const envAllowed = (l) => ENV_ALLOWED.some((a) => a.section === l.section && a.key === l.key && a.value === l.value);
const inForbiddenRange = (p) => FORBIDDEN_PORT_RANGES.some(([lo, hi]) => p >= lo && p <= hi);
const sectionMatches = (t, section) => section === t.section || (t.alias !== undefined && section === t.alias);
/** 端口值原文是否在白名单里：纯十进制整数（不带引号、下划线、0x、env()），在 55320～55329 或等于 8084 */
export function portAllowed(rawValue) {
  if (!/^[1-9]\d*$/.test(rawValue)) return false;
  const p = Number(rawValue);
  return (p >= ALLOWED_PORT_RANGE[0] && p <= ALLOWED_PORT_RANGE[1]) || ALLOWED_EXTRA_PORTS.includes(p);
}

/**
 * 读出 project_id（顶层，值原文）和所有端口项（键名以 port 结尾，不管值怎么写）
 * @param {string} text
 * @returns {{ projectId: string | undefined, projectIdCount: number, ports: { section: string, key: string, raw: string, port: number | null }[] }}
 */
export function readConfigFacts(text) {
  const lines = parseLines(text);
  const pids = lines.filter((l) => l.kind === 'key' && l.section === '' && l.key === 'project_id');
  const projectId = pids[0]?.value;
  const ports = lines
    .filter((l) => l.kind === 'key' && /port$/i.test(l.key))
    .map((l) => ({ section: l.section, key: l.key, raw: l.value, port: /^\d+$/.test(l.value) ? Number(l.value) : null }));
  return { projectId, projectIdCount: pids.length, ports };
}

/**
 * config 护栏（白名单）：返回问题列表，空数组才放行。
 * @param {string} text 目标 config.toml 的内容
 */
export function checkGuard(text) {
  const problems = [];
  const lines = parseLines(text);
  for (const l of lines) {
    const line = l.raw.replace(/\r$/, '');
    if (l.kind === 'other') problems.push(`认不出的写法（点号键、带引号的键、多行值、怪写法的小节头都不认）：${line.trim().slice(0, 60)}`);
    else if (l.kind === 'key' && /:0*(?:543|583)\d\d(?!\d)/.test(l.value)) {
      // 不管键名叫什么，值里出现 :543xx / :583xx（例如 [auth.hook.*] uri = "http://host.docker.internal:54321/..."）都拒
      problems.push(`[${l.section}] ${l.key} 的值里有 543xx / 583xx 端口（别人在用的本地 Supabase），拒绝`);
    } else if (l.kind === 'key' && l.value.includes('env(') && !envAllowed(l)) {
      // env(...) 的值在本机运行时才定，护栏看不到：只放行白名单里写死的那一处（仓库 config 只有这一个）
      problems.push(`[${l.section}] ${l.key} 用了 env(...)，不在白名单里，拒绝`);
    } else if (l.kind === 'key' && /^\[/.test(l.value) && /port|project_id/i.test(l.value)) {
      problems.push(`[${l.section}] ${l.key} 是数组，里面写了端口或 project_id，不认`);
    } else if (l.kind === 'key' && l.key !== 'project_id' && /project_id/i.test(l.key)) {
      // CLI 读 config 时键名不分大小写：PROJECT_ID、Project_Id 之类一律不认
      problems.push(`[${l.section}] ${l.key} 像 project_id，不认`);
    }
  }
  const { projectId, projectIdCount, ports } = readConfigFacts(text);
  if (projectIdCount === 0) problems.push('config.toml 里没有 project_id');
  else if (projectIdCount > 1) problems.push('config.toml 里 project_id 写了不止一次');
  else if (projectId !== `"${E2E_PROJECT_ID}"` && projectId !== `'${E2E_PROJECT_ID}'`) {
    problems.push(`project_id 必须正好是 "${E2E_PROJECT_ID}"（现在是 ${String(projectId).slice(0, 40)}），拒绝`);
  }
  for (const p of ports) {
    if (!portAllowed(p.raw)) {
      problems.push(`[${p.section}] ${p.key} = ${p.raw.slice(0, 30)} 不在白名单里（只许纯十进制的 55320～55329 或 8084）`);
    }
  }
  for (const t of PORT_TARGETS.filter((x) => x.required)) {
    if (!ports.some((p) => sectionMatches(t, p.section) && p.key === t.key)) {
      problems.push(`[${t.section}] ${t.key} 没写，CLI 会用默认端口（543xx 或 8083），拒绝`);
    }
  }
  return problems;
}

/**
 * 环境护栏：给 supabase 子进程拼的 env 去掉所有 SUPABASE_*（不分大小写），并检查目录里有没有 .env* 文件。
 * @param {Record<string, string | undefined>} envObj 当前进程的环境变量
 * @param {Record<string, string[]>} dirListing 目录 → 里面的文件名（.e2e-sb/、.e2e-sb/supabase/，即 spawn 的 cwd 和 CLI 读 config 的目录）
 * @returns {{ env: Record<string, string>, dropped: string[], problems: string[] }}
 */
export function checkEnv(envObj, dirListing) {
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(envObj)) {
    if (/^supabase_/i.test(k)) dropped.push(k);
    else if (v !== undefined) out[k] = v;
  }
  const problems = [];
  for (const [dir, names] of Object.entries(dirListing)) {
    for (const n of names) {
      if (/^\.env/i.test(n)) problems.push(`${dir} 里有 ${n}：supabase CLI 会读它覆盖 config，拒绝（删掉再跑）`);
    }
  }
  return { env: out, dropped, problems };
}

/**
 * 工作目录护栏：.e2e-sb、.e2e-sb/supabase 存在时不能是符号链接或目录联接（Windows 上 lstat 对联接也报 isSymbolicLink），
 * 真实路径必须正好是 <仓库真实路径>/.e2e-sb（/supabase）。prepare 清空目录前、每次跑 supabase 前都查；还不存在的不算问题。
 * @param {string} root 仓库根目录
 * @param {{ exists: (p: string) => boolean, isLink: (p: string) => boolean, realpath: (p: string) => string }} ops
 * @returns {string[]} 问题列表
 */
export function workdirProblems(root, ops) {
  const problems = [];
  const norm = (p) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  let realRoot;
  try {
    realRoot = ops.realpath(root);
  } catch {
    return ['读不出仓库根目录的真实路径'];
  }
  for (const rel of [E2E_WORKDIR, join(E2E_WORKDIR, 'supabase')]) {
    const p = join(root, rel);
    if (!ops.exists(p)) continue;
    if (ops.isLink(p)) {
      problems.push(`${rel.replace(/\\/g, '/')} 是符号链接或目录联接，拒绝（删掉它，up 会重新建普通目录）`);
      continue;
    }
    let real;
    try {
      real = ops.realpath(p);
    } catch {
      problems.push(`读不出 ${rel.replace(/\\/g, '/')} 的真实路径，拒绝`);
      continue;
    }
    if (norm(real) !== norm(join(realRoot, rel))) problems.push(`${rel.replace(/\\/g, '/')} 的真实路径不在仓库下（${real}），拒绝`);
  }
  return problems;
}

/** 把仓库的 config.toml 改写成 e2e 的副本（纯函数；改不了就抛错，不悄悄放过） */
export function rewriteConfig(text) {
  const lines = parseLines(text);
  // 认不出的行（多行字符串、多行数组、点号键……）里可能藏着端口，逐行改写会被骗，宁可不改
  const odd = lines.find((l) => l.kind === 'other');
  if (odd) throw new Error(`supabase/config.toml 有脚本认不出的写法，改写不了（多行值、点号键、带引号的键都不认）：${odd.raw.trim().slice(0, 60)}`);
  const seen = new Set();
  let sawRedirect = false;
  let sawEmailSent = false;
  const out = lines.map((l) => {
    if (l.kind !== 'key') return l.raw;
    const put = (v) => `${l.indent}${l.key}${l.eq}${v}${l.tail}`;
    if (l.section === '' && l.key === 'project_id') {
      seen.add('project_id');
      return put(`"${E2E_PROJECT_ID}"`);
    }
    const t = PORT_TARGETS.find((x) => sectionMatches(x, l.section) && x.key === l.key);
    if (t) {
      seen.add(`${t.section}.${t.key}`);
      return put(String(t.value));
    }
    if (/port$/.test(l.key) && /^\d+$/.test(l.value) && inForbiddenRange(Number(l.value))) {
      // 表里没有的端口项（CLI 以后新加的）：543xx / 583xx 一律挪到 553xx 的同一个尾号
      return put(String(55320 + (Number(l.value) % 10)));
    }
    if (l.section === 'auth' && l.key === 'additional_redirect_urls') {
      sawRedirect = true;
      let urls;
      try {
        urls = JSON.parse(l.value);
      } catch {
        throw new Error(`[auth] additional_redirect_urls 不是单行数组，脚本改不了：${l.value}`);
      }
      if (!urls.includes(E2E_REDIRECT)) urls.push(E2E_REDIRECT);
      return put(JSON.stringify(urls).replace(/","/g, '", "'));
    }
    if (l.section === 'auth.rate_limit' && l.key === 'email_sent') {
      sawEmailSent = true;
      return put(`${E2E_EMAIL_SENT}`);
    }
    return l.raw;
  });
  // 缺的项补上：小节在就插到小节标题下一行，小节不在就追加到文件末尾
  const missing = [];
  if (!seen.has('project_id')) out.unshift(`project_id = "${E2E_PROJECT_ID}"`);
  for (const t of PORT_TARGETS.filter((x) => x.required && !seen.has(`${x.section}.${x.key}`))) {
    missing.push({ section: t.section, alias: t.alias, line: `${t.key} = ${t.value}` });
  }
  if (!sawRedirect) missing.push({ section: 'auth', line: `additional_redirect_urls = ["${E2E_REDIRECT}"]` });
  if (!sawEmailSent) missing.push({ section: 'auth.rate_limit', line: `email_sent = ${E2E_EMAIL_SENT}` });
  for (const m of missing) {
    const at = out.findIndex((raw) => {
      const s = SECTION_RE.exec(raw.replace(/\r$/, ''));
      return s !== null && (s[1] === m.section || s[1] === m.alias);
    });
    if (at >= 0) out.splice(at + 1, 0, m.line);
    else out.push('', `[${m.section}]`, m.line);
  }
  const header =
    '# 由 tools/e2e/real-backend.mjs 从 supabase/config.toml 生成，只给 e2e 用，不要手改（每次 up 重新生成）。\n' +
    '# 偏差：project_id = lemo-e2e、端口 553xx、inspector 8084、多一个 8789 回跳地址、email_sent 调高；仓库的 config.toml 不改。\n';
  return header + out.join('\n');
}
