// 构建前的 VAPID 公钥格式核对（build/ci/vapid-public-key.sh）：release-build.yml（接手清单 VAPID-prod-format，没有开关）和 deploy-preview.yml（B2 O-2，开关 VAPID_KEY_REQUIRED）调同一份脚本。
// 先核格式、不合格才判断像不像私钥 JWK（B2 代码审查复核 M1：真公钥里也可能恰好含 kty）。
// 第一组按文本钉住两个工作流怎么调它（第三方审查 CI-8：原来是两份 shell 副本，这里逐字取出来跑）；其余直接用 bash 跑脚本的正反例，输出里不回显值。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'build', 'ci', 'vapid-public-key.sh');
const BASH = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => existsSync(p)) : 'bash';

/** 工作流里名字以 prefix 开头的步骤，和它后面紧跟的一步（按 “      - ” 切；两个工作流里这两步都在同一个任务中间） */
function stepPair(text: string, prefix: string): [string, string] {
  const all = text.split(/\n(?= {6}- )/);
  const i = all.findIndex((s) => s.startsWith(`      - name: ${prefix}`));
  return [all[i] ?? '', all[i + 1] ?? ''];
}

const CASES = [
  { file: '.github/workflows/release-build.yml', vname: 'PROD_VAPID_PUBLIC_KEY', build: '构建（production 模式）', switchable: false },
  { file: '.github/workflows/deploy-preview.yml', vname: 'PREVIEW_VAPID_PUBLIC_KEY', build: '构建（preview 模式）', switchable: true },
] as const;

describe.each(CASES)('$file 调 build/ci/vapid-public-key.sh', ({ file, vname, build, switchable }) => {
  const [st, next] = stepPair(readFileSync(join(ROOT, file), 'utf8'), 'VAPID 公钥核对');
  it(`排在“${build}”紧前面，不带 if、continue-on-error，变量取自 ${vname}，构建注入的是同一个变量`, () => {
    expect(st).not.toBe('');
    expect(next.startsWith(`      - name: ${build}\n`)).toBe(true);
    expect(st).not.toMatch(/^ {8}(if|continue-on-error):/m);
    expect(st, '两步之间不许隔着别的任务').not.toMatch(/^ {2}\S/m);
    expect(st).toContain(`VAPID_PUBLIC_KEY: \${{ vars.${vname} }}`);
    expect(st).toMatch(new RegExp(`^ {8}run: bash build/ci/vapid-public-key\\.sh ${vname}$`, 'm'));
    expect(next).toContain(`VITE_PUBLIC_VAPID_KEY: \${{ vars.${vname} }}`);
  });
  it(switchable ? '开关 VAPID_KEY_REQUIRED 是 true：变量为空就构建失败（11-03 起，改回 false 这条就报）' : '没有开关（不写 VAPID_KEY_REQUIRED，脚本默认为空就失败）', () => {
    if (switchable) expect(st).toMatch(/^ {10}VAPID_KEY_REQUIRED: 'true'$/m);
    else expect(st).not.toContain('VAPID_KEY_REQUIRED');
  });
});

it('脚本开头 set -euo pipefail、export LC_ALL=C（字符区间按字节比较）', () => {
  const code = readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  expect(code.slice(0, 2)).toEqual(['set -euo pipefail', 'export LC_ALL=C']);
});

// 假值：低熵的 x，不对应任何真钥匙
const GOOD = 'BA' + 'x'.repeat(84) + 'A';

describe.skipIf(!BASH).each(CASES)('$vname：脚本的正反例', ({ vname, switchable }) => {
  /** required 不给时不设 VAPID_KEY_REQUIRED（脚本默认 true，release-build 就是这样调的） */
  const run = (value: string | undefined, required?: string) => {
    const d = mkdtempSync(join(tmpdir(), 'lemo-vapid-'));
    try {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: join(d, 'summary.md') };
      if (required !== undefined) env.VAPID_KEY_REQUIRED = required;
      if (value !== undefined) env.VAPID_PUBLIC_KEY = value;
      const r = spawnSync(BASH ?? 'bash', ['--noprofile', '--norc', SCRIPT, vname], { cwd: d, encoding: 'utf8', env });
      return { code: r.status, out: r.stdout + r.stderr, summary: existsSync(join(d, 'summary.md')) ? readFileSync(join(d, 'summary.md'), 'utf8') : '' };
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  it('合格的公钥（87 个字符、B 开头、第二个字符 A～P、末位合规）：通过，摘要里不写值；中间恰好含 kty 的合格值也通过（M1）', () => {
    for (const v of [GOOD, 'BA' + 'x'.repeat(40) + 'kty' + 'x'.repeat(41) + 'A', 'BAkty' + 'x'.repeat(81) + 'A']) {
      expect(v).toHaveLength(87);
      const r = run(v);
      expect(r.code, r.out).toBe(0);
      expect(r.summary).toContain('已填（87 个字符，格式对）');
      expect(r.out + r.summary).not.toContain(v);
      expect(r.out).not.toContain('私钥');
    }
  });
  it(switchable ? '为空、没设：开关 true 时失败，开关 false 时只出警告、照常构建' : '为空、没设：失败', () => {
    for (const v of ['', undefined]) {
      const r = run(v);
      expect(r.code).toBe(1);
      expect(r.out).toContain(`${vname} 是空的`);
      if (switchable) {
        const w = run(v, 'false');
        expect(w.code, w.out).toBe(0);
        expect(w.out).toContain('::warning::');
      }
    }
  });
  it('误填私钥 JWK（整串 JWK、只带引号、只带花括号、格式不合格又带 kty）：失败，提示私钥已暴露，不回显值', () => {
    const jwk = '{"kty":"EC","crv":"P-256","x":"' + 'x'.repeat(43) + '","y":"' + 'y'.repeat(43) + '","d":"' + 'z'.repeat(43) + '"}';
    for (const v of [jwk, '"' + GOOD.slice(1), '{' + GOOD.slice(1), 'kty' + 'x'.repeat(84)]) {
      const r = run(v);
      expect(r.code, v.slice(0, 8)).toBe(1);
      expect(r.out).toContain('看起来是私钥 JWK');
      expect(r.out).not.toContain('格式不对');
      expect(r.out).not.toContain(v);
    }
  });
  it('正好 43 个字符（可能是私钥的 d）：失败，按私钥已暴露处理，不回显值；42、44 个字符只报格式不对', () => {
    const d = 'z'.repeat(43);
    const r = run(d);
    expect(r.code).toBe(1);
    expect(r.out).toContain('这可能是私钥的 d，按私钥已经暴露处理');
    expect(r.out).not.toContain(d);
    for (const n of [42, 44]) {
      const o = run('z'.repeat(n));
      expect(o.code).toBe(1);
      expect(o.out).toContain('格式不对');
      expect(o.out).not.toContain('私钥');
    }
  });
  it('长度不对、不以 B 开头、第二个字符超出 A～P、末位不合规、带空格换行、单引号、非 base64url 字符：失败，只报长度不回显值', () => {
    const bad = [
      GOOD.slice(0, 86),
      GOOD + 'A',
      'C' + GOOD.slice(1),
      'BQ' + GOOD.slice(2),
      GOOD.slice(0, 86) + 'B',
      GOOD + '\n',
      ' ' + GOOD.slice(1),
      "'" + GOOD,
      'BA' + 'x'.repeat(83) + '+A',
      'BA' + 'x'.repeat(83) + 'éA',
    ];
    for (const v of bad) {
      const r = run(v);
      expect(r.code, JSON.stringify(v.slice(-3))).toBe(1);
      expect(r.out).toContain('格式不对');
      expect(r.out).not.toContain('私钥');
      // LC_ALL=C：长度按字节报
      expect(r.out).toContain(`现在 ${Buffer.byteLength(v)} 个字符`);
      expect(r.out).not.toContain(v.trim());
    }
  });
});
