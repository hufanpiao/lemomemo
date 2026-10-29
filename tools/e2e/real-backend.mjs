// e2e 接真后端：在 .e2e-sb/ 起一套独立的本地 Supabase（project_id = lemo-e2e，端口 553xx）
//
// 用法（仓库根目录）：
//   node tools/e2e/real-backend.mjs up     先跑 npm run copy:shared，清空 .e2e-sb/supabase/（.temp、.branches 留着）后把 supabase/ 复制过去并改写 config.toml，
//                                          过护栏后在 .e2e-sb 里跑 supabase start -x studio --workdir .
//   node tools/e2e/real-backend.mjs env    supabase status -o json，输出 API_URL、ANON_KEY、SERVICE_ROLE_KEY、MAILPIT_URL
//                                          （KEY=value 一行一个；加 --json 输出 JSON）。都是本地演示密钥，也不要贴进聊天或日志
//   node tools/e2e/real-backend.mjs check  同 env 的取法，只说“在跑、拿到了哪些字段”，不输出值；取不到退出码非 0（npm run e2e:real 的第一步）
//   node tools/e2e/real-backend.mjs down   supabase stop --no-backup，只停 lemo-e2e
// 作为模块用：statusEnv() 取四个字段；出错抛 RealBackendError（消息带 NOT_UP_HINT），不在调用方进程里 exit
//
// 为什么不直接用仓库的 supabase/config.toml：本机常年跑着别人在用的本地 Supabase——lemomemo（54321～54329）、
// lemo-qadb（58321、58322），还有 lemo-purgeit 的数据卷。CLI 按 project_id 给容器、数据卷起名，按 config 绑端口，
// 用仓库的 config 一 start / stop 就会撞上 lemomemo。所以本脚本只在 .e2e-sb 里跑 supabase 命令（cwd = .e2e-sb、--workdir .），
// 从不在仓库根目录跑，也不用 stop --all。CI 也一样走 .e2e-sb（不再有直接用仓库 config 的口子）。
//
// 副本 config.toml 和仓库的不同之处（e2e 专用的偏差，仓库里的 supabase/config.toml 不改）：
//   • project_id = "lemo-e2e"；所有端口挪进 553xx，edge runtime 的 inspector_port 改 8084（见 PORT_TARGETS）；
//   • [auth] additional_redirect_urls 加上 http://127.0.0.1:8789/app/（e2e 的 wrangler pages dev 端口）；
//   • [auth.rate_limit] email_sent 从 30 调到 1000：e2e 一轮要发很多封验证码（都进 Mailpit），按线上的每小时 30 封会被限流。
//     这一条只为测试能跑，线上和仓库 config 照旧是 30（架构 15.6 总表）。
//
// 护栏（纯函数，tests/build/e2e-real-backend.test.ts 单测），up、env、check、down 都先过，过不了一个 supabase 命令都不跑：
//   • checkGuard（config.toml，白名单）：project_id 必须严格等于 "lemo-e2e"（CLI 会去掉开头的 _ . -，" lemomemo"、"_lemomemo" 之类都拒）；
//     所有以 port 结尾的键，值必须是纯十进制整数、在 55320～55329 之间或等于 8084（"54325"、54_321、0xD431、"env(X)" 一律拒）；
//     必写的端口项没写（CLI 会用 543xx 默认值）拒；认不出的行（点号键、带引号的键、内联表、多行值、写法怪的小节头）拒。
//     多行值按 isCompleteValue 认：值里有 """ 或 '''、引号或 [ ] { } 在本行没配对，都算认不出（多行字符串里能藏一段假的 [api] port，
//     标准 TOML 里那只是字符串，CLI 照旧用 54321）；值里有 {（行内表、数组里套行内表）、行里有 \u / \U（转义写的键名）也算认不出；
//     rewriteConfig 遇到认不出的行直接抛错，不逐行改写。不管键名叫什么，值里出现 :543xx / :583xx 也拒（hook 的 uri 之类）。
//   • workdirProblems：.e2e-sb、.e2e-sb/supabase 不能是符号链接或目录联接，真实路径必须就在仓库下（prepare 清空目录前、每次跑 supabase 前查）。
//   • checkEnv（环境变量和 .env 文件）：CLI 2.120 认 SUPABASE_PROJECT_ID、SUPABASE_API_PORT 等变量，还读 cwd 里的 .env、.env.local、.env.<SUPABASE_ENV>，
//     都能绕过 config。所以 spawn 时自己拼一份 env，去掉所有 /^supabase_/i 的变量（Windows 键名不分大小写；含 SUPABASE_CLI_BINARY_OVERRIDE、SUPABASE_ENV）；
//     .e2e-sb/、.e2e-sb/supabase/ 里有任何 .env* 文件就拒绝。cwd 是 .e2e-sb，读不到仓库根目录的 .env*。
// supabase CLI：用 node_modules 里那份（package.json 锁版本；CI 跑过 npm ci 之后也是这份），没有时才用 PATH 上的 supabase。
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { argv, env, execPath, exit, stderr, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

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

/**
 * lemo-e2e 的边缘函数环境（第 6 步，10-30）：prepare 写到 .e2e-sb/supabase/functions/.env，supabase start 起的 edge runtime 默认读它。
 * 一律是一看就假的值，不碰真密钥；PROXY_SECRET 必须和 tests/e2e/fake-values.ts 的 FAKE_PROXY_SECRET 一样（单测核对），
 * 函数才信 /sb 转发层写的 x-proxy-secret。
 * 发信：account、invite-signup 把 Resend 的地址写死成 https://api.resend.com，假密钥也会真发请求、把测试邮箱带到外网——
 * 所以 HTTPS_PROXY、HTTP_PROXY（大小写两种）都指容器里没人听的 127.0.0.1:9，出站一律连不上，sendMail 回 false（函数照常走“没发出去”的分支）。
 * NO_PROXY 只放行（10-30 审查建议 1，按函数实际要连的来）：npm 源（edge runtime 启动时按 deno.lock 拉依赖，挡了函数起不来，10-30 实测 503）；
 * kong（容器里的 SUPABASE_URL = http://kong:8000，supabase-js 走它）、supabase_kong_lemo-e2e、supabase_db_lemo-e2e（SUPABASE_DB_URL 的主机，
 * postgres 协议本来不走代理，写上防万一）、localhost、127.0.0.1、host.docker.internal。TURNSTILE_SECRET 不设（[auth.captcha] 本地关）。
 */
const E2E_FN_PROXY = 'http://127.0.0.1:9';
const E2E_FN_NO_PROXY = 'registry.npmjs.org,kong,supabase_kong_lemo-e2e,supabase_db_lemo-e2e,localhost,127.0.0.1,host.docker.internal';
export const E2E_FUNCTIONS_ENV = {
  PROXY_SECRET: 'fake-proxy-secret-for-e2e-only',
  RESEND_API_KEY: 'fake-resend-key-for-e2e-only',
  SIGNUP_HASH_SECRET: 'fake-signup-hash-secret-for-e2e-only',
  CRON_SECRET: 'fake-cron-secret-for-e2e-only',
  OPS_SECRET: 'fake-ops-secret-for-e2e-only',
  HTTPS_PROXY: E2E_FN_PROXY,
  https_proxy: E2E_FN_PROXY,
  HTTP_PROXY: E2E_FN_PROXY,
  http_proxy: E2E_FN_PROXY,
  NO_PROXY: E2E_FN_NO_PROXY,
  no_proxy: E2E_FN_NO_PROXY,
};
/**
 * 写成 env 文件：一行一个 KEY=VALUE，值不带引号（上面的值里都没有空格、引号、#；NO_PROXY 用逗号分隔）
 * @param {Record<string, string>} [vars]
 */
export function functionsEnvText(vars = E2E_FUNCTIONS_ENV) {
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /^supabase_/i.test(k)) throw new Error(`函数环境变量名不认：${k}`);
    if (!/^[A-Za-z0-9_:/.,-]+$/.test(v)) throw new Error(`函数环境变量 ${k} 的值有怪字符`);
  }
  return '# 由 tools/e2e/real-backend.mjs 生成，只给 lemo-e2e 的边缘函数用，全是假值；每次 up 重新生成\n' +
    Object.entries(vars).map(([k, v]) => `${k}=${v}\n`).join('');
}

/** 从 supabase status -o json 的结果里挑 e2e 要的四个字段（新旧 CLI 的字段名都认）；缺了抛错 */
export function pickEnv(status) {
  const pick = (...names) => names.map((n) => status[n]).find((v) => typeof v === 'string' && v !== '');
  const out = {
    API_URL: pick('API_URL'),
    ANON_KEY: pick('ANON_KEY', 'PUBLISHABLE_KEY'),
    SERVICE_ROLE_KEY: pick('SERVICE_ROLE_KEY', 'SECRET_KEY'),
    MAILPIT_URL: pick('MAILPIT_URL', 'INBUCKET_URL'),
  };
  const lack = Object.entries(out).filter(([, v]) => v === undefined).map(([k]) => k);
  if (lack.length > 0) throw new Error(`supabase status 里缺字段：${lack.join('、')}`);
  // 再拦一道：API 必须是 lemo-e2e 的 55321，不是就说明连错了库
  if (new URL(out.API_URL).port !== '55321') throw new Error(`API_URL 不在 55321 端口，拒绝输出（${new URL(out.API_URL).host}）`);
  return out;
}

/**
 * 命令行入口判断：argv[1] 和本文件（按真实路径比，经目录联接、符号链接调用也认得出）是同一个文件才跑 main
 * @param {string | undefined} argv1
 * @param {string} selfPath
 * @param {(p: string) => string} [realpath] 测试时换掉
 * @returns {'main' | 'module' | 'mismatch'}
 */
export function entryKind(argv1, selfPath, realpath = realpathSync) {
  if (!argv1) return 'module';
  let a;
  let b;
  try {
    a = realpath(argv1);
    b = realpath(selfPath);
  } catch {
    return basename(argv1) === basename(selfPath) ? 'mismatch' : 'module';
  }
  if (a.toLowerCase() === b.toLowerCase()) return 'main';
  return basename(argv1) === basename(selfPath) ? 'mismatch' : 'module';
}

// ───────── 以下是命令行部分（起子进程，单测不覆盖） ─────────

/** 出错一律抛 RealBackendError（statusEnv 会在 Playwright 配置里调，不能在别人的进程里直接 exit）；命令行入口 main 统一接住再退出 */
export class RealBackendError extends Error {
  constructor(msg, code = 2) {
    super(msg);
    this.name = 'RealBackendError';
    this.exitCode = code;
  }
}

function fail(msg, code = 2) {
  throw new RealBackendError(msg, code);
}

/** 专用后端没起（或取不到状态）时给调用方的统一提示 */
export const NOT_UP_HINT = 'lemo-e2e 专用后端没起或取不到状态：先跑 npm run e2e:real:up（跑完用 npm run e2e:real:down 停掉）';

const CWD = join(ROOT, E2E_WORKDIR);
const SB_DIR = join(CWD, 'supabase');
const CONFIG = join(SB_DIR, 'config.toml');

const listDir = (d) => (existsSync(d) ? readdirSync(d) : []);

const REAL_FS = { exists: existsSync, isLink: (p) => lstatSync(p).isSymbolicLink(), realpath: (p) => realpathSync.native(p) };

function workdirOrExit() {
  const problems = workdirProblems(ROOT, REAL_FS);
  if (problems.length > 0) fail(`护栏不放行：\n  ${problems.join('\n  ')}`);
}

function guardOrExit() {
  workdirOrExit();
  if (!existsSync(CONFIG)) fail(`没有 ${CONFIG}，先跑 up`);
  const problems = checkGuard(readFileSync(CONFIG, 'utf8'));
  if (problems.length > 0) fail(`护栏不放行：\n  ${problems.join('\n  ')}`);
}

function supabase(args, capture = false) {
  workdirOrExit();
  const { env: childEnv, problems } = checkEnv(env, { [`${E2E_WORKDIR}/`]: listDir(CWD), [`${E2E_WORKDIR}/supabase/`]: listDir(SB_DIR) });
  if (problems.length > 0) fail(`护栏不放行：\n  ${problems.join('\n  ')}`);
  // 本机和 CI（npm ci 之后）都用 node_modules 里那份（package.json 锁版本）；没有时才用 PATH 上的
  const js = join(ROOT, 'node_modules', 'supabase', 'dist', 'supabase.js');
  const [cmd, pre] = existsSync(js) ? [execPath, [js]] : ['supabase', []];
  const r = spawnSync(cmd, [...pre, ...args, '--workdir', '.'], {
    cwd: CWD,
    env: childEnv,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (r.error) fail(`起不了 supabase CLI：${r.error.message}`, 1);
  if (r.status !== 0) fail(`supabase ${args.join(' ')} 失败（退出码 ${r.status}）`, r.status ?? 1);
  return r.stdout;
}

function prepare() {
  const r = spawnSync('npm run copy:shared', { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail('npm run copy:shared 失败', 1);
  // 清空之前先确认 .e2e-sb、.e2e-sb/supabase 不是链接、真实路径就在仓库下（不然 rmSync 会删到别处去）；建完再查一次
  workdirOrExit();
  mkdirSync(SB_DIR, { recursive: true });
  workdirOrExit();
  // 上一轮留下的东西（包括以后从 COPY_ITEMS 里去掉的）全清掉，只留 CLI 自己的状态
  for (const name of readdirSync(SB_DIR)) {
    if (!KEEP_ON_CLEAN.includes(name)) rmSync(join(SB_DIR, name), { recursive: true, force: true });
  }
  for (const item of COPY_ITEMS) {
    cpSync(join(ROOT, 'supabase', item), join(SB_DIR, item), {
      recursive: true,
      dereference: true, // 符号链接复制成实体，不把仓库外的东西链进来
      filter: (src) => !basename(src).startsWith('.env') && basename(src) !== '.temp',
    });
  }
  writeFileSync(CONFIG, rewriteConfig(readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8')));
  // 仓库的 functions/.env* 上面已滤掉不拷；这里写 e2e 自己的假值（E2E_FUNCTIONS_ENV）
  writeFileSync(join(SB_DIR, 'functions', '.env'), functionsEnvText());
}

/**
 * 给 Playwright 配置等调用：取 lemo-e2e 的四个字段（不打印）。
 * 取不到（没 up 过、容器没在跑、字段缺、端口不对）抛 RealBackendError，消息里带 NOT_UP_HINT；不 exit
 */
export function statusEnv() {
  try {
    guardOrExit();
    const out = supabase(['status', '-o', 'json'], true);
    let status;
    try {
      status = JSON.parse(out);
    } catch {
      fail('supabase status -o json 的输出不是 JSON（原文不显示）');
    }
    return pickEnv(status);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new RealBackendError(`${msg}\n${NOT_UP_HINT}`, e instanceof RealBackendError ? e.exitCode : 2);
  }
}

function run(cmd) {
  if (cmd === 'up') {
    prepare();
    guardOrExit();
    supabase(['start', '-x', 'studio']);
  } else if (cmd === 'env') {
    const e = statusEnv();
    stdout.write(argv.includes('--json') ? `${JSON.stringify(e, null, 2)}\n` : Object.entries(e).map(([k, v]) => `${k}=${v}\n`).join(''));
  } else if (cmd === 'check') {
    // npm run e2e:real 的第一步：确认专用后端在跑、四个字段都取得到；只说拿到了哪些字段，不打印值
    const e = statusEnv();
    stdout.write(`real-backend：lemo-e2e 在跑（API ${new URL(e.API_URL).host}），拿到 ${Object.keys(e).join('、')}\n`);
  } else if (cmd === 'down') {
    guardOrExit();
    supabase(['stop', '--no-backup']);
  } else {
    fail('用法：node tools/e2e/real-backend.mjs up | env [--json] | check | down', 64);
  }
}

function main(cmd) {
  try {
    run(cmd);
  } catch (e) {
    if (!(e instanceof RealBackendError)) throw e;
    stderr.write(`real-backend：${e.message}\n`);
    exit(e.exitCode);
  }
}

const kind = entryKind(argv[1], fileURLToPath(import.meta.url));
if (kind === 'main') main(argv[2]);
else if (kind === 'mismatch') {
  stderr.write(`real-backend：入口路径对不上（${argv[1]}），没跑任何命令；请在仓库根目录用 node tools/e2e/real-backend.mjs 调用\n`);
  exit(2);
}
