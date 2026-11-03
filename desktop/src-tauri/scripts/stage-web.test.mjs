// stage-web.mjs、ci-guard.mjs 的纯函数测试。运行：node --test desktop/src-tauri/scripts/stage-web.test.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirtyLines, filesWithSkipFlag } from './ci-guard.mjs';
import { checkBundleEnv, envMarker, injectCsp, pageCsp, planPages, skipAllowed } from './stage-web.mjs';

const HTML = '<!doctype html>\n<html><head>\n    <meta charset="utf-8" />\n    <script type="module" src="/app/assets/a.js"></script>\n</head></html>';

test('main 页不放行 Turnstile，auth 页放行；三页都没有 unsafe-inline', () => {
  const main = pageCsp('production', 'main');
  const auth = pageCsp('production', 'auth');
  assert.ok(!main.includes('challenges.cloudflare.com'));
  assert.ok(main.includes("frame-src 'self' https://view.officeapps.live.com"));
  assert.ok(auth.includes("script-src 'self' https://challenges.cloudflare.com"));
  assert.ok(auth.includes("frame-src 'self' https://challenges.cloudflare.com"));
  for (const c of [main, auth, pageCsp('production', 'quick-add')]) assert.ok(!c.includes('unsafe-inline'));
});

test('quick-add 页：只许本地脚本、不许 iframe、只连 IPC（X-1）', () => {
  for (const env of ['production', 'preview']) {
    const q = pageCsp(env, 'quick-add');
    assert.ok(q.includes("script-src 'self';"));
    assert.ok(q.includes("frame-src 'none'"));
    assert.ok(q.includes("connect-src 'self' ipc: http://ipc.localhost;"));
    assert.ok(!q.includes('lemomemo.com') && !q.includes('cloudflare') && !q.includes('officeapps'));
  }
  assert.throws(() => pageCsp('production', 'other'), /未知页面/);
});

test('两套环境的 connect-src 互不串', () => {
  assert.ok(pageCsp('production', 'main').includes("connect-src 'self' ipc: http://ipc.localhost https://lemomemo.com wss://lemomemo.com;"));
  const p = pageCsp('preview', 'auth');
  assert.ok(p.includes('https://preview.lemomemo.com wss://preview.lemomemo.com'));
  assert.ok(!/ https:\/\/lemomemo\.com/.test(p));
});

test('页面名单：名单外的页面、缺必须有的页面都失败（X-1）', () => {
  assert.deepEqual(planPages(['index.html', 'auth/index.html']), [
    ['index.html', 'main'],
    ['auth/index.html', 'auth'],
  ]);
  assert.deepEqual(planPages(['index.html', 'auth/index.html', 'desktop/quick-add.html']).at(-1), ['desktop/quick-add.html', 'quick-add']);
  assert.throws(() => planPages(['index.html', 'auth/index.html', 'preview.html']), /名单以外.*preview\.html/);
  assert.throws(() => planPages(['index.html', 'auth/index.html', 'x/evil.html']), /名单以外/);
  assert.throws(() => planPages(['index.html']), /缺必须有的页面：auth\/index\.html/);
});

test('meta CSP 插在 charset 后、脚本前', () => {
  const out = injectCsp(HTML, "default-src 'self'");
  const i = out.indexOf('Content-Security-Policy');
  assert.ok(i > out.indexOf('charset') && i < out.indexOf('<script'));
  assert.throws(() => injectCsp(out, 'x'), /已经有 meta CSP/);
});

test('有内联脚本就失败，JSON 数据块放行', () => {
  assert.throws(() => injectCsp(HTML.replace('</head>', '<script>alert(1)</script></head>'), 'x'), /内联脚本/);
  assert.doesNotThrow(() => injectCsp(HTML.replace('</head>', '<script type="application/json">{}</script></head>'), 'x'));
  assert.throws(() => injectCsp('<html><head></head></html>', 'x'), /meta charset/);
});

test('产物环境核对：两个方向都查（X-S5）', () => {
  assert.equal(checkBundleEnv('production', ['x="https://lemomemo.com"']), null);
  assert.match(checkBundleEnv('production', ['"https://lemomemo.com"', '"https://preview.lemomemo.com"']), /预览地址/);
  assert.match(checkBundleEnv('production', ['"https://lemomemo.com"', '"https://abcd.supabase.co"']), /supabase\.co/);
  assert.match(checkBundleEnv('production', ['""']), /找不到/);
  assert.equal(checkBundleEnv('preview', ['"https://preview.lemomemo.com"']), null);
  assert.match(checkBundleEnv('preview', ['"https://preview.lemomemo.com"', 'href="https://lemomemo.com/app/"']), /正式地址/);
  assert.match(checkBundleEnv('preview', ['"https://preview.lemomemo.com"', '"https://abcd.supabase.co"']), /supabase\.co/);
  assert.match(checkBundleEnv('preview', ['"https://lemomemo.com"']), /正式地址/);
});

test('--skip-env-check：CI、GITHUB_ACTIONS 有值就不许用（X-4、M4）', () => {
  assert.equal(skipAllowed({}), true);
  assert.equal(skipAllowed({ CI: '' }), true);
  assert.equal(skipAllowed({ CI: 'true' }), false);
  assert.equal(skipAllowed({ CI: '1' }), false);
  assert.equal(skipAllowed({ CI: 'false' }), false);
  assert.equal(skipAllowed({ GITHUB_ACTIONS: 'true' }), false);
});

test('desktop-env.json 记 envCheck（M4）', () => {
  assert.deepEqual(envMarker('production', false), { env: 'production', envCheck: 'passed' });
  assert.deepEqual(envMarker('preview', true), { env: 'preview', envCheck: 'skipped' });
});

test('ci-guard：流水线里出现 --skip-env-check 就报出来；权限目录有改动就算不一致', () => {
  assert.deepEqual(filesWithSkipFlag([['a.yml', 'run: node stage-web.mjs --env preview'], ['desktop.yml', 'run: node s.mjs --skip-env-check']]), ['desktop.yml']);
  assert.deepEqual(dirtyLines(''), []);
  assert.deepEqual(dirtyLines('?? desktop/src-tauri/permissions/autogenerated/x.toml\n'), ['?? desktop/src-tauri/permissions/autogenerated/x.toml']);
});

test('仓库现有流水线里没有 --skip-env-check（X-4）', () => {
  const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), '.github', 'workflows');
  const files = readdirSync(dir)
    .filter((n) => /\.ya?ml$/i.test(n))
    .map((n) => [n, readFileSync(join(dir, n), 'utf8')]);
  assert.deepEqual(filesWithSkipFlag(files), []);
});
