// voice-probe 的守门和一致性核对（B3 任务单 BE-0、Q1 ①④⑤⑥⑦）：源码不打印多余的东西、不碰数据库、进 PREVIEW_FUNCS 不进别的名单；
// 预览 ref、类型、大小上限和 db-probe、ai-voice 一致；每天额度的计数窗口在整个有效期内不切开任何一个太平洋日期。行为测试在 voice-probe.test.ts。
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIO_TYPES, EXPIRES_AT, isPreview, MAX_AUDIO, PREVIEW_REF, QUOTA_WINDOW_S } from '../../supabase/functions/_preview/voice-probe/handler.ts';
import { PREVIEW_REF as DB_PROBE_REF } from '../../supabase/functions/_preview/db-probe/probe.ts';
import { AUDIO_TYPES as VOICE_TYPES, MAX_AUDIO as VOICE_MAX } from '../../supabase/functions/ai-voice/core.ts';
import { pacificDate } from '../../supabase/functions/_shared/ai/gate.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const PREVIEW_URL = `https://${PREVIEW_REF}.supabase.co`;

describe('voice-probe：和 db-probe、ai-voice 一致；计数窗口', () => {
  it('预览 ref 和 db-probe 写死的是同一个；isPreview 只许末尾多一个斜杠', () => {
    expect(PREVIEW_REF).toBe(DB_PROBE_REF);
    expect([isPreview(PREVIEW_URL), isPreview(`${PREVIEW_URL}/`), isPreview(`${PREVIEW_URL}//`)]).toEqual([true, true, false]);
  });
  it('类型和大小上限和正式 ai-voice 一样', () => {
    expect([...AUDIO_TYPES]).toEqual([...VOICE_TYPES]);
    expect(MAX_AUDIO).toBe(VOICE_MAX);
  });
  it('有效期内（11-07 到 EXPIRES_AT）每个太平洋日期从头到尾都落在同一个 take_rate 窗口里（窗口按 1970 年起整数倍对齐），每天真的只有 100 次', () => {
    const win = (ms: number) => Math.floor(ms / 1000 / QUOTA_WINDOW_S);
    const start = Date.UTC(2026, 10, 6, 0, 0);
    for (let t = start; t <= EXPIRES_AT + 86_400_000; t += 15 * 60_000) {
      // 同一个太平洋日期的前后两个时刻在同一个窗口
      const day = pacificDate(t);
      const next = t + 15 * 60_000;
      if (pacificDate(next) === day) expect(win(next), new Date(t).toISOString()).toBe(win(t));
    }
    expect(win(start)).toBe(win(EXPIRES_AT + 86_400_000));
  });
});

describe('voice-probe：源码和守门（Q1 ①⑥⑦）', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  it('handler.ts 不打印；index.ts 只有一处 console.log，只取 ProbeLog 的五个字段', () => {
    expect(read('supabase/functions/_preview/voice-probe/handler.ts')).not.toMatch(/console\./);
    const idx = read('supabase/functions/_preview/voice-probe/index.ts');
    expect(idx.match(/console\./g)).toHaveLength(1);
    expect(idx).toContain("console.log(JSON.stringify({ fn: 'voice-probe', code: e.code, mime: e.mime, bytes: e.bytes, http: e.http, ms: e.ms }))");
  });
  it('不碰数据库：不引 _shared/db.ts、不读 FN_AI_DB_URL / FN_VAULT_DB_URL；只调 take_rate', () => {
    const src = read('supabase/functions/_preview/voice-probe/index.ts') + read('supabase/functions/_preview/voice-probe/handler.ts');
    expect(src).not.toMatch(/_shared\/db\.ts|FN_AI_DB_URL|FN_VAULT_DB_URL|\.from\(/);
    expect(src).toContain('takeRate(');
  });
  it('从 ai-voice/core.ts 引进来的整条依赖链（逐个跟相对路径）：只许相对路径引用、没有动态 import；不出现 Deno、globalThis（不读环境变量、不碰文件），不建客户端，不碰网络（fetch、WebSocket 等）（安全审复核建议、代码审 S5）', () => {
    const seen = new Set<string>();
    const todo = ['supabase/functions/ai-voice/core.ts'];
    const bad: string[] = [];
    while (todo.length > 0) {
      const p = posix.normalize(todo.pop() ?? '');
      if (seen.has(p)) continue;
      seen.add(p);
      const src = read(p);
      for (const m of src.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1] ?? '';
        if (spec.startsWith('.')) todo.push(posix.join(posix.dirname(p), spec));
        else bad.push(`${p}: 非相对引用 ${spec}`);
      }
      // 代码审 S5、BE-1 安全审建议 7：链上一律不许出现下面这些整词（字符串、行尾注释里出现也算，宁可误报）：
      // • 全局对象：Deno、globalThis、self、window、Reflect、import.meta（Deno['env']、globalThis.Deno.env、把 Deno 赋给别的变量都拦得住）；
      // • 动态执行：eval(、Function(（带不带 new 都拦）、.constructor、字符串形式的 setTimeout / setInterval、动态 import(；
      // • 网络和存储：fetch（整词全禁）、WebSocket、EventSource、XMLHttpRequest、sendBeacon、Worker、indexedDB、caches、BroadcastChannel；
      // • 环境变量和数据库：process.env、createClient、postgres、@supabase/。
      // 只去掉整行的 // 注释（gemini.ts 第 8 行“fetch 注入”的说明）；整行注释里不可能有代码，行尾注释和 /* */ 不去，免得被字符串里的 // 骗过
      const BANNED = new RegExp([
        String.raw`\bDeno\b`, String.raw`\bglobalThis\b`, String.raw`\bself\b`, String.raw`\bwindow\b`, String.raw`\bReflect\b`, String.raw`\bimport\.meta\b`,
        String.raw`\beval\s*\(`, String.raw`\bFunction\s*\(`, String.raw`\.constructor\b`, String.raw`\bset(?:Timeout|Interval)\s*\(\s*['"${'`'}]`, String.raw`\bimport\s*\(`,
        String.raw`\bfetch\b`, String.raw`\bWebSocket\b`, String.raw`\bEventSource\b`, String.raw`\bXMLHttpRequest\b`, String.raw`\bsendBeacon\b`, String.raw`\bWorker\b`,
        String.raw`\bindexedDB\b`, String.raw`\bcaches\b`, String.raw`\bBroadcastChannel\b`,
        String.raw`process\.env`, String.raw`\bcreateClient\b`, String.raw`\bpostgres\b`, String.raw`@supabase/`,
      ].join('|'), 'g');
      const code = src.replace(/^[ \t]*\/\/.*$/gm, '');
      for (const m of code.matchAll(BANNED)) bad.push(`${p}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
    expect(seen.has('supabase/functions/_shared/body.ts') && seen.size >= 5).toBe(true);   // 真的跟进了依赖
  });
  it('进 PREVIEW_FUNCS，不进 PREVIEW_AI_FUNCS、PREVIEW_R2_FUNCS；没有同名顶层目录；config.toml 不声明', () => {
    const py = read('build/check_backend.py');
    const set = (name: string) => /^\s*(\S.*)$/.exec(new RegExp(`^${name} = frozenset\\((.*)\\)$`, 'm').exec(py)?.[1] ?? '')?.[1] ?? '';
    expect(set('PREVIEW_FUNCS')).toContain('"voice-probe"');
    expect(set('PREVIEW_AI_FUNCS')).not.toContain('voice-probe');
    expect(set('PREVIEW_R2_FUNCS')).not.toContain('voice-probe');
    expect(existsSync(join(ROOT, 'supabase', 'functions', 'voice-probe'))).toBe(false);
    expect(read('supabase/config.toml')).not.toContain('voice-probe');
  });
});
