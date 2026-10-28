// lemo-ops 的部署配置核对（架构 6.1、8.4）：wrangler.toml 的 cron 和代码一致、不写密钥；变量样板只有名字。
// 要读文件，放在 Node 环境的 tests/build（tests/functions 按 Workers 环境编译，没有 node:fs）。
import { readFileSync } from 'node:fs';
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

  it('.dev.vars.example 只有变量名、没有值；名字和代码要的一致', () => {
    const txt = readFileSync(join(dir, '.dev.vars.example'), 'utf8');
    const vars = txt.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
    for (const l of vars) expect(l).toMatch(/^[A-Z_0-9]+=$/);
    expect(vars.map((l) => l.slice(0, -1)).sort()).toEqual(['ALERT_FROM', 'ALERT_TO', 'OPS_SECRET', 'RESEND_API_KEY_OPS', 'SUPABASE_ANON_KEY', 'SUPABASE_URL']);
  });
});
