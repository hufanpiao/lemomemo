// e2e 看门狗怎么起命令（接手清单 E2E-watchdog-sugg，10-30 第八批，从 e2e-watchdog.test.ts 拆出免超 300 行）：
// • 不经 shell 起 .cmd/.bat（cmd.exe 转义风险，CVE-2024-27980 一类）；npx playwright、npx -y / --yes playwright 认作 playwright，
//   换成 node + @playwright/test 的 cli.js；带 @版本、--package=、大写 NPX 的照旧不认
// • 拉不起命令时 spawnHint 给中文提示：ENOENT 说明不经 shell，Windows 上点明 .cmd/.bat 起不来、该怎么写；别的错误原样带出
// • 真起一次不存在的命令：退出码 1、打印提示。经 run-watchdog.mjs 的 child_process 起进程，tests/arch/coverage.test.ts 认作重型，
//   要登记在 vitest.config.ts 的 SLOW_NODE_TESTS
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { resolveCommand, runWatchdog, spawnHint } from '../../tools/e2e/run-watchdog.mjs';

function sink(): { stream: Writable; text: () => string } {
  let buf = '';
  const stream = new Writable({ write: (chunk: Buffer, _enc, cb) => void ((buf += chunk.toString()), cb()) });
  return { stream, text: () => buf };
}

describe('run-watchdog 起命令', () => {
  it('npx playwright、npx -y playwright、npx --yes playwright 和 playwright 一样换成 node + cli.js；参数原样', () => {
    const pw = resolveCommand(['playwright', 'test', '--list']);
    expect(pw.file).toBe(process.execPath);
    for (const pre of [['npx'], ['npx', '-y'], ['npx', '--yes']]) {
      expect(resolveCommand([...pre, 'playwright', 'test', '--list']), pre.join(' ')).toEqual(pw);
    }
  });

  it('带 @版本、--package=、大写 NPX、别的 npx 命令、-y 之外的旗标都不代换，原样交给系统（起不来时有提示）', () => {
    for (const cmd of [
      ['npx', 'playwright@1.50.0', 'test'],
      ['npx', '-y', 'playwright@latest', 'test'],
      ['npx', '--package=playwright', 'playwright', 'test'],
      ['npx', '--package=@playwright/test', 'playwright', 'test'],
      ['NPX', 'playwright', 'test'],
      ['npx', '--no-install', 'playwright', 'test'],
      ['npx', '-y', '-y', 'playwright', 'test'],
      ['npx', 'vitest', 'run'],
    ]) {
      expect(resolveCommand(cmd), cmd.join(' ')).toEqual({ file: cmd[0], args: cmd.slice(1) });
    }
  });

  it('拉不起命令的提示：ENOENT 说明不经 shell；Windows 上点明 .cmd/.bat 起不来、该怎么写；别的错误原样带出', () => {
    const win = spawnHint({ code: 'ENOENT', message: 'spawn npx ENOENT' }, 'npx', 'win32');
    for (const t of ['找不到命令 npx（看门狗不经 shell 起命令）', '.cmd/.bat', '请直接写 playwright …']) expect(win).toContain(t);
    expect(spawnHint({ code: 'ENOENT', message: 'x' }, 'foo', 'linux')).toBe('找不到命令 foo（看门狗不经 shell 起命令）：确认它在 PATH 里，或写完整路径');
    expect(spawnHint({ code: 'EACCES', message: 'spawn foo EACCES' }, 'foo', 'win32')).toBe('拉不起命令：spawn foo EACCES');
  });

  it('真起一次不存在的命令：退出码 1，打印找不到命令的中文提示，不转发任何输出', { timeout: 30_000 }, async () => {
    const out = sink();
    const err = sink();
    const code = await runWatchdog({ command: ['lemo-no-such-cmd-e2e', 'x'], silenceMs: 60_000, out: out.stream, err: err.stream });
    expect(code).toBe(1);
    expect(err.text()).toContain('run-watchdog：找不到命令 lemo-no-such-cmd-e2e（看门狗不经 shell 起命令）');
    expect(out.text()).toBe('');
  });
});
