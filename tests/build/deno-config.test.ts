// deno.json 里钉的版本必须和 package.json 一样（架构 2.5：shared 前后端共用，版本不一致会两边校验结果不同）
// supabase/functions/ 和 build/ 里写全的 npm:包@版本 也要和 package.json 一样（deno.json 的 nodeModulesDir=manual 用的是 node_modules 里那一份）
// 进程时区也核对一下：test:tz 设的 TZ 真的生效了
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const readJson = (f: string): unknown => JSON.parse(readFileSync(join(root, f), 'utf8'));
const pkg = readJson('package.json') as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'gen') continue;
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

// ---- 部署一侧依赖锁的源码扫描（架构 0.33 第 7 条，B1 S8 代码审查返工）----
// 和 build/check_backend.py 的 SOURCE_EXT 对齐
const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
// 避开锁的配置：函数目录或别处的这些文件会让 CLI / Deno 换一套解析
// .npmrc 能在部署时换 npm 源（S8 复审低 4）
const BYPASS_CONFIGS = ['deno.json', 'deno.jsonc', 'import_map.json', 'package.json', 'deno.lock', '.npmrc'];
const LOCK_FILES = new Set(['supabase/functions/deno.json', 'supabase/functions/deno.lock']);
// 出站接口地址（fetch 的目标，不是模块）：只放这几个写死的完整地址，普通引号、一字不差；用在 import / 动态 import 里照样报错。
//   B1 K2 invite-signup 加（架构 5.6：Turnstile siteverify、Resend 发信）；加新地址要代码评审和安全审查看
const OUTBOUND_API_URLS: ReadonlySet<string> = new Set([
  'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  'https://api.resend.com/emails',
]);
const NPM_EXACT =/^npm:((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\/[\w./-]*)?$/;

interface Lit { text: string; tpl: boolean; start: number; line: number }

/** 粗分词：跳过注释，取出 '…' "…" `…` 字面量（模板整段取原文，含 ${} 部分），并给出把注释和字面量内容抹掉后的代码 */
function lexLiterals(code: string): { lits: Lit[]; masked: string } {
  const lits: Lit[] = [];
  const out = code.split('');
  const lineAt = (i: number): number => code.slice(0, i).split('\n').length;
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      const e = code.indexOf('\n', i);
      const end = e < 0 ? code.length : e;
      for (let k = i; k < end; k++) out[k] = ' ';
      i = end;
    } else if (c === '/' && code[i + 1] === '*') {
      const e = code.indexOf('*/', i + 2);
      const end = e < 0 ? code.length : e + 2;
      for (let k = i; k < end; k++) if (out[k] !== '\n') out[k] = ' ';
      i = end;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < code.length) {
        const d = code[j];
        if (d === '\\') { j += 2; continue; }
        if (c === '`') {
          if (d === '$' && code[j + 1] === '{') { depth++; j += 2; continue; }
          if (depth > 0 && d === '}') { depth--; j++; continue; }
          if (depth === 0 && d === '`') break;
        } else if (d === c || d === '\n') break;
        j++;
      }
      lits.push({ text: code.slice(i + 1, j), tpl: c === '`', start: i, line: lineAt(i) });
      for (let k = i + 1; k < j && k < code.length; k++) if (out[k] !== '\n') out[k] = 'x';
      i = j + 1;
    } else i++;
  }
  return { lits, masked: out.join('') };
}

/** 一个源码文件里绕开锁的写法；locked 是 supabase/functions/deno.json 里的 npm:包@版本 */
function scanSource(code: string, locked: ReadonlySet<string>): string[] {
  const errs: string[] = [];
  const { lits, masked } = lexLiterals(code);
  const litAt = new Map(lits.map((l) => [l.start, l]));
  for (const l of lits) {
    if (/jsr:|https?:/i.test(l.text) && !(!l.tpl && OUTBOUND_API_URLS.has(l.text))) errs.push(`第 ${l.line} 行：字符串里有 jsr: / http(s):（远程模块不在锁里）`);
    if (l.text.includes('npm:')) {
      const m = l.tpl ? null : NPM_EXACT.exec(l.text);
      if (!m) errs.push(`第 ${l.line} 行：npm: 后面必须是“包@精确版本”，写在普通引号里（${l.text}）`);
      else if (!locked.has(`npm:${m[1]}@${m[2]}`)) errs.push(`第 ${l.line} 行：npm:${m[1]}@${m[2]} 不在 supabase/functions/deno.json 里，要加进去并重新生成 deno.lock`);
    }
  }
  // 动态 import / require：参数必须是普通引号的字面量，且后面紧跟 ) 或 ,
  for (const m of masked.matchAll(/\b(?:import|require)\s*\(\s*/g)) {
    if (/\.\s*$/.test(masked.slice(0, m.index))) continue; // obj.require( 之类不算
    const l = litAt.get(m.index + m[0].length);
    const after = l ? masked.slice(l.start + l.text.length + 2).match(/^\s*[,)]/) : null;
    if (!l || l.tpl || !after) errs.push(`第 ${code.slice(0, m.index).split('\n').length} 行：动态 import( ) 只准写 '…' 或 "…" 字面量（模板、变量、拼接都看不出引的是什么）`);
    else if (/jsr:|https?:/i.test(l.text)) errs.push(`第 ${l.line} 行：动态 import( ) 引远程地址（不在锁里；出站接口白名单只管 fetch，不管 import）`);
  }
  // 静态 import / export … from / import '…'：只准相对路径、npm:包@版本、node:
  for (const m of masked.matchAll(/\b(?:from|import)\s*(?=['"])/g)) {
    const l = litAt.get(m.index + m[0].length);
    if (!l) continue;
    if (!/^(?:\.\.?\/|npm:|node:)/.test(l.text)) errs.push(`第 ${l.line} 行：import 只准相对路径、npm:包@版本、node:（${l.text}；裸名靠 import map，部署时不保证有）`);
  }
  return errs;
}

function walkAll(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === '.temp' || name === '.branches') continue;
    if (statSync(p).isDirectory()) walkAll(p, out);
    else out.push(p);
  }
  return out;
}

/** 整个仓库（或样例根）的扫描：supabase/functions 源码（gen/ 由 copy_shared 管）、supabase/ 下避开锁的配置、config.toml 的 import_map */
function scanDenoLock(base: string): string[] {
  const errs: string[] = [];
  const rel = (p: string): string => relative(base, p).split('\\').join('/');
  const fnDeno = JSON.parse(readFileSync(join(base, 'supabase', 'functions', 'deno.json'), 'utf8')) as { imports: Record<string, string> };
  const locked = new Set(Object.values(fnDeno.imports));
  for (const f of walkAll(join(base, 'supabase'))) {
    const r = rel(f);
    const name = r.split('/').pop() ?? '';
    if (BYPASS_CONFIGS.includes(name) && !LOCK_FILES.has(r)) errs.push(`${r}：supabase/ 下只准有 supabase/functions/deno.json 和 deno.lock，别的 ${name} 会让这个函数绕开锁`);
    if (r.startsWith('supabase/functions/') && !r.startsWith('supabase/functions/_shared/gen/') && SOURCE_EXT.some((e) => r.endsWith(e))) {
      for (const e of scanSource(readFileSync(f, 'utf8'), locked)) errs.push(`${r} ${e}`);
    }
  }
  const toml = join(base, 'supabase', 'config.toml');
  try {
    readFileSync(toml, 'utf8').split('\n').forEach((line, k) => {
      const body = line.replace(/#.*$/, '');
      if (/import_map/.test(body)) errs.push(`supabase/config.toml 第 ${k + 1} 行：不准给函数设 import_map（会绕开 supabase/functions/deno.json 和 deno.lock）`);
    });
  } catch { /* 样例里可以没有 config.toml */ }
  return errs;
}

describe('deno.json', () => {
  const deno = readJson('deno.json') as { imports: Record<string, string>; tasks: Record<string, string> };

  it('映射的 npm 包版本都和 package.json 一致', () => {
    for (const name of ['zod', 'aws4fetch', 'postgres', '@supabase/supabase-js']) {
      expect(deno.imports[name], name).toBe(`npm:${name}@${deps[name]}`);
    }
  });

  it('CI 用到的任务都在：test（ci.yml 的 deno task test）、check、d1', () => {
    expect(Object.keys(deno.tasks).sort()).toEqual(['check', 'd1', 'test']);
    expect(deno.tasks.check).toContain('supabase/functions/_shared/');
  });

  it('supabase/functions、build 里写全的 npm:包@版本 和 package.json 一致', () => {
    const files = [...tsFiles(join(root, 'supabase', 'functions')), ...tsFiles(join(root, 'build'))];
    const seen: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/['"]npm:((?:@[^/'"]+\/)?[^@'"]+)@([^'"/]+)/g)) {
        const [, name = '', ver] = m;
        seen.push(`${relative(root, f)} ${name}`);
        expect(ver, `${relative(root, f)}：${name}`).toBe(deps[name]);
      }
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  it('部署一侧 supabase/functions/deno.json 只写 npm:包@精确版本，和 package.json 一致；deno.lock 和它对得上（架构 0.33 第 7 条）', () => {
    const fnDeno = readJson('supabase/functions/deno.json') as { imports: Record<string, string> } & Record<string, unknown>;
    // 只许 $comment 和 imports：不许 importMap、scopes、nodeModulesDir 之类把解析指到别处
    expect(Object.keys(fnDeno).filter((k) => k !== '$comment').sort()).toEqual(['imports']);
    const wanted = Object.entries(fnDeno.imports);
    expect(wanted.length).toBeGreaterThan(0);
    for (const [name, target] of wanted) expect(target, name).toBe(`npm:${name}@${deps[name]}`);
    const lock = readJson('supabase/functions/deno.lock') as {
      specifiers: Record<string, string>;
      npm: Record<string, { integrity?: string }>;
      workspace?: { dependencies?: string[] };
      jsr?: unknown;
      remote?: unknown;
    };
    // 锁里的直接依赖就是 deno.json 里那几个（改了 deno.json 不重新生成锁，这里和 CI 的 deno install --frozen 都失败）
    expect(Object.keys(lock.specifiers).sort()).toEqual(wanted.map(([, t]) => t).sort());
    expect((lock.workspace?.dependencies ?? []).slice().sort()).toEqual(wanted.map(([, t]) => t).sort());
    // 每个 npm 包（含间接依赖）都有 integrity；现在没有 jsr / https 依赖
    for (const [pkgVer, info] of Object.entries(lock.npm)) expect(info.integrity, pkgVer).toMatch(/^sha512-/);
    expect(lock.jsr).toBeUndefined();
    expect(lock.remote).toBeUndefined();
  });

  it('仓库本身：supabase/functions 源码的远程依赖都在锁里，supabase/ 下没有避开锁的配置', () => {
    expect(scanDenoLock(root)).toEqual([]);
  });

  describe('反例：每一种绕开锁的写法都报（B1 S8 代码审查）', () => {
    const locked = new Set(['npm:zod@4.6.7', 'npm:aws4fetch@1.0.20']);
    const bad: [string, string][] = [
      ['不在锁里的包', "import ms from 'npm:ms@2.1.3';"],
      ['不带版本的 npm:zod', "import { z } from 'npm:zod';"],
      ['版本范围 npm:zod@^4', "import { z } from 'npm:zod@^4.6.7';"],
      ['锁里的包换了版本', "import { z } from 'npm:zod@4.6.6';"],
      ['只为副作用的 jsr', "import 'jsr:@std/assert@1.0.0';"],
      ['只为副作用的 https', 'import "https://deno.land/std@0.224.0/assert/mod.ts";'],
      ['export from http', "export * from 'http://example.com/x.ts';"],
      ['模板字符串的动态 import', 'await import(`npm:ms@2.1.3`);'],
      ['模板字符串里带 ${} 的动态 import', 'const v = "2.1.3"; await import(`npm:ms@${v}`);'],
      ['变量拼出来的动态 import', "const p = 'npm:' + 'ms@2.1.3'; await import(p);"],
      ['参数里拼接的动态 import', "await import('npm:' + 'ms@2.1.3');"],
      ['require 变量', 'const m = require(name);'],
      ['裸名（靠 import map）', "import { z } from 'zod';"],
      ['字符串里藏 jsr', "const u = 'jsr:@std/assert';"],
      ['绝对路径', "import x from '/tmp/x.ts';"],
      ['出站白名单地址拿来动态 import', "await import('https://api.resend.com/emails');"],
      ['出站白名单地址拿来静态 import', "import 'https://api.resend.com/emails';"],
      ['白名单地址多一个字', "const u = 'https://api.resend.com/emails/x';"],
      ['白名单地址写成模板', 'const u = `https://api.resend.com/emails`;'],
      ['不在白名单的出站地址', "const u = 'https://example.com/api';"],
    ];
    for (const [label, code] of bad) {
      it(label, () => {
        expect(scanSource(code, locked).length, code).toBeGreaterThan(0);
      });
    }
    it('对照：正常写法不报（npm:包@版本、相对、node:、字面量动态 import、注释里的 URL）', () => {
      const ok = [
        "import { z } from 'npm:zod@4.6.7';",
        "import type { X } from './x.ts';",
        "export { y } from '../y.ts';",
        "import { Buffer } from 'node:buffer';",
        "const m = await import('./m.ts');",
        '// 参考 https://supabase.com/docs\n/* jsr:@std/x */\nconst n = 1;',
        "const re = Array.from('abc');",
        "const T = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';",
        "await fetch('https://api.resend.com/emails', { method: 'POST' });",
      ].join('\n');
      expect(scanSource(ok, locked)).toEqual([]);
    });

    const tmp = (): string => {
      const d = mkdtempSync(join(tmpdir(), 'lemo-denolock-'));
      mkdirSync(join(d, 'supabase', 'functions', 'todo-remind'), { recursive: true });
      writeFileSync(join(d, 'supabase', 'functions', 'deno.json'), JSON.stringify({ imports: { zod: 'npm:zod@4.6.7' } }));
      writeFileSync(join(d, 'supabase', 'functions', 'deno.lock'), '{}');
      writeFileSync(join(d, 'supabase', 'functions', 'todo-remind', 'index.ts'), "import { z } from 'npm:zod@4.6.7';\n");
      return d;
    };
    it('对照：只有 supabase/functions/deno.json 和 deno.lock 时不报', () => {
      const d = tmp();
      try { expect(scanDenoLock(d)).toEqual([]); } finally { rmSync(d, { recursive: true, force: true }); }
    });
    for (const f of ['deno.json', 'deno.jsonc', 'import_map.json', 'package.json', 'deno.lock']) {
      it(`函数目录下的 ${f}`, () => {
        const d = tmp();
        try {
          writeFileSync(join(d, 'supabase', 'functions', 'todo-remind', f), '{}');
          expect(scanDenoLock(d).join('\n')).toContain(`supabase/functions/todo-remind/${f}`);
        } finally { rmSync(d, { recursive: true, force: true }); }
      });
    }
    it('supabase/functions 顶层的 import_map.json', () => {
      const d = tmp();
      try {
        writeFileSync(join(d, 'supabase', 'functions', 'import_map.json'), '{}');
        expect(scanDenoLock(d).join('\n')).toContain('supabase/functions/import_map.json');
      } finally { rmSync(d, { recursive: true, force: true }); }
    });
    for (const [label, toml] of [
      ['[functions.x] 的 import_map', '[functions.todo-remind]\nverify_jwt = true\nimport_map = "./functions/todo-remind/deno.json"\n'],
      ['点号写法 functions.x.import_map', 'functions.todo-remind.import_map = "./m.json"\n'],
      ['内联表', '[functions]\ntodo-remind = { import_map = "./m.json" }\n'],
    ]) {
      it(`config.toml：${label}`, () => {
        const d = tmp();
        try {
          writeFileSync(join(d, 'supabase', 'config.toml'), `# import_map 写在注释里不算\n${toml}`);
          const errs = scanDenoLock(d);
          expect(errs).toHaveLength(1);
          expect(errs[0]).toContain('import_map');
        } finally { rmSync(d, { recursive: true, force: true }); }
      });
    }
    it('函数源码（.mjs 等扩展名也扫）里的绕法', () => {
      const d = tmp();
      try {
        writeFileSync(join(d, 'supabase', 'functions', 'todo-remind', 'x.mjs'), "import 'npm:zod';\n");
        expect(scanDenoLock(d).join('\n')).toContain('supabase/functions/todo-remind/x.mjs');
      } finally { rmSync(d, { recursive: true, force: true }); }
    });
  });

  it('进程时区和 TZ 环境变量一致（test:tz 用）', () => {
    const want = process.env.TZ;
    if (want) expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(want === 'UTC' ? 'UTC' : want);
  });
});
