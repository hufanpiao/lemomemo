// 账号信时区说法的接线（KO-mail-nolink-tz 复核：时区表挪到 shared/，前后端共用一份）：
//   account、account-purge 两个 index.ts 都从 _shared/gen/i18n/tz-label.ts（build/copy_shared.mjs 由 shared/i18n/tz-label.ts 生成）
//   取 tzLabel、放进 deps；_shared/account-mail.ts 自己不再写时区表（只留类型 TzLabeler），免得两份各改各的。
// 静态读源码，不起函数；tests/functions 的 tsconfig 没有 node 类型，所以放在这里。
// KO-mail-tz-low L4（代码审查 11-05）：原来只查“有一行以 tzLabel, 开头”，写在注释里或别的对象里也能过。
//   现在先去掉注释，再在 Deno.serve 里那次 handle(req, { … }) 的对象字面量里，按顶层属性逐个查（嵌套对象、字符串里的不算）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** 去掉块注释、整行注释和行尾注释（行尾的要求 // 前有空白，免得吃掉 https:// 这类字符串） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s+\/\/.*$/gm, '');
}

/** Deno.serve 里 handle(req, { … }) 那个对象字面量的顶层成员（逐个去掉首尾空白）；找不到回 null */
function handleDepsMembers(src: string): string[] | null {
  const code = stripComments(src);
  const serve = code.indexOf('Deno.serve(');
  if (serve < 0) return null;
  const call = code.indexOf('handle(req, {', serve);
  if (call < 0) return null;
  const members: string[] = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (let i = code.indexOf('{', call); i < code.length; i++) {
    const ch = code[i] as string;
    if (quote) {
      if (ch === '\\') { cur += ch + (code[i + 1] ?? ''); i++; continue; }
      if (ch === quote) quote = '';
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth++;
      if (depth === 1) continue;
    } else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) { if (cur.trim()) members.push(cur.trim()); return members; }
    } else if (ch === ',' && depth === 1) {
      members.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  return null;
}

describe('接线检查本身（L4）：注释里、嵌套对象里、字符串里的 tzLabel 都不算', () => {
  const wrap = (body: string) => `Deno.serve((req) => {\n  return handle(req, {\n${body}\n  });\n});\n`;
  it('顶层的简写、tzLabel: tzLabel 算', () => {
    expect(handleDepsMembers(wrap('    store,\n    tzLabel,\n    now: () => Date.now(),'))).toContain('tzLabel');
    expect(handleDepsMembers(wrap('    tzLabel: tzLabel,'))?.some((m) => /^tzLabel\s*:\s*tzLabel$/.test(m))).toBe(true);
  });
  it('只在注释里、嵌套对象里、字符串里、或在 Deno.serve 之外：不算', () => {
    const hit = (src: string) => (handleDepsMembers(src) ?? []).includes('tzLabel');
    expect(hit(wrap('    store,\n    // tzLabel,\n    now,'))).toBe(false);
    expect(hit(wrap('    store,\n    /* tzLabel, */\n    now,'))).toBe(false);
    expect(hit(wrap('    store: { tzLabel, x: 1 },\n    now,'))).toBe(false);
    expect(hit(wrap("    note: 'a, tzLabel, b',\n    now,"))).toBe(false);
    expect(hit(`const other = {\n  tzLabel,\n};\n${wrap('    now,')}`)).toBe(false);
    expect(handleDepsMembers('export const x = 1;')).toBeNull();
  });
});

describe('账号信的时区说法只有 shared/i18n/tz-label.ts 一份', () => {
  it('两个 index.ts 都从 _shared/gen/i18n/tz-label.ts 取 tzLabel 并放进 deps', () => {
    for (const f of ['supabase/functions/account/index.ts', 'supabase/functions/account-purge/index.ts']) {
      const src = read(f);
      expect(src, f).toContain("import { tzLabel } from '../_shared/gen/i18n/tz-label.ts';");
      const members = handleDepsMembers(src);
      expect(members, f).not.toBeNull();
      expect(members?.some((m) => m === 'tzLabel' || /^tzLabel\s*:\s*tzLabel$/.test(m)), f).toBe(true);
    }
  });

  it('account-mail.ts 不 import shared、不写时区表；shared 那份是 switch（F7）', () => {
    const mail = read('supabase/functions/_shared/account-mail.ts');
    expect(mail).not.toMatch(/case '[A-Z][A-Za-z_]*\/|from '[^']*shared\/i18n/);
    expect(mail).toContain('export type TzLabeler');
    const shared = read('shared/i18n/tz-label.ts');
    expect(shared).toMatch(/switch \(zone\)/);
    expect(shared).toContain("case 'Asia/Seoul'");
  });
});
