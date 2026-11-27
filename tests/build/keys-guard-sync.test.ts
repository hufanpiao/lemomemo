// 处理密钥的 PowerShell 脚本开头的“安全窗口检查”（B0 安全审查低 5、中 2 第 4 点）：原来十二个脚本各抄一份、这里逐字比对，
// B7a 评审第 16 条起收成一份 tools/keys/safe-window.ps1，各脚本点引用。这里核：
//   ① 共用文件查的东西都在（剪贴板历史、三种日志策略、本窗口的 transcript），撤掉的 Claude 检查（R-223、R-298）不再留着；
//   ② FILES 里每个脚本都点引用了它（找不到就停下）、自己不再抄一份、点引用之后真的调用了 Assert-NoRecording；
//   ③ tools 下调用 Assert-NoRecording 的脚本都在 FILES 里（新加密钥脚本漏登记、漏点引用就在这里红）；
//   ④ publish.ps1 例外：它从冻结副本单独运行、只核对自己这一个文件的哈希，不能点引用别的文件（B7a 第三轮审查高 1），
//      改成内联一份，这里核内联的两个函数和共用文件一字不差、整个脚本不点引用任何文件。
// 只读文本，不运行脚本（各脚本的运行测试会真的点引用它）
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const FILES = ['tools/keys/new-proxy-secret.ps1', 'tools/keys/set-r2-tokens.ps1', 'tools/keys/set-fn-role-passwords.ps1', 'tools/release/publish.ps1', 'tools/keys/login-token-tests.ps1', 'tools/keys/set-cron-secret.ps1', 'tools/keys/set-signup-secrets.ps1', 'tools/keys/set-vapid-keys.ps1', 'tools/keys/gen-tauri-key.ps1', 'tools/keys/gen-vault-keys.ps1', 'tools/keys/check-vault-keys-leak.ps1', 'tools/keys/new-ops-secret.ps1', 'tools/keys/set-backup-pull-token.ps1', 'tools/backup/pull.ps1'];
const SHARED = 'tools/keys/safe-window.ps1';
/** 内联一份、不点引用的（从冻结副本单独运行） */
const INLINE = ['tools/release/publish.ps1'];
const DOT = FILES.filter((f) => !INLINE.includes(f));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8').replace(/^\uFEFF/u, '');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 点引用的三行：路径按脚本所在目录算（publish.ps1 在 tools/release，往上一层进 keys） */
function dotSource(rel: string): RegExp {
  const path = rel.startsWith('tools/keys/') ? "'safe-window.ps1'" : "'..\\keys\\safe-window.ps1'";
  return new RegExp([
    `^\\$SafeWindow = Join-Path \\$PSScriptRoot ${esc(path)}$`,
    `^if \\(-not \\(Test-Path -LiteralPath \\$SafeWindow -PathType Leaf\\)\\) \\{ throw "[^"\\n]+" \\}$`,
    '^\\. \\$SafeWindow$',
  ].join('\\n'), 'm');
}

describe('密钥脚本的安全窗口检查', () => {
  it('共用文件：查剪贴板历史、三种日志策略、本窗口 transcript；不再有 Claude 检查；UTF-8 BOM、只有 LF', () => {
    const raw = readFileSync(join(root, SHARED));
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.includes(0x0d)).toBe(false);
    const b = read(SHARED);
    for (const s of ['function Test-PolicyOn', 'function Assert-NoRecording', 'EnableClipboardHistory', 'EnableTranscripting', 'EnableModuleLogging', 'EnableScriptBlockLogging', 'Stop-Transcript']) {
      expect(b).toContain(s);
    }
    expect(b).not.toMatch(/function Assert-NoClaude|Get-CimInstance|-like 'claude\*'/);
    // 只定义函数，点引用时不执行任何检查（调用时机由各脚本定）
    const code = b.split('\n').filter((l) => !/^\s*#/.test(l) && l.trim() !== '');
    expect(code.filter((l) => /^\S/.test(l) && !/^(function |\})/.test(l))).toEqual([]);
  });

  it('publish.ps1 内联的两个函数和共用文件一字不差；整个脚本不点引用任何文件；内联之后真的调用了 Assert-NoRecording', () => {
    const shared = read(SHARED);
    const body = shared.slice(shared.indexOf('function Test-PolicyOn')).trimEnd();
    for (const f of INLINE) {
      const text = read(f);
      const at = text.indexOf(body);
      expect(at, `${f} 内联的安全窗口检查和 ${SHARED} 不一样`).toBeGreaterThan(-1);
      expect(text.indexOf(body, at + 1), f).toBe(-1);
      expect(text, f).not.toMatch(/^\s*\.\s+\S/m);
      expect(text, f).not.toContain('safe-window.ps1\'');
      expect(text.slice(at + body.length), f).toMatch(/^\s*Assert-NoRecording\s*$/m);
    }
  });

  it('每个脚本都点引用共用文件（找不到就停下）、自己不再抄一份、之后真的调用了 Assert-NoRecording', () => {
    for (const f of DOT) {
      const text = read(f);
      const m = dotSource(f).exec(text);
      expect(m, `${f} 没有按约定点引用 ${SHARED}`).not.toBeNull();
      expect(text.match(/^\. \$SafeWindow$/gm)?.length, f).toBe(1);
      expect(text, f).not.toMatch(/^function (Test-PolicyOn|Assert-NoRecording|Assert-NoClaude)\b/m);
      expect(text, f).not.toContain('# ==== 安全窗口检查：开始');
      const rest = text.slice((m?.index ?? 0) + (m?.[0].length ?? 0));
      expect(rest, f).toMatch(/^\s*Assert-NoRecording\s*$/m);
      expect(rest, f).not.toMatch(/^\s*Assert-NoClaude\s*$/m);
    }
  });

  it('tools 下调用 Assert-NoRecording 的脚本都在名单里', () => {
    const found: string[] = [];
    for (const dir of ['tools/keys', 'tools/release', 'tools/backup']) {
      for (const n of readdirSync(join(root, dir)).filter((x) => x.endsWith('.ps1'))) {
        const rel = `${dir}/${n}`;
        if (rel !== SHARED && /^\s*Assert-NoRecording\s*$/m.test(read(rel))) found.push(rel);
      }
    }
    expect(found.sort()).toEqual([...FILES].sort());
  });
});
