// build/build_web.mjs 的构建顺序和退出码（第三方审查 CI-12：检查改成本进程里直接调，原来这几条靠读 build_web.mjs 的文本断言）：
// 把 STEPS 换成假步骤，记下调用顺序、按需让某一步失败或抛错，只看 buildWeb 的行为。
// • 数据清单快照 --check 在 vite build 之前；过期（或抛错）就不构建（B2 FA-6 ③ 审查 L5）
// • 开源许可清单在三次 vite build 之后、注入预缓存清单之前写（R-410）
// • 启动画面、底栏遮罩、（只在 production）探测页、体积预算、首屏块依次查，每道都跑完（11-14 整块评审：原来前三道哪道不过就停、.vite 也不删），
//   退出码按这个顺序取第一个非零的，抛错算 1
// • .vite 在 finally 里删：检查不过、vite build 抛错都删
// 末尾几条用真步骤在临时目录里跑，核对 STEPS 把参数交对了脚本。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { argMode, buildWeb, STEPS } from '../../build/build_web.mjs';
import { cli as firstPaintCli } from '../../build/check_first_paint_chunks.mjs';
import { cli as glassCli } from '../../build/check_glass_css.mjs';
import { cli as probeCli } from '../../build/check_no_probe.mjs';
import { cli as sizeCli } from '../../build/check_size.mjs';
import { cli as splashCli } from '../../build/check_splash_css.mjs';
import { ROOT, UsageError } from '../../build/cli_args.mjs';
import { readManifest } from '../../build/vite_manifest.mjs';

type Steps = typeof STEPS;
type Result = number | (() => never);

/** 假步骤：每次调用记成“名字 参数…”；codes 里给的检查返回那个退出码（给函数就抛错），其余检查返回 0 */
function fake(codes: Partial<Record<keyof Steps, Result>> = {}) {
  const calls: string[] = [];
  const step =
    (name: keyof Steps, ret: unknown = 0) =>
    (...args: unknown[]) => {
      calls.push([name, ...args.map((a) => (typeof a === 'string' ? a.replaceAll('\\', '/').replace(/^.*\/out(?=\/|$)/, 'OUT') : String(a)))].join(' '));
      const c = codes[name];
      if (typeof c === 'function') c();
      return c ?? ret;
    };
  const steps: Steps = {
    manifests: step('manifests'),
    vite: step('vite', undefined),
    licenses: step('licenses', 12),
    inject: step('inject', 3),
    assemble: step('assemble', undefined),
    splash: step('splash'),
    glass: step('glass'),
    probe: step('probe'),
    size: step('size'),
    firstPaint: step('firstPaint'),
    dropViteManifest: step('dropViteManifest', undefined),
  } as unknown as Steps;
  return { calls, steps };
}

const OUT = resolve(tmpdir(), 'lemo-build-web-fake', 'out');
const boom = () => {
  throw new Error('假的：这一步抛错');
};

describe('buildWeb 的顺序', () => {
  it('preview：快照核对 → 三次 vite build → 许可清单 → 注入预缓存 → 拼 dist/web → 启动画面、底栏遮罩 → 体积、首屏块 → 删 .vite；不查探测页；退出码 0', async () => {
    const { calls, steps } = fake();
    expect(await buildWeb('preview', OUT, steps)).toBe(0);
    expect(calls).toEqual([
      'manifests',
      'vite vite.config.ts preview',
      'vite vite.preview.config.ts preview',
      'vite vite.sw.config.ts preview',
      'licenses OUT/app',
      'inject OUT/app',
      'assemble preview OUT',
      'splash OUT/app',
      'glass OUT/app',
      'size OUT/app preview',
      'firstPaint OUT/app',
      'dropViteManifest OUT/app OUT',
    ]);
  });

  it('production：底栏遮罩之后、体积之前查探测页（查整个输出目录）', async () => {
    const { calls, steps } = fake();
    expect(await buildWeb('production', OUT, steps)).toBe(0);
    expect(calls.slice(calls.indexOf('glass OUT/app'), calls.indexOf('size OUT/app production'))).toEqual(['glass OUT/app', 'probe OUT']);
  });

  it('e2e、e2e-real 按 preview 跑 vite，其余步骤照传原模式', async () => {
    for (const mode of ['e2e', 'e2e-real']) {
      const { calls, steps } = fake();
      await buildWeb(mode, OUT, steps);
      expect(calls.filter((c) => c.startsWith('vite ')).every((c) => c.endsWith(' preview')), mode).toBe(true);
      expect(calls, mode).toContain(`size OUT/app ${mode}`);
      expect(calls, mode).not.toContain('probe OUT');
    }
  });
});

describe('buildWeb 的退出码', () => {
  it('数据清单快照过期（退出码 1）或核对时抛错：直接返回 1，不跑 vite build', async () => {
    for (const c of [1, boom]) {
      const { calls, steps } = fake({ manifests: c });
      expect(await buildWeb('preview', OUT, steps)).toBe(1);
      expect(calls).toEqual(['manifests']);
    }
  });

  const GATES = ['splash', 'glass', 'probe', 'size', 'firstPaint', 'dropViteManifest'];
  it('任何一道检查不过（或抛错）：后面的检查照样跑完、最后删 .vite，退出码是它的（抛错算 1）', async () => {
    for (const name of ['splash', 'glass', 'probe', 'size', 'firstPaint'] as const) {
      for (const [c, want] of [[7, 7], [boom, 1]] as [Result, number][]) {
        const { calls, steps } = fake({ [name]: c });
        expect(await buildWeb('production', OUT, steps), name).toBe(want);
        expect(calls.slice(-6).map((x) => x.split(' ')[0]), name).toEqual(GATES);
      }
    }
  });

  it('几道都不过：按顺序取第一个非零退出码', async () => {
    const cases: [Partial<Record<keyof Steps, Result>>, number][] = [
      [{ splash: 4, size: 1 }, 4],
      [{ glass: boom, firstPaint: 5 }, 1],
      [{ probe: 6, size: 3, firstPaint: 2 }, 6],
      [{ size: 3, firstPaint: 1 }, 3],
      [{ size: 0, firstPaint: 9 }, 9],
    ];
    for (const [codes, want] of cases) {
      const { calls, steps } = fake(codes);
      expect(await buildWeb('production', OUT, steps), JSON.stringify(Object.keys(codes))).toBe(want);
      expect(calls.at(-1)).toBe('dropViteManifest OUT/app OUT');
    }
  });

  it('vite build（或许可清单、拼 dist/web）抛错：错照样抛出去，.vite 也删了', async () => {
    for (const name of ['vite', 'licenses', 'assemble'] as const) {
      const { calls, steps } = fake({ [name]: boom });
      await expect(buildWeb('preview', OUT, steps), name).rejects.toThrow('假的：这一步抛错');
      expect(calls.at(-1), name).toBe('dropViteManifest OUT/app OUT');
      expect(calls.some((c) => c.startsWith('splash')), name).toBe(false);
    }
  });
});

describe('argMode：--mode 的解析（共用 cli_args.mjs 的 argValue）', () => {
  it('--mode v、--mode=v 都认；没写是 preview', () => {
    expect(argMode(['--mode', 'production'])).toBe('production');
    expect(argMode(['--mode=e2e'])).toBe('e2e');
    expect(argMode([])).toBe('preview');
  });
  it('写了 --mode 没给值（末尾、后面跟着别的 --参数、--mode= 空着）：报错，不悄悄回落成 preview', () => {
    for (const argv of [['--mode'], ['--mode', '--x'], ['--mode=']]) expect(() => argMode(argv), argv.join(' ')).toThrow(UsageError);
  });
});

describe('真步骤把参数交对了脚本（临时目录）', () => {
  const tmp = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), 'lemo-build-web-'));
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(d, f, '..'), { recursive: true });
      writeFileSync(join(d, f), body);
    }
    return d;
  };
  it('数据清单快照：仓库里的快照是新的，返回 0', async () => {
    expect(await STEPS.manifests()).toBe(0);
  });
  it('探测页：输出目录里有标记返回 1，干净返回 0', () => {
    const dirty = tmp({ 'app/assets/a.js': 'x voice-probe y' });
    const clean = tmp({ 'app/assets/a.js': 'x' });
    try {
      expect(STEPS.probe(dirty)).toBe(1);
      expect(STEPS.probe(clean)).toBe(0);
    } finally {
      for (const d of [dirty, clean]) rmSync(d, { recursive: true, force: true });
    }
  });
  it('首屏块：读 app/.vite/manifest.json（共用的 readManifest），缺首屏动态入口返回 1；没有 manifest 抛错（codeOf 记成 1）', () => {
    const d = tmp({ 'app/.vite/manifest.json': JSON.stringify({ 'index.html': { file: 'assets/i.js' } }), 'app/assets/i.js': '' });
    const none = tmp({});
    try {
      expect(STEPS.firstPaint(join(d, 'app'))).toBe(1);
      expect(() => STEPS.firstPaint(join(none, 'app'))).toThrow('找不到 Vite 的 manifest.json');
    } finally {
      for (const x of [d, none]) rmSync(x, { recursive: true, force: true });
    }
  });
  it('readManifest 的后备 <app>/../../vite-manifest 只在仓库里找：产物在仓库外（系统临时目录）时，旁边放一份也不读', () => {
    const d = tmp({ 'vite-manifest/manifest.json': '{}' });
    try {
      // d/x/app/../.. = d：仓库外，不读 d/vite-manifest
      expect(() => readManifest(join(d, 'x', 'app'))).toThrow('找不到 Vite 的 manifest.json');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// 11-14 整块评审：五个检查的 cli() 共用 cli_args.mjs（argValue、argPath、withUsage）
describe('构建后检查的命令行参数', () => {
  const CLIS = { size: sizeCli, firstPaint: firstPaintCli, glass: glassCli, splash: splashCli } as const;
  it('写了 --app-dir（或 check_size 的 --mode、--baseline，check_no_probe 的 --dir）没给值：退出 2，不悄悄用默认值', () => {
    for (const [name, cli] of Object.entries(CLIS)) {
      expect(cli(['--app-dir']), name).toBe(2);
      expect(cli(['--app-dir=']), name).toBe(2);
    }
    expect(sizeCli(['--mode'])).toBe(2);
    expect(sizeCli(['--baseline', '--json'])).toBe(2);
    expect(probeCli(['--dir'])).toBe(2);
  });
  it('相对路径按仓库根解析（不看当前目录）；--x=v 也认', () => {
    // 要在仓库里才有相对路径：放进被 .gitignore 忽略的 dist/web-*（LEMO_WEB_OUT 那种输出目录的名字）
    mkdirSync(join(ROOT, 'dist'), { recursive: true });
    const dirty = mkdtempSync(join(ROOT, 'dist', 'web-tmp-cli-args-'));
    writeFileSync(join(dirty, 'a.js'), 'x voice-probe y');
    try {
      const rel = relative(ROOT, dirty);
      expect(probeCli(['--dir', rel])).toBe(1);
      expect(probeCli([`--dir=${rel}`])).toBe(1);
    } finally {
      rmSync(dirty, { recursive: true, force: true });
    }
  });
});
