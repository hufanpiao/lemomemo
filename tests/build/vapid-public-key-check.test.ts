// 构建前的 VAPID 公钥格式核对：release-build.yml（接手清单 VAPID-prod-format，没有开关）和 deploy-preview.yml（B2 O-2，开关 VAPID_KEY_REQUIRED）同一写法。
// 先核格式、不合格才判断像不像私钥 JWK（B2 代码审查复核 M1：真公钥里也可能恰好含 kty）。
// 从 workflow-permissions.test.ts 分出来（那个文件快到 max-lines）；按文本取步骤，不依赖 YAML 解析库。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const BASH = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => existsSync(p)) : 'bash';

type Step = { job: string; text: string; name: string; cond: string };
/** 和 workflow-permissions.test.ts 的 steps 同一切法：按任务、按 “      - ” 切步骤 */
function steps(text: string): Step[] {
  const at = text.search(/^jobs:\s*$/m);
  const body = at >= 0 ? text.slice(at) : text;
  const out: Step[] = [];
  for (const part of body.split(/\n(?= {2}[^\s#][^\n]*:[ \t]*\n)/)) {
    const job = /^ {2}([^\s#][^:\n]*):/.exec(part)?.[1] ?? '';
    for (const s of part.split(/\n(?= {6}- )/).filter((x) => x.startsWith('      - '))) {
      out.push({ job, text: s, name: /- name: (.*)/.exec(s)?.[1] ?? '', cond: /^ {8}if: (.*)$/m.exec(s)?.[1] ?? '' });
    }
  }
  return out;
}

// 钉住：这一步排在构建那一步紧前面、不带 if 和 continue-on-error；把 run 原样取出来用 bash 真跑正反例，脚本输出里不回显值。
const CASES = [
  { file: '.github/workflows/release-build.yml', vname: 'PROD_VAPID_PUBLIC_KEY', build: '构建（production 模式）', switchable: false },
  { file: '.github/workflows/deploy-preview.yml', vname: 'PREVIEW_VAPID_PUBLIC_KEY', build: '构建（preview 模式）', switchable: true },
] as const;

// 假值：低熵的 x，不对应任何真钥匙
const GOOD = 'BA' + 'x'.repeat(84) + 'A';

describe.each(CASES)('$file：构建前的 VAPID 公钥格式核对', ({ file, vname, build, switchable }) => {
  const t = readFileSync(join(ROOT, file), 'utf8');
  const all = steps(t);
  const i = all.findIndex((s) => s.name.startsWith('VAPID 公钥核对'));
  const st = all[i];
  it(`排在“${build}”紧前面、同一任务，不带 if、continue-on-error，变量取自 ${vname}，开头 LC_ALL=C`, () => {
    expect(i).toBeGreaterThanOrEqual(0);
    expect(all[i + 1]?.name).toBe(build);
    expect(all[i + 1]?.job).toBe(st?.job);
    expect(st?.cond).toBe('');
    expect(st?.text).not.toContain('continue-on-error');
    expect(st?.text).toContain(`VAPID_PUBLIC_KEY: \${{ vars.${vname} }}`);
    expect(st?.text).toContain('shell: bash');
    // 构建那一步注入的也是同一个变量
    expect(all[i + 1]?.text).toContain(`VITE_PUBLIC_VAPID_KEY: \${{ vars.${vname} }}`);
    expect(script.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('#'))).toBe('export LC_ALL=C');
  });
  if (switchable) {
    // 11-03 负责人已填 PREVIEW_VAPID_PUBLIC_KEY，开关已改成 'true'（B2 O-2）；改回 'false' 这条就报
    it('开关 VAPID_KEY_REQUIRED 是 true：变量为空就构建失败', () => {
      expect(st?.text).toMatch(/^ {10}VAPID_KEY_REQUIRED: 'true'$/m);
    });
  }
  const lines = (st?.text ?? '').split('\n');
  const script = lines
    .slice(lines.findIndex((l) => l.trim() === 'run: |') + 1)
    .filter((l) => l.startsWith('          ') || l.trim() === '')
    .map((l) => l.slice(10))
    .join('\n');
  const run = (value: string | undefined, required = 'true') => {
    const d = mkdtempSync(join(tmpdir(), 'lemo-vapid-'));
    try {
      writeFileSync(join(d, 'check.sh'), script + '\n');
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: join(d, 'summary.md'), VAPID_KEY_REQUIRED: required };
      if (value !== undefined) env.VAPID_PUBLIC_KEY = value;
      const r = spawnSync(BASH ?? 'bash', ['--noprofile', '--norc', '-eo', 'pipefail', 'check.sh'], { cwd: d, encoding: 'utf8', env });
      return { code: r.status, out: r.stdout + r.stderr, summary: existsSync(join(d, 'summary.md')) ? readFileSync(join(d, 'summary.md'), 'utf8') : '' };
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  it.skipIf(!BASH)('合格的公钥（87 个字符、B 开头、第二个字符 A～P、末位合规）：通过，摘要里不写值；中间恰好含 kty 的合格值也通过（M1）', () => {
    for (const v of [GOOD, 'BA' + 'x'.repeat(40) + 'kty' + 'x'.repeat(41) + 'A', 'BAkty' + 'x'.repeat(81) + 'A']) {
      expect(v).toHaveLength(87);
      const r = run(v);
      expect(r.code, r.out).toBe(0);
      expect(r.summary).toContain('已填（87 个字符，格式对）');
      expect(r.out + r.summary).not.toContain(v);
      expect(r.out).not.toContain('私钥');
    }
  });
  it.skipIf(!BASH)(switchable ? '为空、没设：开关 true 时失败，开关 false 时只出警告、照常构建' : '为空、没设：失败', () => {
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
  it.skipIf(!BASH)('误填私钥 JWK（整串 JWK、只带引号、只带花括号、格式不合格又带 kty）：失败，提示私钥已暴露，不回显值', () => {
    const jwk = '{"kty":"EC","crv":"P-256","x":"' + 'x'.repeat(43) + '","y":"' + 'y'.repeat(43) + '","d":"' + 'z'.repeat(43) + '"}';
    for (const v of [jwk, '"' + GOOD.slice(1), '{' + GOOD.slice(1), 'kty' + 'x'.repeat(84)]) {
      const r = run(v);
      expect(r.code, v.slice(0, 8)).toBe(1);
      expect(r.out).toContain('看起来是私钥 JWK');
      expect(r.out).not.toContain('格式不对');
      expect(r.out).not.toContain(v);
    }
  });
  it.skipIf(!BASH)('正好 43 个字符（可能是私钥的 d）：失败，按私钥已暴露处理，不回显值；42、44 个字符只报格式不对', () => {
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
  it.skipIf(!BASH)('长度不对、不以 B 开头、第二个字符超出 A～P、末位不合规、带空格换行、单引号、非 base64url 字符：失败，只报长度不回显值', () => {
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
