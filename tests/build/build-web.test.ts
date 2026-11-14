// build/build_web.mjs 的构建顺序和退出码（第三方审查 CI-12：检查改成本进程里直接调，原来这几条靠读 build_web.mjs 的文本断言）：
// 把 STEPS 换成假步骤，记下调用顺序、按需让某一步失败或抛错，只看 buildWeb 的行为。
// • 数据清单快照 --check 在 vite build 之前；过期（或抛错）就不构建（B2 FA-6 ③ 审查 L5）
// • 开源许可清单在三次 vite build 之后、注入预缓存清单之前写（R-410）
// • 启动画面、底栏遮罩、（只在 production）探测页三道关依次查，哪道不过就带着它的退出码停下
// • 体积预算、首屏块两项都跑完、再删 .vite；退出码体积优先（原来的 (size.status ?? 1) || (zodFree.status ?? 1)），抛错算 1
// 末尾几条用真步骤在临时目录里跑，核对 STEPS 把参数交对了脚本。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWeb, STEPS } from '../../build/build_web.mjs';

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

  it('启动画面、底栏遮罩、探测页哪道不过就停在那里（带它的退出码），后面的检查和删 .vite 都不做', async () => {
    for (const name of ['splash', 'glass', 'probe'] as const) {
      const { calls, steps } = fake({ [name]: 7 });
      expect(await buildWeb('production', OUT, steps), name).toBe(7);
      expect(calls.at(-1)?.split(' ')[0], name).toBe(name);
    }
  });

  it('体积、首屏块两项都跑完再删 .vite；退出码体积优先，抛错算 1', async () => {
    const cases: [Result, Result, number][] = [
      [1, 0, 1],
      [0, 1, 1],
      [3, 1, 3],
      [boom, 0, 1],
      [0, boom, 1],
    ];
    for (const [size, firstPaint, want] of cases) {
      const { calls, steps } = fake({ size, firstPaint });
      expect(await buildWeb('preview', OUT, steps)).toBe(want);
      expect(calls.slice(-3).map((c) => c.split(' ')[0])).toEqual(['size', 'firstPaint', 'dropViteManifest']);
    }
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
});
