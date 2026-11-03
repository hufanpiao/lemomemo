// stage-web.mjs、ci-guard.mjs 的纯函数测试。运行：node --test desktop/src-tauri/scripts/stage-web.test.mjs
// （必须直接指定这个文件；传目录会把 stage-web.mjs、ci-guard.mjs 也当测试跑，报 1 个失败）
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirtyLines, filesClearingCiEnv, filesWithSkipFlag, findPackageJsons, scriptsWithSkipFlag } from './ci-guard.mjs';
import {
  checkBundleEnv,
  checkFileTypes,
  checkJsonAsset,
  checkMagic,
  checkTextAsset,
  checkSvg,
  envMarker,
  injectCsp,
  isPageFile,
  pageCsp,
  planPages,
  skipAllowed,
} from './stage-web.mjs';

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

test('后缀白名单：.html 过 PAGES 名单，其余只许 ASSET_EXT，名单外的一律失败（M4、F5-3 ①）', () => {
  for (const p of ['a.html', 'A.HTML', 'x/a.Html']) assert.ok(isPageFile(p), p);
  for (const p of ['a.htm', 'a.xhtml', 'a.svg', 'a.js', 'manifest.webmanifest']) assert.ok(!isPageFile(p), p);
  const ok = ['index.html', 'auth/index.html', 'assets/a.js', 'assets/a.css', 'icons/a.png', 'favicon.ico', 'icons/a.svg', 'fonts/a.woff2', 'version.json', 'manifest.webmanifest', 'desktop-env.json'];
  assert.deepEqual(checkFileTypes(ok), []);
  // 以前的黑名单 + Tauri 会回落成 text/html 的任意新后缀 + 没有后缀
  const bad = ['a.htm', 'x/a.xhtml', 'a.xht', 'a.shtml', 'a.xml', 'a.xsl', 'a.xslt', 'a.mht', 'a.MHTML', 'i/a.svgz', 'a.txt', 'a.map', 'a.mjs', 'a.webp', 'a.woff', 'a.foo', 'LICENSE', 'a.js.bak'];
  assert.deepEqual(
    checkFileTypes(bad).map((s) => s.split('（')[0]),
    bad,
  );
  assert.match(checkFileTypes(['LICENSE'])[0], /后缀 无/);
  // .HTML 这类大小写不同的也算页面，过 PAGES 名单（精确路径），名单外就失败
  assert.throws(() => planPages(['index.html', 'auth/index.html', 'x/a.HTML']), /名单以外/);
});

test('png、ico、woff2 核对文件头：对不上 Tauri 就按后缀回落成 text/html（F5-3 ②）', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(checkMagic('a.png', png), null);
  assert.equal(checkMagic('a.ico', Uint8Array.from([0, 0, 1, 0, 1])), null);
  assert.equal(checkMagic('a.woff2', new TextEncoder().encode('wOF2xxxx')), null);
  const html = new TextEncoder().encode('<script>alert(1)</script>');
  for (const p of ['a.png', 'a.ico', 'a.woff2', 'A.PNG']) assert.match(checkMagic(p, html) ?? '', /text\/html/, p);
  assert.match(checkMagic('a.png', Uint8Array.from([0x89, 0x50])) ?? '', /文件头/);
  assert.equal(checkMagic('a.js', html), null); // 别的后缀不查文件头
});

test('json、webmanifest：严格 UTF-8、能解析；webmanifest 不许出现 <（F5-3 ①）', () => {
  assert.equal(checkJsonAsset('manifest.webmanifest', '{"name":"柠檬记","icons":[]}'), null);
  assert.equal(checkJsonAsset('version.json', '{"v":"4.0.0"}'), null);
  assert.match(checkJsonAsset('manifest.webmanifest', '{"name":"<script>alert(1)</script>"}') ?? '', /不许出现 </);
  assert.match(checkJsonAsset('manifest.webmanifest', '<html><script>alert(1)</script></html>') ?? '', /JSON/);
  assert.match(checkJsonAsset('version.json', '{oops') ?? '', /JSON/);
  assert.match(checkJsonAsset('a.json', Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])) ?? '', /BOM/);
  assert.match(checkJsonAsset('a.json', Uint8Array.from([0x7b, 0xff, 0x7d])) ?? '', /UTF-8/);
  assert.equal(checkJsonAsset('a.js', '<'), null); // 只查这两种
});

const SVG = 'xmlns="http://www.w3.org/2000/svg"';
const u16 = (s, bom) => {
  const b = Buffer.from(s, 'utf16le');
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), b]) : b;
};

test('SVG：图标用得到的写法放行（渐变、滤镜、clipPath、url(#id)、注释、xml 声明、预定义实体）', () => {
  const okCases = [
    `<svg ${SVG}><!-- 注释 --><rect width="1" height="1" fill="#fff"/></svg>`,
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg ${SVG} viewBox="0 0 1 1"><title>a &amp; b</title><rect/></svg>`,
    `<svg ${SVG} xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient>` +
      `<filter id="f" x="-50%"><feGaussianBlur stdDeviation="4"/></filter><clipPath id="c"><circle r="1"/></clipPath></defs>` +
      `<g clip-path="url(#c)" filter="url(#f)"><rect fill="url(#g)" title='a > b'/></g></svg>`,
  ];
  for (const s of okCases) assert.deepEqual(checkSvg(s), [], s);
});

test('SVG：两份审查探针列出的写法逐条都拦（M4 7 种、F5-3 13 种）', () => {
  const cases = [
    // 安全审查 F5-3（sec-feb-f5/svg-probe.mjs）
    ['命名空间前缀 script', `<svg ${SVG} xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>`],
    ['XHTML 命名空间 script', `<svg ${SVG}><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script></svg>`],
    ['前缀 foreignObject', `<svg ${SVG} xmlns:s="http://www.w3.org/2000/svg"><s:foreignObject/></svg>`],
    ['前缀 iframe', `<svg ${SVG}><h:iframe xmlns:h="http://www.w3.org/1999/xhtml" src="x"/></svg>`],
    ['字符引用 javascript&#58;', `<svg ${SVG}><a href="javascript&#58;alert(1)"><text>x</text></a></svg>`],
    ['首字母字符引用', `<svg ${SVG}><a href="&#106;avascript:alert(1)"><text>x</text></a></svg>`],
    ['中间插 tab', `<svg ${SVG}><a href="java&#9;script:alert(1)"><text>x</text></a></svg>`],
    ['SMIL set href', `<svg ${SVG}><a><set attributeName="href" to="&#106;avascript:alert(1)"/><text>x</text></a></svg>`],
    ['大写 SCRIPT', `<svg ${SVG}><SCRIPT>1</SCRIPT></svg>`],
    ['CDATA 包 script', `<svg ${SVG}><script><![CDATA[alert(1)]]></script></svg>`],
    ['onload 换行', `<svg ${SVG}\nonload="alert(1)"/>`],
    ['外部 DOCTYPE', `<!DOCTYPE svg SYSTEM "http://x/evil.dtd"><svg ${SVG}/>`],
    ['UTF-16LE 编码（带 BOM）', u16(`<svg ${SVG}><script>alert(1)</script></svg>`, true)],
    // 代码审查 M4（cr-feb-f5/svg-probe.mjs）
    ['x:href 字符引用', `<svg ${SVG} xmlns:x="http://www.w3.org/1999/xlink"><a x:href="javascript&#58;alert(1)"><rect width="9" height="9"/></a></svg>`],
    ['&#x09; 实体 tab', '<svg><a href="java&#x09;script:alert(1)"/></svg>'],
    ['UTF-16 当 utf8 读进来', u16('\uFEFF<svg><script>alert(1)</script></svg>', false).toString('utf8')],
    ['animate to 字符引用', '<svg><a><animate attributeName="href" to="javascript&#x3a;alert(1)"/><rect/></a></svg>'],
    // 以前就有的
    ['script', '<svg><script>alert(1)</script></svg>'],
    ['onload', '<svg onload="alert(1)"></svg>'],
    ['javascript: 地址', '<svg><a href="javascript:alert(1)"><rect/></a></svg>'],
    ['foreignObject', '<svg><foreignObject><div/></foreignObject></svg>'],
    ['实体声明', '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'],
    ['xml-stylesheet', '<?xml-stylesheet href="a.xsl"?><svg/>'],
    ['iframe', '<svg><iframe src="x"/></svg>'],
    // 分词器的边角：属性值里藏 >、外部引用、没带引号、自定义实体、UTF-8 BOM、NUL
    ['属性值里藏 > 再跟 onload', `<svg ${SVG}><rect title=">" onload="alert(1)"/></svg>`],
    ['use 引外部文件', `<svg ${SVG}><use href="https://x/a.svg#i"/></svg>`],
    ['url() 指外部', `<svg ${SVG}><rect fill="url(https://x/a.svg#g)"/></svg>`],
    ['xlink:href 指外部', `<svg ${SVG} xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="//x"/></svg>`],
    ['xmlns 换成 XHTML', '<svg xmlns="http://www.w3.org/1999/xhtml"><rect/></svg>'],
    ['xmlns:xlink 指别的命名空间', `<svg ${SVG} xmlns:xlink="http://www.w3.org/1999/xhtml"/>`],
    ['属性值没带引号', `<svg ${SVG} width=1/>`],
    ['自定义实体', `<svg ${SVG}><title>&x;</title></svg>`],
    ['style 元素', `<svg ${SVG}><style>@import url(x)</style></svg>`],
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`<svg ${SVG}/>`)])],
    ['NUL', `<svg ${SVG}/>\0`],
    ['非法 UTF-8', Buffer.concat([Buffer.from(`<svg ${SVG}>`), Buffer.from([0xc3, 0x28]), Buffer.from('</svg>')])],
    ['注释没结束藏 script', `<svg ${SVG}><!-- <script>alert(1)</script>`],
  ];
  for (const [name, svg] of cases) assert.ok(checkSvg(svg).length > 0, `没拦住：${name}`);
  assert.equal(cases.length, 37);
});

test('SVG：原因写得出是哪一种（便于定位）', () => {
  assert.ok(checkSvg(`<svg ${SVG}><s:script/></svg>`).some((w) => w.includes('带前缀的元素')));
  assert.ok(checkSvg(`<svg ${SVG}><a href="&#106;"/></svg>`).includes('数字字符引用 &#'));
  assert.ok(checkSvg(`<!DOCTYPE svg><svg ${SVG}/>`).includes('<!DOCTYPE'));
  assert.deepEqual(checkSvg(u16('<svg/>', true)), ['编码不对（不是合法 UTF-8，或带 BOM、NUL）']);
});

test('仓库现有产物（有构建产物时）的每个文件都能打包：后缀、文件头、JSON、SVG 都不误伤', () => {
  const app = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), 'dist', 'web', 'app');
  const walk = (d, out = []) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  };
  let files = [];
  try {
    files = walk(app);
  } catch {
    return; // 没构建过就跳过（CI 的 desktop.yml 在构建以后跑 stage-web 本身）
  }
  const rels = files.map((p) => p.slice(app.length + 1).replaceAll('\\', '/')).filter((r) => !['sw.js', 'sw.js.map', 'preview.html'].includes(r));
  assert.deepEqual(checkFileTypes(rels), []);
  for (const r of rels) {
    const b = readFileSync(join(app, r));
    assert.equal(checkMagic(r, b) ?? checkJsonAsset(r, b), null, r);
    if (r.endsWith('.svg')) assert.deepEqual(checkSvg(b), [], r);
  }
});

test('仓库现有产物里的 SVG 图标都能打包（X-S7 不误伤）', () => {
  const icons = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), 'public', 'icons');
  const dirs = [icons, join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), 'dist', 'web', 'app', 'icons')];
  for (const d of dirs) {
    let names = [];
    try {
      names = readdirSync(d).filter((n) => n.endsWith('.svg'));
    } catch {
      continue;
    }
    for (const n of names) assert.deepEqual(checkSvg(readFileSync(join(d, n), 'utf8')), [], n);
  }
});

test('ci-guard：package.json 的 scripts 带 --skip-env-check 也报（X-S8）', () => {
  assert.deepEqual(scriptsWithSkipFlag(JSON.stringify({ scripts: { a: 'vite build', 'desktop:stage': 'node s.mjs --env preview --skip-env-check' } })), ['scripts.desktop:stage']);
  assert.deepEqual(scriptsWithSkipFlag(JSON.stringify({ name: 'x' })), []);
  assert.throws(() => scriptsWithSkipFlag('{oops'));
  assert.deepEqual(filesWithSkipFlag([['.github/actions/stage/action.yml', 'runs:\n  steps:\n    - run: node s.mjs --skip-env-check']]), ['.github/actions/stage/action.yml']);
});

test('仓库现有 package.json 的 scripts 里没有 --skip-env-check（X-S8）', () => {
  const pkg = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), 'package.json');
  assert.deepEqual(scriptsWithSkipFlag(readFileSync(pkg, 'utf8')), []);
});

test('ci-guard：工作流里把 CI / GITHUB_ACTIONS 清空、设成 false 都报（安全审查建议 2）', () => {
  const bad = [
    'env:\n  CI: ""',
    'env:\n  CI: \'\'',
    'env:\n  GITHUB_ACTIONS: false',
    'env:\n  CI: 0',
    'env:\n  CI:',
    'env:\n  CI: null  # 关掉',
    '- run: unset CI && node s.mjs',
    '- run: env -u GITHUB_ACTIONS node s.mjs',
    '- run: CI= node s.mjs',
    '- run: CI=false node s.mjs',
    '- run: $env:CI = ""',
    '- run: $env:GITHUB_ACTIONS = $null',
    '- run: Remove-Item env:CI',
  ];
  for (const t of bad) assert.equal(filesClearingCiEnv([['a.yml', t]]).length, 1, t);
  const ok = ['env:\n  CI: true', 'env:\n  NODE_ENV: production', '- run: echo $CI', '- run: CIRCLE=1 node x', 'if: env.CI == \'true\'', '  MY_CI: ""'];
  for (const t of ok) assert.deepEqual(filesClearingCiEnv([['a.yml', t]]), [], t);
  assert.deepEqual(filesClearingCiEnv([['x.yml', 'a: 1\nenv:\n  CI: ""']]), ['x.yml:3']);
});

test('ci-guard：仓库里所有 package.json 都找得到（不进 node_modules），现有的 scripts、工作流都干净（安全审查建议 2）', () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const pkgs = findPackageJsons(repo);
  assert.ok(pkgs.includes('package.json') && pkgs.includes('tools/deploy/package.json'), pkgs.join(','));
  assert.ok(pkgs.every((p) => !p.includes('node_modules/')));
  for (const p of pkgs) assert.deepEqual(scriptsWithSkipFlag(readFileSync(join(repo, p), 'utf8')), [], p);
  const wf = join(repo, '.github', 'workflows');
  const files = readdirSync(wf)
    .filter((n) => /\.ya?ml$/i.test(n))
    .map((n) => [n, readFileSync(join(wf, n), 'utf8')]);
  assert.deepEqual(filesClearingCiEnv(files), []);
});

test('auth 页的脚本来源只有本地和 Turnstile，不许再加第三方（安全审查建议 5）', () => {
  for (const env of ['production', 'preview']) {
    const src = pageCsp(env, 'auth').split('; ').find((d) => d.startsWith('script-src'));
    assert.equal(src, "script-src 'self' https://challenges.cloudflare.com");
  }
});

test('.js、.css 去掉开头空白后以 < 开头的拒掉：会被 Tauri 嗅探成 text/html、不带 CSP（F5-6）', () => {
  for (const [p, text] of [
    ['assets/a.js', '<!-- x -->\nconsole.log(1)'],
    ['assets/a.js', '<script>alert(1)</script>'],
    ['assets/b.css', '  \n\t<style>a{}</style>'],
    ['assets/b.CSS', '\uFEFF<html>'],
  ]) {
    assert.match(checkTextAsset(p, text) ?? '', /text\/html/, `${p} ${JSON.stringify(text)}`);
    assert.match(checkTextAsset(p, new TextEncoder().encode(text)) ?? '', /text\/html/, `${p} 字节`);
  }
});

test('.js、.css 按字节去空白和 BOM（含 UTF-16 的 FE FF、FF FE）以后是 < 的拒（代码审查 B-M2）', () => {
  const xml = [...new TextEncoder().encode('<?xml version="1.0"?><x/>')];
  for (const head of [[0x20, 0xfe, 0xff], [0xff, 0xfe], [0xfe, 0xff], [0xef, 0xbb, 0xbf, 0x0c, 0xff, 0xfe, 0x09], [0x0d, 0x0a, 0xfe, 0xff, 0x20]]) {
    const bytes = new Uint8Array([...head, ...xml]);
    assert.match(checkTextAsset('assets/a.js', bytes) ?? '', /text\/xml/, head.join(','));
    assert.match(checkTextAsset('assets/b.css', bytes) ?? '', /</, head.join(','));
  }
  // 单个 FE、FF 不是 BOM，不去；去完以后不是 < 的放行
  assert.equal(checkTextAsset('assets/a.js', new Uint8Array([0xfe, 0x3c])), null);
  assert.equal(checkTextAsset('assets/a.js', new Uint8Array([0xfe, 0xff, 0x61, 0x3c])), null);
  assert.equal(checkTextAsset('assets/a.js', new Uint8Array([])), null);
});

test('.js、.css 正常开头的放行；中间出现 < 不算；别的后缀不归它查（F5-6）', () => {
  assert.equal(checkTextAsset('assets/a.js', 'const a = 1 < 2;\nexport { a };'), null);
  assert.equal(checkTextAsset('assets/a.js', '\n/* 注释 */ if (x<y) {}'), null);
  assert.equal(checkTextAsset('assets/b.css', '@charset "utf-8";a::before{content:"<"}'), null);
  assert.equal(checkTextAsset('assets/a.js', ''), null);
  assert.equal(checkTextAsset('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'), null);
  assert.equal(checkTextAsset('index.html', '<!doctype html>'), null);
});
