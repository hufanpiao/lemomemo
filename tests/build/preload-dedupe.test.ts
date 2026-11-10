// 动态 import 预加载表去重（B2-UI-b 任务单 V2：首屏增量 ≤ 0；vite.config.ts 的 dropHostLoaded）。
// 守四件事：只去掉宿主静态闭包里的 JS（含间接引的），目标块自己的别的依赖照留；html 宿主一个不动；产物图还没记下时原样返回；
// vite.config.ts 真的把它挂在 build.modulePreload.resolveDependencies 上、产物图插件在 generateBundle 最前面
import type { Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';
import config, { dropHostLoaded, staticClosure } from '../../vite.config.ts';

/** 造一份只有 imports 的产物图；asset 用来确认不会被当成块往下走 */
function bundleOf(graph: Record<string, string[]>): Rolldown.OutputBundle {
  const b: Record<string, unknown> = {};
  for (const [f, imports] of Object.entries(graph)) b[f] = { type: 'chunk', fileName: f, imports };
  b['assets/a.css'] = { type: 'asset', fileName: 'assets/a.css' };
  return b as unknown as Rolldown.OutputBundle;
}

const bundle = bundleOf({
  'assets/main.js': ['assets/jsx-runtime.js', 'assets/native-bridge.js'],
  'assets/native-bridge.js': ['assets/log-store.js'],
  'assets/jsx-runtime.js': [],
  'assets/log-store.js': [],
  'assets/Page.js': ['assets/jsx-runtime.js', 'assets/Settings.js', 'assets/log-store.js'],
  'assets/Settings.js': ['assets/jsx-runtime.js'],
});

describe('预加载表去重', () => {
  it('宿主静态闭包含间接引的块', () => {
    expect([...staticClosure(bundle, 'assets/main.js')].sort()).toEqual(
      ['assets/jsx-runtime.js', 'assets/log-store.js', 'assets/main.js', 'assets/native-bridge.js'].sort(),
    );
  });

  it('js 宿主：去掉它已加载的块，目标块自己的别的依赖照留、顺序不变', () => {
    const deps = ['assets/Page.js', 'assets/jsx-runtime.js', 'assets/Settings.js', 'assets/log-store.js'];
    expect(dropHostLoaded(bundle, deps, 'assets/main.js', 'js')).toEqual(['assets/Page.js', 'assets/Settings.js']);
  });

  it('宿主是懒加载块时按它自己的闭包算，main 才有的块不去掉', () => {
    const deps = ['assets/Sub.js', 'assets/jsx-runtime.js', 'assets/Settings.js', 'assets/native-bridge.js'];
    expect(dropHostLoaded(bundle, deps, 'assets/Page.js', 'js')).toEqual(['assets/Sub.js', 'assets/native-bridge.js']);
  });

  it('html 宿主、产物图没记下、宿主不在图里：原样返回', () => {
    const deps = ['assets/jsx-runtime.js', 'assets/log-store.js'];
    expect(dropHostLoaded(bundle, deps, 'index.html', 'html')).toBe(deps);
    expect(dropHostLoaded(undefined, deps, 'assets/main.js', 'js')).toBe(deps);
    expect(dropHostLoaded(bundle, deps, 'assets/nope.js', 'js')).toBe(deps);
  });

  it('vite.config.ts 挂着 resolveDependencies 和产物图插件（generateBundle order pre，buildStart 清图）', () => {
    type Cfg = {
      plugins: { name?: string; buildStart?: unknown; generateBundle?: { order?: string } }[];
      build: { modulePreload: { polyfill: boolean; resolveDependencies?: unknown } };
    };
    const cfg = (config as unknown as (e: object) => Cfg)({ mode: 'e2e', command: 'build' });
    expect(cfg.build.modulePreload.polyfill).toBe(false);
    expect(typeof cfg.build.modulePreload.resolveDependencies).toBe('function');
    const p = cfg.plugins.flat().find((x) => x?.name === 'lemo:preload-graph');
    expect(p?.generateBundle?.order).toBe('pre');
    // 每次构建先清掉上一次的产物图（代码审建议 2），不靠钩子顺序
    expect(typeof p?.buildStart).toBe('function');
  });
});
