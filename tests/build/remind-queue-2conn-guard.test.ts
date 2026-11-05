// 两连接脚本 tools/db/remind-queue-2conn.mjs 的容器名护栏（租约出队安全复审二 R1-1）：
//   ① lemomemo 在任何环境变量组合下都拒绝（含 act 本机跑工作流时自动设的 CI、GITHUB_ACTIONS、ACT 三个都设）；
//   ② CI 用的 supabase_db_lemo-ci 放行，lemo-purgeit 在哪都拒绝，名字格式不对拒绝；
//   ③ ci.yml 的 db 任务在 supabase start 之前把 project_id 改成 lemo-ci，两连接那一步连 supabase_db_lemo-ci；
//   ④ ci.yml 里每一条 supabase stop 都带 --project-id lemo-ci，停库只在改名成功后跑（复审三 R1-2）。
// 只用 --dry：只判断容器名放不放行就退出（0 放行、2 拒绝），不连库、不调 docker。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'tools', 'db', 'remind-queue-2conn.mjs');

/** 去掉父进程里可能带着的 CI 类变量，再按 extra 设 */
function dry(container: string | null, extra: Record<string, string> = {}): number | null {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !['CI', 'GITHUB_ACTIONS', 'ACT', 'RUNNER_ENVIRONMENT'].includes(k)) env[k] = v;
  }
  const args = container === null ? [SCRIPT, '--dry'] : [SCRIPT, '--dry', container];
  return spawnSync(process.execPath, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000 }).status;
}

const ENV_COMBOS: Record<string, Record<string, string>> = {
  什么都不设: {},
  只设CI: { CI: 'true' },
  只设GITHUB_ACTIONS: { GITHUB_ACTIONS: 'true' },
  CI和GITHUB_ACTIONS: { CI: 'true', GITHUB_ACTIONS: 'true' },
  act三个都设: { CI: 'true', GITHUB_ACTIONS: 'true', ACT: 'true' },
  托管runner: { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' },
};

describe('remind-queue-2conn.mjs --dry：容器名护栏', () => {
  it('lemomemo 及其变体在任何环境变量组合下都拒绝（退出码 2）', () => {
    for (const [name, extra] of Object.entries(ENV_COMBOS)) {
      for (const c of ['supabase_db_lemomemo', 'SUPABASE_DB_LEMOMEMO', 'supabase_db_lemomemo2', 'supabase_db_x-lemomemo']) {
        expect(dry(c, extra), `${name} ${c}`).toBe(2);
      }
    }
  });

  it('lemo-purgeit 在任何环境都拒绝；名字格式不对也拒绝', () => {
    for (const [name, extra] of Object.entries(ENV_COMBOS)) expect(dry('supabase_db_lemo-purgeit', extra), name).toBe(2);
    for (const c of ['lemo-ci', 'supabase_kong_lemo-ci', 'supabase_db_lemo ci', 'supabase_db_', 'supabase_db_lemo-ci;rm']) expect(dry(c), c).toBe(2);
  });

  it('CI 用的 lemo-ci、本机的 lemo-b2push 放行（退出码 0）；不给名字时默认 lemo-b2push', () => {
    for (const [name, extra] of Object.entries(ENV_COMBOS)) {
      expect(dry('supabase_db_lemo-ci', extra), name).toBe(0);
      expect(dry('supabase_db_lemo-b2push', extra), name).toBe(0);
    }
    expect(dry(null)).toBe(0);
  });

  it('脚本里不再看 CI 类环境变量（没有按环境放行的分支）', () => {
    const src = readFileSync(SCRIPT, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/GITHUB_ACTIONS|process\.env\.CI\b|process\.env\.ACT\b/);
  });
});

describe('ci.yml：db 任务改用 lemo-ci', () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('supabase start 之前把 project_id 从 lemomemo 改成 lemo-ci，并核对改成了', () => {
    const sed = ci.indexOf(`sed -i 's/^project_id = "lemomemo"$/project_id = "lemo-ci"/' supabase/config.toml`);
    const start = ci.indexOf('run: supabase start');
    expect(sed).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(sed);
    expect(ci.slice(sed, start)).toContain(`grep -qx 'project_id = "lemo-ci"' supabase/config.toml`);
  });

  it('每一条 supabase stop 都带 --project-id lemo-ci，停库那一步只在改名成功后跑（租约出队安全复审三 R1-2）', () => {
    const stops = ci.split('\n').filter((l) => /supabase\s+stop\b/.test(l) && !/^\s*#/.test(l));
    expect(stops.length).toBeGreaterThan(0);
    for (const l of stops) expect(l, l).toMatch(/supabase\s+stop\b.*--project-id lemo-ci(\s|$)/);
    expect(ci).toMatch(/id: sb-rename\n/);
    const i = ci.indexOf('supabase stop --no-backup --project-id lemo-ci');
    const step = ci.slice(ci.lastIndexOf('- name:', i), i);
    expect(step).toContain("if: always() && steps.sb-rename.outcome == 'success'");
    // 改名那一步正是带 id sb-rename 的那一步
    const rename = ci.indexOf('id: sb-rename');
    expect(ci.slice(ci.lastIndexOf('- name:', rename), ci.indexOf('- name:', rename))).toContain('project_id = "lemo-ci"');
  });

  it('两连接那一步连 supabase_db_lemo-ci；工作流里不再有连 supabase_db_lemomemo 或按 config.toml 拼容器名的写法', () => {
    expect(ci).toContain('node tools/db/remind-queue-2conn.mjs supabase_db_lemo-ci');
    expect(ci).not.toMatch(/supabase_db_lemomemo|supabase_db_\$\{pid\}/);
  });
});
