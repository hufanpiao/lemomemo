// SW 不存用户数据（接手清单 K-sw-seal；架构 4.1、8.1“SW 缓存策略”）
// 退出时的封存（core/account.ts 的 sealForExit）只管得到本页的库连接，管不到 SW；靠下面几条钉住：
// ① SW 只有四个运行时缓存：lemo-nav（/app/ 的页面导航，Pages 的静态 HTML，_routes.json 只把 /、/sb/*、/files/* 交给 Functions）、
//    lemo-holidays（公共节假日 JSON）、lemo-fonts（公共字体分片）、lemo-font-index（公共的可选字体清单，11-14 起不进预缓存）；
//    都不以预缓存前缀开头，退出、换账号、被移除时 clearCacheStorage 照样删
// ② /sb/*、/files/*、非 GET、别的源一律直连，进不了这三个缓存（routes.ts）
// ③ SW 不自己发请求、不往缓存里手写、不拿令牌（不读 localStorage、不带 Authorization）；不引会用 IndexedDB 的 Workbox 模块
//    （workbox-expiration、workbox-background-sync 会把请求体存进 IndexedDB）
// ④ B2 起（0.29 续第 102 条③、第 107 条）放宽：SW 听 push、notificationclick、notificationclose，
//    通知上的“推迟”按键写本机库的 pending_actions，显示通知前只读核对 owner（B2 安全审查 FE-1）——
//    **IndexedDB 只准在 src/sw/pending.ts 里碰**；别的文件里 indexedDB 只准出现在固定的几处（sw.ts 把 self.indexedDB 交给 push.ts，
//    push.ts 原样交给 pending.ts 的 readSwOwner、writePendingAction），按次数核对；open、transaction、deleteDatabase 和增删改查一律不准
//    （代码审查 M2：别名、解构绕写也拦得住，下面有反例）。按 K-sw-seal：
//    ⑴ 只往已经存在、owner 仓有 user_id 的 planner-v4 里写（open 不带版本号，upgradeneeded 且 oldVersion 为 0 就中止，不建新库）；
//       推送里带的 user_id 必须和 owner 的 user_id 一致才写，不一致就丢——不拿 owner 的值去填（串号）
//    ⑵ 开库后监听 versionchange、收到立刻 close()；写完也立刻关；否则退出 ⑤ 的删库会被 SW 的连接挡住
//    ⑶ 退出、换账号时旧账号的推送由服务器一侧断开（删本会话的 devices 行即删订阅，新账号 claim_endpoint 换绑），
//       页面一侧再关掉已显示的通知、退订（FE-2，platform/push.ts 的 disconnectBrowserPush），⑴ 兜底
// ⑤ pending 只写 6 个字段（id、user_id、row_table、row_id、action、created_at），没有标题、正文（FE-4 ②）；
//    SW 打开的地址只有 reminderUrl(...) 和 '/app/' 两种，负载里不取地址（FE-4 ③）
//    这里钉源码上的写法；⑴⑵ 和 FE-1 的行为（串号丢弃、删库不被挡、不建新库、owner 不一致只显示 App 名）在
//    tests/build/sw-pending.test.ts、tests/build/sw-push.test.ts 用 IndexedDB 替身跑
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRECACHE_PREFIX } from '../../src/platform/session.ts';
import { routeOf } from '../../src/sw/routes.ts';

const SW_DIR = join(import.meta.dirname, '../../src/sw');
const RUNTIME_CACHES = ['lemo-font-index', 'lemo-fonts', 'lemo-holidays', 'lemo-nav'];
const ALLOWED_IMPORTS = [
  '../../shared/i18n/i18n.ts',
  '../../shared/i18n/pick-locale.ts',
  // 按钮常量（不 import 任何东西，下面有一条钉住）；notify-text.ts 不准引（会带进时区、日期代码）
  '../../shared/logic/notify-actions.ts',
  '../../shared/logic/remind-route.ts',
  './pending.ts',
  './push-actions.ts',
  // 隐私记推送的固定文案（B5，只有常量，不 import 任何东西）
  './push-vault-data.ts',
  './push.ts',
  './routes.ts',
  'workbox-precaching',
  'workbox-routing',
  'workbox-strategies',
];
/** 唯一准碰 IndexedDB 的文件（④） */
const IDB_FILE = 'pending.ts';
/**
 * pending.ts 以外，提到 indexedDB 的地方只准是这几处，每处正好一次（代码审查 M2）：
 * sw.ts 把 self.indexedDB 放进 swLike；push.ts 声明这个字段，并原样交给 pending.ts 的两个函数
 */
const IDB_PASSTHROUGH: Record<string, readonly string[]> = {
  'sw.ts': ['indexedDB: self.indexedDB,'],
  'push.ts': ['readonly indexedDB: IDBFactory;', 'readSwOwner(sw.indexedDB)', 'writePendingAction(sw.indexedDB,'],
};
/** pending.ts 以外一律不准出现的写法 */
const NON_IDB_FORBIDDEN: Array<[string, RegExp]> = [
  ['开库', /\.open\s*\(/],
  ['开事务', /\.transaction\s*\(/],
  ['删库', /deleteDatabase/],
  ['读写仓', /\.(add|put|delete|clear|get|getAll|getAllKeys|count|openCursor|objectStore)\s*\(/],
  ['IndexedDB 的类型和名字', /indexedDB|\bIDB(Factory|Database|Transaction|ObjectStore|OpenDBRequest|Request|KeyRange|Index|Cursor)\b/i],
  ['动态取全局属性', /\b(self|globalThis|window)\s*\[|\bReflect\s*\./],
];

/** pending.ts 以外的文件：先按次数核对并去掉放行的几处，剩下的不准再碰 IndexedDB。返回违规说明 */
function idbViolations(name: string, code: string): string[] {
  const out: string[] = [];
  let rest = code;
  for (const snip of IDB_PASSTHROUGH[name] ?? []) {
    const n = rest.split(snip).length - 1;
    if (n !== 1) out.push(`${name}：「${snip}」应正好出现 1 次，实际 ${n} 次`);
    rest = rest.split(snip).join('');
  }
  for (const [what, re] of NON_IDB_FORBIDDEN) if (re.test(rest)) out.push(`${name}：${what}（只准在 ${IDB_FILE}）`);
  return out;
}

/** push.ts 里 writePendingAction(sw.indexedDB, { … }) 的对象体（只认多行写法） */
function pendingWrites(code: string): string[] {
  return [...code.matchAll(/writePendingAction\(sw\.indexedDB,\s*\{([\s\S]*?)\n\s*\}\);/g)].map((m) => m[1] ?? '');
}

const PENDING_KEYS = ['id', 'user_id', 'row_table', 'row_id', 'action', 'created_at'];

/** 对象体的顶层字段名（缩进最浅的那一层） */
function topKeys(body: string): (string | undefined)[] {
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  const indent = Math.min(...lines.map((l) => l.length - l.trimStart().length));
  return lines.filter((l) => l.length - l.trimStart().length === indent).map((l) => /^\s*(\w+)\s*:/.exec(l)?.[1]);
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** src/sw 下除测试以外的全部源码（以后新加的文件也算） */
function swSources(): Array<{ name: string; code: string }> {
  return readdirSync(SW_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => ({ name: d.name, code: stripComments(readFileSync(join(SW_DIR, d.name), 'utf8')) }));
}

describe('SW 不存用户数据（K-sw-seal）', () => {
  it('运行时缓存只有 lemo-nav、lemo-holidays、lemo-fonts、lemo-font-index，且都不是预缓存（退出时会被 clearCacheStorage 删掉）', () => {
    const names = swSources()
      .flatMap((f) => [...f.code.matchAll(/cacheName\s*:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1] ?? ''))
      .sort();
    expect(names).toEqual(RUNTIME_CACHES);
    for (const n of names) expect(n.startsWith(PRECACHE_PREFIX), n).toBe(false);
    // 没有另改 Workbox 的缓存名（改了以后 PRECACHE_PREFIX 认不出预缓存，或运行时缓存名对不上）
    for (const f of swSources()) expect(f.code, f.name).not.toMatch(/\bcacheNames\b|setCacheNameDetails/);
  });

  it('SW 不手写缓存、不自己发请求、不拿令牌；IndexedDB 只在 pending.ts 里碰', () => {
    const forbidden: Array<[string, RegExp]> = [
      ['手动开缓存或写缓存', /\bcaches\s*\./],
      ['SW 自己发请求', /(^|[^.\w])fetch\s*\(|importScripts|XMLHttpRequest|sendBeacon/],
      ['拿令牌、读会话', /localStorage|sessionStorage|Authorization|\/sb\//],
    ];
    for (const f of swSources()) {
      for (const [what, re] of forbidden) expect(f.code, `${f.name}：${what}`).not.toMatch(re);
      if (f.name === IDB_FILE) continue;
      expect(idbViolations(f.name, f.code)).toEqual([]);
    }
  });

  it('反例：别名、解构、动态取属性这几种绕写都会被拦（代码审查 M2）', () => {
    const cases = [
      // 别名后带版本号开库（会把用户的库升级）
      "const f = sw.indexedDB; f.open('planner-v4', 9);",
      // 解构后删库
      "const { indexedDB: f } = self; f.deleteDatabase('planner-v4');",
      // 动态取全局属性
      "const g = self['indexed' + 'DB']; g.open('planner-v4');",
      "const g = Reflect.get(globalThis, 'x'); g.open('planner-v4');",
      // 拿到连接以后开事务、改数据
      'db.transaction(["owner"], "readwrite").objectStore("owner").clear();',
    ];
    for (const c of cases) {
      expect(idbViolations('push.ts', c), c).not.toEqual([]);
      expect(idbViolations('routes.ts', c), c).not.toEqual([]);
    }
    // 放行的几处在别的文件里不算数
    expect(idbViolations('routes.ts', 'const x = { indexedDB: self.indexedDB, };')).not.toEqual([]);
    // 放行的一处多写一次也报
    const push = swSources().find((x) => x.name === 'push.ts')?.code ?? '';
    expect(idbViolations('push.ts', `${push}\nreadSwOwner(sw.indexedDB);`)).not.toEqual([]);
  });

  it('pending.ts 按 K-sw-seal 写：不带版本号开库、库不存在就中止升级、挂 versionchange 立刻关、比对 owner 后才写、写完关库', () => {
    const f = swSources().find((x) => x.name === IDB_FILE);
    expect(f).toBeDefined();
    const code = f?.code ?? '';
    // ⑴ 开库只传库名（不带版本号就不会把别人的库升级，也不会以新版本号建库）
    const opens = [...code.matchAll(/\.open\s*\(([^)]*)\)/g)].map((m) => (m[1] ?? '').trim());
    expect(opens).toEqual(['DB_NAME']);
    expect(code).not.toMatch(/deleteDatabase|createObjectStore|deleteObjectStore|createIndex/);
    // 只准 put 一处（下面核对），不准 add、delete、clear（代码审查 M2 ③）
    expect(code).not.toMatch(/\.(add|delete|clear)\s*\(/);
    expect(code).toMatch(/oldVersion\s*===\s*0/);
    expect(code).toMatch(/transaction\?\.abort\(\)/);
    // ⑵
    expect(code).toMatch(/onversionchange\s*=\s*\(\)\s*=>\s*db\.close\(\)/);
    expect(code).toMatch(/finally\s*\{\s*db\.close\(\);?\s*\}/);
    // ⑴ 推送的 user_id 和 owner 比对；不拿 owner 的值去填
    expect(code).toMatch(/owner\.value\s*!==\s*rec\.user_id/);
    expect(code).not.toMatch(/user_id\s*:\s*owner/);
    // 只写 pending_actions 一个仓（owner 只读）
    const puts = [...code.matchAll(/objectStore\(\s*(\w+)\s*\)\.put\(/g)].map((m) => m[1]);
    expect(puts).toEqual(['PENDING_STORE']);
  });

  it('写进 pending 的只有 6 个字段，没有标题、正文（B2 安全审查 FE-4 ②）', () => {
    const push = swSources().find((x) => x.name === 'push.ts')?.code ?? '';
    const calls = pendingWrites(push);
    expect(calls).toHaveLength(1);
    const body = calls[0] ?? '';
    expect(topKeys(body)).toEqual(PENDING_KEYS);
    expect(body).not.toMatch(/title|body|label/);
    // 反例：多写一个顶层字段要报；多一处调用要报；一行写法认不出（数不到，上面的“正好一处”就报）
    const extra = push.replace(/(writePendingAction\(sw\.indexedDB,\s*\{\n)(\s*)/, '$1$2note: d.id,\n$2');
    expect(extra).not.toBe(push);
    expect(topKeys(pendingWrites(extra)[0] ?? '')).not.toEqual(PENDING_KEYS);
    expect(pendingWrites(`${push}\nwritePendingAction(sw.indexedDB, {\n  id: 1,\n});`)).toHaveLength(2);
    expect(pendingWrites('writePendingAction(sw.indexedDB, { id: 1, user_id: 2 });')).toHaveLength(0);
    // pending.ts 的记录类型也只有这 6 个字段
    const pending = swSources().find((x) => x.name === IDB_FILE)?.code ?? '';
    const iface = /export interface SwPendingAction \{([\s\S]*?)\n\}/.exec(pending)?.[1] ?? '';
    expect([...iface.matchAll(/readonly (\w+)\??:/g)].map((m) => m[1])).toEqual(['id', 'user_id', 'row_table', 'row_id', 'action', 'created_at']);
  });

  it('SW 只打开 reminderUrl(...) 或 /app/，负载里不取地址（B2 安全审查 FE-4 ③）', () => {
    const files = swSources();
    const push = files.find((x) => x.name === 'push.ts')?.code ?? '';
    // openWindow、navigate 只在 push.ts 的 openReminderWindow 里调，参数都是 full = new URL(url, origin)
    const calls = files.flatMap((f) => [...f.code.matchAll(/\.(openWindow|navigate)\(([^)]*)\)/g)].map((m) => `${f.name}:${m[1]}(${m[2]})`));
    expect(calls.sort()).toEqual(['push.ts:navigate(full)', 'push.ts:openWindow(full)', 'sw.ts:openWindow(url)']);
    expect(files.find((x) => x.name === 'sw.ts')?.code).toContain('openWindow: (url) => self.clients.openWindow(url),');
    expect(push).toContain('const full = new URL(url, sw.location.origin).href;');
    // openReminderWindow 的地址只有两种来源
    const args = [...push.matchAll(/openReminderWindow\(sw,\s*([^)]*)\)/g)].map((m) => (m[1] ?? '').trim()).sort();
    expect(args).toEqual(['APP_HOME', 'url']);
    expect(push).toContain("const APP_HOME = '/app/';");
    expect([...push.matchAll(/const url = ([^;]*);/g)].map((m) => m[1])).toEqual(['reminderUrl(d.kind, d.id, d.due_at)']);
    // 负载、通知 data 里不读地址、图片字段
    expect(push).not.toMatch(/\[\s*['"](url|href|link|image|icon|badge)['"]\s*\]/);
  });

  it('只引白名单里的模块（不引 workbox-expiration、workbox-background-sync 这类用 IndexedDB 的）', () => {
    for (const f of swSources()) {
      const specs = [...f.code.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
      for (const s of specs) expect(ALLOWED_IMPORTS, `${f.name} 引了 ${s}`).toContain(s);
    }
    // push-actions.ts 也在扫描范围里（白名单、IndexedDB 次数检查都过它）
    expect(swSources().map((f) => f.name)).toContain('push-actions.ts');
    // 白名单里的 notify-actions.ts 自己不准再 import 任何东西（否则会把别的代码间接带进 SW 包）
    const actions = stripComments(readFileSync(join(SW_DIR, '../../shared/logic/notify-actions.ts'), 'utf8'));
    expect(actions).not.toMatch(/\bimport\b|\bfrom\s*['"]|\brequire\s*\(/);
  });

  it('只听 fetch、message，和 B2 起的 push、notificationclick、notificationclose（没有 sync、periodicsync）', () => {
    const events = swSources()
      .flatMap((f) => [...f.code.matchAll(/addEventListener\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1] ?? ''))
      .sort();
    expect(events).toEqual(['fetch', 'message', 'notificationclick', 'notificationclose', 'push']);
    for (const f of swSources()) expect(f.code, f.name).not.toMatch(/\bon(push|notificationclick|notificationclose|sync|periodicsync)\s*=/);
  });

  it('message 只认 SKIP_WAITING', () => {
    const sw = swSources().find((f) => f.name === 'sw.ts');
    expect(sw).toBeDefined();
    const types = [...(sw?.code ?? '').matchAll(/\.type\s*===\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(types).toEqual(['SKIP_WAITING']);
  });

  it('带账号数据的请求进不了运行时缓存：/sb、/files、非 GET、别的源一律直连', () => {
    const O = 'https://lemomemo.com';
    const cases: Array<[string, string, string, string]> = [
      ['/sb/rest/v1/events', 'GET', 'cors', O],
      ['/sb/auth/v1/user', 'GET', 'navigate', O],
      ['/files/v1/o/images/u/n/i.webp?e=1&s=x', 'GET', 'no-cors', O],
      ['/files/v1/o/files/u/n/i.pdf?e=1&s=x', 'GET', 'navigate', O],
      ['/app/holidays/kr/2026.json', 'POST', 'cors', O],
      ['/app/fonts/a.woff2', 'GET', 'cors', 'https://x.supabase.co'],
      ['/app/', 'GET', 'navigate', 'https://x.supabase.co'],
    ];
    for (const [path, method, mode, origin] of cases) {
      expect(routeOf(new URL(path, origin), method, mode, O), `${method} ${origin}${path}`).toBe('bypass');
    }
  });
});
