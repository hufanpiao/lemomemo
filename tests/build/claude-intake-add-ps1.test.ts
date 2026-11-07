// tools/claude-intake/add.ps1（架构 5.7；S-B3 中 6；TC-B3-21：脚本自己从凭据管理器读码，命令行和输出里都没有连接码）。
// 只读源码做静态核对，不起 PowerShell（端到端已用假码和 127.0.0.1 上的假服务器跑过，见 B3 后端回报）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_TEXT_MAX } from '../../shared/schema/ai.ts';
import { TOKEN_RE } from '../../supabase/functions/_shared/intake-token.ts';
import { MAX_BODY } from '../../supabase/functions/claude-intake/core.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const RAW = readFileSync(join(ROOT, 'tools', 'claude-intake', 'add.ps1'));
const SRC = RAW.toString('utf8');
/** 去掉 <# … #> 块注释和 # 行注释（字符串里的 # 不多见，这里只用来查代码） */
const CODE = SRC.replace(/<#[\s\S]*?#>/g, '').replace(/^\s*#.*$/gm, '');
const constOf = (name: string) => new RegExp(`^\\$${name}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, 'm').exec(CODE)?.[1];

describe('add.ps1', () => {
  it('UTF-8 带 BOM（Windows PowerShell 5.1 才认得出中文）', () => {
    expect([...RAW.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
  it('地址写死 lemomemo.com/sb；常量和服务器一致（码格式、2000 字、32 KB）', () => {
    expect(constOf('Endpoint')).toBe("'https://lemomemo.com/sb/functions/v1/claude-intake'");
    expect(constOf('TokenPattern')).toBe(`'${TOKEN_RE.source}'`);
    expect(constOf('TextMax')).toBe(String(AI_TEXT_MAX));
    expect(constOf('BodyMaxBytes')).toBe(`${MAX_BODY / 1024}KB`);
    expect(constOf('CredTarget')).toBe("'lemomemo.claude.intake'");
  });
  it('自测地址只认 127.0.0.1:8840～8849，换地址时连凭据名一起换成 .test', () => {
    const m = /\$testEp -match '([^']+)'/.exec(CODE);
    expect(m?.[1]).toBe('^http://127\\.0\\.0\\.1:884[0-9]/[A-Za-z0-9/_-]*$');
    const re = new RegExp(m?.[1] ?? '$^');
    for (const ok of ['http://127.0.0.1:8841/functions/v1/claude-intake']) expect(re.test(ok)).toBe(true);
    for (const bad of ['https://evil.example/x', 'http://127.0.0.1:9000/x', 'http://127.0.0.1.evil:8841/x', 'http://localhost:8841/x', 'http://127.0.0.1:8841/x?y=1']) expect(re.test(bad), bad).toBe(false);
    expect(CODE).toContain("$CredTarget = 'lemomemo.claude.intake.test'");
  });
  it('连接码不进命令行、不进输出：不用 cmdkey，参数里没有码；-Setup 用 Read-Host -AsSecureString；$token 只用来拼请求头', () => {
    expect(/cmdkey/i.test(CODE)).toBe(false);
    const params = /param\(([\s\S]*?)\n\)/.exec(CODE)?.[1] ?? '';
    expect(params).not.toMatch(/token|code|key/i);
    expect(CODE).toContain('Read-Host -AsSecureString');
    // 安全审建议 4：-Setup 结束提示清 Win+V 剪贴板历史（粘贴进来的码会留在那里）
    expect(CODE).toMatch(/Win\+V.*剪贴板历史/);
    const uses = CODE.split('\n').filter((l) => /\$token\b/.test(l)).map((l) => l.trim());
    expect(uses).toEqual([
      '$token = [LemoClaudeCred]::Read($CredTarget)',
      'if ($null -eq $token -or $token -notmatch $TokenPattern) {',
      '$headers = @{ Authorization = "Bearer $token"; \'X-App-Version\' = $AppVersion }',
      '$token = $null',
    ]);
    expect(/Write-(Output|Host|Verbose|Debug)[^\n]*\$(token|code|headers)/i.test(CODE)).toBe(false);
  });
  it('只发 POST，只发一处', () => {
    expect(CODE.match(/Invoke-(WebRequest|RestMethod)/g)).toEqual(['Invoke-WebRequest']);
    expect(CODE).toMatch(/Invoke-WebRequest -Uri \$Endpoint -Method Post /);
  });
});
