// 两连接脚本 tools/db/remind-queue-2conn.mjs 的容器名护栏（租约出队安全复审二 R1-1）：
//   ① lemomemo 在任何环境变量组合下都拒绝（含 act 本机跑工作流时自动设的 CI、GITHUB_ACTIONS、ACT 三个都设）；
//   ② CI 用的 supabase_db_lemo-ci 放行，lemo-purgeit 在哪都拒绝，名字格式不对拒绝；
//   ③ ci.yml 的 db 任务在 supabase start 之前把 project_id 改成 lemo-ci，两连接那一步连 supabase_db_lemo-ci；
//   ④ ci.yml 里每一条 supabase stop 都带 --project-id lemo-ci，停库只在改名成功后跑（复审三 R1-2）。
// 只用 --dry：只判断容器名放不放行就退出（0 放行、2 拒绝），不连库、不调 docker。
// ⑤ 11-05“不等锁”的判定口径（2b65b43 的 CI 报 5883 毫秒、lemo-e2e 复现不出）：按服务器上的耗时和“在持锁方提交之前结束”判，不按 docker exec 的墙钟；
//   迁移 20261104130000 里出队、finish 的 4 处 for update 都带 skip locked（真等锁只有两连接脚本测得出：PGlite、pgTAP 都只有一个会话，造不出另一个事务持锁）。
// ⑥ 安全复审五：R5-1 持锁方时刻在 commit 之前取、另一边开始得晚报“起晚了”；R5-2 经目录联接（符号链接）调用脚本时护栏照样生效，CI 核对输出里有“全部通过”。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { noWaitVerdict } from '../../tools/db/remind-queue-2conn-verdict.mjs';

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
    // R5-2：退出码之外核对输出里有“全部通过”（脚本静默退出 0 也算失败）
    const step = ci.slice(ci.indexOf('node tools/db/remind-queue-2conn.mjs supabase_db_lemo-ci'), ci.indexOf('- name:', ci.indexOf('node tools/db/remind-queue-2conn.mjs supabase_db_lemo-ci')));
    expect(step).toContain('rc=${PIPESTATUS[0]}');
    expect(step).toContain("grep -qx '全部通过' 2conn.log");
    expect(ci).not.toMatch(/supabase_db_lemomemo|supabase_db_\$\{pid\}/);
  });
});

describe('remind-queue-2conn.mjs：“不等锁”按服务器上的证据判', () => {
  const C = 1_000_000;
  it('持锁方提交之前就结束、服务器上耗时短：不等锁（墙钟多长都不管）', () => {
    expect(noWaitVerdict({ startAt: C - 3010, serverMs: 6, endAt: C - 3000, holderCommitAt: C }).ok).toBe(true);
  });
  it('持锁方提交以后才结束：等了它的锁（哪怕只晚 1 毫秒）', () => {
    const v = noWaitVerdict({ startAt: C - 900, serverMs: 901, endAt: C + 1, holderCommitAt: C });
    expect(v).toMatchObject({ ok: false, late: false });
    expect(v.why).toMatch(/提交以后才结束/);
  });
  it('服务器上耗时 1 秒以上：不算不等锁（兜住“持锁方提交时刻量晚了”的情况）', () => {
    expect(noWaitVerdict({ startAt: C - 3431, serverMs: 3430, endAt: C - 1, holderCommitAt: C }).ok).toBe(false);
  });
  it('没拿到服务器时刻（psql 出错、输出格式不对）：不通过', () => {
    expect(noWaitVerdict({ startAt: C - 1, serverMs: Number.NaN, endAt: C, holderCommitAt: C + 1 }).ok).toBe(false);
    expect(noWaitVerdict({ startAt: C - 1, serverMs: 1, endAt: C, holderCommitAt: Number.NaN }).ok).toBe(false);
    expect(noWaitVerdict({ startAt: Number.NaN, serverMs: 1, endAt: C, holderCommitAt: C + 1 }).ok).toBe(false);
  });
  it('R5-1 ① 去掉 skip locked 的回归：等锁的语句在持锁方 commit 前取的时刻之后才结束，哪怕只晚 1 毫秒也判等锁', () => {
    // 持锁方 sleep 完在 C 取时刻、随后 commit 放锁；等锁的语句放锁后几毫秒结束，服务器上耗时只有 800 毫秒（语句开始得晚）
    const v = noWaitVerdict({ startAt: C - 800, serverMs: 801, endAt: C + 1, holderCommitAt: C });
    expect(v).toMatchObject({ ok: false, late: false });
  });
  it('R5-1 ② 另一边在持锁方提交之后才开始（CI 起 psql 慢）：单独报“起晚了，这一轮没测到”，不算通过、也不说成等锁', () => {
    for (const startAt of [C, C + 1, C + 5000]) {
      const v = noWaitVerdict({ startAt, serverMs: 3, endAt: startAt + 3, holderCommitAt: C });
      expect(v).toMatchObject({ ok: false, late: true });
      expect(v.why).toMatch(/起晚了/);
      expect(v.why).not.toMatch(/等了它的锁/);
    }
  });
  it('脚本不再按墙钟判（r.ms 只出现在打印里）；持锁方进了 pg_sleep 才让另一边动手', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/check\(\s*r\.ms\s*</);
    expect(src.match(/waitSleeping\(/g)?.length).toBeGreaterThanOrEqual(3);
  });
  it('R5-1：两个场景都持锁 7 秒，持锁方的时刻在 commit 之前、sleep 之后取；另一边传回语句开始时刻', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const holders = src.match(/select pg_sleep\((\d+)\) \/\* 2conn-holder \*\/; select \$\{NOW_MS\}; commit;/g) ?? [];
    expect(holders).toHaveLength(2);
    for (const h of holders) expect(h).toContain('pg_sleep(7)');
    expect(src).not.toMatch(/commit; select \$\{NOW_MS\}/);
    expect(src.match(/\$\{STMT_MS\} \|\| '\|' \|\| \$\{START_MS\} \|\| '\|' \|\| \$\{NOW_MS\}/g)).toHaveLength(2);
  });
  it('R5-2：脚本直接调 main()，不再比 import.meta.url 和 argv[1]', () => {
    const src = readFileSync(SCRIPT, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/^await main\(\);$/m);
    expect(src).not.toMatch(/import\.meta\.url|pathToFileURL/);
  });
  it('R5-2：经目录联接（符号链接）调用脚本，lemomemo 照样拒绝（退出码 2）、lemo-ci 照样放行；测完只删链接', () => {
    const dir = mkdtempSync(join(tmpdir(), '2conn-link-'));
    const link = join(dir, 'db');
    symlinkSync(join(ROOT, 'tools', 'db'), link, 'junction');
    try {
      const run = (c: string) => spawnSync(process.execPath, [join(link, 'remind-queue-2conn.mjs'), '--dry', c], { encoding: 'utf8', timeout: 20_000 });
      const bad = run('supabase_db_lemomemo');
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain('拒绝');
      const ok = run('supabase_db_lemo-ci');
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('放行');
    } finally {
      unlinkSync(link);
      rmdirSync(dir);
    }
  });
  it('迁移 20261104130000 的出队、finish 里每一处 for update 都带 skip locked（共 4 处）', () => {
    const sql = readFileSync(join(ROOT, 'supabase', 'migrations', '20261104130000_core_remind_queue_lease.sql'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const body = sql.slice(sql.indexOf('create function private.remind_queue_pop('), sql.indexOf('create or replace function private.enqueue_remind('));
    const fors = body.match(/for update of \w+[^;]*?(?=\)|$)/gm) ?? [];
    expect(body.length).toBeGreaterThan(1000);
    expect(fors).toHaveLength(4);
    for (const f of fors) expect(f).toMatch(/for update of \w+ skip locked/);
  });
});
