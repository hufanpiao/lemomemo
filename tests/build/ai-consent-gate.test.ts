// TC-B1-15（架构 1.3 B1“未同意 AI 的账号服务器一条都不送 AI”、5.2、15.5）：静态守门
// B1 还没有调 AI 的函数（ai-parse、ai-voice、claude-intake 等在 B3 以后），所以“未同意账号调用次数为 0”此刻靠这条保证；
// 之后各批加回放桩的运行时测试（TC-B3-25、TC-B4-05、TC-B4b2-09）。
// 规则（审查必改 2）：
//   ① 先扫 _shared/（不含 consent.ts 本身和生成目录 gen/）：源码碰到谷歌 AI（AI_HINT）的模块算“AI 模块”，
//      再按本地 import 闭包往外扩——import 了 AI 模块的共用模块也算；
//   ② 函数目录里任何文件碰到 AI_HINT，或 import 了任何 AI 模块，这个函数就算“碰到 AI”；
//   ③ 碰到 AI 的函数必须从 _shared/consent.ts 具名 import aiAllowed，并且去掉注释后代码里真的有 aiAllowed( 调用（只 import 不调不算）。
// 不查：_preview/（预览专用的评测函数按架构第 7 节有意不查同意，只在预览项目部署）
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const FN_DIR = join(ROOT, 'supabase', 'functions');
const AI_HINT = /_shared\/ai\/|googleapis\.com|@google\/genai|@google\/generative-ai|@ai-sdk\/google|GEMINI_[A-Z_]*|GOOGLE_API_KEY/;
const IMPORTS_AI_ALLOWED = /import\s*\{[^}]*\baiAllowed\b[^}]*\}\s*from\s*['"][^'"]*_shared\/consent\.ts['"]/;
const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
const SRC = /\.(ts|tsx|mts|js|mjs)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : SRC.test(n) ? [p] : [];
  });
}

/** 去掉 // 和 /* *\/ 注释，保留字符串和模板字符串（里面的 // 不当注释） */
function stripComments(src: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? '';
    if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i++; } else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
  }
  return out;
}

/** 本地 import 解析成绝对路径（只认相对路径） */
function localImports(file: string, src: string): string[] {
  return [...stripComments(src).matchAll(SPEC)].map((m) => m[1] ?? '').filter((s) => s.startsWith('.')).map((s) => resolve(dirname(file), s));
}

/** _shared 里碰到 AI 的模块（绝对路径）：直接碰到 + 按 import 闭包往外扩 */
function aiSharedModules(fnRoot: string): Set<string> {
  const shared = join(fnRoot, '_shared');
  if (!existsSync(shared)) return new Set();
  const mods = files(shared).filter((f) => {
    const rel = relative(shared, f).split(sep).join('/');
    return rel !== 'consent.ts' && !rel.startsWith('gen/');
  });
  const src = new Map(mods.map((f) => [f, readFileSync(f, 'utf8')]));
  const ai = new Set(mods.filter((f) => AI_HINT.test(stripComments(src.get(f) ?? ''))));
  for (let grew = true; grew;) {
    grew = false;
    for (const f of mods) {
      if (!ai.has(f) && localImports(f, src.get(f) ?? '').some((p) => ai.has(p))) { ai.add(f); grew = true; }
    }
  }
  return ai;
}

/** 碰到谷歌 AI、却没 import 并调用 aiAllowed 的函数名 */
function ungated(fnRoot: string): string[] {
  const aiMods = aiSharedModules(fnRoot);
  const bad: string[] = [];
  for (const name of readdirSync(fnRoot)) {
    const dir = join(fnRoot, name);
    if (name.startsWith('_') || !statSync(dir).isDirectory()) continue;
    const srcs = files(dir).map((f) => ({ f, s: readFileSync(f, 'utf8') }));
    const touches = srcs.some(({ f, s }) => AI_HINT.test(stripComments(s)) || localImports(f, s).some((p) => aiMods.has(p)));
    if (!touches) continue;
    const code = srcs.map(({ s }) => stripComments(s));
    const gated = code.some((c) => IMPORTS_AI_ALLOWED.test(c)) && code.some((c) => /\baiAllowed\s*\(/.test(c.replace(IMPORTS_AI_ALLOWED, '')));
    if (!gated) bad.push(name);
  }
  return bad.sort();
}

describe('TC-B1-15：调 AI 的函数都先过 aiAllowed', () => {
  it('supabase/functions 下没有绕过同意直接或间接调谷歌 AI 的函数', () => {
    expect(ungated(FN_DIR)).toEqual([]);
  });

  it('_shared/consent.ts 导出 aiAllowed（守门规则引用的就是它）', () => {
    const src = readFileSync(join(FN_DIR, '_shared', 'consent.ts'), 'utf8');
    expect(src).toMatch(/export async function aiAllowed\(/);
  });

  it('自测：直接调、经 _shared 间接调（含两层）、只 import 不调、只在注释里调的都认得出；真调了就放过', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ai-consent-gate-'));
    const write = (rel: string, body: string): void => {
      const p = join(tmp, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body, 'utf8');
    };
    const GATE = "import { aiAllowed } from '../_shared/consent.ts';\n";
    try {
      write('_shared/consent.ts', 'export async function aiAllowed() { return false; }\n');
      write('_shared/llm.ts', "export const URL = 'https://generativelanguage.googleapis.com/v1beta/models';\n");
      write('_shared/summarize.ts', "import { URL } from './llm.ts';\nexport const go = () => fetch(URL);\n");
      write('_shared/keyed.ts', "export const k = () => Deno.env.get('GOOGLE_API_KEY');\n");
      write('_shared/plain.ts', '// 注释里提到 googleapis.com 不算\nexport const x = 1;\n');
      write('_shared/gen/x.ts', "export const k = 'GEMINI_API_KEY';\n");
      write('ai-direct/index.ts', "const u = 'https://generativelanguage.googleapis.com/v1beta/models';\n");
      write('ai-indirect/index.ts', "import { go } from '../_shared/summarize.ts';\ngo();\n");
      write('ai-key/index.ts', "import { k } from '../_shared/keyed.ts';\nk();\n");
      write('ai-sdk/index.ts', "import { google } from 'npm:@ai-sdk/google@1.0.0';\n");
      write('ai-import-only/index.ts', `${GATE}import { go } from '../_shared/summarize.ts';\ngo();\n`);
      write('ai-comment-only/index.ts', `${GATE}import { go } from '../_shared/summarize.ts';\n// if (!(await aiAllowed(admin, uid))) return;\ngo();\n`);
      write('ai-good/index.ts', `${GATE}import { go } from '../_shared/summarize.ts';\nif (await aiAllowed(admin, uid)) go();\n`);
      write('ai-good-split/index.ts', `${GATE}import './handler.ts';\n`);
      write('ai-good-split/handler.ts', "import { aiAllowed } from '../_shared/consent.ts';\nconst u = 'https://generativelanguage.googleapis.com/x';\nif (await aiAllowed(a, b)) fetch(u);\n");
      write('plain/index.ts', "import { x } from '../_shared/plain.ts';\nconst s = 'http://example.com//not-a-comment';\n");
      write('_preview/ai-eval/index.ts', "import { go } from '../../_shared/summarize.ts';\ngo();\n");
      expect(ungated(tmp)).toEqual(['ai-comment-only', 'ai-direct', 'ai-import-only', 'ai-indirect', 'ai-key', 'ai-sdk']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('stripComments 不把字符串里的 // 当注释', () => {
    expect(stripComments("const u = 'https://a.googleapis.com'; // aiAllowed(\n")).toBe("const u = 'https://a.googleapis.com'; \n");
    expect(stripComments('a /* aiAllowed( */ b')).toBe('a   b');
  });
});
