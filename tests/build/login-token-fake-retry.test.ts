// login-token-fake.ts 的 runScript（重跑逻辑在 pwsh-crash.ts）遇到 pwsh 自身启动崩溃（.NET FileLoadException，CI runner 上偶发）时整次重跑一遍：
// 用假的 spawn 模拟崩溃一次后成功、连着崩两次、普通的脚本失败（不该重跑），不真的起 pwsh
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runScript } from './login-token-fake.ts';
import { PWSH_CRASH, PWSH_CRASH_MESSAGE } from './pwsh-crash.ts';

// 10-31 c935906 那次 CI 的 stderr 开头就是这个样子
const CRASH = "Unhandled exception. System.IO.FileLoadException: Could not load file or assembly 'System.Management.Automation'.\n   at ...";

type Shot = { out?: string; err?: string; code: number | null };
type SpawnPs = NonNullable<Parameters<typeof runScript>[2]>;

/** 按顺序每次 spawn 吐一份 stdout/stderr、再以 code 结束；记下调了几次 */
function fakeSpawn(shots: Shot[]): { spawnPs: SpawnPs; calls: () => number } {
  let n = 0;
  const spawnPs = (() => {
    const shot = shots[n++] ?? { code: 0 };
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    setImmediate(() => {
      child.stdout.end(shot.out ?? '');
      child.stderr.end(shot.err ?? '');
      setImmediate(() => child.emit('close', shot.code));
    });
    return child;
  }) as unknown as SpawnPs;
  return { spawnPs, calls: () => n };
}

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'login-token-retry-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('pwsh 自身崩溃时整次重跑', () => {
  it('只认 stderr 里 Unhandled exception 和 System.IO.FileLoadException 同时出现', () => {
    expect(PWSH_CRASH.test(CRASH)).toBe(true);
    expect(PWSH_CRASH.test('Unhandled exception. System.NullReferenceException')).toBe(false);
    expect(PWSH_CRASH.test('test: 明文输入用完了（System.IO.FileLoadException）')).toBe(false);
  });

  it('崩一次后重跑成功：返回第二次的结果，断言只看它', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeSpawn([{ err: CRASH, code: null }, { out: '第二次的输出', code: 0 }]);
    const r = await runScript(dir(), { plain: [], secure: [] }, f.spawnPs);
    expect(f.calls()).toBe(2);
    expect(r.code).toBe(0);
    expect(r.out).toBe('第二次的输出');
    expect(r.err).toBe('');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(PWSH_CRASH_MESSAGE));
  });

  it('连着崩两次：报明确的提示，不当成脚本失败', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeSpawn([
      { err: CRASH, code: null },
      { err: CRASH, code: null },
    ]);
    await expect(runScript(dir(), { plain: [], secure: [] }, f.spawnPs)).rejects.toThrow(
      'pwsh 自身崩溃（.NET FileLoadException），不是脚本问题：连着两次都在启动时崩了',
    );
    expect(f.calls()).toBe(2);
  });

  it('普通的脚本失败不重跑，原样返回', async () => {
    const f = fakeSpawn([{ err: 'test: 明文输入用完了（邮箱）', code: 1 }]);
    const r = await runScript(dir(), { plain: [], secure: [] }, f.spawnPs);
    expect(f.calls()).toBe(1);
    expect(r.code).toBe(1);
    expect(r.err).toContain('明文输入用完了');
  });
});
