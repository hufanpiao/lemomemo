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
//   • [auth.rate_limit] token_verifications 从 10 调到 1000（10-30 起仓库和线上两个项目都是 10，负责人同意）：各 spec 经
//     /sb/auth/v1/verify 登录一轮约 13 次以上，全从 127.0.0.1 来、fullyParallel，按 10 会被限流。同样只为测试能跑，仓库 config 不改。
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

// 护栏和 config 改写拆在 real-backend-guard.mjs（纯函数），这里原样转出、命令行部分也用它们
export * from './real-backend-guard.mjs';
import {
  ROOT,
  E2E_WORKDIR,
  COPY_ITEMS,
  KEEP_ON_CLEAN,
  checkGuard,
  checkEnv,
  workdirProblems,
  rewriteConfig,
  functionsEnvProblems,
  E2E_FAKE_FN,
  E2E_FAKE_OUTBOUND,
  E2E_FN_PROXY,
  E2E_NO_PROXY_HOSTS,
} from './real-backend-guard.mjs';

/**
 * lemo-e2e 的边缘函数环境（第 6 步，10-30）：prepare 写到 .e2e-sb/supabase/functions/.env，supabase start 起的 edge runtime 默认读它。
 * 一律是一看就假的值，不碰真密钥；PROXY_SECRET 必须和 tests/e2e/fake-values.ts 的 FAKE_PROXY_SECRET 一样（单测核对），
 * 函数才信 /sb 转发层写的 x-proxy-secret。
 * 发信：account、account-purge 把 Resend 的地址写死成 https://api.resend.com，假密钥也会真发请求、把测试邮箱带到外网——
 * 所以 HTTPS_PROXY、HTTP_PROXY（大小写两种）都指容器里没人听的 127.0.0.1:9，出站一律连不上，sendMail 回 false（函数照常走“没发出去”的分支）。
 * invite-signup（INVITE-mailpit，10-30）：TURNSTILE_SITEVERIFY_URL、RESEND_EMAILS_URL 指同一个 edge runtime 里的假出站服务
 * （tools/e2e/fake-outbound-fn.mjs，函数容器里的 127.0.0.1:8081/e2e-fake-outbound/…）：siteverify 总回成功，发信转进 lemo-e2e 的 Mailpit，
 * 验证码信真的收得到；TURNSTILE_SECRET 设成假值（invite-signup 没有它就 misconfigured；[auth.captcha] 照旧本地关，GoTrue 不读它）。
 * NO_PROXY 只放行（10-30 审查建议 1，按函数实际要连的来；E2E_NO_PROXY_HOSTS）：npm 源（edge runtime 启动时按 deno.lock 拉依赖，挡了函数起不来，10-30 实测 503）；
 * kong（容器里的 SUPABASE_URL = http://kong:8000，supabase-js 走它）、supabase_kong_lemo-e2e、supabase_db_lemo-e2e（SUPABASE_DB_URL 的主机，
 * postgres 协议本来不走代理，写上防万一）、supabase_inbucket_lemo-e2e（假 Resend 转 Mailpit）、localhost、127.0.0.1（假出站服务）；
 * 不放 host.docker.internal（没人用，放着就能直连宿主机的 543xx，E2E-guard-sugg2 ③）。
 * 写文件前过 functionsEnvProblems（real-backend-guard.mjs）：键只许 E2E_FN_ENV_RULES 里这些、一个不多一个不少，每个值都按那张表写死核对；
 * 这里加键、改值都要同步改那张表（E2E-guard-sugg2 ①）。
 */
const E2E_FN_NO_PROXY = E2E_NO_PROXY_HOSTS.join(',');
export const E2E_FUNCTIONS_ENV = {
  PROXY_SECRET: 'fake-proxy-secret-for-e2e-only',
  RESEND_API_KEY: 'fake-resend-key-for-e2e-only',
  TURNSTILE_SECRET: 'fake-turnstile-secret-for-e2e-only',
  ...E2E_FAKE_OUTBOUND,
  SIGNUP_HASH_SECRET: 'fake-signup-hash-secret-for-e2e-only',
  CRON_SECRET: 'fake-cron-secret-for-e2e-only',
  OPS_SECRET: 'fake-ops-secret-for-e2e-only',
  HTTPS_PROXY: E2E_FN_PROXY,
  https_proxy: E2E_FN_PROXY,
  HTTP_PROXY: E2E_FN_PROXY,
  http_proxy: E2E_FN_PROXY,
  NO_PROXY: E2E_FN_NO_PROXY,
  no_proxy: E2E_FN_NO_PROXY,
  // 导出内存探针（架构 0.47 第 21 条）：account 只在 envKind 判定为本机时才认它
  EXPORT_MEM_PROBE: '1',
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
  const problems = functionsEnvProblems(vars);
  if (problems.length > 0) throw new Error(`函数环境护栏不放行：${problems.join('；')}`);
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
  // 假出站服务（INVITE-mailpit）：只放进 e2e 副本，随 supabase start 的 edge runtime 起、down 停；config 副本里已给它 verify_jwt = false
  mkdirSync(join(SB_DIR, 'functions', E2E_FAKE_FN), { recursive: true });
  cpSync(join(ROOT, 'tools', 'e2e', 'fake-outbound-fn.mjs'), join(SB_DIR, 'functions', E2E_FAKE_FN, 'index.ts'));
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
