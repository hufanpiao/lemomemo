// build/fonts.py（架构 5.9c 可选字体；B6 字体 11-13）：迷你仓库里放一种字体（源文件借皮肤视觉稿的霞鹜文楷子集 docs/02-设计/皮肤-v4/fonts，
// 只有 912 个字），跑构建看产物；再拿违规样例看 --check（check_fonts）每条规则都拦得住：许可证不在白名单、哈希不对、多一个没登记的文件夹、
// 常用字不全、产物和登记对不上、分片超大。最后查真仓库 --check 通过。本文件起 python 子进程。
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
  fonts: Array<{ id: string; css: string; family: string; prefetch: Array<{ url: string; sha256: string; bytes: number }>; bytes: { prefetch: number; all: number } }>;
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
    license: { spdx: 'OFL-1.1', file: 'LXGWWenKai-OFL.txt', sourceUrl: 'https://github.com/lxgw/LxgwWenKai', version: 'design-subset', sha256: { [REG]: sha(join(d, REG)), [MED]: sha(join(d, MED)) } },
  };
  patch(r);
  writeFileSync(join(d, 'font.json'), JSON.stringify(r));
  return root;
}

const index = (root: string) => JSON.parse(readFileSync(join(root, 'src', 'public', 'fonts-index.json'), 'utf8')) as Index;

describe('build/fonts.py', () => {
  itFt('切出 woff2 分片、样式和清单：预取分片带 sha256，样式按 unicode-range 分片、换掉 --f-zh / --f-ko / --f-num、不做假粗体', () => {
    const root = repo();
    expect(run(root).code).toBe(0);
    const [kai] = index(root).fonts;
    expect(kai?.id).toBe('kai');
    expect(kai?.family).toBe('lemo-kai-zh');
    expect(kai?.prefetch.length).toBeGreaterThan(0);
    const dir = join(root, 'src', 'public', 'fonts', 'kai');
    for (const p of kai?.prefetch ?? []) expect(sha(join(dir, p.url.split('/').pop() ?? ''))).toBe(p.sha256);
    const css = readFileSync(join(dir, kai?.css.split('/').pop() ?? ''), 'utf8');
    expect(css).toMatch(/@font-face\{font-family:"lemo-kai-zh";src:url\("\.\/zh-0-0\.[0-9a-f]{10}\.woff2"\) format\("woff2"\);font-weight:100 499;.*font-display:swap;unicode-range:U\+/);
    expect(css).toContain('font-weight:500 900');
    expect(css).toMatch(/:root\[data-font="kai"\]\{font-synthesis:none;--f-zh:"lemo-kai-zh",-apple-system, "PingFang SC"/);
    expect(css).toContain('--f-ko:"lemo-kai-ko","lemo-kai-zh","Apple SD Gothic Neo"');
    expect(css).toContain('--f-num:"lemo-kai-zh","Manrope"');
    // 每个分片文件都在样式里用到（没有孤儿文件）
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.woff2'))) expect(css).toContain(f);
  });

  itFt('num: manrope 时不换数字字体', () => {
    const root = repo((r) => (r['num'] = 'manrope'));
    expect(run(root).code).toBe(0);
    const [kai] = index(root).fonts;
    expect(readFileSync(join(root, 'src', 'public', 'fonts', 'kai', kai?.css.split('/').pop() ?? ''), 'utf8')).not.toContain('--f-num');
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
    expect(run(repo((r) => ((r['license'] as Record<string, unknown>)['spdx'] = 'GPL-3.0')), '--check').out).toContain('许可证 GPL-3.0 不在白名单');
    expect(run(repo((r) => ((r['license'] as Record<string, unknown>)['sha256'] = {})), '--check').out).toContain('的 sha256 和登记不一致');
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
  });

  it('真仓库：登记和产物一致，--check 通过', () => {
    const out = execFileSync('python', ['-I', SCRIPT, '--check'], { encoding: 'utf8' });
    expect(out).toContain('问题 0 个');
  });
});
