// tools/keys/gen-tauri-key.ps1 的测试（B6-exe F10）：不生成真私钥、不调真的签名工具、不碰真的剪贴板和密码管理器。
// 假签名工具 tests/build/gen-tauri-key-fake-signer.cs 在临时目录里编成 cargo-tauri.exe（固定花纹的假字节，不是能用的密钥），
// 假锁文件里写它的 SHA-256；Read-Host、Set-Clipboard、注册表、进程和磁盘检查都在外壳脚本里换成假的，“U 盘”换成临时目录。
// 剪贴板（F10 安全审查 M4、代码审查 M5）：测试模式下脚本只调 Set-Clipboard（外壳里是假的，只记事件），不调 Forms 的 Clipboard::Clear()、
// 不调 WinRT 的 ClearHistory()，不会清掉开发机的剪贴板和剪贴板历史；正式运行时这三步都在，由静态检查锁住。
// 本文件里没有任何一条用例不带 LEMO_TEST_SIGNER=1 去跑到脚本主流程（“拒绝的运行方式”几条都停在主流程之前）。
// ① 静态：参数只有 signer generate、不带 --password / --write-keys / --ci；剪贴板只放私钥或清空、带三个排除标记；清剪贴板的三步；
//    U 盘只新建不覆盖、刷到盘上；子进程环境变量白名单、工作目录；安全窗口检查真的调用了（不查 Claude，R-298）；仓库锁文件里 tauri-signer 那一行（11-13 起已写）
// ② 从头跑到尾：预览只进剪贴板一次、核对粘贴、打印公钥；正式另写 U 盘并读回核对、不覆盖旧文件；练习模式什么都不留；
//    屏幕和报错里从来没有私钥；子进程只拿到白名单里的环境变量
// ③ 出错路径：空密码（<empty>）、私钥没加密（兼容兜底）、key id 对不上、输出格式不对、签名工具出错（报错里的 base64 被遮住）、
//    哈希不对、锁文件没有这一行、核对粘贴连续对不上、120 秒没按回车、按回车那一步 Ctrl+C
// ④ 拒绝运行：点源、& 调用、测试开关用法不对、测试路径不在 %TEMP%、预览带 U 盘、正式不带 U 盘、U 盘不对、
//    剪贴板历史或跨设备共享开着、CI 设着；开头检查没过时事件里没有任何 clip: 记录
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PS, q, root, writePs } from './login-token-fake.ts';

// 只在 Windows 上真跑：脚本只给负责人在 Windows 上用；Linux 上的 pwsh 编不了假签名工具（Add-Type 不支持 ConsoleApplication，65af126 的 unit 因此失败）
const RUN = Boolean(PS) && process.platform === 'win32';

const SCRIPT = join(root, 'tools', 'keys', 'gen-tauri-key.ps1');
const FINALLY = '已清剪贴板、清掉内存里的变量';
const FINALLY_UNTOUCHED = '没放过私钥，剪贴板没动过';
const text = readFileSync(SCRIPT, 'utf8');
/** 只看代码：去掉开头的帮助块和 # 注释 */
const code = text
  .replace(/<#[\s\S]*?#>/, '')
  .split('\n')
  .map((l) => l.replace(/^\s*#.*$/, '').replace(/\s#\s.*$/, ''))
  .join('\n');
/** 取一个函数（从 function 那一行到下一行顶格的 } 为止） */
const fnBody = (name: string) => {
  const a = code.indexOf(`function ${name}`);
  expect(a, `找不到 function ${name}`).toBeGreaterThanOrEqual(0);
  const rest = code.slice(a);
  return rest.slice(0, rest.indexOf('\n}\n'));
};

// 假签名工具给出的两串（和 .cs 里的花纹一致）
const box = (comment: string, bin: Buffer) => Buffer.from(`untrusted comment: ${comment}\n${bin.toString('base64')}\n`, 'utf8').toString('base64');
const skBin = Buffer.alloc(158, 0x5a);
skBin.write('EdScB2', 0, 'ascii');
const SK = box('rsign encrypted secret key', skBin);
const SK_INNER = skBin.toString('base64');
const pkBin = Buffer.alloc(42, 0x33);
pkBin.write('Ed', 0, 'ascii');
for (let i = 0; i < 8; i++) pkBin[2 + i] = i + 1;
const KEY_ID = '0807060504030201';
const PK = box(`minisign public key: ${KEY_ID}`, pkBin);
// 子进程只许拿到这些环境变量（脚本里的白名单 + PATH；测试模式另放行 FAKE_SIGNER_*）
const ENV_ALLOWED = new Set(['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PATH']);

let dir = '';
let fakeExe = '';
let lockOk = '';

const cleanEnv = (): NodeJS.ProcessEnv => {
  const e = { ...process.env };
  for (const n of ['CI', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'LEMO_TEST_SIGNER']) delete e[n];
  return e;
};

beforeAll(() => {
  if (!RUN || !PS) return;
  dir = mkdtempSync(join(tmpdir(), 'lemo-gen-tauri-key-'));
  mkdirSync(join(dir, 'bin'));
  fakeExe = join(dir, 'bin', 'cargo-tauri.exe');
  const build = writePs(
    dir,
    'build.ps1',
    `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText(${q(join(root, 'tests', 'build', 'gen-tauri-key-fake-signer.cs'))})) -OutputAssembly ${q(fakeExe)} -OutputType ConsoleApplication`,
  );
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', build], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('编假签名工具失败：' + r.stdout + r.stderr);
  const sha = createHash('sha256').update(readFileSync(fakeExe)).digest('hex');
  lockOk = join(dir, 'lock-ok');
  writeFileSync(lockOk, `# 测试用\ntauri-signer  0.0.0-test  windows_amd64  cargo-tauri.exe  ${sha}  https://example.invalid/cargo-tauri.zip\n`);
}, 180_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Opts = {
  target?: 'preview' | 'prod';
  practice?: boolean;
  practiceSave?: boolean;
  usbDrive?: string;
  usbRoot?: string | null;
  /** Win32_LogicalDisk 的 DriveType：2 = 可移动磁盘（默认），3 = 本地磁盘；null = 找不到这个盘 */
  driveType?: number | null;
  mode?: 'ok' | 'empty' | 'plain' | 'badid' | 'garbage' | 'fail';
  lock?: string;
  pastes?: string[];
  /** “按回车”那几步依次返回什么：'' = 按了回车（默认），'TIMEOUT' = 120 秒没按，'THROW' = 按了 Ctrl+C */
  enters?: string[];
  reg?: Record<string, number>;
  claude?: boolean;
  env?: Record<string, string>;
};
let n = 0;
function runScript(o: Opts = {}) {
  const id = ++n;
  const events = join(dir, `events-${id}.json`);
  const log = join(dir, `signer-${id}.json`);
  const usbRoot = o.usbRoot === undefined ? join(dir, `usb-${id}`) : o.usbRoot;
  if (usbRoot) mkdirSync(usbRoot, { recursive: true });
  const pastes = o.pastes ?? [SK];
  const args = [`-Target ${o.target ?? 'preview'}`, `-Signer ${q(fakeExe)}`, `-LockFile ${q(o.lock ?? lockOk)}`];
  if (o.practice) args.push('-Practice');
  if (o.practiceSave) args.push('-PracticeSave');
  if (o.usbDrive) args.push(`-UsbDrive ${o.usbDrive}`);
  if (usbRoot && (o.target ?? 'preview') === 'prod') args.push(`-UsbRootForTest ${q(usbRoot)}`);
  const reg = Object.entries(o.reg ?? {})
    .map(([k, v]) => `'${k}' = ${v}`)
    .join('; ');
  const driveType = o.driveType === undefined ? 2 : o.driveType;
  const disk = driveType === null ? 'return @()' : `return @([pscustomobject]@{ DeviceID = 'F:'; DriveType = ${driveType} })`;
  const harness = writePs(
    dir,
    `run-${id}.ps1`,
    `$ErrorActionPreference = 'Stop'
$env:LEMO_TEST_SIGNER = '1'
$env:FAKE_SIGNER_MODE = ${q(o.mode ?? 'ok')}
$env:FAKE_SIGNER_LOG = ${q(log)}
$env:LEMO_LEAK_PROBE = 'should-not-reach-signer'
${Object.entries(o.env ?? {})
  .map(([k, v]) => `$env:${k} = ${q(v)}`)
  .join('\n')}
$global:reg = @{ ${reg} }
function global:Get-ItemProperty { param($Path, $Name) if ($global:reg.ContainsKey($Name)) { [pscustomobject]@{ $Name = $global:reg[$Name] } } else { $null } }
function global:Get-Process { if (${o.claude ? '$true' : '$false'}) { [pscustomobject]@{ ProcessName = 'claude' } } }
function global:Get-CimInstance { param($ClassName, $Filter)
  if ($ClassName -eq 'Win32_Process') { return @() }
  if ($ClassName -eq 'Win32_LogicalDisk') { ${disk} }
  throw ('test: 没准备的 CIM 类 ' + $ClassName) }
function global:Add-Type { throw 'test: Add-Type 已屏蔽' }
$global:ev = New-Object System.Collections.Generic.List[string]
$global:pastes = New-Object System.Collections.Generic.Queue[string]
${pastes.map((p) => `$global:pastes.Enqueue(${q(p)})`).join('\n')}
$global:enters = New-Object System.Collections.Generic.Queue[string]
${(o.enters ?? []).map((p) => `$global:enters.Enqueue(${q(p)})`).join('\n')}
function global:Set-Clipboard { param([string]$Value) $global:ev.Add('clip:' + $Value) }
function global:Start-Process { $global:ev.Add('spawn') }
function global:Out-File { $global:ev.Add('file') }
function global:Set-Content { $global:ev.Add('file') }
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)][string]$Prompt)
  if ($AsSecureString) { $global:ev.Add('read:secure'); if ($global:pastes.Count -eq 0) { throw 'test: 没有准备粘贴的内容' }; return (ConvertTo-SecureString ([string][char]0x200b + $global:pastes.Dequeue()) -AsPlainText -Force) }
  $a = if ($global:enters.Count -gt 0) { $global:enters.Dequeue() } else { '' }
  if ($a -eq 'THROW') { $global:ev.Add('read:ctrl-c'); throw 'test: 按了 Ctrl+C' }
  if ($a -eq 'TIMEOUT') { $global:ev.Add('read:timeout') } else { $global:ev.Add('read:enter') }
  return $a }
$code = 0
try { & ${q(SCRIPT)} ${args.join(' ')} }
catch { [Console]::Error.WriteLine($_.Exception.Message); $code = 1 }
finally { [IO.File]::WriteAllText(${q(events)}, (ConvertTo-Json -InputObject @($global:ev) -Compress), [Text.UTF8Encoding]::new($false)) }
exit $code`,
  );
  const r = spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  const ev = existsSync(events) ? (JSON.parse(readFileSync(events, 'utf8') || '[]') as string[]) : [];
  const signer = existsSync(log) ? (JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; cwd: string; env: string[] }) : null;
  return { code: r.status, out: r.stdout, err: r.stderr, ev, signer, usbRoot };
}
type Run = ReturnType<typeof runScript>;

/** 屏幕和报错里没有私钥（整串和私钥盒里那一行都没有） */
function expectNoSecret(r: Run) {
  for (const s of [r.out, r.err]) {
    expect(s.includes(SK), '屏幕上出现了私钥').toBe(false);
    expect(s.includes(SK_INNER), '屏幕上出现了私钥盒').toBe(false);
  }
}
const clips = (r: Run) => r.ev.filter((e) => e.startsWith('clip:') && e !== 'clip: ');
/** 没放过私钥，也没碰过剪贴板（连清空都没有，F10 安全审查 M4） */
function expectClipUntouched(r: Run) {
  expect(
    r.ev.filter((e) => e.startsWith('clip:')),
    '没放过私钥却碰了剪贴板',
  ).toEqual([]);
  expect(r.out).toContain(FINALLY_UNTOUCHED);
  expect(r.out).not.toContain(FINALLY);
}

describe('gen-tauri-key.ps1 静态检查（不运行）', () => {
  it('签名工具只带 signer generate 两个参数：不带密码、不写文件、不跳过问密码', () => {
    expect(text).toContain("$psi.Arguments = 'signer generate'");
    expect(code).not.toMatch(/--password|--write-keys|--ci\b|-p\s+\$/);
    expect(text).toMatch(/RedirectStandardOutput = \$true/);
    expect(text).toMatch(/RedirectStandardInput = \$false/);
  });

  it('剪贴板只放私钥（Set-ClipSecret $script:skB64）或清空；放私钥带三个排除标记，失败就停', () => {
    const sets = [...code.matchAll(/Set-Clipboard -Value ('[^']*'|\$\w+)/g)].map((m) => m[1]);
    expect(new Set(sets)).toEqual(new Set(["' '", '$value']));
    const calls = [...code.matchAll(/Set-ClipSecret (\S+)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(['$script:skB64']));
    const f = fnBody('Set-ClipSecret');
    // 第一行就记下“放过私钥”，之后不管成没成功，finally 都会清
    expect(f.split('\n')[1]?.trim()).toBe('$script:clipUsed = $true');
    for (const s of [
      "'ExcludeClipboardContentFromMonitorProcessing'",
      "'CanIncludeInClipboardHistory', [IO.MemoryStream]::new([byte[]]@(0, 0, 0, 0))",
      "'CanUploadToCloudClipboard', [IO.MemoryStream]::new([byte[]]@(0, 0, 0, 0))",
      'SetDataObject($do, $true)',
      "GetApartmentState() -ne 'STA'",
    ]) {
      expect(f).toContain(s);
    }
    // 测试模式那一支只走 Set-Clipboard；正式那一支不退回不带标记的 Set-Clipboard
    expect(f.match(/Set-Clipboard/g)?.length).toBe(1);
    expect(f).toContain('if ($script:testMode) { Set-Clipboard -Value $value; return }');
  });

  it('清剪贴板（F10 安全审查 M4、代码审查 M5）：没放过私钥直接返回；测试模式只调 Set-Clipboard；正式运行时三步都在', () => {
    const lines = fnBody('Clear-Clip')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines[1]).toBe('if (-not $script:clipUsed) { return }');
    expect(lines[2]).toBe("try { Set-Clipboard -Value ' ' } catch { }");
    expect(lines[3]).toBe('if ($script:testMode) { return }');
    const real = lines.slice(4).join('\n');
    expect(real).toContain('[System.Windows.Forms.Clipboard]::Clear()');
    expect(real).toContain('[Windows.ApplicationModel.DataTransfer.Clipboard]::ClearHistory()');
    // ClearHistory 整个脚本只出现这一次（在 testMode 那一行之后）
    expect(code.match(/ClearHistory\(\)/g)?.length).toBe(1);
    // finally 只在放过私钥时才清
    const fin = code.slice(code.lastIndexOf('finally {'));
    expect(fin).toMatch(/if \(\$clipUsed\) \{\s*Clear-Clip/);
    expect(fin).toContain(FINALLY_UNTOUCHED);
  });

  it('U 盘只新建、不覆盖，写完刷到盘上；别处不写文件', () => {
    expect([...code.matchAll(/Write-NewFile \$(\w+) /g)].map((m) => m[1])).toEqual(['skPath', 'pkPath']);
    const f = fnBody('Write-NewFile');
    expect(f).toContain('[IO.FileMode]::CreateNew');
    expect(f).toContain('$fs.Flush($true)');
    expect(code).not.toMatch(/WriteAllText|WriteAllBytes|Out-File|Set-Content|Add-Content|GetTempFileName|\$env:TEMP/);
  });

  it('子进程：环境变量只给白名单、PATH 只有系统目录、工作目录是签名工具所在文件夹、启动以后才放开只读句柄', () => {
    const f = fnBody('Invoke-SignerGenerate');
    expect(f).toContain('$psi.EnvironmentVariables.Clear()');
    expect(f).toContain(`$psi.EnvironmentVariables['PATH'] = "$env:SystemRoot\\System32;$env:SystemRoot"`);
    expect(f).toContain('$psi.WorkingDirectory = [IO.Path]::GetDirectoryName($exe)');
    expect(f).toMatch(/\$p = \[Diagnostics\.Process\]::Start\(\$psi\)\s*\} finally \{\s*\$held\.Dispose\(\)/);
    const list = /foreach \(\$n in ([^)]*)\) \{\s*\$v = \[Environment\]::GetEnvironmentVariable/.exec(f);
    expect(list).not.toBeNull();
    const names = [...(list?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => (m[1] ?? '').toUpperCase());
    expect(new Set([...names, 'PATH'])).toEqual(ENV_ALLOWED);
    expect(fnBody('Open-Signer')).toContain('[IO.FileShare]::Read)');
  });

  it('空密码靠 <empty> 判断；key id 和说明行核对', () => {
    expect(code).toContain("$_.Trim() -ceq '<empty>'");
    expect(fnBody('Get-PublicKeyId')).toContain('$box.Bin[9..2]');
  });

  it('开头的检查都调用了：录屏日志、跨设备共享、环境变量；不查 Claude（R-298，和其他密钥脚本一致）', () => {
    const fn = text.slice(text.indexOf('function Assert-SafeWindow'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(code).not.toMatch(/^\s*Assert-NoClaude\s*$/m);
    for (const c of ['Assert-NoRecording', 'Assert-NoCloudClipboard', 'Assert-CleanEnv']) expect(body).toMatch(new RegExp(`^\\s*${c}\\s*$`, 'm'));
    expect(text).toMatch(/^\s*Assert-SafeWindow\s*$/m);
  });

  it('文件是 UTF-8 BOM、只有 LF', () => {
    const raw = readFileSync(SCRIPT);
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.includes(13)).toBe(false);
  });

  it('仓库的 tools/ci-tools.lock 里 tauri-signer 只有一行，锁的是 2.12.4 的 cargo-tauri.exe（11-13 两人独立算出的哈希）', () => {
    // 只读文本，不在开发机上运行真脚本（F10 代码审查 M5）
    const lock = readFileSync(join(root, 'tools', 'ci-tools.lock'), 'utf8');
    const rows = lock.split(/\r?\n/).filter((l) => /^\s*tauri-signer\s/.test(l)).map((l) => l.trim().split(/\s+/));
    expect(rows).toEqual([[
      'tauri-signer', '2.12.4', 'windows_amd64', 'cargo-tauri.exe',
      '3eee23d4513d032f422ad2d80a1ca502fad757d173318a9d23770784cac549c2',
      'https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v2.12.4/cargo-tauri-x86_64-pc-windows-msvc.zip',
    ]]);
  });
});

describe.skipIf(!RUN)('gen-tauri-key.ps1 跑起来（假签名工具）', () => {
  it('预览：私钥只进剪贴板一次、核对粘贴通过、打印公钥，不写 U 盘', () => {
    const r = runScript();
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('测试模式（LEMO_TEST_SIGNER=1）');
    expect(r.out).toContain(FINALLY);
    expect(clips(r)).toEqual([`clip:${SK}`]);
    // 放剪贴板 → 按回车 → 清空 → 粘贴核对 → 清空 → finally 再清一次
    const i = r.ev.indexOf(`clip:${SK}`);
    expect(r.ev.slice(i, i + 5)).toEqual([`clip:${SK}`, 'read:enter', 'clip: ', 'read:secure', 'clip: ']);
    expect(r.ev.at(-1)).toBe('clip: ');
    expect(r.out).toContain(PK);
    expect(r.out).toContain(KEY_ID);
    expect(r.out).toContain('tauri.preview.conf.json');
    expect(r.out).toContain('这台电脑');
    expect(r.out).toContain('AI、读页面类扩展要先停用');
    expectNoSecret(r);
    expect(r.signer?.args).toEqual(['signer', 'generate']);
    expect(r.ev.filter((e) => e === 'spawn' || e === 'file')).toEqual([]);
  });

  it('子进程只拿到白名单里的环境变量（外壳设的 LEMO_LEAK_PROBE、LEMO_TEST_SIGNER 都传不过去），工作目录是签名工具所在文件夹', () => {
    const r = runScript();
    expect(r.code, r.err).toBe(0);
    const names = (r.signer?.env ?? []).map((x) => x.toUpperCase());
    expect(names).toContain('PATH');
    expect(names).toContain('FAKE_SIGNER_MODE');
    for (const nm of names) expect(ENV_ALLOWED.has(nm) || nm.startsWith('FAKE_SIGNER_'), `子进程拿到了 ${nm}`).toBe(true);
    expect(names).not.toContain('LEMO_LEAK_PROBE');
    expect(names).not.toContain('LEMO_TEST_SIGNER');
    expect((r.signer?.cwd ?? '').toLowerCase().replace(/\\$/, '')).toBe(dirname(fakeExe).toLowerCase());
  });

  it('设了 CI 或 TAURI_SIGNING_*：开头就停，不运行签名工具，不显示变量的值，不碰剪贴板', () => {
    // 子进程那一侧另有白名单（上一条）；这一条只证明开头的检查拦得住
    const r = runScript({ env: { CI: 'true' } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('环境变量 CI 设着');
    expect(r.signer).toBeNull();
    expectClipUntouched(r);
    const r2 = runScript({ env: { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'x' } });
    expect(r2.code).toBe(1);
    expect(r2.err).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
    expect(r2.err).not.toContain("'x'");
    expectClipUntouched(r2);
  });

  it('正式：写进 U 盘（读回核对）、进剪贴板、核对粘贴；第二次不覆盖', () => {
    const r = runScript({ target: 'prod', usbDrive: 'F:' });
    expect(r.code, r.err).toBe(0);
    const d = join(r.usbRoot ?? '', '柠檬记-签名密钥');
    expect(readFileSync(join(d, 'lemomemo-tauri-prod.key'), 'utf8')).toBe(SK);
    expect(readFileSync(join(d, 'lemomemo-tauri-prod.key.pub'), 'utf8')).toBe(PK);
    expect(clips(r)).toEqual([`clip:${SK}`]);
    expect(r.out).toContain('tauri.conf.json');
    expect(r.out).toContain('安全删除硬件');
    expectNoSecret(r);
    const again = runScript({ target: 'prod', usbDrive: 'F:', usbRoot: r.usbRoot });
    expect(again.code).toBe(1);
    expect(again.err).toContain('U 盘上已经有 lemomemo-tauri-prod.key');
    expect(again.signer, '已有旧钥匙时不该运行签名工具').toBeNull();
    expectClipUntouched(again);
    expect(readFileSync(join(d, 'lemomemo-tauri-prod.key'), 'utf8')).toBe(SK);
  });

  it('U 盘不对（本地磁盘、系统盘、找不到）：停下，不运行签名工具，不碰剪贴板（F10 代码审查 M3）', () => {
    for (const [o, msg] of [
      [{ driveType: 3, usbDrive: 'F:' }, '不是可移动磁盘'],
      [{ usbDrive: process.env.SystemDrive ?? 'C:' }, '是系统盘'],
      [{ driveType: null, usbDrive: 'F:' }, '找不到 F: 这个盘'],
    ] as [Opts, string][]) {
      const r = runScript({ target: 'prod', ...o });
      expect(r.code, msg).toBe(1);
      expect(r.err).toContain(msg);
      expect(r.signer).toBeNull();
      expectClipUntouched(r);
      expect(existsSync(join(r.usbRoot ?? '', '柠檬记-签名密钥')), '不该建 U 盘目录').toBe(false);
    }
  });

  it('练习模式：照样跑签名工具，但不进剪贴板、不问、不写 U 盘，只显示 key id', () => {
    const r = runScript({ target: 'prod', practice: true, usbRoot: null });
    expect(r.code, r.err).toBe(0);
    expect(r.signer?.args).toEqual(['signer', 'generate']);
    expectClipUntouched(r);
    expect(r.ev.filter((e) => e.startsWith('read:'))).toEqual([]);
    expect(r.out).toContain(KEY_ID);
    expect(r.out).not.toContain(PK);
    expectNoSecret(r);
  });

  it('练习模式加 -PracticeSave：用要丢掉的钥匙走一遍进剪贴板、存、核对，最后清空', () => {
    const r = runScript({ practice: true, practiceSave: true });
    expect(r.code, r.err).toBe(0);
    expect(clips(r)).toEqual([`clip:${SK}`]);
    expect(r.ev.at(-1)).toBe('clip: ');
    expect(r.out).toContain('柠檬记 练习（用完删掉）');
    expect(r.out).not.toContain(PK);
    expectNoSecret(r);
    const bad = runScript({ practiceSave: true });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('-PracticeSave 只能和 -Practice 一起用');
  });

  it('核对粘贴第一次对不上、第二次对上：重放剪贴板再核对，最后通过', () => {
    const r = runScript({ pastes: [SK.slice(0, 50), SK] });
    expect(r.code, r.err).toBe(0);
    expect(clips(r)).toEqual([`clip:${SK}`, `clip:${SK}`]);
    expect(r.out).toContain('对不上');
    expectNoSecret(r);
  });

  it('核对粘贴连续 3 次对不上：作废、不打印公钥', () => {
    const r = runScript({ pastes: ['a', 'b', 'c'] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('这把密钥作废');
    expect(r.err).toContain('连续 3 次核对都对不上');
    expect(r.out).not.toContain(PK);
    expect(r.ev.at(-1)).toBe('clip: ');
    expectNoSecret(r);
  });

  it('3 次都超时、超时和对不上混着：最后的报错说清原因，不说成“没核对上”（F10 代码审查复核第 3 条）', () => {
    const t = runScript({ enters: ['TIMEOUT', 'TIMEOUT', 'TIMEOUT'] });
    expect(t.code).toBe(1);
    expect(t.err).toContain('3 次都没在 120 秒内按回车');
    expect(t.err).toContain('这把密钥作废');
    expect(t.err).not.toContain('对不上');
    expect(t.out).not.toContain(PK);
    expectNoSecret(t);
    const m = runScript({ enters: ['TIMEOUT', '', ''], pastes: ['a', 'b'] });
    expect(m.code).toBe(1);
    expect(m.err).toContain('3 次里 1 次 120 秒没按回车、2 次核对对不上');
    expectNoSecret(m);
  });

  it('120 秒没按回车：自动清空剪贴板，再来一次', () => {
    const r = runScript({ enters: ['TIMEOUT', ''] });
    expect(r.code, r.err).toBe(0);
    const i = r.ev.indexOf('read:timeout');
    expect(r.ev.slice(i - 1, i + 3)).toEqual([`clip:${SK}`, 'read:timeout', 'clip: ', `clip:${SK}`]);
    expect(r.out).toContain('120 秒没按回车，已清空剪贴板');
    expect(clips(r)).toEqual([`clip:${SK}`, `clip:${SK}`]);
    expectNoSecret(r);
  });

  it('按回车那一步 Ctrl+C：finally 清空剪贴板，屏幕上没有私钥（F10 代码审查 M4）', () => {
    const r = runScript({ enters: ['THROW'] });
    expect(r.code).toBe(1);
    const i = r.ev.indexOf(`clip:${SK}`);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(r.ev.slice(i)).toEqual([`clip:${SK}`, 'read:ctrl-c', 'clip: ']);
    expect(r.out).toContain(FINALLY);
    expect(r.out).not.toContain(PK);
    expectNoSecret(r);
  });

  it('空密码（签名工具打印 <empty>，私钥盒仍是 EdScB2）：停下，不进剪贴板（F10 M1）', () => {
    const r = runScript({ mode: 'empty' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('密码为空');
    expect(r.signer).not.toBeNull();
    expectClipUntouched(r);
    expectNoSecret(r);
  });

  it('私钥盒 KDF 标记是两个 0（兼容别的 minisign 工具的兜底）：停下，不进剪贴板', () => {
    const r = runScript({ mode: 'plain' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('私钥没有加密');
    expectClipUntouched(r);
    expectNoSecret(r);
  });

  it('公钥说明行里的 key id 和公钥对不上：停下，不进剪贴板（F10 代码审查 S6）', () => {
    const r = runScript({ mode: 'badid' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('key id 和公钥本身对不上');
    expectClipUntouched(r);
    expectNoSecret(r);
  });

  it('输出格式不对：停下，不进剪贴板', () => {
    const r = runScript({ mode: 'garbage' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('找不到私钥和公钥');
    expectClipUntouched(r);
  });

  it('签名工具出错：报退出码，标准错误里的 base64 串被遮住', () => {
    const r = runScript({ mode: 'fail' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('退出码 3');
    expect(r.err).toContain('failed to generate key pair ***');
    expect(r.err).not.toContain('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVph');
    expectClipUntouched(r);
  });

  it('签名工具的哈希不对、锁文件里没有这一行：不运行签名工具，不碰剪贴板', () => {
    const bad = join(dir, 'lock-bad');
    writeFileSync(bad, `tauri-signer  0.0.0-test  windows_amd64  cargo-tauri.exe  ${'0'.repeat(64)}  https://example.invalid/x\n`);
    const r = runScript({ lock: bad });
    expect(r.code).toBe(1);
    expect(r.err).toContain('SHA-256 和 tools\\ci-tools.lock 不一致');
    expect(r.signer).toBeNull();
    expectClipUntouched(r);
    const none = join(dir, 'lock-none');
    writeFileSync(none, '# 空\n');
    const r2 = runScript({ lock: none });
    expect(r2.code).toBe(1);
    expect(r2.err).toContain('还没有 tauri-signer / windows_amd64');
    expect(r2.signer).toBeNull();
    expectClipUntouched(r2);
  });

  it('剪贴板历史开着、跨设备共享开着：开头就停，不运行签名工具，事件里没有任何 clip: 记录', () => {
    for (const [o, msg] of [
      [{ reg: { EnableClipboardHistory: 1 } }, '剪贴板历史'],
      [{ reg: { EnableCloudClipboard: 1 } }, '跨设备共享'],
    ] as [Opts, string][]) {
      const r = runScript(o);
      expect(r.code, msg).toBe(1);
      expect(r.err).toContain(msg);
      expect(r.signer).toBeNull();
      expectClipUntouched(r);
    }
  });

  it('有 Claude 进程时不拦（R-298）：照常跑完', () => {
    const r = runScript({ claude: true });
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toContain('检测到 Claude');
  });

  it('预览带 -UsbDrive、正式不带 -UsbDrive：拒绝', () => {
    const r = runScript({ usbDrive: 'F:' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('预览那把只存 Google 密码管理器');
    const r2 = runScript({ target: 'prod', usbRoot: null });
    expect(r2.code).toBe(1);
    expect(r2.err).toContain('请带上 -UsbDrive');
  });
});

describe.skipIf(!RUN)('gen-tauri-key.ps1 拒绝的运行方式（都停在主流程之前，不碰剪贴板）', () => {
  const ps = (args: string[], env: NodeJS.ProcessEnv = cleanEnv()) =>
    spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', env });

  it('在窗口里用 & 调用、点源：拒绝', () => {
    const r = ps(['-Command', `& ${q(SCRIPT)} -Target preview -Signer x.exe`]);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('不要在已打开的窗口里用 & 调用');
    const r2 = ps(['-Command', `. ${q(SCRIPT)} -Target preview -Signer x.exe`]);
    expect(r2.status).not.toBe(0);
    expect(r2.stdout + r2.stderr).toContain('不要点源');
  });

  it('LEMO_TEST_SIGNER=1 但没换锁文件、测试路径不在 %TEMP%：拒绝；没设测试开关却带测试参数：拒绝', () => {
    const r = ps(['-File', SCRIPT, '-Target', 'preview', '-Signer', 'x.exe'], { ...cleanEnv(), LEMO_TEST_SIGNER: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('不能用来生成真钥匙');
    const r3 = ps(['-File', SCRIPT, '-Target', 'preview', '-Signer', 'x.exe', '-LockFile', join(root, 'tools', 'ci-tools.lock')], { ...cleanEnv(), LEMO_TEST_SIGNER: '1' });
    expect(r3.status).not.toBe(0);
    expect(r3.stdout + r3.stderr).toContain('必须在 %TEMP% 下');
    const r2 = ps(['-File', SCRIPT, '-Target', 'preview', '-Signer', 'x.exe', '-LockFile', 'y']);
    expect(r2.status).not.toBe(0);
    expect(r2.stdout + r2.stderr).toContain('只给测试用');
  });
});
