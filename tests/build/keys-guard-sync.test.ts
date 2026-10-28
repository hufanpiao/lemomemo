// 处理密钥的 PowerShell 脚本开头的“安全窗口检查”必须逐字相同（B0 安全审查低 5、中 2 第 4 点；10-28 加上 set-fn-role-passwords.ps1，共四个）：
// 改了一处忘了别的，就会有脚本漏查（例如只按进程名 claude* 判断，漏掉以 node 运行的 Claude）
// 只读文本，不运行脚本
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const FILES = ['tools/keys/new-proxy-secret.ps1', 'tools/keys/set-r2-tokens.ps1', 'tools/keys/set-fn-role-passwords.ps1', 'tools/release/publish.ps1'];
const BEGIN = '# ==== 安全窗口检查：开始';
const END = '# ==== 安全窗口检查：结束 ====';

function block(rel: string): string {
  const text = readFileSync(join(root, rel), 'utf8').replace(/^\uFEFF/u, '');
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  expect(a, `${rel} 没有检查段的开头`).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(BEGIN, a + 1), `${rel} 检查段出现了不止一次`).toBe(-1);
  expect(b, `${rel} 没有检查段的结尾`).toBeGreaterThan(a);
  return text.slice(a, b + END.length);
}

describe('密钥脚本的安全窗口检查', () => {
  it('各脚本逐字相同', () => {
    const [first, ...rest] = FILES.map(block);
    for (const [i, b] of rest.entries()) expect(b, FILES[i + 1]).toBe(first);
  });

  it('查 claude* 进程名、node.exe 命令行（claude-code / @anthropic-ai）和三种日志策略', () => {
    const b = block('tools/keys/new-proxy-secret.ps1');
    for (const s of ["-like 'claude*'", "Name = 'node.exe'", 'claude-code|@anthropic-ai', 'EnableTranscripting', 'EnableModuleLogging', 'EnableScriptBlockLogging', 'Stop-Transcript', 'EnableClipboardHistory']) {
      expect(b).toContain(s);
    }
  });

  // 10-29 负责人定（R-223）：撤掉“不能有 Claude 在运行”的检查，只剩防录屏
  it('每个脚本都真的调用了防录屏检查', () => {
    for (const f of FILES) {
      const text = readFileSync(join(root, f), 'utf8');
      const rest = text.slice(text.indexOf(END) + END.length);
      expect(rest, f).not.toMatch(/^\s*Assert-NoClaude\s*$/m);
      expect(rest, f).toMatch(/^\s*Assert-NoRecording\s*$/m);
    }
  });
});
