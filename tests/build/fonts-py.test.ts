// build/fonts.py（架构 5.9c 可选字体；B6 字体 11-13）：迷你仓库里放一种字体（源文件借皮肤视觉稿的霞鹜文楷子集 docs/02-设计/皮肤-v4/fonts，
// 只有 912 个字），跑构建看产物；再拿违规样例看 --check（check_fonts）每条规则都拦得住：许可证不在白名单、哈希不对、多一个没登记的文件夹、
// 常用字不全、产物和登记对不上、分片超大、licenses 写错、保留字体名没改（11-14 加：一种字体两份许可证、OFL 保留名改名、CFF 转 TrueType 轮廓、
// prefetch: false；源文件不进仓库：--src、没有源文件也能 --check、order 排序）。最后查真仓库 --check 通过。本文件起 python 子进程。
// 切片要 fontTools 和 brotli（pip install fonttools brotli）：没装的机器（CI 现在没装）跳过要切片的几条，只查不用切片的登记规则
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'build', 'fonts.py');
const DESIGN = join(ROOT, 'docs', '02-设计', '皮肤-v4', 'fonts');
const REG = 'LXGWWenKai-Regular.subset.woff2';
const MED = 'LXGWWenKai-Medium.subset.woff2';
const HAS_FONTTOOLS = spawnSync('python', ['-I', '-c', 'import fontTools, brotli']).status === 0;
const itFt = HAS_FONTTOOLS ? it : it.skip;

interface Index {
  fonts: Array<{ id: string; css: string; family: string; sample: string; familyKo: string; sampleKo: string; files: string[]; prefetch: Array<{ url: string; sha256: string; bytes: number }>; bytes: { prefetch: number; all: number }; sources?: Record<string, string> }>;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(root: string, ...args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('python', ['-I', SCRIPT, '--root', root, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** 迷你仓库：tokens.css 抄真的；assets-src/fonts/kai 放两份子集和许可证；patch 改登记 */
function repo(patch: (r: Record<string, unknown>) => void = () => undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'lemo-fonts-'));
  dirs.push(root);
  mkdirSync(join(root, 'src', 'styles'), { recursive: true });
  copyFileSync(join(ROOT, 'src', 'styles', 'tokens.css'), join(root, 'src', 'styles', 'tokens.css'));
  const d = join(root, 'assets-src', 'fonts', 'kai');
  mkdirSync(d, { recursive: true });
  for (const f of [REG, MED, 'LXGWWenKai-OFL.txt']) copyFileSync(join(DESIGN, f), join(d, f));
  const r: Record<string, unknown> = {
    id: 'kai',
    label: { zh: '文楷', ko: '손글씨' },
    num: 'zh',
    faces: { zh: [{ file: REG, weight: '100 499' }, { file: MED, weight: '500 900' }], ko: [{ file: REG, weight: '100 900' }] },
    licenses: [{ name: '霞鹜文楷', spdx: 'OFL-1.1', file: 'LXGWWenKai-OFL.txt', sourceUrl: 'https://github.com/lxgw/LxgwWenKai', version: 'design-subset', sha256: { [REG]: sha(join(d, REG)), [MED]: sha(join(d, MED)) } }],
  };
  patch(r);
  writeFileSync(join(d, 'font.json'), JSON.stringify(r));
  return root;
}

const lic = (r: Record<string, unknown>) => (r['licenses'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
const index = (root: string) => JSON.parse(readFileSync(join(root, 'src', 'public', 'fonts-index.json'), 'utf8')) as Index;

describe('build/fonts.py', () => {
  itFt('切出 woff2 分片、样式和清单：预取分片带 sha256，样式按 unicode-range 分片、换掉 --f-zh / --f-ko / --f-num、不做假粗体', () => {
    const root = repo();
    expect(run(root).code).toBe(0);
    // 可复现：再跑一遍，清单（含每个分片的哈希）一字不差（11-14：不关 recalcTimestamp 的话每跑一次全部分片换名）
    const first = readFileSync(join(root, 'src', 'public', 'fonts-index.json'), 'utf8');
    expect(run(root).code).toBe(0);
    expect(readFileSync(join(root, 'src', 'public', 'fonts-index.json'), 'utf8')).toBe(first);
    const [kai] = index(root).fonts;
    expect(kai?.id).toBe('kai');
    expect(kai?.family).toBe('lemo-kai-zh');
    // 确认用的韩文 family 和样例（platform/fonts.ts 用它确认韩文面也套上了）
    expect(kai?.familyKo).toBe('lemo-kai-ko');
    expect(kai?.sampleKo).toMatch(/^[가-힣 ]+$/);
    expect(kai?.sample).toMatch(/\p{Script=Han}/u);
    expect(kai?.prefetch.length).toBeGreaterThan(0);
    const dir = join(root, 'src', 'public', 'fonts', 'kai');
    for (const p of kai?.prefetch ?? []) expect(sha(join(dir, p.url.split('/').pop() ?? ''))).toBe(p.sha256);
    const css = readFileSync(join(dir, kai?.css.split('/').pop() ?? ''), 'utf8');
    expect(css).toMatch(/@font-face\{font-family:"lemo-kai-zh";src:url\("\.\/zh-0-0\.[0-9a-f]{10}\.woff2"\) format\("woff2"\);font-weight:100 499;.*font-display:swap;unicode-range:U\+/);
    expect(css).toContain('font-weight:500 900');
    // 中文面后面接同一套的韩文面（中文界面里的谚文也用这一套），韩文面后面接中文面（2.4 第 7 点）
    expect(css).toMatch(/:root\[data-font="kai"\]\{font-synthesis:none;--f-zh:"lemo-kai-zh","lemo-kai-ko",-apple-system, "PingFang SC"/);
    expect(css).toContain('--f-ko:"lemo-kai-ko","lemo-kai-zh","Apple SD Gothic Neo"');
    expect(css).toContain('--f-num:"lemo-kai-zh","Manrope"');
    // 每个分片文件都在样式里用到（没有孤儿文件）
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.woff2'))) expect(css).toContain(f);
    // files = 文件夹里的全部文件（换字体一天后清缓存按它留）
    expect([...(kai?.files ?? [])].map((u) => u.split('/').pop()).sort()).toEqual(readdirSync(dir).sort());
    expect(kai?.files.every((u) => u.startsWith('/app/fonts/kai/'))).toBe(true);
  });

  itFt('num: manrope 时不换数字字体', () => {
    const root = repo((r) => (r['num'] = 'manrope'));
    expect(run(root).code).toBe(0);
    const [kai] = index(root).fonts;
    expect(readFileSync(join(root, 'src', 'public', 'fonts', 'kai', kai?.css.split('/').pop() ?? ''), 'utf8')).not.toContain('--f-num');
  });

  itFt('保留字体名（OFL 第 3 条）：写了 reservedNames 的源文件切出的分片改名、--check 通过；没改名的分片被 --check 拦下', () => {
    const root = repo((r) => (lic(r)['reservedNames'] = ['LXGW']));
    expect(run(root).code).toBe(0);
    expect(run(root, '--check').out).not.toContain('保留名');
    // 先不写 reservedNames 切一遍（分片里还是“LXGW WenKai”），再补登记：--check 要拦
    const raw = repo();
    run(raw);
    const reg = join(raw, 'assets-src', 'fonts', 'kai', 'font.json');
    const r = JSON.parse(readFileSync(reg, 'utf8')) as Record<string, unknown>;
    lic(r)['reservedNames'] = ['LXGW'];
    writeFileSync(reg, JSON.stringify(r));
    expect(run(raw, '--check').out).toMatch(/kai：zh-0-0\.[0-9a-f]{10}\.woff2 的字体名还带着保留名/);
  });

  itFt('CFF（OTF）源文件先转成 TrueType 轮廓再切（woff2 对 glyf 有压缩变换，未来荧黑实测小 6 倍）；prefetch: false 的字重不进预取', () => {
    const root = repo();
    const d = join(root, 'assets-src', 'fonts', 'kai');
    // 现造一个两字的 CFF 字体（方块轮廓），代替真 OTF
    const otf = join(d, 'Tiny-CFF.otf');
    const py = [
      'import sys',
      'from fontTools.fontBuilder import FontBuilder',
      'from fontTools.pens.t2CharStringPen import T2CharStringPen',
      "fb = FontBuilder(1000, isTTF=False)",
      "names = ['.notdef', 'A', 'uni6C38']",
      'fb.setupGlyphOrder(names)',
      "fb.setupCharacterMap({0x41: 'A', 0x6C38: 'uni6C38'})",
      'cs = {}',
      'for n in names:',
      '    p = T2CharStringPen(600, None)',
      '    p.moveTo((50, 0)); p.lineTo((550, 0)); p.curveTo((560, 300), (560, 400), (550, 700)); p.lineTo((50, 700)); p.closePath()',
      '    cs[n] = p.getCharString()',
      "fb.setupCFF('TinyCFF', {'FullName': 'Tiny CFF'}, cs, {})",
      "fb.setupHorizontalMetrics({n: (600, 50) for n in names})",
      'fb.setupHorizontalHeader(ascent=800, descent=-200)',
      "fb.setupNameTable({'familyName': 'Tiny CFF', 'styleName': 'Regular'})",
      'fb.setupOS2()',
      'fb.setupPost()',
      'fb.save(sys.argv[1])',
    ].join('\n');
    execFileSync('python', ['-I', '-c', py, otf]);
    const reg = join(d, 'font.json');
    const r = JSON.parse(readFileSync(reg, 'utf8')) as { faces: Record<string, unknown[]> } & Record<string, unknown>;
    r.faces = { zh: [{ file: 'Tiny-CFF.otf', weight: '100 499', prefetch: false }, { file: REG, weight: '500 900' }], ko: [{ file: REG, weight: '100 900' }] };
    lic(r)['sha256'] = { ...(lic(r)['sha256'] as Record<string, string>), 'Tiny-CFF.otf': sha(otf) };
    writeFileSync(reg, JSON.stringify(r));
    expect(run(root).code).toBe(0);
    const out = join(root, 'src', 'public', 'fonts', 'kai');
    const shards = readdirSync(out).filter((n) => n.startsWith('zh-0-'));
    expect(shards.length).toBeGreaterThan(0);
    const tables = execFileSync('python', ['-I', '-c', 'import sys\nfrom fontTools.ttLib import TTFont\nprint(sorted(TTFont(sys.argv[1]).keys()))', join(out, shards[0] ?? '')], { encoding: 'utf8' });
    expect(tables).toContain("'glyf'");
    expect(tables).not.toContain("'CFF '");
    // zh-0（prefetch: false）一片都不预取，zh-1 照常预取
    const [kai] = index(root).fonts;
    const pre = (kai?.prefetch ?? []).map((p) => p.url.split('/').pop() ?? '');
    expect(pre.some((n) => n.startsWith('zh-0-'))).toBe(false);
    expect(pre.some((n) => n.startsWith('zh-1-'))).toBe(true);
  });

  it('licenses 不是列表、同一个源文件登记在两项许可证里，都被拦', () => {
    expect(run(repo((r) => (r['licenses'] = { spdx: 'OFL-1.1' })), '--check').out).toContain('licenses 要写成列表');
    expect(run(repo((r) => (r['licenses'] = [lic(r), lic(r)])), '--check').out).toContain('在两项许可证里都登记了');
  });

  itFt('--check：子集只有 912 个字，常用字不全被拦（中文要 GB 2312 全部、韩文要 2350 个音节）', () => {
    const root = repo();
    run(root);
    const r = run(root, '--check');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/kai\.zh：LXGWWenKai-Regular\.subset\.woff2 缺 \d+ 个常用字/);
    expect(r.out).toMatch(/kai\.ko：.* 缺 \d+ 个常用字/);
  });

  it('违规样例：许可证不在白名单、哈希不对、id 和文件夹不同名、没有 font.json 的文件夹', () => {
    expect(run(repo((r) => (lic(r)['spdx'] = 'GPL-3.0')), '--check').out).toContain('许可证 GPL-3.0 不在白名单');
    expect(run(repo((r) => (lic(r)['sha256'] = {})), '--check').out).toContain('的 sha256 和登记不一致');
    expect(run(repo((r) => (r['id'] = 'wenkai')), '--check').out).toContain('id 要和文件夹同名');
    const root = repo();
    mkdirSync(join(root, 'assets-src', 'fonts', 'yozai'));
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('yozai：文件夹里没有 font.json');
  });

  itFt('违规样例：登记了却没跑构建、产物里多一个没登记的文件夹、分片超过 300 KB', () => {
    const root = repo();
    mkdirSync(join(root, 'src', 'public'), { recursive: true });
    writeFileSync(join(root, 'src', 'public', 'fonts-index.json'), '{"v":1,"fonts":[]}');
    expect(run(root, '--check').out).toContain('和登记 [\'kai\'] 不一致');
    run(root);
    mkdirSync(join(root, 'src', 'public', 'fonts', 'old'));
    writeFileSync(join(root, 'src', 'public', 'fonts', 'kai', 'big.woff2'), Buffer.alloc(300 * 1024 + 1));
    const r = run(root, '--check');
    expect(r.out).toContain('src/public/fonts/old 没有登记');
    expect(r.out).toContain('big.woff2 307201 B 超过单个分片上限');
    expect(r.out).toMatch(/kai：清单 files 和文件夹对不上（少 \['big\.woff2'\]/);
  });

  // 源文件不进仓库（B6 字体 11-14 主持人定）：构建用 --src 指本机目录；CI 没有源文件，--check 只核产物和登记（清单里记着切片用的源文件 sha256）
  itFt('源文件不在仓库里：--src 指别处能切；没有源文件 --check 照样过；登记的 sha256 改了、没重新切被拦；构建缺源文件被拦', () => {
    const root = repo();
    const kaiDir = join(root, 'assets-src', 'fonts', 'kai');
    const src = join(root, 'elsewhere');
    mkdirSync(join(src, 'kai'), { recursive: true });
    for (const f of [REG, MED]) {
      copyFileSync(join(kaiDir, f), join(src, 'kai', f));
      rmSync(join(kaiDir, f));
    }
    const noSrc = run(root);
    expect(noSrc.code).toBe(1);
    expect(noSrc.out).toMatch(/kai\.zh：源文件 .*LXGWWenKai-Regular\.subset\.woff2 不在/);
    expect(run(root, '--src', src).code).toBe(0);
    expect(index(root).fonts[0]?.sources).toEqual({ [REG]: sha(join(src, 'kai', REG)), [MED]: sha(join(src, 'kai', MED)) });
    // 没有源文件：跳过覆盖核对（912 字的子集带着源文件会因缺字被拦），产物和登记一致就过
    const ok = run(root, '--check');
    expect(ok.out).toContain('问题 0 个');
    expect(ok.out).not.toContain('常用字');
    // 带着源文件核对：覆盖照查
    expect(run(root, '--check', '--src', src).out).toMatch(/缺 \d+ 个常用字/);
    // 登记换了源文件的 sha256 却没重新切
    const reg = JSON.parse(readFileSync(join(kaiDir, 'font.json'), 'utf8')) as Record<string, unknown>;
    (lic(reg)['sha256'] as Record<string, string>)[REG] = '0'.repeat(64);
    writeFileSync(join(kaiDir, 'font.json'), JSON.stringify(reg));
    expect(run(root, '--check').out).toContain('切片用的源文件');
  });

  itFt('order 决定清单里的先后（设置 › 字体按清单列），同序按 id', () => {
    const root = repo((r) => (r['order'] = 5));
    const d2 = join(root, 'assets-src', 'fonts', 'aaa');
    mkdirSync(d2);
    for (const f of [REG, MED, 'LXGWWenKai-OFL.txt']) copyFileSync(join(root, 'assets-src', 'fonts', 'kai', f), join(d2, f));
    const r2 = JSON.parse(readFileSync(join(root, 'assets-src', 'fonts', 'kai', 'font.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(d2, 'font.json'), JSON.stringify({ ...r2, id: 'aaa', order: 9 }));
    expect(run(root).code).toBe(0);
    expect(index(root).fonts.map((f) => f.id)).toEqual(['kai', 'aaa']);
    expect(run(root, '--check').out).not.toContain('order');
  });

  it('真仓库：登记和产物一致，--check 通过', () => {
    const out = execFileSync('python', ['-I', SCRIPT, '--check'], { encoding: 'utf8' });
    expect(out).toContain('问题 0 个');
  });
});
