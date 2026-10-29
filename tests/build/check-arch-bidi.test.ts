// B1 接手清单 LINT-bidi：build/check_arch.py 的 BIDI 规则——源码里原样出现看不见的双向、零宽、填充类控制字符要报错（防 Trojan Source）
// 违规样例不能放进仓库（放了就是原样字符，自己会被扫到），所以每条用例在临时目录现拼一棵迷你仓库：
// 控制字符一律用 String.fromCodePoint 拼，本文件不含任何原样控制字符；转义写法里的反斜杠也用 BS 拼
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const ch = (cp: number) => String.fromCodePoint(cp);
const BS = String.fromCharCode(92);
const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

/** 所有文件都拦的码位 */
const FORBIDDEN: number[] = [
  ...range(0x200b, 0x200f),
  ...range(0x202a, 0x202e),
  ...range(0x2060, 0x2064),
  ...range(0x2066, 0x2069),
  0x061c, 0x2028, 0x2029, 0xfeff,
  0x180e, 0x3164, 0x115f, 0x1160, 0xffa0,
  ...range(0xe0000, 0xe007f),
];
/** 只在代码类扩展名里拦的码位（.md 不拦） */
const CODE_ONLY: number[] = [0x00ad, ...range(0xfe00, 0xfe0f)];
const EXTS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.css', '.sql', '.psql', '.py', '.ps1', '.sh', '.rs',
  '.json', '.jsonc', '.toml', '.yml', '.yaml', '.html', '.svg', '.xml', '.webmanifest', '.md', '.txt',
];

interface Item {
  rule: string;
  file: string;
  line: number;
  message: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), 'lemo-bidi-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

function bidi(root: string): { code: number; errors: Item[] } {
  const args = ['-I', join(ROOT, 'build', 'check_arch.py'), '--root', root, '--json', '--today', '2026-10-28'];
  let code = 0;
  let out: string;
  try {
    out = execFileSync('python', args, { encoding: 'utf8' });
  } catch (e) {
    const err = e as { status: number; stdout: string };
    code = err.status;
    out = err.stdout;
  }
  const report = JSON.parse(out) as { errors: Item[] };
  return { code, errors: report.errors.filter((x) => x.rule === 'BIDI') };
}

const where = (errors: Item[]) => errors.map((e) => `${e.file}:${e.line}`);
const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
const codes = (errors: Item[]) => errors.map((e) => /U\+[0-9A-F]{4,5}/.exec(e.message)?.[0]);
const lines = (...ls: string[]) => ls.join('\n');

describe('build/check_arch.py BIDI（LINT-bidi）', () => {
  it('代码文件里每个禁用码位原样出现 → 各报一条，行号、码位都对，退出码 1', () => {
    const all = [...FORBIDDEN, ...CODE_ONLY];
    const body = lines('// head', ...all.map((cp) => `const s = 'a${ch(cp)}b';`));
    const { code, errors } = bidi(repo({ 'lib/bad.ts': body }));
    expect(code).toBe(1);
    expect(errors.map((e) => e.line)).toEqual(all.map((_, i) => i + 2));
    expect(codes(errors)).toEqual(all.map(hex));
  });

  it('除二进制外所有文件都扫：各种扩展名、没有扩展名的文件都报', () => {
    const files: Record<string, string> = Object.fromEntries(EXTS.map((ext) => [`lib/f${ext}`, `x${ch(0x202e)}y\n`]));
    files['Dockerfile'] = `RUN echo ${ch(0x2066)}\n`;
    const { errors } = bidi(repo(files));
    expect(errors.map((e) => e.file).sort()).toEqual([...EXTS.map((ext) => `lib/f${ext}`), 'Dockerfile'].sort());
  });

  it('软连字符、变体选择符只在代码类扩展名里拦，.md 不拦', () => {
    const body = `a${ch(0x00ad)}b${ch(0xfe0f)}c\n`;
    const { errors } = bidi(repo({ 'docs/note.md': body, 'lib/x.ts': body }));
    expect(where(errors)).toEqual(['lib/x.ts:1', 'lib/x.ts:1']);
    expect(codes(errors)).toEqual(['U+00AD', 'U+FE0F']);
  });

  it('坏字节绕不过去：.json 里 NUL + RLO、.ts 里非法 UTF-8 + RLO、.ts 里 NUL + RLO、奇数长度的坏 UTF-16 + RLO → 都报', () => {
    const rlo = [0xe2, 0x80, 0xae];
    const odd = Buffer.concat([Buffer.from(`${ch(0xfeff)}a${ch(0x202e)}`, 'utf16le'), Buffer.from([0x41])]);
    expect(odd.length % 2).toBe(1);
    const { code, errors } = bidi(
      repo({
        'lib/blob.json': new Uint8Array([0x7b, 0x00, ...rlo, 0x7d]),
        'lib/badutf8.ts': new Uint8Array([0x2f, 0x2f, 0xff, 0xfe, 0x0a, 0x78, ...rlo, 0x0a]),
        'lib/nul.ts': new Uint8Array([0x2f, 0x2f, 0x00, 0x0a, 0x78, ...rlo, 0x0a]),
        'tools/odd.ps1': odd,
      }),
    );
    expect(code).toBe(1);
    expect(errors.map((e) => `${e.file}:${e.line} ${codes([e])[0]}`).sort()).toEqual([
      'lib/badutf8.ts:2 U+202E',
      'lib/blob.json:1 U+202E',
      'lib/nul.ts:2 U+202E',
      'tools/odd.ps1:1 U+202E',
    ]);
  });

  it('只有没扩展名或扩展名不认识的文件，含 NUL 才当二进制跳过', () => {
    const body = new Uint8Array([0x00, 0xe2, 0x80, 0xae]);
    const { errors } = bidi(repo({ 'lib/blob': body, 'lib/data.qqq': body, 'lib/notes.md': body }));
    expect(where(errors)).toEqual(['lib/notes.md:1']);
  });

  it('二进制扩展名但内容是文本、不含 NUL（.png 可被 require 当 JS、.bin 可被 python 当脚本）→ 照报', () => {
    const { errors } = bidi(
      repo({ 'assets/logo.png': `module.exports = '${ch(0x202e)}';\n`, 'assets/tool.bin': `print('${ch(0x202e)}')\n` }),
    );
    expect(where(errors).sort()).toEqual(['assets/logo.png:1', 'assets/tool.bin:1']);
  });

  it('二进制扩展名但 NUL 在第 9000 字节之后（git 也只看前 8000 字节）→ 不当二进制，照报', () => {
    const enc = new TextEncoder();
    const body = new Uint8Array([...enc.encode(`x${ch(0x202e)}y\n`), ...new Uint8Array(9000).fill(0x61), 0x00]);
    const { errors } = bidi(repo({ 'assets/late-nul.png': body }));
    expect(where(errors)).toEqual(['assets/late-nul.png:1']);
  });

  it('文件名里带 RLO → 报，行号 0、报错写明“文件名”（非 git 目录和 git 仓库两种扫法都查）', (ctx) => {
    const name = `lib/invoice${ch(0x202e)}fdp.ts`;
    let root: string;
    try {
      root = repo({ [name]: 'export const a = 1;\n' });
    } catch {
      ctx.skip(); // 文件系统建不出带 U+202E 的文件名（NTFS 能建，目前 Windows 上不会走到这里）
      return;
    }
    const plain = bidi(root);
    expect(plain.errors.map((e) => `${e.file}:${e.line}`)).toEqual([`${name}:0`]);
    expect(plain.errors[0]?.message).toContain('文件名');
    expect(codes(plain.errors)).toEqual(['U+202E']);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    expect(bidi(root).errors.map((e) => `${e.file}:${e.line}`)).toEqual([`${name}:0`]);
  });

  it('git 里强制提交的 node_modules 文件照扫（只有退回整棵树扫描时才排除 node_modules）', () => {
    const root = repo({ '.gitignore': 'node_modules/\n', 'x/node_modules/y/index.js': `x${ch(0x202e)}\n` });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '-f', 'x/node_modules/y/index.js'], { cwd: root, stdio: 'ignore' });
    const { errors } = bidi(root);
    expect(where(errors)).toEqual(['x/node_modules/y/index.js:1']);
  });

  it('对照：写成转义、文件开头的 BOM、（非 git 目录下的）node_modules、含 NUL 的二进制扩展名 → 不报', () => {
    const { code, errors } = bidi(
      repo({
        'lib/escaped.ts': `const rlo = '${BS}u202e'; const zw = '${BS}u{200b}';\n`,
        'lib/escaped.sql': `select E'${BS}u2066';\n`,
        'tools/bom.ps1': `${ch(0xfeff)}Write-Output 1\n`,
        'node_modules/pkg/index.js': `x${ch(0x202e)}y\n`,
        // 二进制扩展名的对照样本必须含 NUL（扩展名命中且含 NUL 才跳过）
        'assets/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, ...new TextEncoder().encode(`x${ch(0x202e)}y`)]),
      }),
    );
    expect(errors).toEqual([]);
    expect(code).toBe(0);
  });

  it('文件中间的 BOM → 报', () => {
    const { errors } = bidi(repo({ 'lib/mid.ts': `const a = 1;\nconst b = '${ch(0xfeff)}';\n` }));
    expect(where(errors)).toEqual(['lib/mid.ts:2']);
  });

  it('行号只数换行符：U+2028、U+2029 不算换行', () => {
    const { errors } = bidi(repo({ 'lib/ls.js': `a${ch(0x2028)}b${ch(0x2029)}c\nd${ch(0x202e)}\n` }));
    expect(where(errors)).toEqual(['lib/ls.js:1', 'lib/ls.js:1', 'lib/ls.js:2']);
  });

  it('UTF-16（FF FE、FE FF 开头）先解码再扫，不因为有 NUL 当成二进制；开头的 BOM 不报', () => {
    const text = `${ch(0xfeff)}line1\nx${ch(0x202e)}y\n`;
    const le = Buffer.from(text, 'utf16le');
    const be = Buffer.from(text, 'utf16le').swap16();
    const clean = Buffer.from(`${ch(0xfeff)}ok\n`, 'utf16le');
    const { errors } = bidi(repo({ 'tools/le.ps1': le, 'tools/be.ps1': be, 'tools/clean.ps1': clean }));
    expect(where(errors).sort()).toEqual(['tools/be.ps1:2', 'tools/le.ps1:2']);
    expect(codes(errors)).toEqual(['U+202E', 'U+202E']);
  });

  it('FF FE 开头但内容其实是 UTF-8 的 .sh（bash 照样执行）→ UTF-16、UTF-8 两种都扫，照报，且同一处不重复报', () => {
    const enc = new TextEncoder();
    const fake = new Uint8Array([0xff, 0xfe, ...enc.encode(`\necho '${ch(0x202e)}'\n`)]);
    // 真 UTF-16 的同一内容：两种解码只有 UTF-16 那种命中，合并后只报一次
    const real = Buffer.from(`${ch(0xfeff)}\necho '${ch(0x202e)}'\n`, 'utf16le');
    const { errors } = bidi(repo({ 'tools/a.sh': fake, 'tools/b.sh': real }));
    expect(errors.map((e) => `${e.file}:${e.line} ${codes([e])[0]}`).sort()).toEqual([
      'tools/a.sh:2 U+202E',
      'tools/b.sh:2 U+202E',
    ]);
  });

  it('FF FE 开头、两种解码都命中同一处（同一行同一码位）→ 只报一次', () => {
    // FF FE 之后是 UTF-16LE 的 RLO（2E 20）再接 UTF-8 的 RLO（E2 80 AE）：两种解码各在第 1 行解出一个 RLO
    const bytes = new Uint8Array([0xff, 0xfe, 0x2e, 0x20, 0xe2, 0x80, 0xae, 0x00]);
    const { errors } = bidi(repo({ 'tools/both.sh': bytes }));
    expect(errors.map((e) => `${e.file}:${e.line} ${codes([e])[0]}`)).toEqual(['tools/both.sh:1 U+202E']);
  });

  it('例外名单精确到行：0004_attachments.sql 只放行第 16 行实际出现的码位（202A、202E、2066、2069）', () => {
    const path = 'supabase/migrations/0004_attachments.sql';
    const line16 = `  and name !~ '[${ch(0x202a)}-${ch(0x202e)}${ch(0x2066)}-${ch(0x2069)}]'`;
    const head = Array.from({ length: 15 }, (_, i) => `-- ${i + 1}`);
    const ok = bidi(repo({ [path]: lines(...head, line16, '') }));
    expect(ok.errors).toEqual([]);
    expect(ok.code).toBe(0);
    // 第 16 行多一个 202B（这一行原本没有）、别的行出现 202B、名单外的 200B、别的文件里同样的 202A → 都报
    const bad = bidi(
      repo({
        [path]: lines(...head, `${line16}${ch(0x202b)}`, `select '${ch(0x202b)}';`, `select '${ch(0x200b)}';`, ''),
        'supabase/migrations/0005_other.sql': `select '${ch(0x202a)}';\n`,
      }),
    );
    expect(bad.code).toBe(1);
    expect(bad.errors.map((e) => `${e.file}:${e.line} ${codes([e])[0]}`)).toEqual([
      `${path}:16 U+202B`,
      `${path}:17 U+202B`,
      `${path}:18 U+200B`,
      'supabase/migrations/0005_other.sql:1 U+202A',
    ]);
  });

  it('git 仓库里按 git ls-files 扫：已跟踪和未忽略的新文件报，.gitignore 忽略的不报', () => {
    const root = repo({
      '.gitignore': 'ignored.ts\n',
      'tracked.ts': `x${ch(0x2067)}\n`,
      'untracked.md': `x${ch(0x200b)}\n`,
      'ignored.ts': `x${ch(0x202e)}\n`,
    });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', 'tracked.ts', '.gitignore'], { cwd: root, stdio: 'ignore' }); // 静音 git 的 CRLF 提示
    const { errors } = bidi(root);
    expect(where(errors).sort()).toEqual(['tracked.ts:1', 'untracked.md:1']);
  });

  it('git 出错（.git 指向不存在的目录）→ 退回整棵树扫：.gitignore 不生效，忽略的文件也报', () => {
    const root = repo({
      '.git': 'gitdir: ./no-such-dir\n',
      '.gitignore': 'ignored.ts\n',
      'ignored.ts': `x${ch(0x202e)}\n`,
    });
    let gitFailed = false;
    try {
      execFileSync('git', ['ls-files'], { cwd: root, stdio: 'ignore' });
    } catch {
      gitFailed = true;
    }
    expect(gitFailed).toBe(true);
    const { errors } = bidi(root);
    expect(where(errors)).toEqual(['ignored.ts:1']);
  });

  it('真仓库：BIDI 0 个错误', { timeout: 60_000 }, () => {
    expect(bidi(ROOT).errors).toEqual([]);
  });
});
