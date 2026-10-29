// lemo-ops 的部署配置核对（架构 6.1、8.4）：wrangler.toml 的 cron 和代码一致、不写密钥；变量样板只有名字。
// 要读文件，放在 Node 环境的 tests/build（tests/functions 按 Workers 环境编译，没有 node:fs）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..', '..', 'workers', 'lemo-ops');
// 不 import index.ts（它用 Workers 的类型，Node 这份 tsconfig 没有），按文本取两个常量
const src = readFileSync(join(dir, 'src', 'index.ts'), 'utf8');
const constOf = (name: string) => new RegExp(`export const ${name} = '([^']+)'`).exec(src)?.[1];
const CRON_HEARTBEAT = constOf('CRON_HEARTBEAT');
const CRON_DAILY = constOf('CRON_DAILY');

describe('lemo-ops 部署配置', () => {
  it('wrangler.toml 的 cron 和代码里的一致；KV ID 是占位、不含密钥', () => {
    const toml = readFileSync(join(dir, 'wrangler.toml'), 'utf8');
    const crons = /crons\s*=\s*\[([^\]]*)\]/.exec(toml)?.[1] ?? '';
    expect(CRON_HEARTBEAT).toBe('*/15 * * * *');
    expect(crons.split(',').map((s) => s.trim().replace(/^"|"$/g, ''))).toEqual([CRON_HEARTBEAT, CRON_DAILY]);
    expect(toml).toContain('id = "REPLACE_WITH_KV_NAMESPACE_ID"');
    expect(toml).toMatch(/^workers_dev = false/m);
    expect(toml).not.toMatch(/^\s*(OPS_SECRET|RESEND_API_KEY_OPS|SUPABASE_ANON_KEY|SUPABASE_URL|ALERT_TO|ALERT_FROM)\s*=/m);
    expect(toml).not.toMatch(/re_[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{10,}/);
  });

  it('R-261：wrangler.toml 开着 observability（Workers Logs），面板上看得到发信失败的错误码', () => {
    const toml = readFileSync(join(dir, 'wrangler.toml'), 'utf8');
    // 取 [observability] 这一节（到下一个 [ 开头的行为止），里面必须有 enabled = true，且没有 enabled = false
    const sec = /^\[observability\]\s*\r?\n((?:(?!\[).*\r?\n?)*)/m.exec(toml)?.[1];
    expect(sec).toBeDefined();
    expect(sec).toMatch(/^enabled\s*=\s*true\s*(#.*)?$/m);
    expect(sec).not.toMatch(/^enabled\s*=\s*false/m);
    // 采样不能调到 0（等于关掉）
    expect(sec ?? '').not.toMatch(/^head_sampling_rate\s*=\s*0(\.0*)?\s*$/m);
    // traces 明确关着：[observability.traces] 这一节里 enabled = false，且没有 enabled = true
    const traces = /^\[observability\.traces\]\s*\r?\n((?:(?!\[).*\r?\n?)*)/m.exec(toml)?.[1];
    expect(traces).toBeDefined();
    expect(traces).toMatch(/^enabled\s*=\s*false\s*(#.*)?$/m);
    expect(traces).not.toMatch(/^enabled\s*=\s*true/m);
    // 也不许用点号写法在别处把它打开
    expect(toml).not.toMatch(/^\s*(observability\.)?traces\.enabled\s*=\s*true/m);
  });

  it('R-261：开了日志，src/ 里只有一处 console 输出，只打固定前缀加错误码（不打印收件人、正文、请求和响应）', () => {
    const files = readdirSync(join(dir, 'src')).filter((f) => f.endsWith('.ts')).sort();
    expect(files).toEqual(expect.arrayContaining(['alerts.ts', 'http.ts', 'index.ts', 'mail-fail.ts', 'rules.ts']));
    const hits = files.flatMap((f) => {
      const t = readFileSync(join(dir, 'src', f), 'utf8');
      return [...t.matchAll(/console\.\w+\(.*$/gm)].map((m) => `${f}: ${m[0]}`);
    });
    expect(hits).toEqual(['index.ts: console.error(`lemo-ops: ${code}`);']);
    // log(...) 的实参只能是字符串字面量（错误码），或 runScheduled 里那一处（配置错只含变量名、其他只含错误类型名）
    for (const f of files) {
      const t = readFileSync(join(dir, 'src', f), 'utf8');
      for (const m of t.matchAll(/\blog\??\.?\(([^)]*)\)/g)) {
        const arg = m[1] ?? '';
        if (/^'[a-z0-9_:]+'$/.test(arg)) continue;
        expect(`${f}: ${arg}`).toBe("index.ts: e instanceof Error && e.message.startsWith('lemo-ops 配置'");
      }
    }
    const idx = readFileSync(join(dir, 'src', 'index.ts'), 'utf8');
    expect(idx).toContain("log(e instanceof Error && e.message.startsWith('lemo-ops 配置') ? e.message : `运行出错：${e instanceof Error ? e.name : 'unknown'}`);");
  });

  it('.dev.vars.example 只有变量名、没有值；名字和代码要的一致', () => {
    const txt = readFileSync(join(dir, '.dev.vars.example'), 'utf8');
    const vars = txt.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
    for (const l of vars) expect(l).toMatch(/^[A-Z_0-9]+=$/);
    expect(vars.map((l) => l.slice(0, -1)).sort()).toEqual(['ALERT_FROM', 'ALERT_TO', 'OPS_SECRET', 'RESEND_API_KEY_OPS', 'SUPABASE_ANON_KEY', 'SUPABASE_URL']);
  });
});
